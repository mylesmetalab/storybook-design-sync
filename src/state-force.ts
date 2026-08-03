/**
 * Forcing a pseudo-state in the preview, so the rendered value can be compared
 * against the design's node for that state.
 *
 * ## The mechanism, and why it is this one
 *
 * A rendered element cannot be put into `:hover` from page JavaScript — measured
 * 2026-08-03 in headless Chromium, synthetic `pointerover`/`mouseover`/
 * `mouseenter`/`mousemove` are a complete no-op and `el.matches(":hover")` stays
 * false. What works is rewriting the stylesheet so a class triggers the same
 * declarations, then toggling that class. `design-sync-core`'s `rewriteSelector`
 * owns the selector logic; this module is the DOM plumbing around it.
 *
 * The same measurement showed the class form, a real pointer and CDP's
 * `CSS.forcePseudoState` all producing identical computed values, so there is no
 * fidelity argument for using CDP on the headless path — and using one mechanism
 * on both surfaces makes panel/headless agreement structural rather than
 * something to keep re-testing.
 *
 * ## Transitions are suspended, not waited out
 *
 * `getComputedStyle` during a transition returns the **interpolated** value. A
 * read taken right after forcing therefore reports the *rest* colour, which
 * makes a correctly-forced state look like it changed nothing — and the
 * applicability rule below would then report "not compared" for a state that
 * forced perfectly. This cost me an hour while settling the crux: every
 * mechanism, including a real pointer, appeared to do nothing.
 *
 * Waiting a fixed time would work and would be a timing guess. Suspending
 * transitions removes the problem by construction, and it is the mechanism dual
 * mode already uses for the same reason.
 *
 * ## The applicability rule
 *
 * Forcing a state that moves no computed value means one of two things: the
 * design and code agree this state is visually identical, or the forcing
 * silently failed. **Nothing here can tell those apart**, so it is never
 * reported as a match — it is reported as not compared, with the state named.
 * Same shape as dual mode's refusal when a theme switch moves no colour.
 */

import {
  pseudoStateClass,
  rewriteSelector,
  type RewritablePseudoState,
} from "@metalab/design-sync-core";

import type { CodeSnapshot } from "./engines/types.js";

/* ------------------------------------------------------------------------- *
 * Pure logic
 * ------------------------------------------------------------------------- */

/**
 * Which style properties differ between two snapshots of the same element.
 *
 * Compares the union of keys: a property present in one snapshot and absent from
 * the other is a difference, not something to skip. Returns them sorted so a
 * report's evidence list is stable.
 */
export function changedStyleProperties(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (before[key] !== after[key]) changed.push(key);
  }
  return changed.sort();
}

/**
 * Tailwind variant prefixes that mean "this state is expressed as a data
 * attribute the component writes from its own state", e.g. `data-disabled:`.
 *
 * Why this matters: on shadcn-over-Base-UI or Radix, `disabled` styling hangs
 * off `data-disabled`, which the library writes from React state. Adding a class
 * or setting the DOM `disabled` property does **not** make Base UI re-render, so
 * the attribute never appears and the forced rendering is missing the very
 * declarations the state is made of. Comparing that against Figma's
 * `State=Disabled` node would produce confident, wrong drift.
 *
 * The Design Inspector solves this with a library-derived attribute table
 * (~600 lines). Until that moves into core, this addon **declines** rather than
 * forcing a state it cannot reproduce faithfully.
 */
const DATA_STATE_VARIANT_RE = /(?:^|:)(?:group-|peer-)?data-([a-z-]+):/;

/**
 * Does this element style the requested state through a data attribute?
 *
 * Reads the element's own class list only. That is where Tailwind variant
 * classes literally live, so it is exact for the utility-class case this is
 * about; hand-written CSS keying off `[data-disabled]` is **not** detected, and
 * that limit is stated in the README rather than guessed at.
 */
export function stylesStateViaDataAttribute(
  classNames: readonly string[],
  state: string,
): boolean {
  const wanted = state.toLowerCase();
  for (const cls of classNames) {
    const m = DATA_STATE_VARIANT_RE.exec(cls);
    if (m && m[1] === wanted) return true;
  }
  return false;
}

/** Outcome of one declared state binding, as the preview sees it. */
export type StateForceOutcome =
  | {
      state: string;
      nodeId: string;
      kind: "compared";
      snapshot: CodeSnapshot;
      /** Properties that moved when the state was forced. Never empty. */
      changed: string[];
    }
  | {
      state: string;
      nodeId: string;
      /**
       * Forcing worked mechanically but nothing moved, so there is nothing to
       * attribute a comparison to. Not a match — see the module docstring.
       */
      kind: "no-computed-change";
    }
  | {
      state: string;
      nodeId: string;
      /** This addon cannot reproduce the state faithfully. `detail` says why. */
      kind: "not-forceable";
      detail: string;
    };

/**
 * Decide the outcome from the two snapshots, given the evidence.
 *
 * Pure so the honesty rule is unit-tested without a DOM: the interesting cases
 * are "changed nothing" and "declined", and both are about what we refuse to
 * claim rather than about DOM mechanics.
 */
export function classifyStateForce(args: {
  state: string;
  nodeId: string;
  /** Set when the state cannot be reproduced; short reason for the report. */
  declined?: string;
  before: Readonly<Record<string, string>>;
  forced: CodeSnapshot;
}): StateForceOutcome {
  const { state, nodeId, declined, before, forced } = args;
  if (declined !== undefined) {
    return { state, nodeId, kind: "not-forceable", detail: declined };
  }
  const changed = changedStyleProperties(before, forced.styles);
  if (changed.length === 0) {
    return { state, nodeId, kind: "no-computed-change" };
  }
  return { state, nodeId, kind: "compared", snapshot: forced, changed };
}

