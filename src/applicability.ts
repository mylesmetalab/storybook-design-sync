/**
 * Applicability — "is this element the one that renders the text we are about
 * to make a claim about?"
 *
 * Why this exists: on a Card, the story root plus `[data-slot=body]` and
 * `[data-slot=text]` are layout `div`s that hold no text of their own. Each was
 * still handed four comparisons — `line-height` ("not bound in Figma", with a
 * design-side fix prompt), `color` (the div's *inherited* colour against a
 * descendant's fill), and two `copy` rows expecting strings that belong to
 * descendants. Twelve of the sixteen remaining rows on every Card story were
 * this. Each one is technically-true-and-inapplicable: the wrapper does not
 * paint the glyphs, so a verdict about its type is a verdict about nobody.
 *
 * The sibling repo solved the same problem first — `storybook-design-inspector`
 * v0.2.3, `src/decorator/applicability.ts`, `typographyApplies()`. This is the
 * same predicate with one deliberate difference, and the difference is the whole
 * subtlety:
 *
 *   - The **inspector** reads `element.textContent`, which includes descendant
 *     text, because it is deciding whether to *show a panel section* for an
 *     element a human just clicked. Font properties cascade, so a container
 *     wrapping text is still worth *inspecting*.
 *   - The **auditor** is deciding whether to *state a verdict* by comparing this
 *     element against a Figma node. A container's computed `font-size` is
 *     whatever it inherited, and Figma's answer comes from a TEXT descendant —
 *     so the two sides describe different elements, and the drift is fabricated.
 *     Here the question has to be "does this element have a text node of its
 *     own", not "does its subtree contain text".
 *
 * The hazard to avoid is implementing that as a leaf check. A container can own
 * text *and* have element children (`<h3>Title <Badge/></h3>`); on that element
 * the font properties do apply, they do cascade to the badge, and suppressing
 * them would hide real drift. So the probe carries the element's own text nodes
 * only — not "has no children".
 *
 * Pure functions over plain values, so the DOM read stays in `preview.ts` and
 * every rule is unit-testable without a browser.
 */

/**
 * `<input type>` values that paint no text of their own. Everything else — text,
 * search, email, number, date, … — renders its value or placeholder, and that
 * text never appears in `textContent`, so the tag has to be special-cased or
 * every form control would look text-less.
 */
const TEXTLESS_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "hidden",
  "image",
]);

export interface TextOwnershipProbe {
  /**
   * Concatenated **direct child text nodes** of the element, untrimmed.
   *
   * `undefined` means the snapshot never probed it — a snapshot captured by an
   * older preview bundle, or replayed from a cache written by one. That is not
   * evidence of absence, so it must never suppress a row: see
   * {@link ownsRenderedText}.
   */
  ownText?: string | null | undefined;
  /** Tag name, any case. */
  tagName?: string | null | undefined;
  /** The `type` attribute, when the element is an `<input>`. */
  inputType?: string | null | undefined;
}

/**
 * Does this element render text of its own?
 *
 * Returns `true` when it does, when it is a form control whose value/placeholder
 * is its text, **and when we cannot tell** — an unprobed snapshot gets the
 * pre-existing behaviour rather than silent suppression. Hiding rows on the
 * strength of a missing field would be its own dishonesty, and it is the same
 * call the inspector makes with `ALL_APPLICABLE`.
 */
export function ownsRenderedText(probe: TextOwnershipProbe | null | undefined): boolean {
  if (!probe) return true;
  // Not probed → not an answer. Compare exactly as before.
  if (probe.ownText === undefined) return true;
  if ((probe.ownText ?? "").trim() !== "") return true;
  const tag = (probe.tagName ?? "").trim().toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = (probe.inputType ?? "text").trim().toLowerCase();
    return !TEXTLESS_INPUT_TYPES.has(type || "text");
  }
  return false;
}

/**
 * The properties whose comparison only means something on the element that owns
 * the text — the typography family, plus `color`.
 *
 * `color` is here for the same reason as `font-size`, not a different one: on a
 * wrapper it is an inherited value being matched against a descendant TEXT
 * node's fill. The live Card reported exactly that on three elements.
 *
 * Deliberately NOT here: `background-color`, `border-*`, padding, radius, gap,
 * shadows. A wrapper paints all of those itself.
 */
export const TEXT_OWNED_PROPERTIES: ReadonlySet<string> = new Set([
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-decoration-line",
]);

/** Is `property` one of the {@link TEXT_OWNED_PROPERTIES}? */
export function isTextOwnedProperty(property: string): boolean {
  return TEXT_OWNED_PROPERTIES.has(property);
}
