import { EVENTS, type CheckDriftRequestPayload } from "./channels.js";

/**
 * One definition of what a "check this story" request contains.
 *
 * Both buttons in the panel go through here: **Check drift** (one story, the one
 * on screen) and **Check all** (a loop over the registry). They used to build
 * the payload separately, and drifted apart twice in one release cycle:
 *
 * - v0.0.42 (#78): the bulk path never read the **Both modes** checkbox, so a
 *   ticked box ran the whole registry in single mode and reported it as done.
 * - #80: the bulk path sent no `args`, so the Tailwind `cva()` resolver could not
 *   tell which variant was rendering and reported binding rows as drift. The same
 *   story came back with 7 drift rows from **Check all** and 4 from **Check
 *   drift**, with nothing in the panel saying which was right (4 was).
 *
 * The divergence was the defect, not either instance of it, so the fix is
 * structural: `requestStoryCheck` is the only place a `CheckDriftRequestPayload`
 * is built or emitted, and the per-story context it sends is read from one
 * function. A field added here reaches both paths or neither.
 * `check-request.test.ts` asserts both properties, including at source level.
 */

/** The `parameters.designSync` surface a check request is built from. */
export interface StoryDesignSyncParams {
  /** CSS selector for the element to snapshot. Keys the CSS-scanner bindings. */
  target?: string;
  /** Deprecated per-story token bindings (superseded by the CSS scanner). */
  tokens?: Record<string, string>;
  /** Attribute on `<html>` carrying the active mode name. */
  modeAttribute?: string;
  /** How this project switches theme — see `mode-switch.ts` (#69). */
  modeSwitch?: unknown;
  /**
   * The two mode names a **Both modes** check should snapshot, overriding
   * `["light", "dark"]`. Typed `unknown` because it comes from a consumer's story
   * file: `dualModeNames` decides whether it is usable.
   */
  modes?: unknown;
  /**
   * `false` turns the `copy` dimension off for this story (#63). Figma cannot
   * express "this text is a placeholder", so a component whose design holds lorem
   * and whose stories hold product copy would otherwise drift forever.
   */
  compareCopy?: boolean;
  /** Where per-row applies POST to. Not part of a check request. */
  pipelineUrl?: string;
}

/**
 * The slice of Storybook's manager API this module reads.
 *
 * `getData(storyId)` is Storybook's own per-story accessor: for a prepared story
 * it carries the same `parameters` and `args` that `useParameter()` and
 * `useArgs()` return for the *current* story — both of those hooks are
 * implemented on top of it (`useArgs` → `getCurrentStoryData().args`,
 * `useParameter` → `getCurrentParameter` → `getData(storyId).parameters[key]`).
 * That equivalence is what lets one reader serve both paths: the panel's own
 * story and a story the bulk loop just navigated to are read the same way.
 *
 * Note the name: there is no `getStoryData` on the Storybook 10 API. The manager
 * called `sbApi?.getStoryData?.(...)` in two places and, being optional-chained,
 * it silently evaluated to `undefined` every time.
 */
export interface StoryDataReader {
  getData?: (storyId: string, refId?: string) => unknown;
}

export type CheckTrigger = "explicit" | "bulk";

/**
 * Everything a check request is built from. Constructed only by
 * `storyCheckContext`, so a new field lands on both paths at once; every field
 * is required, so an unpopulated one is a compile error rather than a silently
 * absent payload key.
 */
export interface StoryCheckContext {
  storyId: string;
  designSync: StoryDesignSyncParams;
  args: Record<string, unknown> | undefined;
  dualMode: boolean;
  /**
   * `"bulk"` means "one story of a Check all run": the engine's caches are what
   * make ~90 stories affordable against Figma's rate limits. `"explicit"` is a
   * human pressing Check drift, which is a request for the truth, so the engine
   * revalidates. The only field the two paths are *meant* to disagree on.
   */
  trigger: CheckTrigger;
}

export type EmitFn = (event: string, ...args: unknown[]) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read one story's `parameters.designSync`. Absent (rather than guessed) when the
 * story isn't in the index yet, isn't prepared, or declares nothing — the caller
 * gets `{}` and the request simply carries no declarations, which is what an
 * undeclared story means.
 */
export function readStoryDesignSync(
  api: StoryDataReader | undefined,
  storyId: string,
): StoryDesignSyncParams {
  const entry = readStoryEntry(api, storyId);
  if (!entry) return {};
  const parameters = entry["parameters"];
  if (!isRecord(parameters)) return {};
  const designSync = parameters["designSync"];
  return isRecord(designSync) ? (designSync as StoryDesignSyncParams) : {};
}

/**
 * Read one story's current args — the live ones, including control edits, because
 * Storybook writes `STORY_ARGS_UPDATED` back onto the same index entry that
 * `useArgs()` reads.
 *
 * `undefined` for a story with no args, and for an empty args object: the props
 * dimension and the `cva()` resolver both treat "no args" and "{}" alike, and
 * omitting the key keeps a bulk request byte-identical to the explicit one.
 */
export function readStoryArgs(
  api: StoryDataReader | undefined,
  storyId: string,
): Record<string, unknown> | undefined {
  const entry = readStoryEntry(api, storyId);
  if (!entry) return undefined;
  const args = entry["args"];
  if (!isRecord(args) || Object.keys(args).length === 0) return undefined;
  return args;
}

function readStoryEntry(
  api: StoryDataReader | undefined,
  storyId: string,
): Record<string, unknown> | undefined {
  if (typeof api?.getData !== "function") return undefined;
  const entry = api.getData(storyId);
  return isRecord(entry) ? entry : undefined;
}