/**
 * The reason string for a declined state, kept next to the predicate so the
 * wording and the condition cannot drift apart.
 */
export function declineReason(state: string): string {
  return (
    `this element styles :${state} through a \`data-${state}\` attribute that the ` +
    `component library writes from its own state. Adding a class or setting the DOM ` +
    `property does not make the library re-render, so the forced rendering would be ` +
    `missing the declarations the state is made of. Bind this state as its own story ` +
    `instead — give the story the arg that renders it, and register that story ` +
    `against the Figma node for the state.`
  );
}

/* ------------------------------------------------------------------------- *
 * DOM plumbing (runs in the preview iframe)
 * ------------------------------------------------------------------------- */

const REWRITE_FLAG = "__designSyncPseudoRewritten";

/**
 * Append class-based parallel selectors to every rule in one stylesheet.
 *
 * Flagged after the first pass so repeated calls are cheap and the rewrite never
 * compounds. A cross-origin sheet cannot be read at all; it is flagged too, so
 * we stop retrying — and because its rules are therefore *not* rewritten, a
 * state whose styles live there will show up as `no-computed-change` rather than
 * as a false match. That is the right failure direction.
 */
export function rewriteStyleSheetForStates(sheet: CSSStyleSheet): void {
  const flagged = sheet as CSSStyleSheet & { [REWRITE_FLAG]?: boolean };
  if (flagged[REWRITE_FLAG]) return;
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    flagged[REWRITE_FLAG] = true;
    return;
  }
  rewriteRules(rules);
  flagged[REWRITE_FLAG] = true;
}

function rewriteRules(rules: CSSRuleList): void {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (rule === undefined) continue;
    const styleRule = rule as CSSStyleRule;
    if (typeof styleRule.selectorText === "string") {
      const original = styleRule.selectorText;
      const rewritten = rewriteSelector(original);
      if (rewritten !== original) {
        try {
          styleRule.selectorText = rewritten;
        } catch {
          // A browser that rejects the new selector list keeps the old one.
        }
      }
    }
    // Recurse into @media / @supports / @layer / @container. This is what makes
    // Tailwind's `hover:` utilities reachable at all — they sit inside
    // `@layer utilities > @media ((hover: hover))`.
    const grouping = rule as CSSGroupingRule;
    let inner: CSSRuleList | undefined;
    try {
      inner = grouping.cssRules;
    } catch {
      inner = undefined;
    }
    if (inner) rewriteRules(inner);
  }
}

/** Rewrite every readable stylesheet in the document. Idempotent. */
export function rewriteAllStyleSheetsForStates(doc: Document = document): void {
  let sheets: CSSStyleSheet[];
  try {
    sheets = Array.from(doc.styleSheets) as CSSStyleSheet[];
  } catch {
    return;
  }
  for (const sheet of sheets) rewriteStyleSheetForStates(sheet);
}

/**
 * Put `element` into `state` and return the undo.
 *
 * Records nothing beyond the class it added, because that is all it changes: the
 * real `disabled` property is deliberately **not** set here. Setting it would
 * make `:disabled` match but would not make a Base UI or Radix component
 * re-render its `data-disabled` attribute, producing a rendering that is neither
 * the default state nor the real disabled state. `stylesStateViaDataAttribute`
 * catches that case earlier and declines instead.
 */
export function forceState(element: HTMLElement, state: string): () => void {
  const cls = pseudoStateClass(state);
  if (element.classList.contains(cls)) return () => {};
  element.classList.add(cls);
  return () => element.classList.remove(cls);
}

/** Remove every state class this module might have added. */
export function clearForcedStates(
  element: HTMLElement,
  states: readonly string[],
): void {
  for (const state of states) element.classList.remove(pseudoStateClass(state));
}

/**
 * Snapshot each declared state in turn.
 *
 * The caller owns transition suspension and the snapshot function, so this stays
 * testable and so the suspension covers the whole sequence rather than being set
 * up and torn down per state.
 *
 * Every declaration produces exactly one outcome, in the order given. A state is
 * always un-forced before the next is forced, so outcomes never compound.
 */
export function snapshotForcedStates(args: {
  element: HTMLElement;
  declarations: ReadonlyArray<{ state: RewritablePseudoState | string; nodeId: string }>;
  /** The already-taken default-state snapshot, for the change comparison. */
  base: CodeSnapshot;
  /** Takes a snapshot of `element` as it currently renders. */
  snapshot: () => CodeSnapshot;
  /** Called between forcing and snapshotting, to flush style recalculation. */
  flush?: () => void;
}): StateForceOutcome[] {
  const { element, declarations, base, snapshot, flush } = args;
  const classNames = Array.from(element.classList);
  const outcomes: StateForceOutcome[] = [];

  for (const { state, nodeId } of declarations) {
    if (stylesStateViaDataAttribute(classNames, state)) {
      outcomes.push(
        classifyStateForce({
          state,
          nodeId,
          declined: declineReason(state),
          before: base.styles,
          forced: base,
        }),
      );
      continue;
    }
    const undo = forceState(element, state);
    try {
      flush?.();
      const forced = snapshot();
      outcomes.push(classifyStateForce({ state, nodeId, before: base.styles, forced }));
    } finally {
      undo();
      flush?.();
    }
  }
  return outcomes;
}
