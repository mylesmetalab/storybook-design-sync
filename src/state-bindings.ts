/**
 * Declared state bindings — comparing a forced pseudo-state against its own
 * Figma node.
 *
 * ## Why this exists
 *
 * A drift check measures the story as rendered, which is its *default* state.
 * A Button's hover fill, a Tab's active underline and a Menu Item's hover
 * background are all design decisions bound to Figma variables, and none of
 * them were compared. In the reference design file that is 37 `State=Hover`
 * nodes across 11 component sets — a clean report meant "the default state
 * matches", not "the component matches".
 *
 * ## The vocabulary is deliberately narrow: forced pseudo-states only
 *
 * The reference file's `State` axis carries eleven distinct values, and they
 * are **two different kinds of thing**:
 *
 *   - `Hover`, `Active`, `Disabled` — the browser owns these. Comparing them
 *     means *forcing* a pseudo-state on a rendered element.
 *   - `Error`, `Open`/`Closed`, `On`/`Off`, `Current` — the component owns
 *     these. They are props, or `data-state` attributes the component renders
 *     from its own args. Nothing needs forcing: a story that passes
 *     `error: true` renders that state already, and it is bound to its own
 *     Figma node by an ordinary registry entry.
 *
 * Only the first kind belongs here. Accepting `error` in this map would invite
 * forcing a state that is really an arg — producing a row that looks compared
 * but was reached the wrong way, which is the failure class this addon exists
 * to avoid. So the key set below is closed, and an unrecognised key is
 * reported with the reason rather than passed through.
 *
 * ```json
 * "ui-button--primary": {
 *   "nodeId": "4185:3779",
 *   "lastSyncedHash": null,
 *   "states": { "hover": "4185:3783" }
 * }
 * ```
 *
 * ## Why *declared*, not inferred
 *
 * Same reason as `children` (see `child-bindings.ts`). A `State=Hover` sibling
 * could often be found by walking the component set and substituting one
 * variant axis value — but "often" is the problem. A mis-paired node produces
 * drift numbers that are real and describe a different variant. Auto-suggestion
 * at *registration* time, where a human reviews the pairing before it is
 * committed, is reasonable future work; inferring it at check time is not.
 *
 * ## `visited`, `link` and `target` are deliberately absent
 *
 * The stylesheet rewriter can force them, but `:visited` styles are
 * intentionally unreadable through `getComputedStyle` — browsers restrict them
 * to prevent history sniffing. A `visited` binding could therefore never
 * produce a truthful comparison, only a silent match against the unvisited
 * value. `link` and `target` are document-navigation states rather than
 * component states. Accepting any of the three would be advertising a
 * comparison that cannot happen.
 *
 * Kept free of Storybook/React/DOM imports so it is unit-testable directly.
 */

/**
 * The pseudo-states a binding may name.
 *
 * Every one of these is forceable by the class-rewrite mechanism *and* readable
 * through `getComputedStyle`. Both halves are required — see the note on
 * `visited` above.
 */
export const FORCEABLE_STATES = [
  "hover",
  "active",
  "focus",
  "focus-visible",
  "focus-within",
  "disabled",
] as const;

export type ForceableState = (typeof FORCEABLE_STATES)[number];

/**
 * States that appear in real design files as a `State=` variant value but are
 * **not** pseudo-states. Named explicitly so the error message can explain
 * where they belong instead of just rejecting the key.
 */
const DECLARED_NOT_FORCED: Record<string, string> = {
  error: "a validation state the component renders from its own props",
  open: 'a disclosure state, normally a `data-state="open"` attribute',
  closed: 'a disclosure state, normally a `data-state="closed"` attribute',
  checked: "a form value the component renders from its own props",
  unchecked: "a form value the component renders from its own props",
  on: "a toggle value the component renders from its own props",
  off: "a toggle value the component renders from its own props",
  current: "a navigation state, normally `aria-current`",
  selected: "a selection state the component renders from its own props",
  default: "the state a story already renders — that is the entry's own `nodeId`",
};

