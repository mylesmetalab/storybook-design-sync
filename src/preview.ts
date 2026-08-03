import { addons } from "storybook/preview-api";
import {
  EVENTS,
  type CheckDriftRequestPayload,
  type ChildBindingsInfoPayload,
  type ChildSnapshotEntry,
  type StateSnapshotEntry,
  type CodeSnapshotPayload,
} from "./channels.js";
import type { CodeSnapshot } from "./engines/types.js";
import {
  clearForcedStates,
  rewriteAllStyleSheetsForStates,
  snapshotForcedStates,
} from "./state-force.js";
import {
  normalizeBindingKey,
  compositeBorderTokens,
} from "./binding-shape.js";
import { resolveStoryRoot } from "./story-root.js";
import {
  resolveChildElements,
  type ChildBindingDeclaration,
  type ChildElementResolution,
} from "./child-bindings.js";
import {
  MODE_SWITCH_PHASE_BUDGET_MS,
  applyMode,
  createStyleFlusher,
  fingerprint,
  parseModeSwitch,
  resolveModeSwitch,
  staleModeReason,
  switchUnavailableReason,
  type ModeSwitchElement,
  type ModeSwitchHosts,
  type ModeSwitchRestore,
} from "./mode-switch.js";
import { withBudget } from "./bulk-run.js";

const SNAPSHOT_PROPERTIES = [
  // Box / background
  "background-color",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  // Borders — uniform borders read from the top side; longhands available
  // for completeness if a component declares them per-side.
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  // Layout — compared against Figma auto-layout by the `structure` dimension
  // (`engines/layout.ts`). `display` is not compared to anything itself: it is
  // the *applicability* evidence, and without it the layout comparison refuses
  // to run at all, because `flex-direction: row` is reported on every plain
  // block element whether or not it lays out anything.
  "gap",
  "display",
  "flex-direction",
  "justify-content",
  "align-items",
  "flex-wrap",
  // Typography — useful for components with text content. Inherited values
  // resolve on `getComputedStyle`, so a button with no inner text still
  // reports the cascaded font.
  "color",
  "font-size",
  "font-weight",
  "font-family",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-decoration-line",
  "text-transform",
  "text-align",
  // Not compared against Figma — collected because `text-align` needs it.
  // Computed `text-align` reports the initial value `start` on any element that
  // never sets the property, and resolving `start`/`end` to left/right without
  // knowing the writing direction would be a guess.
  "direction",
  // Effects
  "box-shadow",
  // Compared against Figma's `node.opacity` since v0.0.39 (same 0..1 scale on
  // both sides, so the comparison needs no conversion).
  "opacity",
] as const;

/**
 * Story-root resolution — including portalled overlay content (Radix / Base UI
 * Dialog, Popover, Tooltip, Select, Menu all render outside `#storybook-root`)
 * — lives in `story-root.ts` so it can be unit-tested against a DOM without
 * importing Storybook's preview API. See that file for the resolution order and
 * the ambiguity rules.
 */

/**
 * Pull a token name out of an inline-style value. Accepts:
 *   - bare `var(--token)` references (the common case)
 *   - compound values where exactly one `var()` reference is the
 *     binding (e.g. `1px solid var(--row-border-bottom)` — common when
 *     consumers use CSS shorthand like `borderBottom: "1px solid var(...)"`)
 *
 * Ambiguous compound values (multiple `var()` references) return null so
 * we don't guess which one is "the" binding.
 *
 * `var(--font-size-11)` → "font-size-11"
 * `var(--label-text, #fff)` → "label-text"
 * `1px solid var(--row-border-bottom)` → "row-border-bottom"
 * `var(--a), var(--b)` → null (ambiguous)
 * `11px` → null (literal, no binding)
 */
const INLINE_VAR_ANY = /var\(\s*--([a-zA-Z0-9_-]+)\s*(?:,[^)]*)?\)/g;
function extractInlineVarToken(value: string): string | null {
  const matches = [...value.matchAll(INLINE_VAR_ANY)];
  if (matches.length !== 1) return null;
  return matches[0]![1] ?? null;
}

