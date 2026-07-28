import { addons } from "storybook/preview-api";
import {
  EVENTS,
  type CheckDriftRequestPayload,
  type CodeSnapshotPayload,
} from "./channels.js";
import type { CodeSnapshot } from "./engines/types.js";
import {
  normalizeBindingKey,
  compositeBorderTokens,
} from "./binding-shape.js";
import { resolveStoryRoot } from "./story-root.js";

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
  // Layout
  "gap",
  // Typography — useful for components with text content. Inherited values
  // resolve on `getComputedStyle`, so a button with no inner text still
  // reports the cascaded font.
  "color",
  "font-size",
  "font-weight",
  "font-family",
  "line-height",
  "letter-spacing",
  "text-decoration-line",
  "text-transform",
  "text-align",
  // Effects
  "box-shadow",
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
  return { styles, bindings, variantClasses, rootClasses: allClasses, texts };
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

/**
 * Wait for the browser to flush style + layout after a CSS-variable-driving
 * attribute change. Two rAFs ensures the next paint pass has run; reading
 * `offsetHeight` forces the synchronous part. Even when transitions are
 * suspended, browsers occasionally need this extra tick to settle.
 */
function waitForStyleFlush(): Promise<void> {
  void document.documentElement.offsetHeight;
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
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

  if (payload.dualMode) {
    const [modeA, modeB] = payload.dualModes ?? ["light", "dark"];
    const root = document.documentElement;
    const original = root.getAttribute(modeAttribute);
    const restoreTransitions = suspendTransitions();

    // Pass A
    root.setAttribute(modeAttribute, modeA);
    await waitForStyleFlush();
    const snapA = snapshotElement(target);
    if (payload.tokens) snapA.bindings = { ...(snapA.bindings ?? {}), ...payload.tokens };

    // Pass B
    root.setAttribute(modeAttribute, modeB);
    await waitForStyleFlush();
    const snapB = snapshotElement(target);
    if (payload.tokens) snapB.bindings = { ...(snapB.bindings ?? {}), ...payload.tokens };

    // Restore
    if (original === null) root.removeAttribute(modeAttribute);
    else root.setAttribute(modeAttribute, original);
    restoreTransitions();

    const out: CodeSnapshotPayload = {
      storyId: payload.storyId,
      snapshot: snapA,
      mode: modeA,
      additionalSnapshots: [{ mode: modeB, snapshot: snapB }],
    };
    if (payload.args) out.args = payload.args;
    if (payload.target) out.target = payload.target;
    channel.emit(EVENTS.CodeSnapshot, out);
    return;
  }

  const snapshot = snapshotElement(target);
  if (payload.tokens) {
    snapshot.bindings = { ...(snapshot.bindings ?? {}), ...payload.tokens };
  }
  const mode = readActiveMode(modeAttribute);
  const out: CodeSnapshotPayload = { storyId: payload.storyId, snapshot };
  if (mode) out.mode = mode;
  if (payload.args) out.args = payload.args;
  if (payload.target) out.target = payload.target;
  channel.emit(EVENTS.CodeSnapshot, out);
});