/** States the rewriter can force but which cannot be truthfully compared. */
const UNREADABLE: Record<string, string> = {
  visited:
    "`:visited` styles are restricted by the browser and cannot be read through getComputedStyle, " +
    "so this could only ever report a false match",
  link: "a document-navigation state, not a component state",
  target: "a document-navigation state, not a component state",
};

export function isForceableState(value: string): value is ForceableState {
  return (FORCEABLE_STATES as readonly string[]).includes(value);
}

/** Registry shape: pseudo-state name → Figma node id. */
export type StateBindingMap = Partial<Record<ForceableState, string>>;

/** One well-formed declaration. */
export interface StateBindingDeclaration {
  state: ForceableState;
  nodeId: string;
}

/**
 * Outcome of a declared state binding. `compared` is the only value that means
 * rows exist for it; every other value means **no comparison ran** and the
 * report must say so.
 *
 * `no-computed-change` is the one that matters most and the one most likely to
 * be reported wrongly: forcing a state that moves nothing means either the
 * design and code agree that this state is visually identical, or the forcing
 * silently failed. We cannot tell those apart, so it is never a match.
 *
 * **It must only be decided after transitions have settled.** Reading
 * immediately after forcing returns the interpolated mid-transition value, so a
 * component with `transition-colors` — which is most of them — looks unchanged
 * when it is not. Measured 2026-08-03: an immediate read of the reference
 * Button reported the rest colour for a real pointer hover, a CDP-forced hover
 * and a class-forced hover alike.
 */
export type StateBindingStatus =
  | "compared"
  | "state-unknown"
  | "binding-malformed"
  | "not-forceable"
  | "no-computed-change"
  | "snapshot-missing"
  | "node-unreachable";

export interface StateBindingValidation {
  /** Well-formed declarations, in `FORCEABLE_STATES` order (stable output). */
  declarations: StateBindingDeclaration[];
  /**
   * Entries present in the registry that are not usable. Reported, never
   * dropped: each becomes a visible message.
   */
  malformed: Array<{ state: string; detail: string }>;
  /** Set when `states` itself is the wrong shape. No declarations can be read. */
  fatal?: string;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function stateKeyProblem(key: string): string | undefined {
  const lower = key.toLowerCase();
  if (isForceableState(lower)) return undefined;
  const declared = DECLARED_NOT_FORCED[lower];
  if (declared) {
    return (
      `"${key}" is ${declared}, not a pseudo-state, so there is nothing to force. ` +
      `Bind it as its own story instead: give the story args that render the state, ` +
      `and register that story against the Figma node for it.`
    );
  }
  const unreadable = UNREADABLE[lower];
  if (unreadable) {
    return `"${key}" is not supported: ${unreadable}.`;
  }
  return (
    `"${key}" is not a state this tool can force. Supported: ` +
    `${FORCEABLE_STATES.join(", ")}.`
  );
}

/**
 * Validate a registry entry's `states` field.
 *
 * Absent (`undefined` / `null`) is the legacy shape and is completely silent —
 * every pre-existing registry entry must behave exactly as it did before.
 */
export function validateStateBindings(raw: unknown): StateBindingValidation {
  if (raw === undefined || raw === null) return { declarations: [], malformed: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      declarations: [],
      malformed: [],
      fatal:
        `"states" must be an object mapping "<pseudo-state>" → "<figma node id>"; ` +
        `got ${typeName(raw)}.`,
    };
  }

