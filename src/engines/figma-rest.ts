import type {
  CheckDriftInput,
  ChildTarget,
  CodeSnapshot,
  Engine,
  EngineContext,
  EngineFactory,
} from "./types.js";
import type {
  ChildBindingReport,
  DimensionDiff,
  DriftReport,
  ModeAwareValue,
  NameDivergenceKind,
} from "../dimensions/types.js";
import { formatChildProblem } from "../child-bindings.js";
import {
  matchTokenNames,
  aliasSignature,
  type NameMatchVia,
  type TokenAliasMap,
} from "../token-aliases.js";
import { divergenceNote, nameDivergenceStatus } from "../binding-divergence.js";
import { variantSetRowApplicable } from "../row-triage.js";
import { isTextOwnedProperty, ownsRenderedText } from "../applicability.js";
import { PersistentCache } from "../cache.js";
import { isTransparentColor, normalizeColor } from "./color-normalize.js";
import {
  figmaEffectsToShadows,
  formatShadows,
  parseCssBoxShadow,
  shadowsEqual,
  type FigmaEffect,
} from "./box-shadow.js";
import { layoutRows } from "./layout.js";
import { textStyleRows, type FigmaTypeStyle } from "./text-style-map.js";
import {
  componentPropertyRows,
  type FigmaComponentPropertyDefinition,
  type FigmaComponentPropertyValue,
} from "./component-properties.js";
import {
  allPaintsHiddenNote,
  hiddenPaintsSkippedNote,
  isHiddenNode,
  partialOpacityNote,
  pickVisiblePaint,
  type PaintKindWord,
  type PaintSelection,
} from "./paint-visibility.js";
import {
  FigmaRateLimitError,
  describeFetchFailure,
  isRateLimitError,
  isRetryableStatus,
  parseRetryAfter,
  retryDecision,
} from "./rate-limit.js";

const FIGMA_API = "https://api.figma.com/v1";

/**
 * The two top-level file fields the addon reads. `lastModified` is the cache
 * invalidator; `version` is the revision id a fix prompt cites so its reader can
 * tell whether the file has moved since the read (#76).
 */
interface FileMeta {
  lastModified: string;
  version?: string;
}

/**
 * What a failed (or swallowed) metadata fetch returns. An empty `lastModified`
 * already means "skip the persistent cache" everywhere it is consulted, and an
 * absent `version` means the prompt says the version was not recorded rather than
 * printing something invented.
 */
const EMPTY_FILE_META: FileMeta = { lastModified: "" };

interface FigmaNodesResponse {
  nodes: Record<
    string,
    { document: FigmaNode; styles?: Record<string, FigmaStyleMeta> } | null
  >;
}

/**
 * Why one requested node produced nothing.
 *
 *  - `"fetch-failed"` — Figma could not be read (429, 5xx, network). No
 *    comparison happened and the next attempt may well succeed, so a report
 *    containing one of these is `incomplete`: not cached, not counted as checked.
 *  - `"absent"` — Figma answered and the id is not in the file. A stable finding
 *    about the registry, not a hole in the run.
 *
 * Issue #73 was the two being indistinguishable at this boundary.
 */
interface NodeFailure {
  kind: "fetch-failed" | "absent";
  detail: string;
  retryAfterMs?: number;
  rateLimited?: boolean;
}

/**
 * One entry of the `styles` map that `GET /files/:key/nodes` returns *alongside*
 * each requested node's `document` — style id → metadata. This is the only place
 * a shared style's **name** is available; the node tree carries the id only.
 *
 * What it does NOT carry is the style's paint definition. It doesn't need to:
 * Figma inlines the style's resolved paint into the node's own `fills`, variable
 * binding included, so the indirection is already followed for us. Verified
 * against the live SDS file (`Nq23XwGfazYZZZ5vr8OezI`): the Card's Image
 * placeholder carries `styles: {fill, fills} → "293:27519"` **and**
 * `fills[0].boundVariables.color → Slate/200` **and** a top-level
 * `boundVariables.fills`. `GET /files/:key/styles` adds nothing here — same
 * metadata, no paint. So no extra request is made, and none is needed.
 */
interface FigmaStyleMeta {
  key?: string;
  name?: string;
  styleType?: string;
  description?: string;
}

/**
 * Where the per-node `styles` map is parked on the document so the diff methods
 * can name a style without a second request. Non-standard field on a
 * Figma-shaped object, hence the prefix; `FigmaNode`'s index signature carries
 * it, and `mergeInheritedBindings` spreads the variant so it survives.
 */
const STYLE_META_KEY = "__designSyncStyleMeta";

/** Attach the response's style metadata to the document it describes. */
function withStyleMeta(
  document: FigmaNode,
  styles: Record<string, FigmaStyleMeta> | undefined,
): FigmaNode {
  if (!styles || Object.keys(styles).length === 0) return document;
  (document as Record<string, unknown>)[STYLE_META_KEY] = styles;
  return document;
}

/**
 * The shared style delivering this node's fill, when one does.
 *
 * Figma writes both `styles.fill` and `styles.fills` for a paint style (the
 * live file carries both), so either spelling counts. Returns the style's name
 * when the response's metadata map is present, else its raw id — an id is a
 * worse answer than a name but it is still the truth, and it is never presented
 * as a token.
 *
 * `root` is the node the response was keyed by, which is where the metadata map
 * is parked. It differs from `node` when the paint belongs to a TEXT descendant
 * of the fetched node.
 */
function fillStyleName(node: FigmaNode, root: FigmaNode = node): string | undefined {
  const styles = node.styles as Record<string, string> | undefined;
  const id = styles?.["fill"] ?? styles?.["fills"];
  if (!id) return undefined;
  const meta = (root as Record<string, unknown>)[STYLE_META_KEY] as
    | Record<string, FigmaStyleMeta>
    | undefined;
  return meta?.[id]?.name ?? id;
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  boundVariables?: Record<string, FigmaVariableAlias | FigmaVariableAlias[]>;
  fills?: FigmaPaint[];
  // Variant info shows up on COMPONENT (instance variant props) or COMPONENT_SET.
  componentPropertyDefinitions?: Record<string, FigmaComponentPropertyDefinition>;
  /** Actual property values — INSTANCE nodes only. */
  componentProperties?: Record<string, FigmaComponentPropertyValue>;
  variantProperties?: Record<string, string>;
  children?: FigmaNode[];
  [key: string]: unknown;
}

interface FigmaPaint {
  type: string;
  color?: { r: number; g: number; b: number; a?: number };
  /**
   * Optional, default `true`. Read only through `paint-visibility.ts` — a paint
   * this is `false` on does not render, and reading it as the element's colour
   * was issue #85.
   */
  visible?: boolean;
  opacity?: number;
  boundVariables?: Record<string, FigmaVariableAlias>;
}

interface FigmaVariableAlias {
  type: "VARIABLE_ALIAS";
  id: string;
}

interface FigmaLocalVariablesResponse {
  meta: {
    variables: Record<string, FigmaVariable>;
    variableCollections: Record<string, FigmaVariableCollection>;
  };
}

interface FigmaVariable {
  id: string;
  name: string;
  resolvedType: "FLOAT" | "COLOR" | "STRING" | "BOOLEAN";
  variableCollectionId: string;
  valuesByMode: Record<string, unknown>;
  /**
   * Per-platform code name a designer sets on the variable (#93). Returned by
   * `/variables/local`, which this engine already calls — the field was simply
   * being parsed away.
   *
   * On the reference file 356 of 361 variables populate `WEB`, uniformly as
   * `var(--name)`. See `code-syntax.ts` for why a value here is authoritative
   * only when the project also declares that property.
   */
  codeSyntax?: { WEB?: string } | undefined;
}

interface FigmaVariableCollection {
  id: string;
  name: string;
  modes: { modeId: string; name: string }[];
  defaultModeId: string;
}

/**
 * Tiny TTL cache. Process-lifetime by default; entries expire after `ttlMs`.
 * Used to amortize Figma REST calls across a bulk drift check (86 stories
 * pointing at the same Figma file should not re-fetch variables 86 times).
 */
class TtlCache<V> {
  private readonly store = new Map<string, { value: V; expires: number }>();
  hits = 0;
  misses = 0;
  constructor(private readonly ttlMs: number) {}
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry || entry.expires < Date.now()) {
      if (entry) this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }
  set(key: string, value: V): void {
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
  }
  /**
   * Drop an entry. Deliberately NOT a counter event: the next `get` records the
   * miss and the fetch that follows records itself, so the panel's hit/miss
   * numbers keep describing real HTTP traffic. Those counters were the
   * diagnostic that made the stale-`match` bug findable.
   */
  delete(key: string): void {
    this.store.delete(key);
  }
  /** Drop every entry whose key matches — node keys are `${fileKey}:${nodeId}`. */
  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.store.keys()]) {
      if (predicate(key)) this.store.delete(key);
    }
  }
}

/**
 * Bounded-concurrency + 429-aware fetcher. A bulk Check-all run fires
 * one node request per (story × mode), which on a 64-story file is
 * 128 parallel `GET /files/.../nodes?ids=` — well past Figma's
 * rate ceiling. Without throttling, half the report comes back as
 * 429s instead of drift.
 *
 * Strategy:
 *   - Cap in-flight requests at MAX_CONCURRENT (4).
 *   - On 429 or 5xx, honor `Retry-After` (or fall back to a capped
 *     exponential backoff with jitter), retry up to MAX_RETRIES (3).
 *   - **Bound the total sleeping** per request. Beyond that, throw a
 *     `FigmaRateLimitError` carrying the wait Figma asked for.
 *
 * The last rule is issue #74. Four attempts each honouring a 30s `Retry-After`
 * is over 90 seconds in which this function knows exactly what is wrong and
 * says nothing; the per-story check that a reviewer reaches for was the one path
 * with no ceiling on it, so it sat in "Checking…" indefinitely. The policy —
 * including the "would this wait push us over budget?" decision — lives in
 * `rate-limit.ts` where it is unit-tested.
 */
const MAX_CONCURRENT = 4;

let inflight = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (inflight < MAX_CONCURRENT) {
    inflight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      inflight++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  inflight--;
  const next = waiters.shift();
  if (next) next();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * `what` names the thing being fetched ("node 2142:11381", "file variables") so a
 * rate-limit refusal can say which read failed. Purely for wording.
 */
async function throttledFetch(
  url: string,
  init: RequestInit,
  what?: string,
): Promise<Response> {
  let spentBackoffMs = 0;
  for (let attempt = 0; ; attempt++) {
    await acquireSlot();
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      releaseSlot();
      const decision = retryDecision({ attempt, retryAfterMs: null, spentBackoffMs });
      if (decision.action === "give-up") throw err;
      spentBackoffMs += decision.waitMs;
      await sleep(decision.waitMs);
      continue;
    }
    releaseSlot();

    if (!isRetryableStatus(res.status)) return res;

    const retryAfterMs = parseRetryAfter(res.headers?.get?.("Retry-After") ?? null);
    const decision = retryDecision({ attempt, retryAfterMs, spentBackoffMs });
    if (decision.action === "give-up") {
      // The status is knowable, the wait is knowable, and waiting it out is what
      // produced a silent 90-second stall. Fail with both (#74).
      throw new FigmaRateLimitError({
        status: res.status,
        retryAfterMs,
        ...(what ? { what } : {}),
      });
    }
    spentBackoffMs += decision.waitMs;
    await sleep(decision.waitMs);
  }
}

class FigmaRestEngine implements Engine {
  readonly name = "figma-rest";
  private readonly pat: string | undefined;
  /** Cache of `node_id → containing_frame.nodeId` per fileKey. */
  private readonly parentMaps = new Map<string, Map<string, string>>();
  /**
   * Variables, cached for 5 min. The TTL exists for **bulk** runs, where one
   * fetch serving ~90 stories is the difference between a working Check-all and
   * a wall of 429s.
   *
   * It is NOT a claim that variables are stable: this comment used to read
   * "variables are stable for the lifetime of a working session", and a designer
   * changing a token value mid-session is precisely what this tool exists to
   * detect. Combined with the engine memoization added in v0.0.28 (which turned
   * these per-check caches into cross-check ones), that premise gave the panel a
   * five-minute window in which it confidently reported `match` against values
   * that had changed. An explicit Check drift now drops this entry before
   * reading — see `revalidateBeforeExplicitCheck`.
   */
  private readonly variablesCache = new TtlCache<FigmaLocalVariablesResponse>(5 * 60_000);
  /**
   * Per-node fetches are cached for 30s — long enough that a bulk run
   * fully benefits, short enough that single-story checks against a node
   * the user just modified pick up the change.
   */
  private readonly nodeCache = new TtlCache<FigmaNode>(30_000);
  /**
   * File metadata (`lastModified` + `version`) — 60s TTL. `lastModified` drives
   * cross-restart cache invalidation; `version` is stamped onto the report so a
   * fix prompt can say which revision of the file it read (#76).
   */
  private readonly fileMetaCache = new TtlCache<FileMeta>(60_000);
  /**
   * The `lastModified` we last saw per fileKey. When it moves, every artefact
   * cached for that file is suspect and gets dropped — a cheap truth signal is a
   * better invalidator than a timer.
   */
  private readonly lastSeenModified = new Map<string, string>();
  /** The user action whose explicit revalidation we already performed. */
  private lastRevalidatedCheckId: string | undefined;
  /** Persistent on-disk cache (gitignored sidecar). Optional. */
  private readonly persistentCache: PersistentCache | null;

  constructor(ctx: EngineContext) {
    this.pat = ctx.figmaPat;
    this.persistentCache = ctx.cachePath ? new PersistentCache(ctx.cachePath) : null;
  }