/**
 * Warn once per story when the manager API could not be read at all, rather than
 * sending a context-free request that looks like a story with nothing declared.
 * That silence is exactly how #80 survived: a request missing `args` produces a
 * confident report, just a wrong one.
 */
const contextUnreadableWarned = new Set<string>();
function warnContextUnreadable(storyId: string, reason: string): void {
  if (contextUnreadableWarned.has(storyId)) return;
  contextUnreadableWarned.add(storyId);
  // eslint-disable-next-line no-console
  console.warn(
    `[design-sync] ${storyId}: could not read the story's parameters or args from ` +
      `the Storybook manager API (${reason}). The check will run without them, so ` +
      "declared targets and variant args are not part of this report.",
  );
}

/**
 * One-time-per-story deprecation warning for the legacy
 * `parameters.designSync.tokens` story param. Token bindings are now derived from
 * CSS by the preset's scanner; the param is kept as a fallback for a single
 * release before removal. Lives here so both check paths warn — the bulk path
 * never did, because it never read the param.
 */
const tokensDeprecationWarned = new Set<string>();
function warnTokensDeprecated(storyId: string): void {
  if (tokensDeprecationWarned.has(storyId)) return;
  tokensDeprecationWarned.add(storyId);
  // eslint-disable-next-line no-console
  console.warn(
    `[design-sync] ${storyId}: parameters.designSync.tokens is deprecated. ` +
      "Bindings are now derived from your CSS — you can remove the `tokens` " +
      "block. CSS-derived bindings take precedence where they exist.",
  );
}

/**
 * The story's declared mode names, or `undefined` to mean "use the default pair".
 *
 * Anything other than exactly two non-empty strings is refused and warned about:
 * a one-element or misspelled `modes` array can't be half-honoured, and silently
 * substituting `["light", "dark"]` for it would report a two-mode comparison the
 * story never asked for.
 */
export function dualModeNames(storyId: string, modes: unknown): [string, string] | undefined {
  if (modes === undefined) return undefined;
  const usable =
    Array.isArray(modes) &&
    modes.length === 2 &&
    modes.every((m) => typeof m === "string" && m.trim().length > 0);
  if (!usable) {
    warnModesUnusable(storyId, modes);
    return undefined;
  }
  return [modes[0] as string, modes[1] as string];
}

const modesWarned = new Set<string>();
function warnModesUnusable(storyId: string, modes: unknown): void {
  if (modesWarned.has(storyId)) return;
  modesWarned.add(storyId);
  // eslint-disable-next-line no-console
  console.warn(
    `[design-sync] ${storyId}: parameters.designSync.modes must be exactly two ` +
      `non-empty mode names, e.g. ["light", "dark"] — got ${JSON.stringify(modes)}. ` +
      "Ignoring it; a Both modes check will use light and dark.",
  );
}

/**
 * Gather every piece of per-story context a check request needs. The single
 * source for both paths: `dualMode` is a panel-level control the caller passes
 * in, everything else is read from the story itself — so a bulk run applies each
 * story's own `modeSwitch`/`target` instead of the panel's current story's.
 */
export function storyCheckContext(
  api: StoryDataReader | undefined,
  storyId: string,
  opts: { dualMode: boolean; trigger: CheckTrigger },
): StoryCheckContext {
  if (typeof api?.getData !== "function") {
    warnContextUnreadable(storyId, "no getData on the manager API");
  } else if (readStoryEntry(api, storyId) === undefined) {
    warnContextUnreadable(storyId, "the story is not in the index");
  }
  return {
    storyId,
    designSync: readStoryDesignSync(api, storyId),
    args: readStoryArgs(api, storyId),
    dualMode: opts.dualMode,
    trigger: opts.trigger,
  };
}

/**
 * The only constructor of a `CheckDriftRequestPayload`. Optional keys are set
 * only when declared, so the wire payload (and therefore the cache hash) is
 * unchanged for a story that declares nothing.
 */
export function buildCheckDriftRequest(ctx: StoryCheckContext): CheckDriftRequestPayload {
  const { designSync } = ctx;
  const payload: CheckDriftRequestPayload = { storyId: ctx.storyId };
  if (designSync.target) payload.target = designSync.target;
  if (designSync.tokens) payload.tokens = designSync.tokens;
  if (designSync.modeAttribute) payload.modeAttribute = designSync.modeAttribute;
  // Relayed even when absent-shaped, so the preview can tell "declared" from
  // "detect it" — the distinction #69 turned on.
  if (designSync.modeSwitch !== undefined) payload.modeSwitch = designSync.modeSwitch;
  if (ctx.args !== undefined) payload.args = ctx.args;
  if (ctx.dualMode) {
    payload.dualMode = true;
    const modes = dualModeNames(ctx.storyId, designSync.modes);
    if (modes) payload.dualModes = modes;
  }
  if (ctx.trigger === "bulk") payload.bulk = true;
  // Sent only when the story actually declared it, so a story that says nothing
  // keeps a byte-identical payload (and therefore cache hash).
  if (designSync.compareCopy === false) payload.compareCopy = false;
  return payload;
}

/**
 * Ask for one story to be checked. `Check drift` calls this once; `Check all`
 * calls it per story. Returns what it sent, which is what the invariant test
 * compares across the two triggers.
 */
export function requestStoryCheck(
  emit: EmitFn,
  api: StoryDataReader | undefined,
  storyId: string,
  opts: { dualMode: boolean; trigger: CheckTrigger },
): CheckDriftRequestPayload {
  const payload = buildCheckDriftRequest(storyCheckContext(api, storyId, opts));
  if (payload.tokens) warnTokensDeprecated(storyId);
  emit(EVENTS.CheckDriftRequest, payload);
  return payload;
}