  const found = new Map<ForceableState, string>();
  const malformed: Array<{ state: string; detail: string }> = [];

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      malformed.push({
        state: key,
        detail: `the key is empty — it must be one of: ${FORCEABLE_STATES.join(", ")}.`,
      });
      continue;
    }
    const problem = stateKeyProblem(trimmed);
    if (problem) {
      malformed.push({ state: trimmed, detail: problem });
      continue;
    }
    const state = trimmed.toLowerCase() as ForceableState;
    if (typeof value !== "string") {
      malformed.push({
        state,
        detail: `the value must be a Figma node id string; got ${typeName(value)}.`,
      });
      continue;
    }
    const nodeId = value.trim();
    if (nodeId.length === 0) {
      malformed.push({ state, detail: "the Figma node id is empty." });
      continue;
    }
    if (/\s/.test(nodeId)) {
      malformed.push({
        state,
        detail: `the Figma node id "${nodeId}" contains whitespace.`,
      });
      continue;
    }
    // A duplicate can only arrive via differing case or surrounding whitespace
    // ("hover" and "Hover"). Silently keeping one would make the registry's
    // meaning depend on key order, so it is reported.
    const existing = found.get(state);
    if (existing !== undefined && existing !== nodeId) {
      malformed.push({
        state: trimmed,
        detail:
          `"${state}" is declared more than once with different node ids ` +
          `(${existing} and ${nodeId}). Remove one.`,
      });
      continue;
    }
    found.set(state, nodeId);
  }

  // Emit in vocabulary order, not registry key order, so output is stable
  // regardless of how the JSON happens to be written.
  const declarations: StateBindingDeclaration[] = [];
  for (const state of FORCEABLE_STATES) {
    const nodeId = found.get(state);
    if (nodeId !== undefined) declarations.push({ state, nodeId });
  }
  return { declarations, malformed };
}

/**
 * Parse a `--state "<pseudo-state>=<nodeId>"` flag.
 *
 * Splits on the FIRST "=" rather than the last (which is what `--child` does):
 * a state name never contains "=", and a Figma node id never does either, so
 * first-split gives the better error on a typo like `hover=1:1=2:2`.
 */
export function parseStateFlag(raw: string): StateBindingDeclaration {
  const idx = raw.indexOf("=");
  const bad = (detail?: string): never => {
    throw new Error(
      `--state expects "<pseudo-state>=<figma node id>" (got "${raw}").` +
        (detail ? ` ${detail}` : ` Supported states: ${FORCEABLE_STATES.join(", ")}.`),
    );
  };
  if (idx <= 0 || idx === raw.length - 1) bad();
  const state = raw.slice(0, idx).trim().toLowerCase();
  const nodeId = raw.slice(idx + 1).trim();
  if (!state || !nodeId) bad();
  if (nodeId.includes("=")) {
    bad(`"${nodeId}" is not a node id — there is more than one "=" in the argument.`);
  }
  const problem = stateKeyProblem(state);
  // Refuse at parse time with the routing message, rather than writing a map
  // that `validateStateBindings` would then refuse on the way out.
  if (problem) bad(problem);
  return { state: state as ForceableState, nodeId };
}

/**
 * Shape-only audit across a whole registry, mirroring `auditChildBindings`.
 *
 * Deliberately has no DOM and no Figma access: it cannot know whether a state
 * is forceable on a given element or whether the node exists. Callers must say
 * so rather than implying the bindings are verified.
 */
export function auditStateBindings(
  stories: Record<string, { states?: unknown }>,
): {
  storiesWithStates: number;
  declaredBindings: number;
  issues: Array<{ storyId: string; state: string; detail: string }>;
} {
  let storiesWithStates = 0;
  let declaredBindings = 0;
  const issues: Array<{ storyId: string; state: string; detail: string }> = [];

  for (const [storyId, entry] of Object.entries(stories)) {
    const raw = entry?.states;
    if (raw === undefined || raw === null) continue;
    const { declarations, malformed, fatal } = validateStateBindings(raw);
    if (fatal) {
      issues.push({ storyId, state: "(all)", detail: fatal });
      continue;
    }
    if (declarations.length > 0) storiesWithStates += 1;
    declaredBindings += declarations.length;
    for (const m of malformed) issues.push({ storyId, state: m.state, detail: m.detail });
  }

  return { storiesWithStates, declaredBindings, issues };
}