  async checkDrift(input: CheckDriftInput): Promise<DriftReport> {
    if (!this.pat) {
      throw new Error(
        "[design-sync] FIGMA_PAT env var is not set; cannot call Figma REST.",
      );
    }
    const { fileKey, nodeId } = input.nodeRef;
    const startedAt = Date.now();
    const hitsBefore = this.variablesCache.hits + this.nodeCache.hits;
    const missesBefore = this.variablesCache.misses + this.nodeCache.misses;

    // A deliberate Check drift is a request for the truth, so it never reads
    // Figma out of a timer-backed cache. A bulk run keeps its caches — that is
    // what makes ~90 stories affordable.
    const explicit = input.trigger !== "bulk";
    if (explicit) {
      await this.revalidateBeforeExplicitCheck(fileKey, input.checkId);
    } else {
      await this.dropCachesIfFileChanged(fileKey);
    }

    // Persistent-cache short-circuit. Cheap path: fetch only file metadata
    // (one tiny HTTP call, cached for 60s) and check whether the cached
    // report is still valid for this story + snapshot. Hit → return
    // immediately, no node/variables fetch, no engine work.
    //
    // Skipped for an explicit check: the entry is keyed on the file's
    // `lastModified`, so it can only be trusted to the same degree that signal
    // can, and the whole point of the click is not to trust a timestamp. Bulk
    // runs (and cold starts after a restart) still get the full benefit, and an
    // explicit check still *writes* the cache below.
    // Loaded either way: an explicit check skips the *read* but still writes,
    // and writing without having loaded would drop every other story's entry.
    // The alias map is part of what produced a report's verdicts, so it is part
    // of the cache identity: adding the alias that turns 89 false drift rows into
    // advisories must not leave a bulk run replaying the pre-alias report.
    const aliases: TokenAliasMap = input.tokenAliases ?? {};
    // Config that changes a report's VERDICTS is part of the cache identity, not
    // just its inputs: nothing in the Figma file or the DOM moves when someone
    // edits `design-sync.config.json`. `tokenAliases` joined in v0.0.38; the copy
    // gate joins here, because turning `copy` off must not leave every cached entry
    // replaying the rows it was turned off to stop producing (#63).
    const configKey = [
      aliasSignature(aliases),
      input.compareCopy === false ? "copy:off" : "",
    ]
      .filter(Boolean)
      .join("|");

    if (this.persistentCache) await this.persistentCache.load();
    if (this.persistentCache && !explicit) {
      const meta = await this.fetchFileMeta(fileKey).catch(() => EMPTY_FILE_META);
      const cached = this.persistentCache.get(
        input.storyId,
        meta.lastModified,
        input.snapshot,
        input.children,
        configKey,
      );
      if (cached) {
        return {
          ...cached,
          generatedAt: new Date().toISOString(),
          // `generatedAt` restamps — that is what the panel's "last checked" line
          // means. `source` MUST NOT: these values came out of a file on disk, and
          // the read they describe happened whenever it happened (#76). Restamping
          // it here would hand a fix prompt a two-day-old reading wearing today's
          // timestamp, which is precisely the failure the field exists to prevent.
          // A cache written before this field existed carries none, and "unknown"
          // is then the honest answer — not now.
          ...(cached.source ? { source: { ...cached.source, fromCache: true } } : {}),
          timing: {
            totalMs: Date.now() - startedAt,
            figmaFetchMs: 0,
            cacheHits: 1,
            cacheMisses: 0,
          },
        };
      }
    }

    const figmaT0 = Date.now();
    // Read alongside the node so the report can say WHICH revision of the file it
    // was read from (#76). It is one small request, already 60s-cached and already
    // made on the cache path, so a bulk run pays nothing extra for it.
    const fileMeta = await this.fetchFileMeta(fileKey).catch(() => EMPTY_FILE_META);
    const node = await this.fetchNodeWithInheritedBindings(fileKey, nodeId);
    // A variables fetch that FAILED and one that legitimately returns nothing
    // (a non-Enterprise file, 403/404 — handled inside `fetchLocalVariables`)
    // both arrive here as `null`, and the consequence is the same either way:
    // every token-bound property resolves to no Figma value, so nothing can
    // drift. That is fine when the file has no variables to read and a lie when
    // we were rate-limited out of reading them — every row silently degrades to
    // flag-only and the story reports zero drift. So the failure is kept.
    let variables: FigmaLocalVariablesResponse | null = null;
    let variablesFailure: unknown;
    try {
      variables = await this.fetchLocalVariables(fileKey);
    } catch (err: unknown) {
      variablesFailure = err;
    }
    const figmaFetchMs = Date.now() - figmaT0;

    const dimensions: DimensionDiff[] = [];
    const snapshot = input.snapshot;
    const activeMode = input.mode;

    // props runs first so the variant-set check can see whether the same axes
    // were already compared against the story args (in which case its own,
    // weaker class-based comparison has nothing to add). Push order below is
    // unchanged — the panel's row order is not affected.
    const propsDiffs = this.diffProps(node, input.args);

    // Values first, and kept: the binding diff needs them to tell a name-only
    // divergence (advisory) from a genuine defect (drift). See issue #57.
    const valueDiffs = this.diffTokenValues(node, snapshot, variables, activeMode);
    dimensions.push(...valueDiffs);
    dimensions.push(
      ...this.diffTokenBindings(node, snapshot, variables, activeMode, { aliases, valueDiffs }),
    );
    dimensions.push(...this.diffVariantSet(node, snapshot, input.storyId, propsDiffs));
    // `copy` is the one dimension whose applicability the addon cannot decide for
    // itself: Figma has no way to mark a string as placeholder text, so the
    // consumer declares it (`"copy": "off"` project-wide, or
    // `parameters.designSync.compareCopy: false` per story). Off means NO rows —
    // an empty row with its verdict withheld is the bug fixed in v0.0.29. See #63.
    if (input.compareCopy !== false) {
      dimensions.push(...this.diffCopy(node, snapshot));
    }
    dimensions.push(...propsDiffs);
    // `structure` — Figma auto-layout vs computed CSS layout. Emits nothing
    // unless BOTH sides are laying out children (see `layout.ts`), which is why
    // it can be shown at all.
    dimensions.push(...layoutRows(node, snapshot?.styles));

    // Declared child bindings. Nothing runs — and no `children` field appears on
    // the report — when the registry entry has no `children` key, which is what
    // keeps legacy entries byte-identical.
    let childReports: ChildBindingReport[] | undefined;
    let childFetchFailures: Array<{ selector: string; failure: NodeFailure }> = [];
    if (input.children && input.children.length > 0) {
      const outcome = await this.diffChildren(
        {
          fileKey,
          storyId: input.storyId,
          registryPath: input.registryPath ?? ".design-sync/registry.json",
        },
        input.children,
        variables,
        activeMode,
        aliases,
        input.compareCopy !== false,
      );
      dimensions.push(...outcome.dimensions);
      childReports = outcome.reports;
      childFetchFailures = outcome.fetchFailures;
    }

    // Reserved kinds — engine fills as flag-only placeholders. `structure` left
    // this list in v0.0.39: it now emits real comparisons (see `layoutRows`
    // above), and a placeholder alongside them would be a row claiming the
    // dimension does nothing.
    dimensions.push(this.placeholder("motion", "story.motion"));

    const report: DriftReport = {
      storyId: input.storyId,
      nodeId,
      dimensions,
      generatedAt: new Date().toISOString(),
      // The provenance of the values above. `readAt` is when the Figma fetch
      // STARTED, not when this object was assembled: the two differ by the length
      // of the fetch, and the earlier one is the one an applier must distrust.
      source: {
        readAt: new Date(figmaT0).toISOString(),
        ...(fileMeta.lastModified ? { fileLastModified: fileMeta.lastModified } : {}),
        ...(fileMeta.version ? { fileVersion: fileMeta.version } : {}),
      },
      timing: {
        totalMs: Date.now() - startedAt,
        figmaFetchMs,
        cacheHits: this.variablesCache.hits + this.nodeCache.hits - hitsBefore,
        cacheMisses: this.variablesCache.misses + this.nodeCache.misses - missesBefore,
      },
    };
    if (activeMode) report.mode = activeMode;
    if (childReports) report.children = childReports;

    // Anything this report claims to cover that could not be READ. Set before the
    // cache write, because the cache's refusal is keyed on it (#73).
    const incomplete = summarizeIncomplete(childFetchFailures, variablesFailure);
    if (incomplete) report.incomplete = incomplete;

    // Stash for future short-circuits. `set` refuses an incomplete report, so a
    // rate-limited run is retried next time instead of replayed.
    if (this.persistentCache) {
      const fileLastModified = fileMeta.lastModified;
      if (fileLastModified) {
        this.persistentCache.set(
          input.storyId,
          fileLastModified,
          input.snapshot,
          report,
          input.children,
          configKey,
        );
      }
      // Cache bookkeeping worth saying out loud: entries discarded on a version
      // mismatch (silence there looks exactly like a cold run — #62) and a refusal
      // to persist this report (#73).
      const status = this.persistentCache.status();
      if (status.discardedByVersion > 0 || status.notPersisted !== undefined) {
        report.cacheStatus = {
          ...(status.discardedByVersion > 0
            ? { discardedByVersion: status.discardedByVersion }
            : {}),
          ...(status.notPersisted !== undefined ? { notPersisted: status.notPersisted } : {}),
        };
      }
    }

    return report;
  }

  /**
   * Pre-fetch everything a **Check all** run shares: the file's `lastModified`
   * (one tiny request, and the invalidator every story's cache lookup consults)
   * and the file's local variables (the big one — every resolved token value in
   * every story comes out of it).
   *
   * Issue #56: on a cold run this work happened inside the *first story's* 8s
   * budget. Live numbers: `ui-button--primary` 8016ms ✗ timed out, then
   * `ui-button--primary-small` 1959ms ✓, `ui-button--primary-disabled` 1130ms ✓.
   * The first story wasn't slow — it was paying for the other nine. Hoisted here,
   * it is charged to the run, and each story's budget covers only its own work.
   *
   * Never throws. A warm-up that fails (no PAT, 403, network) leaves the caches
   * cold and the per-story path fetches exactly as it did before; the run is
   * slower, not wrong.
   */
  async warm(fileKey: string): Promise<void> {
    if (!this.pat) return;
    await this.dropCachesIfFileChanged(fileKey).catch(() => undefined);
    await this.fetchLocalVariables(fileKey).catch(() => null);
  }

  /* ---- cache freshness ---------------------------------------------------- *
   *
   * Two mechanisms, and both are needed:
   *
   *  (a) **Revalidate on a cheap truth signal.** The file's `lastModified` is one
   *      small request. When it moves, everything cached for that file is
   *      suspect and gets dropped. This is strictly better than a timer, and it
   *      is what keeps a long bulk run honest without re-fetching per story.
   *
   *  (b) **Bypass on an explicit check.** (a) is only as good as its signal, and
   *      we have NOT verified against live Figma that editing a *variable value*
   *      (as opposed to a node) bumps the consuming file's `lastModified` — a
   *      published-library value in particular may not, until the update is
   *      accepted in the file. So an explicit Check drift drops this file's
   *      variables and nodes unconditionally rather than asking a timestamp for
   *      permission. This is the mechanism the correctness guarantee rests on;
   *      (a) is the optimisation that extends some of it to bulk runs.
   */

  /** Drop every in-memory artefact cached for one file. */
  private invalidateFile(fileKey: string): void {
    this.variablesCache.delete(fileKey);
    this.nodeCache.deleteWhere((key) => key.startsWith(`${fileKey}:`));
    this.parentMaps.delete(fileKey);
  }

  /**
   * (a) — compare the file's `lastModified` against the last one we saw and drop
   * this file's caches when it moved. Uses the 60s-cached metadata value, so a
   * bulk run pays at most one extra request per minute and still shares a single
   * variables fetch for the run.
   */
  private async dropCachesIfFileChanged(fileKey: string): Promise<void> {
    const current = await this.fetchFileLastModified(fileKey).catch(() => "");
    if (!current) return;
    const previous = this.lastSeenModified.get(fileKey);
    this.lastSeenModified.set(fileKey, current);
    if (previous !== undefined && previous !== current) this.invalidateFile(fileKey);
  }

  /**
   * (b) — prepare for a user-initiated check: re-read `lastModified` with its own
   * cache bypassed, then drop this file's variables and nodes regardless of what
   * it says.
   *
   * Runs **once per user action**: a dual-mode check calls `checkDrift` twice for
   * one press, and invalidating between the two passes would double the request
   * count for no gain (nothing can have changed between them). Callers that pass
   * no `checkId` are treated as a fresh action — correctness over speed.
   */
  private async revalidateBeforeExplicitCheck(
    fileKey: string,
    checkId: string | undefined,
  ): Promise<void> {
    if (checkId !== undefined && checkId === this.lastRevalidatedCheckId) return;
    this.lastRevalidatedCheckId = checkId;
    this.fileMetaCache.delete(fileKey);
    await this.dropCachesIfFileChanged(fileKey);
    this.invalidateFile(fileKey);
  }

  /**
   * Fetch the file's metadata via the lightest possible call. `depth=1` keeps the
   * response small; only the top-level fields are needed. Cached in-process for
   * 60s — bulk runs share one fetch.
   *
   * Both fields, not just `lastModified`. `lastModified` is the cache invalidator
   * it always was; `version` is the identity a fix prompt cites so the applier can
   * tell whether the file it is re-reading is the one the prompt described (#76).
   * They come from the same response, so recording the second costs nothing.
   */
  private async fetchFileMeta(fileKey: string): Promise<FileMeta> {
    const cached = this.fileMetaCache.get(fileKey);
    if (cached) return cached;
    const url = `${FIGMA_API}/files/${encodeURIComponent(fileKey)}?depth=1`;
    const res = await throttledFetch(url, { headers: this.headers() });
    if (!res.ok) {
      // Swallow — without a metadata fetch we just skip the persistent cache.
      return EMPTY_FILE_META;
    }
    const data = (await res.json()) as { lastModified?: string; version?: string };
    const meta: FileMeta = {
      lastModified: data.lastModified ?? "",
      ...(typeof data.version === "string" && data.version !== ""
        ? { version: data.version }
        : {}),
    };
    if (meta.lastModified) this.fileMetaCache.set(fileKey, meta);
    return meta;
  }

  /** The invalidator on its own, for the call sites that only key on it. */
  private async fetchFileLastModified(fileKey: string): Promise<string> {
    return (await this.fetchFileMeta(fileKey)).lastModified;
  }

  // ---- HTTP ---------------------------------------------------------------

  /**
   * Fetch the registered node and, if it is a COMPONENT inside a COMPONENT_SET,
   * merge the parent's `boundVariables` underneath the variant's so inherited
   * padding/radius bindings don't read as `flag-only`. Variant overrides win.
   */
  private async fetchNodeWithInheritedBindings(
    fileKey: string,
    nodeId: string,
  ): Promise<FigmaNode> {
    const node = await this.fetchNode(fileKey, nodeId);
    if (node.type !== "COMPONENT") return node;

    const parents = await this.fetchComponentParentsMap(fileKey).catch(() => null);
    const parentId = parents?.get(nodeId);
    if (!parentId) return node;

    const parent = await this.fetchNode(fileKey, parentId).catch(() => null);
    if (!parent || parent.type !== "COMPONENT_SET") return node;

    return mergeInheritedBindings(node, parent);
  }

  private async fetchNode(fileKey: string, nodeId: string): Promise<FigmaNode> {
    const cacheKey = `${fileKey}:${nodeId}`;
    const cached = this.nodeCache.get(cacheKey);
    if (cached) return cached;

    const url = `${FIGMA_API}/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`;
    const res = await throttledFetch(url, { headers: this.headers() }, `node ${nodeId}`);
    if (!res.ok) {
      throw new Error(`[design-sync] Figma REST ${res.status} for node ${nodeId}.`);
    }
    const data = (await res.json()) as FigmaNodesResponse;
    const entry = data.nodes[nodeId];
    if (!entry) {
      throw new Error(`[design-sync] Figma node ${nodeId} not found in ${fileKey}.`);
    }
    const document = withStyleMeta(entry.document, entry.styles);
    this.nodeCache.set(cacheKey, document);
    return document;
  }

  /**
   * Fetch several nodes in **one** request. `GET /files/:key/nodes` takes a
   * comma-separated `ids` list, so a 3-child component costs exactly one HTTP
   * call, not three — and zero calls when the 30s node cache already holds them
   * (a bulk run re-checking the same story). Goes through `throttledFetch` like
   * every other call, so the concurrency gate and 429 backoff apply unchanged.
   *
   * Ids the response doesn't contain are reported back as unreachable rather
   * than thrown: one bad child binding must not abort the whole report, and it
   * must not vanish either.
   *
   * Each failure carries **why**, and the distinction is load-bearing (issue #73):
   *
   *  - `"fetch-failed"` — we could not read Figma (rate limit, network, HTTP
   *    error). The comparison did not happen and might well succeed next time, so
   *    the report is marked `incomplete`, is not cached, and does not count as a
   *    checked story.
   *  - `"absent"` — Figma answered, and the node genuinely isn't in the file. That
   *    is a finding about the registry, stable across runs, already reported per
   *    child, and legitimately cacheable.
   *
   * Collapsing the two is what let a transient 429 be stored as a permanent green
   * tick.
   */
  private async fetchNodesBatch(
    fileKey: string,
    nodeIds: readonly string[],
  ): Promise<{ nodes: Map<string, FigmaNode>; unreachable: Map<string, NodeFailure> }> {
    const nodes = new Map<string, FigmaNode>();
    const unreachable = new Map<string, NodeFailure>();
    const misses: string[] = [];
    for (const id of new Set(nodeIds)) {
      const cached = this.nodeCache.get(`${fileKey}:${id}`);
      if (cached) nodes.set(id, cached);
      else misses.push(id);
    }
    if (misses.length === 0) return { nodes, unreachable };

    const ids = misses.map((id) => encodeURIComponent(id)).join(",");
    const url = `${FIGMA_API}/files/${encodeURIComponent(fileKey)}/nodes?ids=${ids}`;
    let res: Response;
    try {
      res = await throttledFetch(
        url,
        { headers: this.headers() },
        misses.length === 1 ? `node ${misses[0]}` : `${misses.length} child nodes`,
      );
    } catch (err: unknown) {
      const failure: NodeFailure = {
        kind: "fetch-failed",
        detail: describeFetchFailure(err),
        ...(isRateLimitError(err) && err.retryAfterMs !== null
          ? { retryAfterMs: err.retryAfterMs }
          : {}),
        ...(isRateLimitError(err) ? { rateLimited: true } : {}),
      };
      for (const id of misses) unreachable.set(id, failure);
      return { nodes, unreachable };
    }
    if (!res.ok) {
      for (const id of misses) {
        unreachable.set(id, { kind: "fetch-failed", detail: `Figma REST ${res.status}` });
      }
      return { nodes, unreachable };
    }
    const data = (await res.json()) as FigmaNodesResponse;
    for (const id of misses) {
      const entry = data.nodes?.[id];
      if (entry?.document) {
        const document = withStyleMeta(entry.document, entry.styles);
        this.nodeCache.set(`${fileKey}:${id}`, document);
        nodes.set(id, document);
      } else {
        unreachable.set(id, {
          kind: "absent",
          detail: `no node with that id in file ${fileKey}`,
        });
      }
    }
    return { nodes, unreachable };
  }