/**
 * Parse a raw inline `style="…"` attribute value into prop/value pairs.
 * Naive split on `;` then `:` — sufficient for declarations with `var(...)`
 * because var()'s nested parens never contain a `;` and we trim around
 * the first colon (not split, so colons inside `url(...)` etc. survive).
 *
 * Returned values are trimmed; declarations with empty prop or value are
 * skipped.
 */
function parseInlineStyle(raw: string): Array<{ prop: string; value: string }> {
  const out: Array<{ prop: string; value: string }> = [];
  for (const part of raw.split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (!prop || !value) continue;
    out.push({ prop, value });
  }
  return out;
}

// `compositeBorderTokens` + `normalizeBindingKey` live in
// `binding-shape.ts` so scan-tsx, scan-css, and this DOM scanner share
// one definition. Keep extraction logic in sync by editing there only.

function snapshotElement(el: HTMLElement): CodeSnapshot {
  const cs = window.getComputedStyle(el);
  const styles: Record<string, string> = {};
  for (const prop of SNAPSHOT_PROPERTIES) {
    styles[prop] = cs.getPropertyValue(prop).trim();
  }

  // Bindings: data-token-* attrs map a CSS prop → token name.
  const bindings: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith("data-token-")) {
      bindings[attr.name.slice("data-token-".length)] = attr.value;
    }
  }

  // Inline-style binding scan. Inline-styled components (React style={{…}},
  // styled-components rendered as DOM style attrs, anything that ends up
  // as `style="foo: var(--bar)"` in the rendered markup) carry their
  // bindings on the rendered element. We parse the raw `style` attribute
  // string rather than iterating `el.style` because the CSSStyleDeclaration
  // path drops some shorthand entries when their value contains `var(...)`
  // (Chrome doesn't enumerate `background: var(--x)` via item()), and we
  // also need access to the original composite-shorthand strings to
  // extract a single token reference embedded in them (e.g.
  // `border-bottom: 1px solid var(--row-border-bottom)`).
  //
  // data-token-* attributes still win when both are present (they're an
  // explicit override).
  const rawStyleAttr = el.getAttribute("style") ?? "";
  for (const decl of parseInlineStyle(rawStyleAttr)) {
    // Path 1: whole-value bare-var. Most common case; supported on every
    // property the engines compare against.
    const bareToken = extractInlineVarToken(decl.value);
    if (bareToken) {
      const key = normalizeBindingKey(decl.prop);
      if (!bindings[key]) bindings[key] = bareToken;
      continue;
    }
    // Path 2: composite border/outline shorthand carrying a single var().
    // Maps the var to <side>-color so the engine's binding diff sees a
    // wiring on the longhand it compares against.
    for (const [longhand, token] of compositeBorderTokens(decl.prop, decl.value)) {
      const key = normalizeBindingKey(longhand);
      if (!bindings[key]) bindings[key] = token;
    }
  }

  // Visible text content: split innerText on whitespace-y separators and
  // keep non-empty trimmed strings. Used by the `copy` dimension to check
  // that each Figma TEXT-node character string appears somewhere in the
  // rendered story.
  const rawText = el.innerText ?? "";
  const texts = Array.from(
    new Set(
      rawText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );

  // The element's OWN text — direct child text nodes only, deliberately not the
  // subtree. This is what tells a `<h3>Title</h3>` (whose type the design
  // specifies) from a `<div data-slot="body">` wrapper (whose type is inherited
  // and specifies nothing). `Node.TEXT_NODE` is 3; the numeric literal avoids
  // depending on the `Node` global being present.
  //
  // Concatenated untrimmed and trimmed later, so a wrapper's whitespace-only
  // text nodes (the newlines between JSX children) read as "no own text".
  const ownText = Array.from(el.childNodes)
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent ?? "")
    .join("");

  // Variant signals — collect both styles consumers actually use:
  //  - BEM modifiers:    ".icon-button--accent"  → suffix "accent"
  //  - Adjacent classes: ".file-item.active"     → "active" (any class
  //                                                 after the first/base)
  //
  // We send all candidates; the engine matches case-insensitively against
  // Figma's variant values.
  const allClasses = Array.from(el.classList);
  const candidates = new Set<string>();
  // Adjacent modifiers: any class after the first (which is the base).
  for (const c of allClasses.slice(1)) candidates.add(c);
  // BEM modifiers: include the suffix after `--` of any class.
  for (const c of allClasses) {
    const i = c.indexOf("--");
    if (i !== -1) candidates.add(c.slice(i + 2));
  }
  const variantClasses = [...candidates];

  // The raw list too: expanding to candidates loses which convention (if any)
  // produced them, and the engine needs that to decide whether the variant-set
  // comparison applies to this component at all.
  const inputType = el.getAttribute?.("type");
  return {
    styles,
    bindings,
    variantClasses,
    rootClasses: allClasses,
    texts,
    ownText,
    tagName: el.tagName,
    ...(inputType ? { inputType } : {}),
  };
}

