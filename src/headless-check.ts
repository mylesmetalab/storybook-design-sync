import { EVENTS, type RegisteredStoriesPayload, type RegisteredStoryEntry } from "./channels.js";
import type { DriftReport } from "./dimensions/types.js";
import {
  ATTACHED_SOURCE,
  bridgeSource,
  drainSource,
  emitSource,
  type BridgeEvent,
} from "./headless-bridge.js";
import {
  CONFIG_ERROR,
  SET_CURRENT_STORY,
  STORY_ERRORED,
  STORY_MISSING,
  STORY_PREPARED,
  STORY_RENDERED,
  STORY_THREW_EXCEPTION,
} from "./storybook-events.js";
import { requestStoryCheck, type StoryDataReader } from "./check-request.js";
import { runBulkCheck, type BulkStoryOutcome, type WarmOutcome } from "./bulk-run.js";
import { bulkBudgetMs, WARM_BUDGET_MS } from "./check-budget.js";
import { componentNameFromStoryId } from "./fix-prompt.js";

/**
 * The Node half of `design-sync check` — a headless stand-in for the panel's
 * **Check all**, and deliberately nothing more than that.
 *
 * ## What this is, stated precisely
 *
 * The panel's bulk run is: warm the shared Figma fetch once, then per story
 * navigate → wait for `storyRendered` → `requestStoryCheck(...)` → wait for
 * `design-sync:driftReport`. Every one of those steps happens here, on the same
 * channel, against the same running Storybook. The measuring (`preview.ts`) and
 * the comparing (`server.ts` + `engines/figma-rest.ts`) are untouched and
 * un-duplicated: this module contributes sequencing and a browser tab, exactly
 * as `manager.tsx` does.
 *
 * Three things are shared rather than re-derived, and each was a divergence
 * waiting to happen:
 *
 *  - the request payload comes from `requestStoryCheck` — the single
 *    construction site v0.0.43 collapsed two into (#80). This is not a third;
 *    it is a third *caller*.
 *  - the sequencing comes from `runBulkCheck` (`bulk-run.ts`), so the run's
 *    shared fetch completes before the first story's timer starts (#56).
 *  - the per-story budget comes from `bulkBudgetMs`, so a story that fails
 *    headlessly fails in the panel too.
 *
 * ## What it necessarily needs
 *
 * A **running `storybook dev`**. The Figma-reading engine lives in Storybook's
 * Node process, and the preview only carries a websocket transport when
 * `CONFIG_TYPE === "DEVELOPMENT"` (`createBrowserChannel`). A static
 * `storybook build` has no server channel and therefore no engine, so it cannot
 * answer a drift check at all. Documented as a limit rather than worked around,
 * because working around it would mean a second engine host.
 */

/**
 * The browser capability this module needs: evaluate an expression, and load a
 * URL with the bridge installed. Two methods, no browser types — so the
 * orchestration is unit-tested against a fake and `playwright` is only ever
 * imported by `headless-driver.ts`.
 */
export interface HeadlessDriver {
  /** Load `url`, install the bridge before page scripts, resolve once attached. */
  navigate(url: string): Promise<void>;
  /** Evaluate a JS expression in the page; resolve with its JSON value. */
  evaluate<T>(expression: string): Promise<T>;
}

/** Channel events the bridge logs. Everything else in the page is ignored. */
export const BRIDGE_EVENTS: string[] = [
  STORY_RENDERED,
  STORY_PREPARED,
  STORY_MISSING,
  STORY_ERRORED,
  STORY_THREW_EXCEPTION,
  CONFIG_ERROR,
  EVENTS.DriftReport,
  EVENTS.DriftError,
  EVENTS.RegisteredStories,
  EVENTS.WarmCacheDone,
  EVENTS.ConfigInfo,
];

export function bridgeInstallSource(): string {
  return bridgeSource({ events: BRIDGE_EVENTS, storyPreparedEvent: STORY_PREPARED });
}

export function bridgeAttachedSource(): string {
  return ATTACHED_SOURCE;
}

/**
 * A buffered view of the preview channel, seen from Node.
 *
 * Buffered because the events do not arrive in the order we ask for them: a
 * story's `storyPrepared` can precede its `storyRendered`, and a `driftReport`
 * can land while we are still draining. Anything logged and not yet consumed
 * stays in `buffer` until something matches it, so no reply is lost by having
 * been early — which in a channel-driven check is the difference between a
 * report and a spurious timeout.
 */