  /**
   * Compare each declared child element against its own Figma node, through the
   * same diff methods the root uses — so every CSS property the root supports
   * (padding, radii, borders, gap, the full typography set, shadows, colours)
   * works for a child with no per-property wiring.
   *
   * Two root-only dimensions are deliberately **not** run for children:
   *
   *  - `variant-set` compares Figma variant values against modifier classes.
   *    A child element is not a variant of anything; the check's premise is
   *    structurally false there, and on a child with any class at all it would
   *    emit "code variants not declared in Figma" — a confident signal that
   *    doesn't apply.
   *  - `props` compares Figma component properties against the **story's** args.
   *    Those args describe the component, not its header; matching them against
   *    a child node's (usually absent) properties can only produce noise.
   *
   * Both are reported once, for the root, where they mean something.
   */
  private async diffChildren(
    ctx: { fileKey: string; storyId: string; registryPath: string },
    children: readonly ChildTarget[],
    variables: FigmaLocalVariablesResponse | null,
    activeMode: string | undefined,
    aliases: TokenAliasMap,
    /** Same gate as the root's (#63) — a declared child's copy rows are copy rows. */
    compareCopy: boolean,
  ): Promise<{
    dimensions: DimensionDiff[];
    reports: ChildBindingReport[];
    /** Children whose Figma node could not be READ (not merely absent). */
    fetchFailures: Array<{ selector: string; failure: NodeFailure }>;
  }> {
    const { fileKey } = ctx;
    const dimensions: DimensionDiff[] = [];
    const reports: ChildBindingReport[] = [];
    const fetchFailures: Array<{ selector: string; failure: NodeFailure }> = [];

    const comparable = children.filter((c) => !c.problem && c.snapshot && c.nodeId);
    const { nodes, unreachable } =
      comparable.length > 0
        ? await this.fetchNodesBatch(
            fileKey,
            comparable.map((c) => c.nodeId),
          )
        : { nodes: new Map<string, FigmaNode>(), unreachable: new Map<string, NodeFailure>() };

    for (const child of children) {
      // Resolution already failed upstream (bad selector, no/ambiguous match,
      // malformed registry value). Pass the reason through untouched.
      if (child.problem || !child.snapshot || !child.nodeId) {
        reports.push({
          selector: child.selector,
          nodeId: child.nodeId,
          status: child.problem?.status ?? "snapshot-missing",
          message: child.problem?.message ?? "",
          rowCount: 0,
        });
        continue;
      }
      let node = nodes.get(child.nodeId);
      // A child bound to a nested COMPONENT (an instance of another library
      // component) gets the same COMPONENT_SET inheritance merge the root does,
      // so bindings declared on the parent set don't read as "Figma declares
      // nothing". Costs no extra node request: the batch already warmed the
      // cache `fetchNode` reads from.
      if (node?.type === "COMPONENT") {
        node = await this.fetchNodeWithInheritedBindings(fileKey, child.nodeId).catch(() => node!);
      }
      if (!node) {
        const failure = unreachable.get(child.nodeId);
        if (failure?.kind === "fetch-failed") {
          fetchFailures.push({ selector: child.selector, failure });
        }
        reports.push({
          selector: child.selector,
          nodeId: child.nodeId,
          status: "node-unreachable",
          message: formatChildProblem({
            status: "node-unreachable",
            selector: child.selector,
            storyId: ctx.storyId,
            registryPath: ctx.registryPath,
            nodeId: child.nodeId,
            detail: failure?.detail,
            // A rate limit is not a mis-typed node id, and telling the user to
            // check the id would send them after the wrong thing.
            transient: failure?.kind === "fetch-failed",
          }),
          rowCount: 0,
        });
        continue;
      }

      // Per element, exactly as for the root: this child's own value diffs are
      // what its binding rows are triaged against.
      const childValueDiffs = this.diffTokenValues(node, child.snapshot, variables, activeMode);
      const rows = [
        ...childValueDiffs,
        ...this.diffTokenBindings(node, child.snapshot, variables, activeMode, {
          aliases,
          valueDiffs: childValueDiffs,
        }),
        // Copy is compared for a declared child element, and NOT for a forced
        // state. A CSS pseudo-state cannot change an element's text content, so
        // the state's copy row is byte-identical to the resting one by
        // construction — reporting it again is a second, duplicate finding about
        // one string, and re-states a disagreement the default-state row already
        // made. Observed live: every Button story reported its label drift twice.
        //
        // Layout, by contrast, IS applicable: `:hover` can legitimately change
        // padding or alignment, so it keeps the same comparison and the same
        // applicability guard the root gets.
        ...(compareCopy && child.kind !== "state" ? this.diffCopy(node, child.snapshot) : []),
        ...layoutRows(node, child.snapshot.styles),
      ];
      for (const row of rows) {
        row.childSelector = child.selector;
        // A forced-state target is the same element in a different condition, so
        // the row carries the condition as well as its identity. See
        // `ChildTarget.kind`.
        if (child.kind === "state") row.forcedState = child.selector.replace(/^:/, "");
      }
      dimensions.push(...rows);
      const report: ChildBindingReport = {
        selector: child.selector,
        nodeId: child.nodeId,
        status: "compared",
        rowCount: rows.length,
      };
      if (node.name) report.nodeName = node.name;
      reports.push(report);
    }

    return { dimensions, reports, fetchFailures };
  }

  /**
   * Build a `componentNodeId → containing_frame.nodeId` map from the file's
   * components endpoint. Cached per fileKey.
   *
   * Returns an empty map on 403/404 (e.g. PAT scope insufficient) — callers
   * fall back to no inheritance, which matches v0 behavior.
   */
  private async fetchComponentParentsMap(fileKey: string): Promise<Map<string, string>> {
    const cached = this.parentMaps.get(fileKey);
    if (cached) return cached;
    const url = `${FIGMA_API}/files/${encodeURIComponent(fileKey)}/components`;
    const res = await throttledFetch(url, { headers: this.headers() });
    if (!res.ok) {
      const empty = new Map<string, string>();
      this.parentMaps.set(fileKey, empty);
      return empty;
    }
    const data = (await res.json()) as {
      meta?: { components?: Array<{ node_id: string; containing_frame?: { nodeId?: string } }> };
    };
    const map = new Map<string, string>();
    for (const c of data.meta?.components ?? []) {
      const parent = c.containing_frame?.nodeId;
      if (parent) map.set(c.node_id, parent);
    }
    this.parentMaps.set(fileKey, map);
    return map;
  }

  private async fetchLocalVariables(fileKey: string): Promise<FigmaLocalVariablesResponse | null> {
    const cached = this.variablesCache.get(fileKey);
    if (cached) return cached;

    const url = `${FIGMA_API}/files/${encodeURIComponent(fileKey)}/variables/local`;
    const res = await throttledFetch(url, { headers: this.headers() }, "the file's variables");
    if (res.status === 404 || res.status === 403) return null; // not enterprise / no access
    if (!res.ok) {
      throw new Error(`[design-sync] Figma variables ${res.status} for ${fileKey}.`);
    }
    const data = (await res.json()) as FigmaLocalVariablesResponse;
    this.variablesCache.set(fileKey, data);
    return data;
  }

  private headers(): Record<string, string> {
    return { "X-Figma-Token": this.pat ?? "" };
  }

  // ---- Diff logic ---------------------------------------------------------