const channel = addons.getChannel();

/**
 * Read the active mode from the rendered DOM. Default attribute is
 * `data-theme` (the common theming convention). Falls back to "light".
 *
 * The attribute is read off the document root (`<html>`) but stories using
 * a wrapping element can override via `parameters.designSync.modeAttribute`
 * pointing to a different attribute.
 */
/**
 * Read the active mode from the host document. Returns the attribute's
 * value when set (e.g. "light" / "dark"), `undefined` when the attribute
 * is missing so the engine can resolve mode-aware values from Figma's
 * default mode rather than silently guessing "light".
 *
 * Pre-fix this returned "light" on missing — every Storybook iframe
 * without a theme attribute looked like an explicit light-mode opinion,
 * which produced cross-mode false drift against dark-default Figma files.
 */
function readActiveMode(modeAttribute = "data-theme"): string | undefined {
  const root = document.documentElement;
  const value = root.getAttribute(modeAttribute);
  return value ? value.toLowerCase() : undefined;
}

/**
 * Inject a stylesheet that disables all transitions and animations. Returns
 * a cleanup function. Used during dual-mode toggling so the snapshot reads
 * the *target* mode value, not a transition midpoint.
 */
function suspendTransitions(): () => void {
  const style = document.createElement("style");
  style.setAttribute("data-design-sync-suspend-transitions", "");
  style.textContent =
    "*,*::before,*::after{transition:none!important;animation:none!important;}";
  document.head.appendChild(style);
  // Force the new style to apply before the caller toggles attributes.
  void document.documentElement.offsetHeight;
  return () => style.remove();
}

/** Read a layout property to force a synchronous style + layout recalculation. */
function forceReflow(): void {
  void document.documentElement.offsetHeight;
}

/**
 * Wait for the browser to flush style + layout after a theme change.
 *
 * The frame callback is **raced against a timer** rather than awaited. This was a
 * plain `requestAnimationFrame(() => requestAnimationFrame(resolve))`, and rAF does
 * not fire in a document the browser considers hidden — a backgrounded tab, an
 * inactive window. Measured live in the consumer: `visibilityState: "hidden"`,
 * rAF never fired in 3s, `setTimeout` fired. So every dual-mode check parked on
 * the first flush, before any comparison and upstream of every budget (issue #78).
 *
 * The policy and the race live in `mode-switch.ts` so they are unit-tested; this
 * is only the wiring to the real DOM.
 */
const waitForStyleFlush = createStyleFlusher({
  raf:
    typeof requestAnimationFrame === "function"
      ? (cb) => void requestAnimationFrame(cb)
      : undefined,
  setTimer: (cb, ms) => void setTimeout(cb, ms),
  forceReflow,
});

/**
 * Ask the server which child elements the registry binds for this story. The
 * registry is a file on the Node side, so the preview cannot read it; asking
 * *before* snapshotting is what lets the children be captured in the same pass
 * (and, in a dual-mode run, in the same two mode passes) as the root.
 *
 * On timeout we resolve to `[]` and snapshot the root only. That is not a silent
 * loss: the server compares the declarations it knows about against the
 * `childSnapshots` it receives and reports every absent one as
 * `snapshot-missing`.
 */