export class HeadlessChannel {
  private seq = 0;
  private buffer: BridgeEvent[] = [];
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly driver: HeadlessDriver,
    opts: {
      pollMs?: number;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    } = {},
  ) {
    this.pollMs = opts.pollMs ?? 40;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  /** Forget everything. Called after a page load, whose bridge starts at seq 0. */
  reset(): void {
    this.seq = 0;
    this.buffer = [];
  }

  async emit(type: string, payload?: unknown): Promise<void> {
    const sent = await this.driver.evaluate<boolean>(emitSource(type, payload));
    if (!sent) {
      throw new Error(
        `Could not emit "${type}" — the Storybook preview channel is not available in the page. ` +
          `Is this URL a Storybook running in dev mode?`,
      );
    }
  }

  /** Pull everything new out of the page's log into the buffer. */
  async poll(): Promise<void> {
    const drained = await this.driver.evaluate<BridgeEvent[] | null>(drainSource(this.seq));
    if (drained === null) {
      throw new Error(
        "The design-sync bridge is not installed in the page — the Storybook preview may have " +
          "navigated away or failed to boot.",
      );
    }
    for (const event of drained) {
      if (event.seq > this.seq) this.seq = event.seq;
      this.buffer.push(event);
    }
  }

  /** Remove and return the first buffered event matching `match`. */
  take(match: (event: BridgeEvent) => boolean): BridgeEvent | undefined {
    const index = this.buffer.findIndex(match);
    if (index === -1) return undefined;
    return this.buffer.splice(index, 1)[0];
  }

  /**
   * Wait for a matching event, polling the page's log.
   *
   * `reject` recognizes the failures that mean the awaited event is never coming
   * — a missing story, a render exception — so the run reports the cause instead
   * of the budget. A timeout here is honest but useless; a named cause is not.
   */
  async waitFor(opts: {
    match: (event: BridgeEvent) => boolean;
    reject?: (event: BridgeEvent) => string | undefined;
    timeoutMs: number;
    describe: string;
  }): Promise<BridgeEvent> {
    const deadline = this.now() + opts.timeoutMs;
    for (;;) {
      const hit = this.take(opts.match);
      if (hit) return hit;
      if (opts.reject) {
        const bad = this.take((e) => opts.reject!(e) !== undefined);
        if (bad) throw new Error(opts.reject(bad)!);
      }
      if (this.now() >= deadline) {
        throw new Error(
          `Timed out after ${Math.round(opts.timeoutMs / 1000)}s waiting for ${opts.describe}.`,
        );
      }
      await this.sleep(this.pollMs);
      await this.poll();
    }
  }
}

/** Preview URL for a story id (or the bare preview when omitted). */
export function previewUrl(baseUrl: string, storyId?: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const query = storyId ? `?viewMode=story&id=${encodeURIComponent(storyId)}` : "";
  return `${base}/iframe.html${query}`;
}

/**
 * Ask the addon server for the registry, exactly as the panel's **Check all**
 * does (`ListRegisteredRequest`). The registry is read on the Node side by the
 * running Storybook, so `check` never opens `.design-sync/registry.json` itself
 * — there is one reader of the bindings, and it is the one the panel uses.
 */
export async function listRegisteredStories(
  channel: HeadlessChannel,
  timeoutMs = 15_000,
): Promise<RegisteredStoriesPayload> {
  await channel.emit(EVENTS.ListRegisteredRequest);
  const event = await channel.waitFor({
    match: (e) => e.type === EVENTS.RegisteredStories,
    timeoutMs,
    describe: "the addon server's registry listing",
  });
  const payload = (event.args[0] ?? {}) as RegisteredStoriesPayload;
  if (payload.error) {
    throw new Error(`The addon server could not read the registry: ${payload.error}`);
  }
  return {
    stories: Array.isArray(payload.stories) ? payload.stories : [],
    fileKey: payload.fileKey ?? "",
  };
}

/**
 * Ask the running addon server what it is — `ConfigRequest` → `ConfigInfo`, the
 * same handshake the panel performs when it mounts.
 *
 * Worth a round trip for one reason above the others: `addonVersion` is the
 * version **the Storybook process is executing**, and a running dev server keeps
 * serving the bundle it started with (#62). The CLI binary and the dev server can
 * therefore be different releases, in which case `check`'s answer is the server's
 * answer and not this CLI's. That is reported, never guessed at and never
 * silently smoothed over.
 */