  private diffTokenValues(
    node: FigmaNode,
    snapshot: CodeSnapshot | undefined,
    variables: FigmaLocalVariablesResponse | null,
    activeMode?: string,
  ): DimensionDiff[] {
    const out: DimensionDiff[] = [];
    if (!snapshot) return out;

    // Background color: code "background-color" vs Figma fills[0] (resolved).
    //
    // Never on a TEXT node. A TEXT node's fill IS its text colour — Figma has no
    // separate background for one — so comparing it against CSS
    // `background-color` is a category error, and a guaranteed one: the code side
    // reads `rgba(0, 0, 0, 0)` on any text element, so every bound TEXT node
    // reported drift. Live Card, on `[data-slot=title]`: `background-color`
    // rgba(0,0,0,0) vs rgb(30,30,30) → drift, immediately followed by `color`
    // rgb(30,30,30) vs rgb(30,30,30) → match. Same Figma fill, compared twice,
    // right once. The `color` path below is the one that means something.
    if (node.type !== "TEXT") {
      const codeBg = snapshot.styles["background-color"];
      // Which paint renders is a question of its own (#85): the first *visible*
      // one, not `fills[0]`. `paint` carries the answer plus the note that
      // explains a skipped, switched-off or blended paint.
      const paint = readPaint(node.fills, "fill", variables, activeMode);
      const figmaBg = paint.color;
      const fillStyle = fillStyleName(node);
      // Every paint switched off is a fact about the design and belongs in a row —
      // but only when the code paints something, which the first clause already
      // covers. With both sides painting nothing the two agree and a row would be
      // noise.
      if (!isTransparentColor(codeBg) || figmaBg !== undefined || fillStyle !== undefined) {
        const modes = figmaBg?.modes;
        const figmaValue = figmaBg?.value;
        const sourceAdvisory = paintSourceAdvisory({
          styleName: fillStyle,
          variableId: figmaBg?.variableId,
          variables,
        });
        // A shared paint style is Figma stating an opinion. When we can't turn it
        // into a colour (a gradient or image-only style, a paint we can't read),
        // the row has to say the read failed — `flag-only` would claim Figma
        // declares nothing, and `match` on an absent value is the false positive
        // the honesty invariant exists to forbid.
        //
        // Only when a paint actually renders, though: a style whose paints are all
        // switched off was read fine, and its answer is "nothing is painted"
        // (#85). That is the paint note's story to tell, not a failed read's.
        const unreadableStyle =
          figmaBg === undefined && fillStyle !== undefined && paint.selection.kind === "paint";
        const status: DimensionDiff["status"] =
          unreadableStyle || paint.incomparable
            ? "unresolved"
            : colorRowStatus(codeBg, figmaValue);
        const diff: DimensionDiff = {
          kind: "token-value",
          property: "background-color",
          codeValue: codeBg ?? null,
          figmaValue: figmaValue ?? null,
          status,
        };
        if (modes) diff.modes = modes;
        if (figmaBg?.tokenName) diff.tokenName = figmaBg.tokenName;
      // #93 — Figma's own code name, so the prompt can quote it instead of
      // guessing at both halves of the naming.
      if (figmaBg?.codeSyntax) diff.figmaCodeSyntax = figmaBg.codeSyntax;
        if (sourceAdvisory) diff.sourceAdvisory = sourceAdvisory;
        // Paint visibility outranks the paint-style notes: "every paint is off"
        // and "this is the second paint, the first is off" are the facts that
        // decide whether the rest of the row means anything (#85).
        if (paint.note) {
          diff.note = paint.note;
        } else if (unreadableStyle) {
          diff.note =
            `Figma's fill comes from the shared paint style "${fillStyle}", but no colour could be ` +
            `read from it (the paint is not a readable solid), so no comparison was made.`;
        } else if (fillStyle !== undefined && figmaBg?.tokenName === undefined) {
          diff.note =
            `Figma's fill comes from the shared paint style "${fillStyle}", whose paint is not bound ` +
            `to a variable — the design names no token for this colour.`;
        }
        out.push(diff);
      }
    }

    // Numeric Figma boundVariables → resolved float, compared to computed CSS px.
    const numericMap: Array<[string, string]> = [
      ["paddingTop", "padding-top"],
      ["paddingRight", "padding-right"],
      ["paddingBottom", "padding-bottom"],
      ["paddingLeft", "padding-left"],
    ];
    for (const [figmaKey, cssProp] of numericMap) {
      const alias = node.boundVariables?.[figmaKey];
      const aliasObj = Array.isArray(alias) ? alias[0] : alias;
      if (!aliasObj || !variables) continue;
      const v = variables.meta.variables[aliasObj.id];
      if (!v || v.resolvedType !== "FLOAT") continue;
      const figmaPx = resolveNumericForMode(v, variables, activeMode);
      if (figmaPx === null) continue;
      const codeValue = snapshot.styles[cssProp];
      const codePx = parsePx(codeValue);
      const status: DimensionDiff["status"] =
        codePx !== null && Math.abs(codePx - figmaPx) < 0.5 ? "match" : "drift";
      out.push({
        kind: "token-value",
        property: cssProp,
        codeValue: codeValue ?? null,
        figmaValue: `${figmaPx}px (token: ${v.name})`,
        status,
        tokenName: v.name,
        // Figma's own code name for this variable (#93). Preferred over name
        // conversion downstream, and only when the project declares it.
        ...(v.codeSyntax?.WEB !== undefined ? { figmaCodeSyntax: v.codeSyntax.WEB } : {}),
      });
    }

    // Border radius: Figma stores per-corner aliases.
    const radiusKeys: Array<[string, string]> = [
      ["RECTANGLE_TOP_LEFT_CORNER_RADIUS", "border-top-left-radius"],
      ["RECTANGLE_TOP_RIGHT_CORNER_RADIUS", "border-top-right-radius"],
      ["RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", "border-bottom-left-radius"],
      ["RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS", "border-bottom-right-radius"],
    ];
    const corners = node.boundVariables?.rectangleCornerRadii as
      | Record<string, FigmaVariableAlias>
      | undefined;
    // Map cssProp → raw-node-field for the fallback path. Figma surfaces
    // per-corner raw radii under `topLeftRadius` etc. when the node has
    // explicit values, plus the shorthand `cornerRadius` when all four
    // corners share a value. We use these when no variable binding exists.
    const rawCornerFields: Record<string, string> = {
      "border-top-left-radius": "topLeftRadius",
      "border-top-right-radius": "topRightRadius",
      "border-bottom-left-radius": "bottomLeftRadius",
      "border-bottom-right-radius": "bottomRightRadius",
    };

    for (const [figmaKey, cssProp] of radiusKeys) {
      let figmaPx: number | null = null;
      let tokenName: string | undefined;

      // Path 1: variable-bound corner — same as before, carries tokenName
      // so the value-drift Apply path can promote a code literal to var().
      const alias = corners?.[figmaKey];
      if (alias && variables) {
        const v = variables.meta.variables[alias.id];
        if (v && v.resolvedType === "FLOAT") {
          const resolved = resolveNumericForMode(v, variables, activeMode);
          if (resolved !== null) {
            figmaPx = resolved;
            tokenName = v.name;
          }
        }
      }

      // Path 2: raw px — Figma's UI lets you type a value without binding
      // it to a token. Previously we emitted no row in this case, which
      // hid real drift. Now we surface it with the raw figmaValue so the
      // user at least sees the divergence; the row lands in the
      // informational section because there's no token name to promote
      // the code literal to.
      if (figmaPx === null) {
        const rawField = rawCornerFields[cssProp];
        if (rawField) {
          const raw = (node as Record<string, unknown>)[rawField];
          if (typeof raw === "number") {
            figmaPx = raw;
          } else if (raw === undefined) {
            // Fallback to the shorthand `cornerRadius` when corners are
            // uniform — Figma sometimes only sets the shorthand.
            const uniform = (node as Record<string, unknown>).cornerRadius;
            if (typeof uniform === "number") figmaPx = uniform;
          }
        }
      }

      if (figmaPx === null) continue;
      const codeValue = snapshot.styles[cssProp];
      const codePx = parsePx(codeValue);
      const status: DimensionDiff["status"] =
        codePx !== null && Math.abs(codePx - figmaPx) < 0.5 ? "match" : "drift";
      const dim: DimensionDiff = {
        kind: "token-value",
        property: cssProp,
        codeValue: codeValue ?? null,
        figmaValue: tokenName ? `${figmaPx}px (token: ${tokenName})` : `${figmaPx}px`,
        status,
      };
      if (tokenName) dim.tokenName = tokenName;
      else if (status === "drift") {
        dim.note =
          "Figma corner has no variable binding; bind it to a radius token in Figma to enable auto-apply.";
      }
      out.push(dim);
    }

    // Gap — frames carry `itemSpacing` either bound to a variable or as a
    // raw number on `node.itemSpacing`. Match-on-px first, then fall back
    // to raw.
    {
      const gapAlias = node.boundVariables?.itemSpacing;
      const aliasObj = Array.isArray(gapAlias) ? gapAlias[0] : gapAlias;
      let figmaGap: { value: number; tokenName?: string } | undefined;
      if (aliasObj && variables) {
        const v = variables.meta.variables[aliasObj.id];
        if (v && v.resolvedType === "FLOAT") {
          const px = resolveNumericForMode(v, variables, activeMode);
          if (px !== null) figmaGap = { value: px, tokenName: v.name };
        }
      }
      if (!figmaGap && typeof node.itemSpacing === "number") {
        figmaGap = { value: node.itemSpacing as number };
      }
      const codeValue = snapshot.styles["gap"];
      const codePx = parsePx(codeValue);
      // `getComputedStyle().gap` returns the keyword `"normal"` when no
      // gap is set on a non-flex/non-grid element — code has no opinion
      // there. Treat as flag-only when Figma has a value, otherwise skip.
      const codeHasNoOpinion = codeValue === "normal" || codeValue === undefined || codeValue === "";
      if (figmaGap || codePx !== null) {
        let status: DimensionDiff["status"];
        if (codeHasNoOpinion && figmaGap) status = "flag-only";
        else if (figmaGap && codePx !== null && Math.abs(codePx - figmaGap.value) < 0.5) status = "match";
        else status = "drift";
        out.push({
          kind: "token-value",
          property: "gap",
          codeValue: codeValue ?? null,
          figmaValue: figmaGap
            ? figmaGap.tokenName
              ? `${figmaGap.value}px (token: ${figmaGap.tokenName})`
              : `${figmaGap.value}px`
            : null,
          status,
          ...(figmaGap?.tokenName ? { tokenName: figmaGap.tokenName } : {}),
          ...(codeHasNoOpinion && figmaGap
            ? { note: "Code has no `gap` declared (default `normal`); Figma specifies a value." }
            : {}),
        });
      }
    }

    // Border width & color — only report when Figma actually draws a border.
    // Figma's `strokeWeight` defaults to 1 on every variant template even when no
    // stroke is drawn, so guarding on `strokeWeight > 0` alone produces
    // false-positive rows for icon-only / borderless components.
    //
    // "Draws a border" means a *visible* stroke paint (#85). The old guard was
    // `strokes.length > 0`, which called a switched-off stroke a border and then
    // reported the template's 1px default as the design's intent.
    const strokePaint = readPaint(
      node.strokes as FigmaPaint[] | undefined,
      "stroke",
      variables,
      activeMode,
    );
    const figmaHasVisibleStroke = strokePaint.selection.kind === "paint";
    /** Strokes exist but every one is switched off — a deliberate no-stroke. */
    const figmaStrokesAllHidden = strokePaint.selection.kind === "all-hidden";

    // The element may draw its border on any single edge (commonly
    // border-bottom for separator rows) rather than uniformly. Pick
    // whichever edge actually has a non-zero width so the comparison
    // matches reality. Falls back to the top edge when none drawn.
    const codeBorderEdge = pickBorderEdge(snapshot.styles);
    const codeBorderPx = parsePx(snapshot.styles[`border-${codeBorderEdge}-width`]) ?? 0;
    if (figmaHasVisibleStroke || codeBorderPx > 0) {
      const weightAlias = node.boundVariables?.strokeWeight;
      const aliasObj = Array.isArray(weightAlias) ? weightAlias[0] : weightAlias;
      let figmaWeight: { value: number; tokenName?: string } | undefined;
      if (aliasObj && variables) {
        const v = variables.meta.variables[aliasObj.id];
        if (v && v.resolvedType === "FLOAT") {
          const px = resolveNumericForMode(v, variables, activeMode);
          if (px !== null) figmaWeight = { value: px, tokenName: v.name };
        }
      }
      if (!figmaWeight && figmaHasVisibleStroke && typeof node.strokeWeight === "number") {
        figmaWeight = { value: node.strokeWeight as number };
      }
      const codeValue = snapshot.styles[`border-${codeBorderEdge}-width`];
      const codePx = parsePx(codeValue);
      if (figmaWeight || (codePx !== null && codePx > 0)) {
        const status: DimensionDiff["status"] =
          figmaWeight && codePx !== null && Math.abs(codePx - figmaWeight.value) < 0.5 ? "match" : "drift";
        out.push({
          kind: "token-value",
          property: "border-width",
          codeValue: codeValue ?? null,
          figmaValue: figmaWeight
            ? figmaWeight.tokenName
              ? `${figmaWeight.value}px (token: ${figmaWeight.tokenName})`
              : `${figmaWeight.value}px`
            : null,
          status,
          ...(figmaWeight?.tokenName ? { tokenName: figmaWeight.tokenName } : {}),
          // Reached when the code draws a border and Figma's strokes are all
          // switched off. Without the note the null Figma cell reads as "Figma
          // says nothing", when in fact it says "draw nothing" (#85).
          ...(figmaStrokesAllHidden && !figmaWeight && strokePaint.note
            ? { note: strokePaint.note }
            : {}),
        });
      }
    }

    // Border color — same guard, and the same paint-selection question as the
    // fill (#85): the stroke that renders, not `strokes[0]`. The block also runs
    // for a deliberate no-stroke, so that a code border against a switched-off
    // design stroke is reported instead of silently skipped.
    if (figmaHasVisibleStroke || figmaStrokesAllHidden) {
      const figmaStroke = strokePaint.color;
      const strokeTokenName = figmaStroke?.tokenName;
      const strokeVariableId = figmaStroke?.variableId;
      const codeValue = snapshot.styles[`border-${codeBorderEdge}-color`];
      if (figmaStroke || !isTransparentColor(codeValue)) {
        const status: DimensionDiff["status"] = strokePaint.incomparable
          ? "unresolved"
          : colorRowStatus(codeValue, figmaStroke?.value);
        const diff: DimensionDiff = {
          kind: "token-value",
          property: "border-color",
          codeValue: codeValue ?? null,
          figmaValue: figmaStroke?.value ?? null,
          status,
        };
        if (figmaStroke?.modes) diff.modes = figmaStroke.modes;
        if (strokeTokenName) diff.tokenName = strokeTokenName;
        if (figmaStroke?.codeSyntax) diff.figmaCodeSyntax = figmaStroke.codeSyntax;
        const strokeAdvisory = paintSourceAdvisory({
          variableId: strokeVariableId,
          variables,
        });
        if (strokeAdvisory) diff.sourceAdvisory = strokeAdvisory;
        if (strokePaint.note) diff.note = strokePaint.note;
        out.push(diff);
      }
    }

    // Effects (DROP_SHADOW / INNER_SHADOW → box-shadow). Figma's REST node
    // response carries the *resolved* effect array, so that — not the
    // `effects` variable binding, whose value is an effect object rather than
    // a number/colour — is what gets compared. Both sides are parsed into
    // structured shadows before comparison: the computed CSS string puts the
    // colour first and `inset` last, so no string compare could ever match
    // Figma's field order (`box-shadow.ts` has the details, including which
    // effect shapes are excluded outright).
    {
      const effects = node.effects as FigmaEffect[] | undefined;
      const codeValue = snapshot.styles["box-shadow"];
      const resolveEffectColor = (effect: FigmaEffect): string | undefined => {
        const alias = pickAlias(
          (effect as { boundVariables?: Record<string, FigmaVariableAlias | FigmaVariableAlias[]> })
            .boundVariables?.["color"],
        );
        if (alias && variables) {
          const resolved = resolveColorVariable(alias.id, variables, activeMode);
          if (resolved) return resolved.value;
        }
        return effect.color ? rgbaToCss(effect.color) : undefined;
      };
      const figma = figmaEffectsToShadows(effects, resolveEffectColor);
      const code = parseCssBoxShadow(codeValue);
      // Any excluded effect shape, an unreadable Figma side, or an unparseable
      // code side means there is no faithful comparison to make — emit nothing
      // rather than a verdict about a shadow we only partly understand. Both
      // sides at "no shadow" carries no information either.
      if (
        figma !== null &&
        figma.excluded.length === 0 &&
        code !== null &&
        !(figma.shadows.length === 0 && code.length === 0)
      ) {
        // The bound `effects` variable's name, for display only.
        let tokenName: string | undefined;
        const effectAlias = pickAlias(
          node.boundVariables?.effects as FigmaVariableAlias | FigmaVariableAlias[] | undefined,
        );
        if (effectAlias && variables) {
          const v = variables.meta.variables[effectAlias.id];
          if (v) tokenName = v.name;
        }
        const figmaShadow = formatShadows(figma.shadows);
        const status: DimensionDiff["status"] = shadowsEqual(figma.shadows, code)
          ? "match"
          : "drift";
        out.push({
          kind: "token-value",
          property: "box-shadow",
          codeValue: codeValue ?? null,
          figmaValue: tokenName ? `${figmaShadow} (token: ${tokenName})` : figmaShadow,
          status,
          ...(tokenName ? { tokenName } : {}),
        });
      }
    }

    // Opacity — `node.opacity` against computed `opacity`. Directly
    // comparable: Figma's node opacity and CSS `opacity` both scale the whole
    // element including its children, on the same 0..1 scale, so this needs no
    // unit conversion and no heuristics.
    //
    // Three shapes, and the distinction between them is the whole honesty of
    // the row:
    //   - The snapshot has no `opacity` key at all (a preview bundle older than
    //     the property). No comparison is possible — emit nothing rather than
    //     read a missing value as 0 or 1.
    //   - Figma omits `opacity` (the common case: it is only serialized when
    //     it isn't 1) AND the code computes 1. Both sides are at the default and
    //     neither said anything — no row, same rule the box-shadow comparison
    //     uses for "no shadow on either side".
    //   - Otherwise compare. When Figma's side is the implicit default, the note
    //     says so, so a drift row can't be misread as "the designer set 1 here".
    {
      const rawCode = snapshot.styles["opacity"];
      const figmaRaw = (node as Record<string, unknown>)["opacity"];
      const figmaExplicit = typeof figmaRaw === "number" && Number.isFinite(figmaRaw);
      const figmaOpacity = figmaExplicit ? (figmaRaw as number) : 1;
      const codeOpacity = rawCode === undefined ? null : Number.parseFloat(rawCode);
      const codeUsable = codeOpacity !== null && Number.isFinite(codeOpacity);
      const bothDefault = !figmaExplicit && codeUsable && Math.abs(codeOpacity! - 1) < 0.001;
      if (rawCode !== undefined && !bothDefault) {
        // A bound variable gives the row a token name, so a drifted literal can
        // be promoted to `var(--token)` the same way padding is.
        let tokenName: string | undefined;
        const alias = pickAlias(node.boundVariables?.["opacity"]);
        if (alias && variables) {
          const v = variables.meta.variables[alias.id];
          if (v && v.resolvedType === "FLOAT") tokenName = v.name;
        }
        const status: DimensionDiff["status"] = !codeUsable
          ? "flag-only"
          : Math.abs(codeOpacity! - figmaOpacity) < 0.001
            ? "match"
            : "drift";
        const notes: string[] = [];
        if (!figmaExplicit) {
          notes.push("Figma's node has no explicit opacity, which means 1.");
        }
        if (!codeUsable) {
          notes.push(`Computed \`opacity: ${rawCode}\` is not a number, so no comparison was made.`);
        }
        out.push({
          kind: "token-value",
          property: "opacity",
          codeValue: rawCode,
          figmaValue: tokenName ? `${figmaOpacity} (token: ${tokenName})` : String(figmaOpacity),
          status,
          ...(tokenName ? { tokenName } : {}),
          ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
        });
      }
    }

    // Typography — find the first TEXT descendant (or the node itself if it's
    // TEXT) and read its style + first fill. Inherited values resolve on the
    // code side via getComputedStyle, so an element that renders its own text
    // compares cleanly whether or not it declares the type itself: buttons,
    // tabs, menu items, headings.
    //
    // Gated on the element owning text. A wrapper `div` inherits a font size
    // from the page and Figma answers from a TEXT node several levels down, so
    // the two sides describe different elements and every row is fabricated.
    // Live Card: the story root, `[data-slot=body]` and `[data-slot=text]` are
    // layout divs, and between them they produced twelve such rows —
    // `line-height` "not bound in Figma" (with a design-side fix prompt),
    // `color` (inherited vs a descendant's fill), and two `copy` rows for
    // strings their children hold. The text-bearing descendants are compared on
    // their own, through their declared child bindings, where the verdict is
    // about the element that paints the glyphs. See `applicability.ts`.
    const textNode = ownsRenderedText(snapshot) ? findFirstTextNode(node) : undefined;
    if (textNode) {
      const ts = textNode.style as
        | (FigmaTypeStyle & {
            fontFamily?: string;
            fontPostScriptName?: string;
            fontWeight?: number;
            lineHeightPx?: number;
            lineHeightPercent?: number;
            lineHeightUnit?: string;
          })
        | undefined;
      const bound = textNode.boundVariables ?? {};

      // font-size
      pushTypographyNumeric({
        out,
        snapshot,
        variables,
        activeMode,
        cssProp: "font-size",
        rawValue: ts?.fontSize,
        alias: pickAlias(bound["fontSize"]),
      });
      // font-weight
      pushTypographyNumeric({
        out,
        snapshot,
        variables,
        activeMode,
        cssProp: "font-weight",
        rawValue: ts?.fontWeight,
        alias: pickAlias(bound["fontWeight"]),
        // weights aren't pixel values; compare as plain numbers
        unitless: true,
      });
      // line-height — Figma may store as px directly, percent of font size,
      // or `AUTO` / `INTRINSIC_%` (let the font metrics decide). The browser's
      // `line-height: normal` also resolves to a font-metric-derived px, so
      // when Figma is on auto we can't meaningfully compare against the
      // computed code value — both sides are "no opinion". Skip the row in
      // that case rather than reporting a guaranteed-drift number.
      const lineHeightUnit = (ts as { lineHeightUnit?: string } | undefined)?.lineHeightUnit;
      const figmaLineHeightIsAuto = lineHeightUnit === "AUTO" || lineHeightUnit === "INTRINSIC_%";
      let lineHeightPx: number | undefined;
      if (!figmaLineHeightIsAuto) {
        if (typeof ts?.lineHeightPx === "number" && ts.lineHeightPx > 0) {
          lineHeightPx = ts.lineHeightPx;
        } else if (
          typeof ts?.lineHeightPercent === "number" &&
          ts.lineHeightPercent > 0 &&
          typeof ts.fontSize === "number"
        ) {
          lineHeightPx = (ts.lineHeightPercent / 100) * ts.fontSize;
        }
      }
      // Only emit a row when Figma has an explicit opinion. When AUTO, both
      // sides are font-metric-driven — comparing px to px would always drift.
      if (!figmaLineHeightIsAuto) {
        pushTypographyNumeric({
          out,
          snapshot,
          variables,
          activeMode,
          cssProp: "line-height",
          rawValue: lineHeightPx,
          alias: pickAlias(bound["lineHeight"]),
        });
      }
      // font-family — string compare. Figma gives the display name; CSS
      // computed font-family returns a quoted, possibly multi-fallback string
      // (e.g. `"Nunito Sans", system-ui`). Match if Figma's value appears as
      // a substring of code's value (case-insensitive).
      {
        const codeValue = snapshot.styles["font-family"];
        let figmaFamily: string | undefined = ts?.fontFamily;
        let tokenName: string | undefined;
        const familyAlias = pickAlias(bound["fontFamily"]);
        if (familyAlias && variables) {
          const v = variables.meta.variables[familyAlias.id];
          if (v) {
            tokenName = v.name;
            if (v.resolvedType === "STRING") {
              const raw = resolveStringForMode(v, variables, activeMode);
              if (raw !== null) figmaFamily = raw;
            }
          }
        }
        if (figmaFamily || codeValue) {
          const codeNorm = (codeValue ?? "").toLowerCase().replace(/['"]/g, "");
          const figmaNorm = (figmaFamily ?? "").toLowerCase();
          const status: DimensionDiff["status"] =
            figmaFamily && codeNorm.includes(figmaNorm) ? "match" : "drift";
          out.push({
            kind: "token-value",
            property: "font-family",
            codeValue: codeValue ?? null,
            figmaValue: figmaFamily
              ? tokenName
                ? `${figmaFamily} (token: ${tokenName})`
                : figmaFamily
              : null,
            status,
            ...(tokenName ? { tokenName } : {}),
          });
        }
      }

      // color — the text node's first VISIBLE fill (#85). A TEXT node's fill is
      // its text colour, and a switched-off one is as invisible here as anywhere
      // else, so the same predicate applies.
      {
        const codeValue = snapshot.styles["color"];
        const textPaint = readPaint(textNode.fills, "fill", variables, activeMode);
        const figmaColor = textPaint.color;
        const colorTokenName = figmaColor?.tokenName;
        const colorVariableId = figmaColor?.variableId;
        if (codeValue || figmaColor) {
          const status: DimensionDiff["status"] = textPaint.incomparable
            ? "unresolved"
            : colorRowStatus(codeValue, figmaColor?.value);
          const diff: DimensionDiff = {
            kind: "token-value",
            property: "color",
            codeValue: codeValue ?? null,
            figmaValue: figmaColor?.value ?? null,
            status,
          };
          if (figmaColor?.modes) diff.modes = figmaColor.modes;
          if (colorTokenName) diff.tokenName = colorTokenName;
          if (figmaColor?.codeSyntax) diff.figmaCodeSyntax = figmaColor.codeSyntax;
          const sourceAdvisory = paintSourceAdvisory({
            styleName: fillStyleName(textNode, node),
            variableId: colorVariableId,
            variables,
          });
          if (sourceAdvisory) diff.sourceAdvisory = sourceAdvisory;
          if (textPaint.note) diff.note = textPaint.note;
          out.push(diff);
        }
      }

      // letter-spacing / text-align / text-transform / text-decoration-line /
      // font-style. Gated on `ts` existing: without a `style` object we cannot
      // tell "not italic" from "this response carries no typography", and a
      // fabricated `normal` would be exactly the confident-but-inapplicable
      // signal these rows exist to avoid. See `text-style-map.ts` for the
      // per-property mapping and every case that deliberately emits no row.
      if (ts) {
        const letterSpacingAlias = pickAlias(bound["letterSpacing"]);
        let letterSpacingTokenName: string | undefined;
        if (letterSpacingAlias && variables) {
          const v = variables.meta.variables[letterSpacingAlias.id];
          if (v && v.resolvedType === "FLOAT") letterSpacingTokenName = v.name;
        }
        out.push(
          ...textStyleRows({
            style: ts,
            codeStyles: snapshot.styles,
            figmaChars: (textNode as { characters?: string }).characters,
            letterSpacingTokenName,
          }),
        );
      }
    }

    return out;
  }

  /**
   * The `token-binding` dimension: does the code bind the same design token the
   * Figma node does?
   *
   * `valueDiffs` is the `token-value` output for the SAME element, computed just
   * before this call. It is what lets a name divergence be triaged honestly
   * instead of being reported as drift on the strength of a name comparison
   * alone — see `nameDivergenceStatus` below and issue #57.
   */
  private diffTokenBindings(
    node: FigmaNode,
    snapshot: CodeSnapshot | undefined,
    variables: FigmaLocalVariablesResponse | null,
    activeMode: string | undefined,
    opts: { aliases: TokenAliasMap; valueDiffs: readonly DimensionDiff[] } = {
      aliases: {},
      valueDiffs: [],
    },
  ): DimensionDiff[] {
    const out: DimensionDiff[] = [];
    const bindings = snapshot?.bindings ?? {};
    const figmaBindings = collectFigmaBindings(node, variables, activeMode);

    // Same applicability gate as the value rows: a wrapper that owns no text
    // gets no wiring verdict on the typography family or `color` either. A
    // binding row is the same claim as a value row with the names swapped in, so
    // suppressing one and keeping the other would leave the report contradicting
    // itself.
    const ownsText = ownsRenderedText(snapshot);
    const keys = new Set(
      [...Object.keys(bindings), ...Object.keys(figmaBindings)].filter(
        (key) => ownsText || !isTextOwnedProperty(key),
      ),
    );
    for (const key of keys) {
      const codeValue = bindings[key];
      const figma = figmaBindings[key];
      // If either side has no declared binding, we don't actually know whether
      // there is drift — the token may be applied via CSS variables that this
      // engine can't see. Mark as flag-only rather than crying wolf.
      let status: DimensionDiff["status"];
      let note: string | undefined;
      let nameDivergence: NameDivergenceKind | undefined;
      let nameResolvedBy: NameMatchVia | undefined;
      if (!codeValue && !figma) continue;
      if (!codeValue) {
        status = "flag-only";
        note = "Code binding not declared (add a `data-token-*` attribute or `parameters.designSync.tokens` to surface).";
      } else if (!figma) {
        status = "flag-only";
        note = "Figma node has no bound variable for this property.";
      } else {
        // Two mechanisms, alias first. `tokenAliases` is the project stating that
        // two names are one decision; the heuristic collapses spellings
        // (`radius/xl` ≡ `radius-xl` ≡ `--radius-xl`) and can do no more than
        // that. Which one answered is recorded on the row.
        const match = matchTokenNames(
          codeValue,
          figma.tokenName,
          opts.aliases,
          figma.codeSyntax,
        );
        if (match.same) {
          status = "match";
          nameResolvedBy = match.via;
          if (codeValue !== figma.tokenName) {
            note =
              match.via === "code-syntax"
                ? `Same token, stated by Figma: its \`codeSyntax\` names \`${figma.codeSyntax}\`, ` +
                  `which is what the code binds. Nothing inferred, and no \`tokenAliases\` entry needed.`
                : match.via === "alias"
                  ? `Same token by \`tokenAliases\` (${codeValue} ⇄ ${figma.tokenName}).`
                  : `Same token, different naming convention (${codeValue} vs ${figma.tokenName}).`;
          }
        } else {
          // The names diverge. Whether that is a DEFECT depends entirely on the
          // value comparison, which is the whole of issue #57: a Tailwind
          // consumer binding `primary` against a library naming the same
          // decision `color/background/brand/default` produced ~10 "drift" rows
          // per story whose values matched exactly.
          const verdict = nameDivergenceStatus(key, opts.valueDiffs);
          if (verdict === "drift") {
            status = "drift";
            note = divergenceNote({
              codeValue,
              figmaName: figma.tokenName,
              kind: "drift",
              aliasExpected: match.aliasExpected,
            });
          } else {
            status = "advisory";
            nameDivergence = verdict;
            note = divergenceNote({
              codeValue,
              figmaName: figma.tokenName,
              kind: verdict,
              aliasExpected: match.aliasExpected,
            });
          }
        }
      }
      const diff: DimensionDiff = {
        kind: "token-binding",
        property: key,
        codeValue: codeValue ?? null,
        figmaValue: figma?.tokenName ?? null,
        status,
      };
      if (note) diff.note = note;
      if (nameDivergence) diff.nameDivergence = nameDivergence;
      if (nameResolvedBy) diff.nameResolvedBy = nameResolvedBy;
      if (figma?.modes) diff.modes = figma.modes;
      // #93: the variable's own code name, so downstream can prefer what Figma
      // states over what conversion would infer.
      if (figma?.codeSyntax !== undefined) diff.figmaCodeSyntax = figma.codeSyntax;
      out.push(diff);
    }
    return out;
  }

  private diffVariantSet(
    node: FigmaNode,
    snapshot: CodeSnapshot | undefined,
    storyId: string,
    propsDiffs: DimensionDiff[] = [],
  ): DimensionDiff[] {
    // The preview already expands BEM-modifier classes and adjacent classes
    // (.file-item.active style) into a candidate set. Lowercase everything
    // here for case-insensitive matching.
    const codeVariants = new Set(
      (snapshot?.variantClasses ?? []).map((v) => v.toLowerCase()),
    );

    // Storybook stories don't emit class-based variant modifiers like
    // `.row--state-hover`, so without help we'd flag drift on every
    // variant story. Infer the variant from the story id suffix
    // (`molecules-rowboolean--checked-true-state-hover` →
    // `{Checked: "true", State: "Hover"}`) using Figma's prop names as
    // the parsing dictionary — that way `--state-picker-open` correctly
    // resolves to `{State: "PickerOpen"}` and not `{State: "picker",
    // open: ""}`.
    const figmaPropKeys =
      node.type === "COMPONENT" && node.name.includes("=")
        ? Object.keys(parseVariantName(node.name))
        : [];
    const inferredVariant = parseStoryVariantSuffix(storyId, figmaPropKeys);
    for (const v of Object.values(inferredVariant)) {
      codeVariants.add(v.toLowerCase());
    }

    // If this node is a single COMPONENT (a variant in a set), Figma encodes
    // the active variant as the node name "Property=Value, Other=Value".
    // Parse it as a structured Record<property, value> and compare each
    // property independently against code modifiers. This lets us:
    //   - skip falsy/default values (no modifier expected in code)
    //   - report per-property drift instead of collapsing to a string set
    //     where "false" looks identical to a real variant value
    if (node.type === "COMPONENT" && node.name.includes("=")) {
      const figmaProps = parseVariantName(node.name);
      const missing: string[] = [];
      const matched: string[] = [];
      const skipped: string[] = [];
      const evaluatedAxes: string[] = [];

      for (const [prop, value] of Object.entries(figmaProps)) {
        if (isFalsyVariantValue(value)) {
          skipped.push(`${prop}=${value}`);
          continue;
        }
        evaluatedAxes.push(prop);
        if (codeVariants.has(value.toLowerCase())) {
          matched.push(`${prop}=${value}`);
        } else {
          missing.push(`${prop}=${value}`);
        }
      }

      // Inapplicable (no modifier-class convention to reason about) or
      // redundant (props already confirmed every axis)? Then this row is a
      // confident signal that doesn't apply — emit nothing at all.
      if (
        !variantSetRowApplicable({
          rootClasses: snapshot?.rootClasses,
          evaluatedAxes,
          propsStatuses: propsStatusesByAxis(propsDiffs),
        })
      ) {
        return [];
      }

      const status: DimensionDiff["status"] = missing.length === 0 ? "match" : "drift";
      const diff: DimensionDiff = {
        kind: "variant-set",
        property: "active-variant",
        codeValue: [...codeVariants],
        figmaValue: figmaProps,
        status,
      };
      if (status === "drift") {
        diff.note = `Figma variants not present in code: [${missing.join(", ")}]`;
      } else if (skipped.length > 0) {
        diff.note = `Falsy/default skipped: [${skipped.join(", ")}]`;
      }
      return [diff];
    }

    // COMPONENT_SET: compare code-side variant classes to the option list.
    const figmaOptions = new Set<string>();
    if (node.componentPropertyDefinitions) {
      for (const def of Object.values(node.componentPropertyDefinitions)) {
        for (const opt of def.variantOptions ?? []) figmaOptions.add(opt.toLowerCase());
      }
    }
    if (codeVariants.size === 0 && figmaOptions.size === 0) return [];

    // Same premise, same suppression: comparing a utility class list against a
    // Figma component set's variant options is not a comparison. (No per-axis
    // `props` rows exist for a COMPONENT_SET, so only the evidence rule can
    // fire here.)
    if (!variantSetRowApplicable({ rootClasses: snapshot?.rootClasses })) return [];

    // Drift only if the code variant isn't a known Figma option.
    const unknownInFigma = [...codeVariants].filter((v) => !figmaOptions.has(v));
    const status: DimensionDiff["status"] = unknownInFigma.length === 0 ? "match" : "drift";
    const diff: DimensionDiff = {
      kind: "variant-set",
      property: "variant-options",
      codeValue: [...codeVariants],
      figmaValue: [...figmaOptions],
      status,
    };

    // Coverage warning: when the story registers against the SET rather than
    // a specific variant, value/binding diffs run against the set's root
    // node (typically inheriting from the first child). Surface that fact
    // so users know to pin to a variant for exact comparison.
    const notes: string[] = [];
    if (node.type === "COMPONENT_SET") {
      const firstVariant = node.children?.find((c) => c.type === "COMPONENT");
      if (firstVariant) {
        notes.push(
          `Registered node is the COMPONENT_SET. Value/binding diffs use the set root; ` +
            `first variant "${firstVariant.name}" → ${firstVariant.id}. ` +
            `Pin the registry to a specific variant node for exact comparison.`,
        );
      }
    }
    if (status === "drift") {
      notes.push(`code variants not declared in Figma: [${unknownInFigma.join(", ")}]`);
    }
    if (notes.length > 0) diff.note = notes.join(" ");
    return [diff];
  }

  /**
   * Compare Figma's variant properties (parsed from the registered variant
   * node's name) against Storybook story args. One row per Figma property.
   *
   * Matching strategy:
   *   - Falsy/default Figma values (false/default/off/no/none) → match by
   *     absence (no arg expected to carry that value)
   *   - "True" → look for an arg whose name resembles the Figma property
   *     (with `is`/`has` prefixes stripped) and is truthy
   *   - Anything else → look for any arg whose stringified value equals
   *     the Figma value (case-insensitive)
   *
   * Then, independently of the variant axes, Figma's **component properties**
   * (BOOLEAN / TEXT / INSTANCE_SWAP) are compared against the same args — see
   * `component-properties.ts` for the name-matching rule and its refusals.
   *
   * If the registered node has neither variant axes nor comparable component
   * properties (or no args were provided), emits a single flag-only row.
   */
  private diffProps(node: FigmaNode, args: Record<string, unknown> | undefined): DimensionDiff[] {
    if (!args) {
      return [this.placeholder("props", "story.args (no args sent)")];
    }

    const isVariant = node.type === "COMPONENT" && node.name.includes("=");
    const variantRows: DimensionDiff[] = isVariant
      ? Object.entries(parseVariantName(node.name)).map(([prop, value]): DimensionDiff => {
          if (isFalsyVariantValue(value)) {
            return {
              kind: "props",
              property: prop,
              codeValue: null,
              figmaValue: value,
              status: "match",
              note: "Falsy/default — no arg expected.",
            };
          }
          const matchingArg = findMatchingArg(args, prop, value);
          return {
            kind: "props",
            property: prop,
            codeValue: matchingArg ? { [matchingArg[0]]: matchingArg[1] } : null,
            figmaValue: value,
            status: matchingArg ? "match" : "drift",
          };
        })
      : [];

    // Figma *component* properties (BOOLEAN / TEXT / INSTANCE_SWAP) — distinct
    // from variant axes, and until now read only for their `variantOptions`.
    // `figmaTexts` lets a TEXT property defer to the `copy` dimension instead
    // of reporting the same string twice.
    const propertyRows = componentPropertyRows({
      node,
      args,
      figmaTexts: collectFigmaText(node),
    });

    if (variantRows.length === 0 && propertyRows.length === 0) {
      return [
        {
          kind: "props",
          property: "story.args",
          codeValue: args,
          figmaValue: null,
          status: "flag-only",
          note: "Registered node has no Figma variant or component properties to compare against.",
        },
      ];
    }
    return [...variantRows, ...propertyRows];
  }

  /**
   * Compare each Figma TEXT-node's `characters` against visible text in the
   * rendered story. We allow case-insensitive substring containment (a
   * Figma label "Send" still matches a code button reading "Send →").
   *
   * Single row per Figma string. Strings present in code = match; absent =
   * drift. If neither side has any text, no row is emitted.
   *
   * Not run on an element that owns no text. Its `texts` are its descendants',
   * and those descendants hold the copy, get their own `copy` rows through their
   * child bindings, and are where a fix would be made — so a row here restates
   * their verdict against an element that renders none of it. On the live Card
   * this was two of the four rows on each of three layout divs.
   */
  private diffCopy(node: FigmaNode, snapshot: CodeSnapshot | undefined): DimensionDiff[] {
    if (!ownsRenderedText(snapshot)) return [];
    const figmaStrings = collectFigmaText(node);
    const codeStringsRaw = snapshot?.texts ?? [];
    const codeTexts = codeStringsRaw.map((s) => s.toLowerCase());
    if (figmaStrings.length === 0 && codeTexts.length === 0) return [];

    if (figmaStrings.length === 0) {
      // Figma has no text but code does — surface as flag-only so it's
      // visible without crying drift; the user may have added a label that
      // belongs in design too.
      return [
        {
          kind: "copy",
          property: "text",
          codeValue: snapshot?.texts ?? [],
          figmaValue: [],
          status: "flag-only",
          note: "Code has visible text; Figma node has no TEXT children.",
        },
      ];
    }

    // 1:1 pairing — when the component has exactly one visible text on
    // each side, we know which Figma node pairs with which code string
    // without ambiguity. Emit a single row that carries both concrete
    // values, so Apply works in either direction (code-tsx-text rewrites
    // the JSX literal; the plugin's characters writer pushes to Figma).
    // Asymmetric cases (multi-text, or Figma-only) fall through to the
    // legacy per-Figma-string iteration below.
    if (figmaStrings.length === 1 && codeStringsRaw.length === 1) {
      const figmaText = figmaStrings[0]!;
      const codeText = codeStringsRaw[0]!;
      const match =
        codeText.toLowerCase() === figmaText.toLowerCase() ||
        codeText.toLowerCase().includes(figmaText.toLowerCase()) ||
        figmaText.toLowerCase().includes(codeText.toLowerCase());
      return [
        {
          kind: "copy",
          property: "text",
          codeValue: codeText,
          figmaValue: figmaText,
          status: match ? "match" : "drift",
        },
      ];
    }

    return figmaStrings.map((figmaText): DimensionDiff => {
      const lower = figmaText.toLowerCase();
      const present = codeTexts.some((c) => c.includes(lower) || lower.includes(c));
      return {
        kind: "copy",
        property: "text",
        codeValue: present ? figmaText : null,
        figmaValue: figmaText,
        status: present ? "match" : "drift",
      };
    });
  }

  private placeholder(
    kind: DimensionDiff["kind"],
    property: string,
  ): DimensionDiff {
    return {
      kind,
      property,
      codeValue: null,
      figmaValue: null,
      status: "flag-only",
      note: "Reserved for a future engine.",
    };
  }
}

// ---- helpers --------------------------------------------------------------

/**
 * Merge a parent COMPONENT_SET's boundVariables underneath the variant's,
 * so any padding/radius/etc. binding declared on the parent shows up when
 * the variant doesn't override it. Variant wins on conflicts.
 *
 * `rectangleCornerRadii` is a nested map keyed by corner; merge per-corner
 * rather than wholesale-replacing.
 *
 * `componentPropertyDefinitions` is inherited the same way and for the same
 * reason: Figma declares BOOLEAN/TEXT/INSTANCE_SWAP properties on the
 * COMPONENT_SET, not on each variant, so a registry pinned to a variant node
 * (the normal case) would otherwise see none of them.
 */
function mergeInheritedBindings(variant: FigmaNode, parent: FigmaNode): FigmaNode {
  const parentBV = parent.boundVariables ?? {};
  const variantBV = variant.boundVariables ?? {};
  const merged: Record<string, FigmaVariableAlias | FigmaVariableAlias[]> = { ...parentBV };
  for (const [k, v] of Object.entries(variantBV)) {
    if (k === "rectangleCornerRadii") {
      const parentCorners = (parentBV.rectangleCornerRadii ?? {}) as Record<string, FigmaVariableAlias>;
      const variantCorners = v as unknown as Record<string, FigmaVariableAlias>;
      merged.rectangleCornerRadii = { ...parentCorners, ...variantCorners } as unknown as FigmaVariableAlias;
    } else {
      merged[k] = v;
    }
  }
  // Inherit only the non-VARIANT definitions. A variant's own axes come from
  // its name (`Size=Large`), and handing the parent's VARIANT entries to a
  // variant node would hand `diffVariantSet` a second, weaker view of axes it
  // already compares — the exact redundancy v0.0.34 removed.
  const definitions =
    variant.componentPropertyDefinitions ??
    pickNonVariantDefinitions(parent.componentPropertyDefinitions);
  return {
    ...variant,
    boundVariables: merged,
    ...(definitions ? { componentPropertyDefinitions: definitions } : {}),
  };
}

function pickNonVariantDefinitions(
  defs: Record<string, FigmaComponentPropertyDefinition> | undefined,
): Record<string, FigmaComponentPropertyDefinition> | undefined {
  if (!defs) return undefined;
  const out: Record<string, FigmaComponentPropertyDefinition> = {};
  for (const [key, def] of Object.entries(defs)) {
    if (def?.type !== "VARIANT") out[key] = def;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Find a Storybook arg that matches a Figma variant property using three
 * strategies, in priority order:
 *   1. Direct value match — any arg whose stringified value equals the
 *      Figma value (case-insensitive). Catches "variant: 'accent'" → "Accent".
 *   2. Property-name match for booleans — when Figma value is "True", any
 *      arg whose name matches the Figma property name (with optional
 *      is/has prefix) and is truthy. Catches "isDirty: true" → IsDirty=True.
 *   3. Value-as-name match for boolean states — any arg whose name (with
 *      is/has prefix stripped) equals the Figma value, and is truthy.
 *      Catches "isActive: true" → State=Active.
 *
 * Returns the matching [key, value] tuple or null.
 */
function findMatchingArg(
  args: Record<string, unknown>,
  figmaProp: string,
  figmaValue: string,
): [string, unknown] | null {
  const lowerValue = figmaValue.toLowerCase();
  const isBoolish = lowerValue === "true" || lowerValue === "false";
  const propClean = figmaProp.toLowerCase().replace(/[-_]/g, "");
  const propStripped = propClean.replace(/^(is|has)/, "");

  // For boolean Figma values, strategy 2 (property-name) runs first because
  // strategy 1 would match the FIRST truthy arg regardless of whose property
  // it represents. For non-boolean values, strategy 1 (direct value match) is
  // the most specific signal.
  if (isBoolish) {
    if (lowerValue === "true") {
      for (const [k, v] of Object.entries(args)) {
        if (!v) continue;
        const kClean = k.toLowerCase().replace(/[-_]/g, "");
        if (kClean === propClean || kClean === propStripped) return [k, v];
      }
    }
  } else {
    for (const [k, v] of Object.entries(args)) {
      if (String(v).toLowerCase() === lowerValue) return [k, v];
    }
  }

  // Strategy 3: value-as-name (Figma "Active" → code `isActive: true`)
  for (const [k, v] of Object.entries(args)) {
    if (!v) continue;
    const kClean = k.toLowerCase().replace(/[-_]/g, "").replace(/^(is|has)/, "");
    if (kClean === lowerValue) return [k, v];
  }
  return null;
}

/**
 * Walk the Figma node tree and collect all TEXT-node `characters` values.
 *
 * Two stop conditions prevent a layout container (Panel rendering nested
 * Folder/Row instances) from flooding the report with every label inside
 * every nested instance — those nested components have their own stories
 * with their own copy diff, and double-counting their text turns the
 * parent's `copy` rows into noise drowning out real drift.
 *
 * Stops:
 *   1. INSTANCE boundary — don't recurse into nested component references.
 *      Their text is owned by their own story.
 *   2. Hard depth cap (8 levels) — backstop for deeply nested layouts that
 *      use raw frames instead of instances.
 *
 * Deduplicates and returns trimmed non-empty strings.
 */
const COPY_SCAN_MAX_DEPTH = 8;

function collectFigmaText(node: FigmaNode): string[] {
  const out = new Set<string>();
  function walk(n: FigmaNode, depth: number): void {
    if (n.type === "TEXT") {
      const chars = (n as unknown as { characters?: string }).characters;
      if (typeof chars === "string") {
        const trimmed = chars.trim();
        if (trimmed) out.add(trimmed);
      }
    }
    if (depth >= COPY_SCAN_MAX_DEPTH) return;
    for (const child of n.children ?? []) {
      // Stop at nested instances — their text belongs to another story.
      // The root node itself can be an INSTANCE; only skip *descendant*
      // instances (i.e. depth > 0).
      if (child.type === "INSTANCE" && depth > 0) continue;
      // A hidden layer renders no text, and hides its children with it (#85).
      // Comparing a switched-off placeholder's `characters` against the story's
      // rendered copy is the copy dimension's version of reading `fills[0]` blind.
      if (isHiddenNode(child)) continue;
      walk(child, depth + 1);
    }
  }
  walk(node, 0);
  return [...out];
}

/**
 * Parse a Storybook story id's variant suffix into a structured
 * `{ Property: "Value" }` map, using Figma's known property names as
 * the parsing dictionary.
 *
 * Examples (figmaKeys = ["State", "Checked"]):
 *   "molecules-rowboolean--checked-true-state-hover" → { Checked: "true", State: "Hover" }
 *   "molecules-rowassetpicker--state-picker-open"    → { State: "PickerOpen" }
 *   "molecules-rowbutton--default"                   → { }   (no recognized keys)
 *
 * Algorithm:
 *   1. Take the suffix after the last `--` and split on `-`.
 *   2. Walk tokens; when a token matches a known Figma prop name
 *      (case-insensitive), open a new property. Accumulate following
 *      tokens as the value until the next prop match or end-of-suffix.
 *   3. Camel-case the accumulated value tokens so multi-word values
 *      (`picker-open` → `PickerOpen`) match Figma's variant names.
 *
 * If `figmaKeys` is empty, returns an empty map — without a dictionary
 * we can't tell which tokens are keys vs values, and over-eager
 * inference would produce more noise than it clears.
 */
function parseStoryVariantSuffix(
  storyId: string,
  figmaKeys: string[],
): Record<string, string> {
  if (figmaKeys.length === 0) return {};
  const suffix = storyId.split("--").pop() ?? "";
  if (!suffix || suffix === "default") return {};
  const keyByLower = new Map(figmaKeys.map((k) => [k.toLowerCase(), k]));
  const tokens = suffix.split("-").filter(Boolean);
  const out: Record<string, string[]> = {};
  let currentKey: string | null = null;
  for (const tok of tokens) {
    const matchedKey = keyByLower.get(tok.toLowerCase());
    if (matchedKey) {
      currentKey = matchedKey;
      out[currentKey] = [];
    } else if (currentKey) {
      out[currentKey]!.push(tok);
    }
    // Tokens before the first recognized key (e.g. accidental prefix)
    // are dropped — they're not part of the variant.
  }
  const result: Record<string, string> = {};
  for (const [key, valueTokens] of Object.entries(out)) {
    if (valueTokens.length === 0) continue;
    // Camel-case `picker-open` → `PickerOpen`; preserve `true`/`false`
    // as-is for boolean variants (Figma encodes them lowercase).
    const joined = valueTokens
      .map((t) => (t === "true" || t === "false" ? t : t[0]!.toUpperCase() + t.slice(1)))
      .join("");
    // Boolean variants stay lowercase — that's how Figma stores them.
    result[key] = joined === "True" ? "true" : joined === "False" ? "false" : joined;
  }
  return result;
}

/**
 * Turn the reads that failed into the report's `incomplete` record, or return
 * undefined when everything this report covers was actually read.
 *
 * The verdict this produces is what stops a rate limit becoming a cached green
 * tick (#73): `incomplete` set means not cached, not counted as checked, and said
 * out loud in the panel. Only *unread* data qualifies — a node Figma confirms is
 * absent is a finding, not a hole.
 */
export function summarizeIncomplete(
  childFailures: ReadonlyArray<{ selector: string; failure: NodeFailure }>,
  variablesFailure: unknown,
): DriftReport["incomplete"] {
  if (childFailures.length === 0 && variablesFailure === undefined) return undefined;

  const targets: string[] = [];
  const details: string[] = [];
  let retryAfterMs: number | undefined;
  let rateLimited = false;

  if (variablesFailure !== undefined) {
    targets.push("the file's variables");
    details.push(describeFetchFailure(variablesFailure));
    if (isRateLimitError(variablesFailure)) {
      rateLimited = true;
      if (variablesFailure.retryAfterMs !== null) {
        retryAfterMs = Math.max(retryAfterMs ?? 0, variablesFailure.retryAfterMs);
      }
    }
  }

  const seenDetails = new Set<string>();
  for (const { selector, failure } of childFailures) {
    targets.push(selector);
    if (!seenDetails.has(failure.detail)) {
      seenDetails.add(failure.detail);
      details.push(failure.detail);
    }
    if (failure.rateLimited) rateLimited = true;
    if (failure.retryAfterMs !== undefined) {
      retryAfterMs = Math.max(retryAfterMs ?? 0, failure.retryAfterMs);
    }
  }

  const what =
    childFailures.length > 0 && variablesFailure !== undefined
      ? `${childFailures.length} child binding${childFailures.length === 1 ? "" : "s"} and the file's variables`
      : childFailures.length > 0
        ? `${childFailures.length} child binding${childFailures.length === 1 ? "" : "s"}`
        : "the file's variables";
  const cause = rateLimited ? "rate limited by Figma" : "the Figma read failed";
  return {
    reason: `${what} could not be read — ${cause}`,
    targets,
    detail: details.join(" "),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/**
 * Parse a Figma variant name like "State=Active, IsDirty=False" into a
 * structured `{ State: "Active", IsDirty: "False" }`. Tolerates trailing
 * spaces and missing values.
 */
function parseVariantName(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of name.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/**
 * Index the `props` rows by the Figma variant axis they compared, so the
 * variant-set check can ask "was this axis already confirmed against the story
 * args?". `diffProps` emits one row per axis, keyed by the axis name.
 */
function propsStatusesByAxis(propsDiffs: DimensionDiff[]): Record<string, DimensionDiff["status"]> {
  const out: Record<string, DimensionDiff["status"]> = {};
  for (const d of propsDiffs) {
    if (d.kind === "props") out[d.property] = d.status;
  }
  return out;
}

/**
 * Variant values that conventionally mean "no modifier in code" — typically
 * the absence-state of a boolean variant or the unmodified default.
 *
 * Code-side BEM rarely emits `.foo--false` or `.foo--default`; the absence
 * of a modifier IS the falsy state. Treat these as match-by-skip rather
 * than flagging false-positive drift.
 */
function isFalsyVariantValue(value: string): boolean {
  const v = value.toLowerCase();
  return v === "false" || v === "default" || v === "off" || v === "no" || v === "none";
}

/**
 * Pick the border edge to compare against the Figma stroke. Rows that
 * draw only a `border-bottom` would otherwise read zero from
 * `border-top-width` and falsely report drift. Falls back to "top" when
 * no edge has a non-zero width — keeps prior behavior for components
 * that genuinely have no border.
 */
function pickBorderEdge(styles: Record<string, string>): "top" | "right" | "bottom" | "left" {
  for (const edge of ["bottom", "top", "left", "right"] as const) {
    if ((parsePx(styles[`border-${edge}-width`]) ?? 0) > 0) return edge;
  }
  return "top";
}

function parsePx(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*px$/.exec(value);
  return m && m[1] ? Number(m[1]) : null;
}

function rgbaToCss(c: { r: number; g: number; b: number; a?: number }): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  const a = c.a ?? 1;
  return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}

interface ResolvedFill {
  value: string;
  modes?: ModeAwareValue;
  tokenName?: string;
  /** The bound variable's own `codeSyntax.WEB`, verbatim, when it declares one (#93). */
  codeSyntax?: string;
  /**
   * Id of the variable the paint binds, when it binds one. Carried so the row
   * can say something about the variable's *tier* — the name alone can't, and
   * guessing tier from the name is exactly what `colorTokenTier` refuses to do.
   */
  variableId?: string;
}

/**
 * Verdict for a colour comparison. `drift` requires a concrete value on both
 * sides — with only one side present there is nothing to compare, and calling
 * that drift is the exact false positive the honesty invariant forbids. The
 * row still renders with whatever detail exists; it just doesn't accuse.
 */
function colorRowStatus(
  codeValue: string | undefined,
  figmaValue: string | undefined,
): DimensionDiff["status"] {
  if (!codeValue || !figmaValue) return "flag-only";
  return normalizeColor(codeValue) === normalizeColor(figmaValue) ? "match" : "drift";
}

/**
 * Resolve one paint — the one that renders — to a colour.
 *
 * Takes a `Paint` rather than a node on purpose (issue #85). Choosing *which*
 * paint is a separate question with its own answer in `paint-visibility.ts`, and
 * every reader here had inlined `[0]` as if it weren't a question at all. The
 * fill, stroke and TEXT-colour paths now all pick first, then resolve here, so
 * none of them can drift back to index 0 on its own.
 */
function resolvePaintColor(
  fill: FigmaPaint,
  variables: FigmaLocalVariablesResponse | null,
  activeMode?: string,
): ResolvedFill | undefined {
  // A paint delivered by a shared paint style arrives here already flattened:
  // Figma inlines the style's paint into `fills`, `boundVariables` included, so
  // there is no style indirection left to follow. `fillStyleName` reports which
  // style it was; this function only ever reads the paint in front of it.
  const alias = fill.boundVariables?.color;
  const tokenName = alias && variables ? variables.meta.variables[alias.id]?.name : undefined;
  if (alias && variables) {
    const resolved = resolveColorVariable(alias.id, variables, activeMode);
    if (resolved) {
      if (tokenName) resolved.tokenName = tokenName;
      resolved.variableId = alias.id;
      return resolved;
    }
  }
  // The variable didn't resolve, but Figma also hands back the paint's own
  // resolved colour — use it, and keep the token name so the row still
  // knows which token it is nominally bound to.
  if (fill.color) {
    return {
      value: rgbaToCss(fill.color),
      ...(tokenName ? { tokenName } : {}),
      ...(alias ? { variableId: alias.id } : {}),
    };
  }
  return undefined;
}

/**
 * What a paint array yields for a colour row: the colour (when one paints), the
 * note the row must carry, and whether a verdict may be claimed at all.
 *
 * One function for the fill, stroke and TEXT-colour paths so the three cannot
 * answer #85 differently — they were three near-copies of the same eight lines,
 * and all three read index 0 blind.
 */
interface PaintRead {
  selection: PaintSelection<FigmaPaint>;
  /** The rendering paint's colour, when there is one and it could be read. */
  color?: ResolvedFill;
  /** Note explaining a skipped, switched-off or blended paint. */
  note?: string;
  /**
   * True when a paint renders but its colour is not what appears (partial
   * opacity). The row reports; it must not compare.
   */
  incomparable: boolean;
}

function readPaint(
  paints: FigmaPaint[] | undefined,
  word: PaintKindWord,
  variables: FigmaLocalVariablesResponse | null,
  activeMode?: string,
): PaintRead {
  const selection = pickVisiblePaint(paints);
  if (selection.kind === "all-hidden") {
    return {
      selection,
      note: allPaintsHiddenNote(word, selection.hidden),
      incomparable: false,
    };
  }
  if (selection.kind !== "paint") return { selection, incomparable: false };
  const color = resolvePaintColor(selection.paint, variables, activeMode);
  if (selection.partialOpacity !== undefined) {
    return {
      selection,
      ...(color ? { color } : {}),
      note: partialOpacityNote(word, selection.partialOpacity),
      incomparable: true,
    };
  }
  return {
    selection,
    ...(color ? { color } : {}),
    ...(selection.hiddenBefore > 0
      ? { note: hiddenPaintsSkippedNote(word, selection.hiddenBefore) }
      : {}),
    incomparable: false,
  };
}

/**
 * A raw `valuesByMode` entry that points at another variable rather than
 * holding a literal. Figma's REST shape for semantic tokens: `Border/Neutral/
 * Secondary` doesn't store a colour, it stores an alias to `Slate/600`.
 */
function asVariableAlias(raw: unknown): FigmaVariableAlias | undefined {
  if (raw && typeof raw === "object" && (raw as { type?: string }).type === "VARIABLE_ALIAS") {
    return raw as FigmaVariableAlias;
  }
  return undefined;
}

/**
 * Match a collection mode by name. Exact (case-insensitive) first, then as a
 * whole word inside the mode name — real files prefix their modes with the
 * system name (SDS ships `"SDS Light"` / `"SDS Dark"`, not `"Light"` /
 * `"Dark"`), and an exact-only match silently sent every dark-mode
 * comparison to the file's default mode.
 */
function findModeId(collection: FigmaVariableCollection, modeName: string): string | undefined {
  const target = modeName.trim().toLowerCase();
  if (!target) return undefined;
  const exact = collection.modes.find((m) => m.name.trim().toLowerCase() === target);
  if (exact) return exact.modeId;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`\\b${escaped}\\b`, "i");
  return collection.modes.find((m) => word.test(m.name))?.modeId;
}

/** How many alias hops to follow before giving up. Real chains are 1-2 deep. */
const MAX_ALIAS_DEPTH = 8;

/** Why an alias chain produced no literal. Drives the row's honest message. */
type UnresolvedReason =
  | "variable-missing"
  | "collection-missing"
  | "no-value"
  | "wrong-type"
  | "cycle"
  | "depth";

type LiteralResolution =
  | { ok: true; value: unknown; chain: string[] }
  | { ok: false; reason: UnresolvedReason; chain: string[] };

type UnresolvedLiteral = Extract<LiteralResolution, { ok: false }>;

/**
 * Read a variable's literal value for `modeName`, following `VARIABLE_ALIAS`
 * indirection to whatever variable actually holds the literal.
 *
 * Each hop re-resolves the mode against the *target's own* collection, which
 * matters because aliases routinely cross collections with unrelated mode
 * sets — `Color` has `SDS Light`/`SDS Dark`, while the `Color Primitives` it
 * points into has a single `Value` mode. Falls back to the collection's
 * default mode whenever `modeName` doesn't name one of its modes.
 *
 * Type-agnostic on purpose: COLOR (`{r,g,b,a}`), FLOAT (`number`), STRING and
 * BOOLEAN variables all alias the same way, so every reader goes through here.
 *
 * Never returns a partially-resolved stand-in (a variable *name* is not a
 * value). On failure it returns the reason plus the chain walked so the caller
 * can tell the user exactly what couldn't be resolved.
 */
function resolveVariableLiteral(
  variableId: string,
  variables: FigmaLocalVariablesResponse,
  modeName: string | undefined,
  seen: Set<string> = new Set(),
  depth = 0,
  chain: string[] = [],
): LiteralResolution {
  const v = variables.meta.variables[variableId];
  // Label hops by name where we have one; the raw id is all we can say about
  // a variable that isn't in the response (typically a library reference).
  const walked = [...chain, v?.name ?? variableId];

  // Cycle before depth: a self-referential chain should say "loops", not
  // "too deep", even though both guards would stop it.
  if (seen.has(variableId)) return { ok: false, reason: "cycle", chain: walked };
  if (depth > MAX_ALIAS_DEPTH) return { ok: false, reason: "depth", chain: walked };
  seen.add(variableId);

  if (!v) return { ok: false, reason: "variable-missing", chain: walked };
  const collection = variables.meta.variableCollections[v.variableCollectionId];
  if (!collection) return { ok: false, reason: "collection-missing", chain: walked };

  // Prefer the named mode; fall back to the collection's default when this
  // collection doesn't name it (every hop past the first, since aliases cross
  // into collections with unrelated mode sets) or defines no value for it.
  const namedModeId = modeName ? findModeId(collection, modeName) : undefined;
  const raw =
    (namedModeId ? v.valuesByMode[namedModeId] : undefined) ??
    v.valuesByMode[collection.defaultModeId];
  if (raw === undefined) return { ok: false, reason: "no-value", chain: walked };

  const alias = asVariableAlias(raw);
  if (alias) return resolveVariableLiteral(alias.id, variables, modeName, seen, depth + 1, walked);
  return { ok: true, value: raw, chain: walked };
}

/**
 * The honest message for a row whose Figma side couldn't be read. Names the
 * token, what was expected, why the read failed, and states plainly that no
 * comparison happened — so a reader never mistakes it for a verdict.
 */
function describeUnresolvedVariable(
  res: UnresolvedLiteral,
  tokenName: string,
  expected: string,
  modeName?: string,
): string {
  const chain = res.chain.join(" → ");
  const forMode = modeName ? ` for mode "${modeName}"` : "";
  let why: string;
  switch (res.reason) {
    case "cycle":
      why = `its alias chain loops back on itself (${chain})`;
      break;
    case "depth":
      why = `its alias chain is more than ${MAX_ALIAS_DEPTH} hops deep (${chain})`;
      break;
    case "variable-missing":
      why =
        `its alias points at a variable that isn't in this file's local variables (${chain}) — ` +
        `it likely lives in a library this token can't reach`;
      break;
    case "collection-missing":
      why = `its variable collection is missing from the file's variables response (${chain})`;
      break;
    case "no-value":
      why = `it defines no value${forMode}, nor for its collection's default mode (${chain})`;
      break;
    case "wrong-type":
      why = `its alias chain ends at a value that isn't ${expected} (${chain})`;
      break;
  }
  return (
    `Figma value unresolved — no comparison was made. The variable "${tokenName}" ` +
    `could not be resolved to ${expected}: ${why}. "${tokenName}" is a token NAME shown ` +
    `for context, not a value.`
  );
}

/** Narrow a resolved literal to Figma's `{r,g,b,a}` colour shape (floats 0..1). */
/**
 * The literal at the end of an alias chain, or `undefined` when the chain
 * couldn't be walked. Callers that only need the value use this; callers that
 * need to explain a failure keep the full `LiteralResolution` and hand it to
 * `describeUnresolvedVariable`.
 */
function literalValue(res: LiteralResolution): unknown {
  return res.ok ? res.value : undefined;
}

function asFigmaColor(raw: unknown): { r: number; g: number; b: number; a?: number } | undefined {
  if (raw && typeof raw === "object" && "r" in raw && "g" in raw && "b" in raw) {
    return raw as { r: number; g: number; b: number; a?: number };
  }
  return undefined;
}

/**
 * The variable's own `codeSyntax.WEB` as a spreadable fragment (#93).
 *
 * A helper rather than an inline spread because the colour path returns from more
 * than one place, and a name Figma states must not be attached to some rows and
 * omitted from others — an inconsistently-populated field reads as "Figma didn't
 * declare one", which is a false absence claim.
 */
function codeSyntaxOf(v: FigmaVariable): { codeSyntax?: string } {
  return v.codeSyntax?.WEB !== undefined ? { codeSyntax: v.codeSyntax.WEB } : {};
}

function resolveColorVariable(
  variableId: string,
  variables: FigmaLocalVariablesResponse,
  activeMode?: string,
): ResolvedFill | undefined {
  const v = variables.meta.variables[variableId];
  if (!v || v.resolvedType !== "COLOR") return undefined;
  const collection = variables.meta.variableCollections[v.variableCollectionId];
  if (!collection) return undefined;

  /**
   * Resolve for a named mode, but only when THIS variable's collection
   * actually has that mode. Without the guard, a single-mode collection would
   * answer every mode name with its default value and we'd emit a
   * `{light, dark}` map for a token that has no such thing. Alias hops deeper
   * in the chain are free to fall back — that's `resolveVariableLiteral`'s job.
   */
  const findByName = (modeName: string): string | undefined => {
    if (!findModeId(collection, modeName)) return undefined;
    const color = asFigmaColor(literalValue(resolveVariableLiteral(variableId, variables, modeName)));
    return color ? rgbaToCss(color) : undefined;
  };

  const light = findByName("light");
  const dark = findByName("dark");

  // The "comparison value" is the active mode if known, else the file default.
  const activeStr = activeMode ? findByName(activeMode) : undefined;
  const defaultColor = asFigmaColor(
    literalValue(resolveVariableLiteral(variableId, variables, undefined)),
  );
  const value = activeStr ?? (defaultColor ? rgbaToCss(defaultColor) : undefined);
  // A variable name is not a colour. Returning one here used to poison the
  // caller's raw-paint fallback and guarantee `drift` on every colour row
  // whose token aliases another token — report "unresolved" instead.
  if (value === undefined) return undefined;

  if (light && dark) {
    return { value, modes: { light, dark }, ...codeSyntaxOf(v) };
  }
  return { value, ...codeSyntaxOf(v) };
}

/* ------------------------------------------------------------------------- *
 * where a colour came from: paint style, and token tier
 * ------------------------------------------------------------------------- */

/**
 * Which layer of the design's colour system a bound variable sits in.
 *
 *  - `"semantic"` — its own collection has more than one mode, so the variable
 *    itself varies by theme. Nothing to say.
 *  - `"palette"` — it has exactly one mode, **and** this file themes colour in
 *    some other collection. Both halves are facts read from the variables
 *    response, and together they mean something specific: the design has a
 *    themed colour layer and this fill bypasses it, so it cannot follow the
 *    theme. (Live case: the Card's Image placeholder binds `Slate/200` from the
 *    single-mode `Color Primitives`, while `Background/Neutral/Tertiary` in
 *    `Color` aliases `Slate/200` under `SDS Light` and `Slate/900` under
 *    `SDS Dark`. The placeholder stays light grey on a dark card.)
 *  - `"undetermined"` — anything else, and it says nothing at all.
 *
 * The last case is load-bearing. A single-mode collection is completely normal
 * for Size, Radius and Typography, and it is normal for *colour* too in a
 * single-theme design system — so "one mode" alone is not evidence of a tier
 * mistake, and neither is a name that "looks like a palette". No name heuristic
 * is applied here: `Slate/200` and `Background/Neutral/Tertiary` are told apart
 * by their collections' mode counts, not by their spelling.
 */
type ColorTokenTier = "palette" | "semantic" | "undetermined";

function colorTokenTier(
  variableId: string,
  variables: FigmaLocalVariablesResponse,
): ColorTokenTier {
  const v = variables.meta.variables[variableId];
  if (!v || v.resolvedType !== "COLOR") return "undetermined";
  const own = variables.meta.variableCollections[v.variableCollectionId];
  if (!own) return "undetermined";
  if (own.modes.length > 1) return "semantic";

  // Single mode. Only meaningful if colour is themed elsewhere in this file.
  const themesColourElsewhere = Object.values(variables.meta.variables).some((other) => {
    if (other.resolvedType !== "COLOR") return false;
    if (other.variableCollectionId === v.variableCollectionId) return false;
    const c = variables.meta.variableCollections[other.variableCollectionId];
    return (c?.modes.length ?? 0) > 1;
  });
  return themesColourElsewhere ? "palette" : "undetermined";
}

/**
 * The multi-mode COLOR variables that alias **directly** to `variableId` — the
 * design's own semantic wrappers for this primitive, by construction rather than
 * by name similarity.
 *
 * One hop only. A deeper chain may well end at the same primitive, but naming a
 * two-hop ancestor as "the token you meant" is a guess, and a guess with a
 * variable name attached reads as a fact.
 */
function semanticWrappersOf(
  variableId: string,
  variables: FigmaLocalVariablesResponse,
): Array<{ name: string; collection: string }> {
  const out: Array<{ name: string; collection: string }> = [];
  for (const other of Object.values(variables.meta.variables)) {
    if (other.resolvedType !== "COLOR" || other.id === variableId) continue;
    const collection = variables.meta.variableCollections[other.variableCollectionId];
    if (!collection || collection.modes.length < 2) continue;
    const pointsHere = Object.values(other.valuesByMode).some(
      (raw) => asVariableAlias(raw)?.id === variableId,
    );
    if (pointsHere) out.push({ name: other.name, collection: collection.name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Everything true about where a paint's colour came from, as one sentence or
 * none. Attached to the row as `sourceAdvisory` — never as a status.
 *
 * Two independent facts, either or both of which may be present:
 *  1. the fill is delivered by a shared paint style (so the fix belongs in the
 *     style, not on the node — and until now the style was invisible in the
 *     report even though a paint style is how most real libraries ship fills);
 *  2. the bound variable is a palette primitive in a file that themes colour.
 */
function paintSourceAdvisory(opts: {
  styleName?: string | undefined;
  variableId?: string | undefined;
  variables: FigmaLocalVariablesResponse | null;
}): string | undefined {
  const parts: string[] = [];
  if (opts.styleName) {
    parts.push(
      `Delivered by the shared paint style "${opts.styleName}" — the binding below is the style's, ` +
        `so a change belongs in the style rather than on this node.`,
    );
  }
  if (opts.variableId && opts.variables) {
    const v = opts.variables.meta.variables[opts.variableId];
    if (v && colorTokenTier(opts.variableId, opts.variables) === "palette") {
      const collection =
        opts.variables.meta.variableCollections[v.variableCollectionId]?.name ?? "its collection";
      let sentence =
        `"${v.name}" is a single-mode variable in "${collection}", so this colour cannot follow the ` +
        `theme — it renders the same value in every mode.`;
      const wrappers = semanticWrappersOf(opts.variableId, opts.variables);
      if (wrappers.length > 0) {
        const named = wrappers
          .slice(0, 3)
          .map((w) => `"${w.name}" (${w.collection})`)
          .join(", ");
        sentence +=
          ` ${wrappers.length === 1 ? "The variable" : "Variables"} ${named} alias${wrappers.length === 1 ? "es" : ""} ` +
          `it and do${wrappers.length === 1 ? "es" : ""} vary per mode.`;
      }
      parts.push(sentence);
    }
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * Pick a numeric (FLOAT) variable's value for the active mode, falling back
 * to the file's default mode if the active one isn't defined. Follows alias
 * indirection — without it, an aliasing numeric token resolved to `null` and
 * the row was dropped from the report entirely.
 */
function resolveNumericForMode(
  v: FigmaVariable,
  variables: FigmaLocalVariablesResponse,
  activeMode?: string,
): number | null {
  const raw = literalValue(resolveVariableLiteral(v.id, variables, activeMode));
  return typeof raw === "number" ? raw : null;
}

/** Same, for STRING variables (font-family). */
function resolveStringForMode(
  v: FigmaVariable,
  variables: FigmaLocalVariablesResponse,
  activeMode?: string,
): string | null {
  const raw = literalValue(resolveVariableLiteral(v.id, variables, activeMode));
  return typeof raw === "string" ? raw : null;
}

interface FigmaBinding {
  tokenName: string;
  modes?: ModeAwareValue;
  /** The variable's own `codeSyntax.WEB`, verbatim, when it declares one (#93). */
  codeSyntax?: string;
}

/**
 * Map Figma's camelCase boundVariable keys to the CSS-property keys the
 * snapshot collects, so the diff joins instead of producing two rows.
 *
 * `rectangleCornerRadii` is a nested map and is expanded separately below.
 */
const FIGMA_KEY_TO_CSS: Record<string, string> = {
  paddingTop: "padding-top",
  paddingRight: "padding-right",
  paddingBottom: "padding-bottom",
  paddingLeft: "padding-left",
  itemSpacing: "gap",
  fills: "background-color",
  strokeWeight: "border-width",
  strokes: "border-color",
  effects: "box-shadow",
  // Typography — surface from either the variant root or its TEXT
  // descendants (the latter via `collectFigmaBindings`' tree walk).
  fontFamily: "font-family",
  fontSize: "font-size",
  fontWeight: "font-weight",
  // Binding (token-name) comparison only. A Figma `fontStyle` variable holds a
  // font *style name* ("Italic", "Semi Bold Italic") — a weight+slant compound
  // — so it must never be read as a CSS `font-style` *value*. The value side
  // reads `TypeStyle.italic`; see `text-style-map.ts`.
  fontStyle: "font-style",
  lineHeight: "line-height",
  letterSpacing: "letter-spacing",
  textCase: "text-transform",
  textDecoration: "text-decoration-line",
  textAlignHorizontal: "text-align",
};

/** Figma's TEXT-node binding keys that should bubble up to the parent FRAME
 *  for wiring purposes, since the snapshot target is usually the FRAME-level
 *  element in code (e.g. `.text-button`) which receives the cascaded text
 *  styles. The string values are the CSS-prop keys the story tokens use. */
const TEXT_CHILD_BUBBLE: Record<string, string> = {
  fills: "color",
  fontFamily: "font-family",
  fontSize: "font-size",
  fontWeight: "font-weight",
  fontStyle: "font-style",
  lineHeight: "line-height",
  letterSpacing: "letter-spacing",
  textCase: "text-transform",
  textDecoration: "text-decoration-line",
  textAlignHorizontal: "text-align",
};

const FIGMA_CORNER_TO_CSS: Record<string, string> = {
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: "border-top-left-radius",
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: "border-top-right-radius",
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: "border-bottom-left-radius",
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: "border-bottom-right-radius",
};

/**
 * The colour variable the **rendering** paint binds, for the wiring dimension.
 *
 * A switched-off paint may well bind a variable; that binding is not what the
 * element is wired to, and reporting it made the Wiring column name a token the
 * design had stopped using (#85).
 */
function visiblePaintColorAlias(
  paints: FigmaPaint[] | undefined,
): FigmaVariableAlias | undefined {
  const selection = pickVisiblePaint(paints);
  if (selection.kind !== "paint") return undefined;
  return selection.paint.boundVariables?.color;
}

function collectFigmaBindings(
  node: FigmaNode,
  variables: FigmaLocalVariablesResponse | null,
  activeMode?: string,
): Record<string, FigmaBinding> {
  const out: Record<string, FigmaBinding> = {};
  const raw = node.boundVariables ?? {};

  const setBinding = (property: string, alias: FigmaVariableAlias): void => {
    const v = variables?.meta.variables[alias.id];
    if (!v) {
      out[property] = { tokenName: alias.id };
      return;
    }
    const resolved =
      v.resolvedType === "COLOR" ? resolveColorVariable(alias.id, variables!, activeMode) : undefined;
    const binding: FigmaBinding = { tokenName: v.name };
    // See #93: carried so the row can prefer what Figma states over inference.
    if (v.codeSyntax?.WEB !== undefined) binding.codeSyntax = v.codeSyntax.WEB;
    if (resolved?.modes) binding.modes = resolved.modes;
    out[property] = binding;
  };

  for (const [figmaKey, alias] of Object.entries(raw)) {
    if (figmaKey === "rectangleCornerRadii") {
      // Expand the nested per-corner map into individual CSS-prop keys.
      const corners = alias as unknown as Record<string, FigmaVariableAlias>;
      for (const [cornerKey, cornerAlias] of Object.entries(corners)) {
        const cssProp = FIGMA_CORNER_TO_CSS[cornerKey];
        if (cssProp && cornerAlias) setBinding(cssProp, cornerAlias);
      }
      continue;
    }
    const aliases = Array.isArray(alias) ? alias : [alias];
    const first = aliases[0];
    if (!first) continue;
    // On a TEXT node `fills` is the text colour, not a background — Figma gives
    // a TEXT node no separate background paint. Mapping it to `background-color`
    // put the same variable on two rows, one of which could only ever read as
    // drift against a transparent computed background.
    const cssProp =
      node.type === "TEXT" && figmaKey === "fills"
        ? "color"
        : (FIGMA_KEY_TO_CSS[figmaKey] ?? figmaKey);
    setBinding(cssProp, first);
  }

  // Fall back to the rendering paint's `boundVariables.color` when the node has
  // no top-level `fills` boundVariable (some shapes carry it on the paint
  // instead). Same TEXT-node rule as above — and the *visible* paint, because a
  // switched-off paint's variable is not what this element is wired to (#85).
  const fillProperty = node.type === "TEXT" ? "color" : "background-color";
  if (!out[fillProperty]) {
    const fillAlias = visiblePaintColorAlias(node.fills);
    if (fillAlias) setBinding(fillProperty, fillAlias);
  }

  // Bubble TEXT-descendant bindings up to the variant root. Designers
  // typically bind typography vars on the inner TEXT layer; consumers
  // declare those same tokens on the FRAME-level element (e.g. `color`
  // and `font-size` on `.text-button`). Without this bubbling, the Wiring
  // column would falsely say "Figma has no bound variable for this
  // property" for color/font-* even though the design clearly does.
  const textNode = findFirstTextNode(node);
  if (textNode) {
    const textBound = textNode.boundVariables ?? {};
    for (const [figmaKey, cssProp] of Object.entries(TEXT_CHILD_BUBBLE)) {
      if (out[cssProp]) continue; // root-level binding wins
      const alias = pickAlias(textBound[figmaKey]);
      if (alias) {
        setBinding(cssProp, alias);
        continue;
      }
      // `fills` on TEXT is the color paint — try the visible paint's
      // `boundVariables.color`.
      if (figmaKey === "fills" && !out["color"]) {
        const fillAlias = visiblePaintColorAlias(textNode.fills);
        if (fillAlias) setBinding("color", fillAlias);
      }
    }
  }

  return out;
}

/**
 * Pick the "primary" TEXT descendant for typography comparison.
 *
 * Naïve depth-first picks whichever TEXT node happens to come first in the
 * tree, which is often a single-character glyph like "▾" / "▼" / "✓" — that
 * glyph runs in a different style (`chrome/glyph/*`) from the row's actual
 * label, so the diff reads the wrong typography. We instead score every
 * TEXT descendant and prefer ones that look like real labels:
 *
 *   - more characters wins
 *   - alphanumeric content wins over pure-symbol content
 *   - if a node IS itself a TEXT node, return it (preserves trivial case)
 *
 * Falls back to the first descendant when no candidate stands out (e.g.
 * single-glyph atoms like the Caret).
 *
 * Hidden descendants are not candidates (#85) — a switched-off label's
 * typography is not the component's typography. The bound node itself is read
 * even when hidden: see `isHiddenNode`.
 */
function findFirstTextNode(node: FigmaNode): FigmaNode | undefined {
  if (node.type === "TEXT") return node;
  const all: FigmaNode[] = [];
  const walk = (n: FigmaNode): void => {
    if (n.type === "TEXT") all.push(n);
    for (const child of n.children ?? []) {
      if (isHiddenNode(child)) continue;
      walk(child);
    }
  };
  walk(node);
  if (all.length === 0) return undefined;
  if (all.length === 1) return all[0];

  // Score each candidate; higher is better.
  const score = (n: FigmaNode): number => {
    const chars = (n as unknown as { characters?: string }).characters ?? "";
    let s = chars.length;
    if (/[a-zA-Z0-9]/.test(chars)) s += 100;
    return s;
  };
  let best = all[0]!;
  let bestScore = score(best);
  for (let i = 1; i < all.length; i++) {
    const cand = all[i]!;
    const cs = score(cand);
    if (cs > bestScore) {
      best = cand;
      bestScore = cs;
    }
  }
  return best;
}

function pickAlias(value: FigmaVariableAlias | FigmaVariableAlias[] | undefined): FigmaVariableAlias | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Compare a numeric Figma value against the code-side CSS for `cssProp`.
 * Pushes a `token-value` row if either side has data. When `alias` is set
 * (Figma variable bound), the resolved variable value wins over the raw
 * one and its name appears in the figma cell as "(token: …)".
 */
function pushTypographyNumeric(opts: {
  out: DimensionDiff[];
  snapshot: CodeSnapshot;
  variables: FigmaLocalVariablesResponse | null;
  activeMode: string | undefined;
  cssProp: string;
  rawValue: number | undefined;
  alias: FigmaVariableAlias | undefined;
  /** Skip the "px" suffix in the figma cell — useful for unitless props
   *  like font-weight. CSS comparison is on the parsed number either way. */
  unitless?: boolean;
}): void {
  const { out, snapshot, variables, activeMode, cssProp, rawValue, alias, unitless } = opts;
  let figmaValue: number | undefined = rawValue;
  let tokenName: string | undefined;
  if (alias && variables) {
    const v = variables.meta.variables[alias.id];
    if (v && v.resolvedType === "FLOAT") {
      const resolved = resolveNumericForMode(v, variables, activeMode);
      if (resolved !== null) {
        figmaValue = resolved;
        tokenName = v.name;
      }
    }
  }
  const codeValue = snapshot.styles[cssProp];
  // For font-weight, computed style can be "400" (unitless). parsePx will
  // return null. Fall back to parseFloat for unitless cases.
  const codeNum = unitless
    ? codeValue
      ? Number(codeValue)
      : null
    : parsePx(codeValue);
  if (figmaValue === undefined && codeNum === null) return;
  const status: DimensionDiff["status"] =
    figmaValue !== undefined && codeNum !== null && Math.abs(codeNum - figmaValue) < 0.5
      ? "match"
      : "drift";
  out.push({
    kind: "token-value",
    property: cssProp,
    codeValue: codeValue ?? null,
    figmaValue:
      figmaValue !== undefined
        ? tokenName
          ? `${figmaValue}${unitless ? "" : "px"} (token: ${tokenName})`
          : `${figmaValue}${unitless ? "" : "px"}`
        : null,
    status,
    ...(tokenName ? { tokenName } : {}),
  });
}

export const createFigmaRestEngine: EngineFactory = (ctx) => new FigmaRestEngine(ctx);