const CHILD_BINDINGS_TIMEOUT_MS = 2000;

interface DeclaredBindings {
  children: ChildBindingDeclaration[];
  states: Array<{ state: string; nodeId: string }>;
}

const NO_BINDINGS: DeclaredBindings = { children: [], states: [] };

function requestBindings(storyId: string): Promise<DeclaredBindings> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: DeclaredBindings): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      channel.off(EVENTS.ChildBindingsInfo, onInfo);
      resolve(value);
    };
    const onInfo = (info: ChildBindingsInfoPayload): void => {
      if (!info || info.storyId !== storyId) return;
      done({
        children: Array.isArray(info.children) ? info.children : [],
        states: Array.isArray(info.states) ? info.states : [],
      });
    };
    const timer = setTimeout(() => done(NO_BINDINGS), CHILD_BINDINGS_TIMEOUT_MS);
    channel.on(EVENTS.ChildBindingsInfo, onInfo);
    channel.emit(EVENTS.ChildBindingsRequest, { storyId });
  });
}

/**
 * Force each declared pseudo-state and snapshot the root in it.
 *
 * Wiring only — the mechanism, the honesty rule and the decline predicate live in
 * `state-force.ts` where they are unit-tested. Three things this owns:
 *
 * 1. **The stylesheet rewrite happens here, lazily.** A `:hover` rule cannot be
 *    triggered by a class until its selector has the parallel form appended, and
 *    doing it only when a story actually declares a state means a project with no
 *    state bindings pays nothing and has its stylesheets left alone.
 * 2. **Transitions are suspended across the whole sequence**, not per state.
 *    `getComputedStyle` mid-transition returns the interpolated value, so an
 *    unsuspended read reports the rest value and a correctly-forced state looks
 *    like it changed nothing — which the honesty rule would then report as "not
 *    compared". Suspending removes the timing question rather than guessing at it.
 * 3. **The document is restored even if a snapshot throws.** A surviving
 *    `pseudo-hover` class would leave this story — and, because the preview
 *    iframe persists, every story checked after it — reading as hovered.
 */
function snapshotDeclaredStates(
  target: HTMLElement,
  base: CodeSnapshot,
  declarations: ReadonlyArray<{ state: string; nodeId: string }>,
): StateSnapshotEntry[] {
  if (declarations.length === 0) return [];
  rewriteAllStyleSheetsForStates(document);
  const restoreTransitions = suspendTransitions();
  try {
    return snapshotForcedStates({
      element: target,
      declarations,
      base,
      snapshot: () => snapshotElement(target),
      flush: forceReflow,
    });
  } finally {
    clearForcedStates(
      target,
      declarations.map((d) => d.state),
    );
    restoreTransitions();
    forceReflow();
  }
}

/**
 * Snapshot every resolved child with the *same* `snapshotElement` the root uses,
 * so every property that works for the root works for a child. Unresolved
 * declarations still produce an entry — carrying their resolution kind, so the
 * server can word the failure — because a dropped entry is exactly the silence
 * this feature exists to prevent.
 *
 * `parameters.designSync.tokens` is deliberately NOT merged in: those bindings are
 * declared for the story's root element, so copying them onto a child would put
 * an authoritative-looking token name on an element they don't describe. A child's
 * bindings come from its own `data-token-*` attributes, its own inline styles, and
 * the CSS scanner's entry for its own selector (merged server-side).
 */