export async function readServerConfig(
  channel: HeadlessChannel,
  timeoutMs = 15_000,
): Promise<{
  apply: string;
  fileKey: string;
  addonVersion?: string;
  installedVersion?: string;
  error?: string;
}> {
  await channel.emit(EVENTS.ConfigRequest);
  const event = await channel.waitFor({
    match: (e) => e.type === EVENTS.ConfigInfo,
    timeoutMs,
    describe: "the addon server's config reply",
  });
  const payload = (event.args[0] ?? {}) as {
    apply?: string;
    fileKey?: string;
    addonVersion?: string;
    installedVersion?: string;
    error?: string;
  };
  return {
    apply: payload.apply ?? "off",
    fileKey: payload.fileKey ?? "",
    ...(payload.addonVersion !== undefined ? { addonVersion: payload.addonVersion } : {}),
    ...(payload.installedVersion !== undefined ? { installedVersion: payload.installedVersion } : {}),
    ...(payload.error !== undefined ? { error: payload.error } : {}),
  };
}

/**
 * The run's shared Figma fetch, hoisted out of every story's budget (#56).
 *
 * Resolves — never rejects — for the same reason the panel's does: a warm-up
 * that could not run makes the run slow, not wrong, because each story still
 * fetches what it needs. The failure is reported and carried into the output.
 */
export async function warmSharedCaches(
  channel: HeadlessChannel,
  budgetMs = WARM_BUDGET_MS,
  now: () => number = () => Date.now(),
): Promise<WarmOutcome> {
  const startedAt = now();
  try {
    await channel.emit(EVENTS.WarmCacheRequest);
    const event = await channel.waitFor({
      match: (e) => e.type === EVENTS.WarmCacheDone,
      timeoutMs: budgetMs,
      describe: "the shared Figma fetch",
    });
    const payload = (event.args[0] ?? {}) as { ms?: number; error?: string };
    const ms = typeof payload.ms === "number" ? payload.ms : now() - startedAt;
    return payload.error === undefined ? { ms } : { ms, error: payload.error };
  } catch (err: unknown) {
    return {
      ms: now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Turn one `storyPrepared` payload into the reader `check-request.ts` expects.
 *
 * `getData(storyId)` on the manager API returns the index entry Storybook builds
 * *from this very event*, so this adapter is the same data by the same route —
 * see the note on `StoryDataReader`. Anything other than the requested id yields
 * `undefined`, so a stale payload can never furnish another story's context.
 */
export function preparedReader(storyId: string, prepared: unknown): StoryDataReader {
  return {
    getData(requested: string): unknown {
      return requested === storyId ? prepared : undefined;
    },
  };
}

/**
 * Render one story and check it — the headless twin of `checkOneStory` in
 * `manager.tsx`, step for step.
 *
 * Holds no timer of its own. The per-story budget is applied once, by
 * `runBulkCheck`, after the shared fetch — the #56 ordering, which a timer in
 * here would quietly undo.
 */
export async function checkStoryHeadless(opts: {
  channel: HeadlessChannel;
  storyId: string;
  dualMode: boolean;
  /** Set when the page was loaded on this story, so it needs no navigation. */
  alreadyCurrent?: boolean;
  /** Ceiling on the render step alone; the caller's budget covers the whole. */
  renderTimeoutMs?: number;
  /** Ceiling on waiting for the server's reply. */
  reportTimeoutMs?: number;
}): Promise<DriftReport> {
  const { channel, storyId, dualMode } = opts;
  const renderTimeoutMs = opts.renderTimeoutMs ?? 20_000;
  const reportTimeoutMs = opts.reportTimeoutMs ?? 60_000;

  if (!opts.alreadyCurrent) {
    await channel.emit(SET_CURRENT_STORY, { storyId, viewMode: "story" });
  }
  await channel.waitFor({
    match: (e) => e.type === STORY_RENDERED && e.args[0] === storyId,
    reject: (e) => renderFailure(e, storyId),
    timeoutMs: renderTimeoutMs,
    describe: `story "${storyId}" to render`,
  });

  // The story's own `parameters.designSync` and `args`, from the event the
  // manager builds its index entry out of.
  const prepared = await channel.waitFor({
    match: (e) => e.type === STORY_PREPARED && preparedId(e) === storyId,
    timeoutMs: renderTimeoutMs,
    describe: `story "${storyId}" to report its parameters`,
  });

  // The one construction site, called with a reader instead of the manager API.
  // A field added to a check request reaches this path for free.
  //
  // The emit is *captured* rather than performed inline because sending it takes
  // a round trip to the page and `requestStoryCheck` is synchronous. Capturing
  // keeps the send awaited — a fire-and-forget emit that failed would surface as
  // an unhandled rejection and a bare timeout, instead of the real cause.
  let sent: { event: string; payload: unknown } | undefined;
  requestStoryCheck(
    (event: string, ...args: unknown[]) => {
      sent = { event, payload: args[0] };
    },
    preparedReader(storyId, prepared.args[0]),
    storyId,
    { dualMode, trigger: "bulk" },
  );
  if (!sent) {
    throw new Error("requestStoryCheck emitted nothing — the check request was never sent.");
  }
  await channel.emit(sent.event, sent.payload);

  const reply = await channel.waitFor({
    match: (e) =>
      (e.type === EVENTS.DriftReport && reportStoryId(e) === storyId) ||
      (e.type === EVENTS.DriftError && errorStoryId(e) === storyId),
    timeoutMs: reportTimeoutMs,
    describe: `a drift report for "${storyId}"`,
  });
  if (reply.type === EVENTS.DriftError) {
    const payload = (reply.args[0] ?? {}) as { message?: string };
    throw new Error(payload.message ?? "The addon server reported an error with no message.");
  }
  const payload = (reply.args[0] ?? {}) as { report?: DriftReport };
  if (!payload.report) throw new Error("The addon server sent a drift report with no report in it.");
  return payload.report;
}

function preparedId(event: BridgeEvent): string | undefined {
  const payload = event.args[0] as { id?: string } | undefined;
  return payload?.id;
}

function reportStoryId(event: BridgeEvent): string | undefined {
  const payload = event.args[0] as { report?: { storyId?: string } } | undefined;
  return payload?.report?.storyId;
}

function errorStoryId(event: BridgeEvent): string | undefined {
  const payload = event.args[0] as { storyId?: string } | undefined;
  return payload?.storyId;
}

/**
 * Whether an event means the awaited render is never happening, and what to say.
 *
 * `storyMissing` is the one worth wording carefully: it is the headless
 * equivalent of a story id that the panel would simply never navigate to, and
 * the cause is almost always a registry entry whose id no longer matches the
 * code — which `design-sync audit` names precisely.
 */
export function renderFailure(event: BridgeEvent, storyId: string): string | undefined {
  const payload = event.args[0] as { message?: string; name?: string } | undefined;
  if (event.type === STORY_MISSING) {
    return (
      `Storybook has no story with id "${storyId}". The registry binds it, so either the story was ` +
      `renamed or its id is wrong — run \`design-sync audit\` to see which.`
    );
  }
  if (event.type === STORY_ERRORED || event.type === STORY_THREW_EXCEPTION) {
    return `Story "${storyId}" failed to render: ${payload?.message ?? "no message"}`;
  }
  if (event.type === CONFIG_ERROR) {
    return `Storybook's preview config failed to load: ${payload?.message ?? "no message"}`;
  }
  return undefined;
}

/* ------------------------------------------------------------------------- *
 * Selection
 * ------------------------------------------------------------------------- */

export interface StorySelection {
  /** `--story <id>`, repeatable. Exact ids. */
  stories: string[];
  /** `--component <name>`, repeatable. Matched against the story id's component. */
  components: string[];
}

export interface SelectionResult {
  selected: RegisteredStoryEntry[];
  /** `--story` ids the registry does not bind. Reported, never skipped quietly. */
  unknownStories: string[];
  /** `--component` names nothing registered answers to. */
  unknownComponents: string[];
}

/**
 * Apply `--story` / `--component` to the registry listing.
 *
 * A filter that matched nothing is returned as such rather than folded into an
 * empty result: `check --story typo-here` exiting 0 over zero stories would be
 * the purest form of a green that means nothing.
 */
export function selectStories(
  registered: readonly RegisteredStoryEntry[],
  selection: StorySelection,
): SelectionResult {
  const wantStories = new Set(selection.stories);
  const wantComponents = new Set(selection.components.map((c) => c.toLowerCase()));
  const unknownStories = selection.stories.filter(
    (id) => !registered.some((entry) => entry.storyId === id),
  );
  const unknownComponents = [...wantComponents].filter(
    (name) => !registered.some((entry) => componentNameFromStoryId(entry.storyId).toLowerCase() === name),
  );
  if (wantStories.size === 0 && wantComponents.size === 0) {
    return { selected: [...registered], unknownStories, unknownComponents };
  }
  const selected = registered.filter(
    (entry) =>
      wantStories.has(entry.storyId) ||
      wantComponents.has(componentNameFromStoryId(entry.storyId).toLowerCase()),
  );
  return { selected, unknownStories, unknownComponents };
}

/* ------------------------------------------------------------------------- *
 * The run
 * ------------------------------------------------------------------------- */

export interface HeadlessRunResult {
  outcomes: Array<BulkStoryOutcome<DriftReport>>;
  warm: WarmOutcome;
  fileKey: string;
  /** Story id → Figma node id, as the registry binds them. */
  nodeIds: Record<string, string>;
  /** What the running Storybook process reports about itself. */
  server: Awaited<ReturnType<typeof readServerConfig>>;
  startedAt: number;
  finishedAt: number;
}

export interface HeadlessRunOptions {
  driver: HeadlessDriver;
  baseUrl: string;
  selection: StorySelection;
  dualMode: boolean;
  /** Override the shared per-story budget. Defaults to `bulkBudgetMs(dualMode)`. */
  budgetMs?: number;
  channel?: HeadlessChannel;
  now?: () => number;
  onStoryStart?: (index: number, storyId: string, total: number) => void;
  onStoryDone?: (index: number, outcome: BulkStoryOutcome<DriftReport>, total: number) => void;
  onSelection?: (result: SelectionResult) => void;
  onWarmed?: (outcome: WarmOutcome) => void;
  onServer?: (server: Awaited<ReturnType<typeof readServerConfig>>) => void;
}

/**
 * Thrown for conditions that mean the check never got to compare anything: an
 * unreachable Storybook, a registry with no usable bindings, a filter that
 * matched nothing. Distinct from a story that failed, because it maps to a
 * different exit code — "I could not run" is not "I ran and found gaps".
 */
export class HeadlessSetupError extends Error {}

export async function runHeadlessCheck(opts: HeadlessRunOptions): Promise<HeadlessRunResult> {
  const now = opts.now ?? (() => Date.now());
  const channel = opts.channel ?? new HeadlessChannel(opts.driver);
  const startedAt = now();

  // First load: no story, because the registry listing needs only the channel.
  // Loading a story here would mean guessing which one before we know the list.
  await opts.driver.navigate(previewUrl(opts.baseUrl));
  channel.reset();

  const server = await readServerConfig(channel);
  opts.onServer?.(server);

  const listing = await listRegisteredStories(channel);
  if (listing.stories.length === 0) {
    throw new HeadlessSetupError(
      "No stories are registered with a Figma node — every registry entry is a pending stub or the " +
        "registry is empty. Run `design-sync audit` to see what is bound.",
    );
  }
  const selection = selectStories(listing.stories, opts.selection);
  opts.onSelection?.(selection);
  if (selection.unknownStories.length > 0) {
    throw new HeadlessSetupError(
      `Not registered with a Figma node: ${selection.unknownStories.join(", ")}. ` +
        "Nothing was checked, because a filter that matches nothing must not report a pass.",
    );
  }
  if (selection.unknownComponents.length > 0) {
    throw new HeadlessSetupError(
      `No registered story belongs to component(s): ${selection.unknownComponents.join(", ")}. ` +
        "Nothing was checked, because a filter that matches nothing must not report a pass.",
    );
  }
  if (selection.selected.length === 0) {
    throw new HeadlessSetupError("The story selection is empty — nothing to check.");
  }

  const storyIds = selection.selected.map((entry) => entry.storyId);

  // Second load, on the first targeted story. Re-loading (rather than switching
  // stories from the bare preview) keeps every story in the run reached the same
  // way: the first is rendered by the page load, the rest by `setCurrentStory`.
  await opts.driver.navigate(previewUrl(opts.baseUrl, storyIds[0]));
  channel.reset();
  let first = true;

  let warm: WarmOutcome = { ms: 0 };
  const outcomes = await runBulkCheck<DriftReport>({
    storyIds,
    warm: () => warmSharedCaches(channel, WARM_BUDGET_MS, now),
    check: (storyId) => {
      const alreadyCurrent = first;
      first = false;
      return checkStoryHeadless({ channel, storyId, dualMode: opts.dualMode, alreadyCurrent });
    },
    budgetMs: opts.budgetMs ?? bulkBudgetMs(opts.dualMode),
    onWarmed: (outcome) => {
      warm = outcome;
      opts.onWarmed?.(outcome);
    },
    onStoryStart: (i, storyId) => opts.onStoryStart?.(i, storyId, storyIds.length),
    onStoryDone: (i, outcome) => opts.onStoryDone?.(i, outcome, storyIds.length),
    now,
  });

  const nodeIds: Record<string, string> = {};
  for (const entry of selection.selected) nodeIds[entry.storyId] = entry.nodeId;

  return {
    outcomes,
    warm,
    fileKey: listing.fileKey || server.fileKey,
    nodeIds,
    server,
    startedAt,
    finishedAt: now(),
  };
}