function snapshotChildren(
  resolutions: readonly ChildElementResolution[],
): ChildSnapshotEntry[] {
  return resolutions.map((r): ChildSnapshotEntry => {
    if (r.kind === "found") {
      return {
        selector: r.selector,
        nodeId: r.nodeId,
        kind: "found",
        snapshot: snapshotElement(r.element),
      };
    }
    if (r.kind === "ambiguous") {
      return {
        selector: r.selector,
        nodeId: r.nodeId,
        kind: "ambiguous",
        candidates: r.candidates,
      };
    }
    if (r.kind === "invalid") {
      return { selector: r.selector, nodeId: r.nodeId, kind: "invalid", detail: r.detail };
    }
    return {
      selector: r.selector,
      nodeId: r.nodeId,
      kind: "not-found",
      rootMatches: r.rootMatches,
    };
  });
}

/** Attach a second-mode snapshot to the matching child entry, by selector. */
function attachChildMode(
  entries: ChildSnapshotEntry[],
  extra: ChildSnapshotEntry[],
  mode: string,
): void {
  const bySelector = new Map(extra.map((e) => [e.selector, e]));
  for (const entry of entries) {
    if (entry.kind !== "found") continue;
    const other = bySelector.get(entry.selector);
    if (other?.kind === "found" && other.snapshot) {
      entry.additionalSnapshots = [{ mode, snapshot: other.snapshot }];
    }
  }
}

/**
 * The elements whose computed styles count as evidence that a theme switch
 * landed. The story root and its bound children first — they are what the report
 * is about — then `<body>` and `<html>`, which catch a theme that works but whose
 * effect on this particular component is nil.
 */
function modeEvidence(target: HTMLElement, children: readonly ChildElementResolution[]): Element[] {
  const out: Element[] = [target];
  for (const child of children) if (child.kind === "found") out.push(child.element);
  if (document.body) out.push(document.body);
  out.push(document.documentElement);
  return out;
}

function readComputed(el: unknown): Record<string, string> {
  const cs = window.getComputedStyle(el as Element);
  const out: Record<string, string> = {};
  for (const prop of [
    "background-color",
    "color",
    "border-top-color",
    "border-bottom-color",
    "box-shadow",
    "outline-color",
  ]) {
    out[prop] = cs.getPropertyValue(prop).trim();
  }
  return out;
}

/** `<html>` and `<body>` as the mode-switch module's minimal element shape. */
function modeHosts(): ModeSwitchHosts {
  const html = document.documentElement as unknown as ModeSwitchElement;
  const body = (document.body ?? document.documentElement) as unknown as ModeSwitchElement;
  return { html, body };
}

channel.on(EVENTS.CheckDriftRequest, async (payload: CheckDriftRequestPayload) => {
  const resolution = resolveStoryRoot({
    doc: document,
    selector: payload.target,
    storyId: payload.storyId,
  });
  if (resolution.kind !== "found") {
    // Ambiguity is reported, never resolved by picking one: snapshotting the
    // wrong element yields drift numbers that are real but describe something
    // else, which is the worst failure mode this addon has.
    channel.emit(EVENTS.DriftError, {
      storyId: payload.storyId,
      message:
        resolution.kind === "ambiguous"
          ? `${resolution.message} Candidates: ${resolution.candidates.join(" | ")}`
          : resolution.message,
    });
    return;
  }
  const target = resolution.element;

  const modeAttribute = payload.modeAttribute ?? "data-theme";

  // Declared child bindings, resolved once against the settled DOM. Resolution
  // is mode-independent (a theme toggle doesn't change which elements match), so
  // it happens here rather than inside each mode pass.
  const declared = await requestBindings(payload.storyId);
  const declarations = declared.children;
  const childResolutions =
    declarations.length > 0 ? resolveChildElements(target, declarations) : [];

  if (payload.dualMode) {
    const modes = payload.dualModes ?? ["light", "dark"];
    const [modeA, modeB] = modes;
    const hosts = modeHosts();
    const evidence = modeEvidence(target, childResolutions);

    /**
     * Everything that mutated the document, newest first, plus the phase we are
     * in. Both live out here because the *guarantees* live out here: whatever
     * happens inside — a refusal, a throw, the phase budget expiring — the
     * document is put back and exactly one snapshot payload is emitted.
     *
     * Issue #78 was the absence of both. The phase parked forever, so the theme
     * was never restored (the story sat in `class="light"` with transitions
     * permanently suspended) and no payload was ever sent, which left the panel's
     * 65s ceiling as the only thing that ended the check — reporting "no reply"
     * instead of a cause.
     */
    const undo: ModeSwitchRestore[] = [];
    let phase = "detecting the theme mechanism";
    let abandoned = false;
    const restoreTransitions = suspendTransitions();
    const restoreDocument = (): void => {
      // Newest first: pass B's restore captured the state pass A had left.
      while (undo.length > 0) undo.pop()!.apply();
      restoreTransitions();
      // The consumer saw a canvas still painted dark after the class was gone.
      // Computed values were right; the paint had not caught up.
      forceReflow();
    };

    type Outcome =
      | { kind: "dual"; snapA: CodeSnapshot; snapB: CodeSnapshot; children: ChildSnapshotEntry[]; mechanism: string }
      | {
          kind: "single";
          snapshot: CodeSnapshot;
          children: ChildSnapshotEntry[];
          mode: string | undefined;
          mechanism: string;
          reason: string;
        };

    const snapshotWithTokens = (): CodeSnapshot => {
      const snap = snapshotElement(target);
      if (payload.tokens) snap.bindings = { ...(snap.bindings ?? {}), ...payload.tokens };
      return snap;
    };

    const refuse = (mechanism: string, reason: string): Outcome => ({
      kind: "single",
      snapshot: snapshotWithTokens(),
      children: snapshotChildren(childResolutions),
      mode: readActiveMode(modeAttribute),
      mechanism,
      reason,
    });

    const runSwitchingPhase = async (): Promise<Outcome> => {
      // Which mechanism switches this project's theme, and — the part #69 was
      // missing — whether it actually does. `modeAttribute` (or the newer
      // `modeSwitch`) still wins when declared; with nothing declared, class and
      // attribute forms are tried and the one that moves a computed colour is used.
      const { spec: declared, problem } = parseModeSwitch({
        modeSwitch: payload.modeSwitch,
        // Only forward `modeAttribute` as a declaration when the story actually
        // set it; the default would otherwise read as an explicit choice and
        // suppress detection — which is how #69 stayed invisible.
        ...(payload.modeAttribute ? { modeAttribute: payload.modeAttribute } : {}),
      });
      const switching = await resolveModeSwitch({
        hosts,
        evidence,
        readStyles: readComputed,
        modes: [modeA, modeB],
        declared,
        flush: waitForStyleFlush,
      });
      if (abandoned) throw new Error("abandoned");

      if (!switching.changed || !switching.spec) {
        // One rendered state, not two. Snapshot it once and say the mode
        // comparison did not happen. The alternative — two identical snapshots
        // merged into a "both modes" report — is the false pass v0.0.41 removed.
        return refuse(
          switching.mechanism,
          [switching.reason ?? "Not performed — no verified theme switch was found.", problem]
            .filter((s): s is string => s !== undefined)
            .join(" "),
        );
      }

      // Two passes, each measuring the code side in its own mode. The code-side
      // re-snapshot is why this needs no second channel round trip: both modes are
      // captured while the preview already holds the rendered story, so a bulk run
      // pays one request per story whether or not both modes are asked for.
      phase = `measuring "${modeA}"`;
      undo.push(applyMode(hosts, switching.spec, modeA, modes, { forceReflow }));
      await waitForStyleFlush();
      if (abandoned) throw new Error("abandoned");
      // The evidence, read at the same moment as the snapshot — not during an
      // earlier probe. This is what makes "the mode had settled" a claim about
      // the values actually being compared (#78).
      const settledA = fingerprint(evidence, readComputed);
      const snapA = snapshotWithTokens();
      const childrenA = snapshotChildren(childResolutions);

      phase = `measuring "${modeB}"`;
      undo.push(applyMode(hosts, switching.spec, modeB, modes, { forceReflow }));
      await waitForStyleFlush();
      if (abandoned) throw new Error("abandoned");
      const settledB = fingerprint(evidence, readComputed);
      const snapB = snapshotWithTokens();
      const childrenB = snapshotChildren(childResolutions);

      if (settledA === settledB) {
        // The mechanism was verified, yet the two passes read the same document.
        // Deliberately checked on the document-level evidence, never on the
        // story's own rows: a component that renders identically in both modes
        // while Figma holds two values is a real dark-mode drift, and refusing
        // there would discard the finding this feature exists to make.
        return refuse(
          switching.mechanism,
          staleModeReason({ modeA, modeB, mechanism: switching.mechanism }),
        );
      }

      attachChildMode(childrenA, childrenB, modeB);
      return {
        kind: "dual",
        snapA,
        snapB,
        children: childrenA,
        mechanism: switching.mechanism,
      };
    };

    let outcome: Outcome;
    try {
      // A ceiling inside the preview, before any snapshot leaves it. The server's
      // budget cannot help here — it only starts once a snapshot arrives — so
      // without this the panel ceiling is the only guard and the user gets "no
      // reply" instead of a cause.
      outcome = await withBudget(runSwitchingPhase(), {
        budgetMs: MODE_SWITCH_PHASE_BUDGET_MS,
        message: `mode-switch phase exceeded ${MODE_SWITCH_PHASE_BUDGET_MS}ms`,
        onExpired: () => {
          // Stop the abandoned phase from mutating the document after we restore.
          abandoned = true;
        },
      });
    } catch {
      const spentPhase = phase;
      restoreDocument();
      outcome = {
        kind: "single",
        snapshot: snapshotWithTokens(),
        children: snapshotChildren(childResolutions),
        mode: readActiveMode(modeAttribute),
        mechanism: spentPhase,
        reason: switchUnavailableReason(spentPhase, `${MODE_SWITCH_PHASE_BUDGET_MS}ms`),
      };
    }

    // Restore before emitting, always. Measurements are already taken, and the
    // user is looking at this story.
    restoreDocument();

    const out: CodeSnapshotPayload =
      outcome.kind === "dual"
        ? {
            storyId: payload.storyId,
            snapshot: outcome.snapA,
            mode: modeA,
            additionalSnapshots: [{ mode: modeB, snapshot: outcome.snapB }],
            modeSwitch: {
              requested: [modeA, modeB],
              applied: true,
              mechanism: outcome.mechanism,
            },
          }
        : {
            storyId: payload.storyId,
            snapshot: outcome.snapshot,
            ...(outcome.mode ? { mode: outcome.mode } : {}),
            modeSwitch: {
              requested: [modeA, modeB],
              applied: false,
              mechanism: outcome.mechanism,
              reason: outcome.reason,
            },
          };
    if (payload.args) out.args = payload.args;
    if (payload.target) out.target = payload.target;
    // Relayed so the server knows whether this was a bulk run's story or a
    // deliberate single check (which must not be answered from a cache).
    if (payload.bulk) out.bulk = true;
    if (payload.compareCopy === false) out.compareCopy = false;
    if (outcome.children.length > 0) out.childSnapshots = outcome.children;
    channel.emit(EVENTS.CodeSnapshot, out);
    return;
  }

  const snapshot = snapshotElement(target);
  if (payload.tokens) {
    snapshot.bindings = { ...(snapshot.bindings ?? {}), ...payload.tokens };
  }
  const childSnapshots = snapshotChildren(childResolutions);
  const stateSnapshots = snapshotDeclaredStates(target, snapshot, declared.states);
  const mode = readActiveMode(modeAttribute);
  const out: CodeSnapshotPayload = { storyId: payload.storyId, snapshot };
  if (mode) out.mode = mode;
  if (payload.args) out.args = payload.args;
  if (payload.target) out.target = payload.target;
  if (payload.bulk) out.bulk = true;
  if (payload.compareCopy === false) out.compareCopy = false;
  if (childSnapshots.length > 0) out.childSnapshots = childSnapshots;
  if (stateSnapshots.length > 0) out.stateSnapshots = stateSnapshots;
  channel.emit(EVENTS.CodeSnapshot, out);
});
