/**
 * Which paint in a Figma `fills` / `strokes` array actually paints the element.
 *
 * Issue #85. Every read in this engine took `fills[0]` and nothing anywhere
 * looked at `Paint.visible`, so a paint toggled **off** — ordinary design
 * practice: last month's brand colour parked above the current one, an overlay
 * that is off for this variant — was resolved, token-attributed and compared as
 * though it painted the element. The row was wrong twice over: a finding against
 * a colour nobody can see, *and* the visible paint below it never compared at
 * all. It was also unfalsifiable from the panel, because the value the tool
 * named genuinely is in the file.
 *
 * This is an **applicability predicate**, in the sense the working agreement
 * means it: the comparison was never wrong about what it read, it was wrong
 * about whether that reading applied.
 *
 * Two rules, and one deliberate non-rule:
 *
 *  - A paint is invisible when `visible === false` **or** its `opacity` is `0`.
 *    Both are "off", by two different routes, and the second was as unchecked as
 *    the first.
 *  - The first *visible* paint wins, **whatever its type**. A visible gradient
 *    above a solid is not skipped in favour of the solid: the gradient is what
 *    renders, so skipping it would re-create this very bug in a new dress. It
 *    resolves to no colour and the row says the read failed — which is true.
 *  - "No paint array" and "every paint hidden" are different facts. The second
 *    is the design deliberately painting nothing, not an absence of information,
 *    and it must not fall through to the same `undefined` as the first.
 */

/** The subset of Figma's `Paint` this module needs. */
export interface VisibilityPaint {
  /** Optional, default `true` — the field nothing checked. */
  visible?: boolean;
  /**
   * Optional, default `1`. `0` is invisible by another route; anything strictly
   * between 0 and 1 renders blended with whatever is behind it, so the paint's
   * own colour is *not* what appears on screen.
   */
  opacity?: number;
}

/**
 * What a `fills` / `strokes` array turned out to hold.
 *
 * A discriminated union rather than `Paint | undefined` precisely because the
 * three no-paint cases mean different things to a reader, and collapsing them is
 * how #85 read as an absence.
 */
export type PaintSelection<P extends VisibilityPaint> =
  /** No `fills` / `strokes` key at all — Figma told us nothing. */
  | { kind: "absent" }
  /** The key is there and empty — the design declares no paint. */
  | { kind: "empty" }
  /**
   * Every paint is switched off. The design paints nothing here *on purpose*,
   * which is a fact about the design, not a gap in the response.
   */
  | { kind: "all-hidden"; hidden: number }
  /**
   * The paint that renders: the first visible one.
   *
   * `hiddenBefore` counts the switched-off paints above it — the ones that used
   * to be compared instead of this. `partialOpacity` is set only when the paint
   * is visible but blended (`0 < opacity < 1`), which is a "cannot compare
   * faithfully", not a value.
   */
  | {
      kind: "paint";
      paint: P;
      index: number;
      hiddenBefore: number;
      partialOpacity?: number;
    };

/** `visible === false`, or an opacity that renders nothing. */
export function isHiddenPaint(paint: VisibilityPaint): boolean {
  if (paint.visible === false) return true;
  const { opacity } = paint;
  return typeof opacity === "number" && Number.isFinite(opacity) && opacity <= 0;
}

/**
 * The same predicate, applied to a **descendant node** rather than a paint.
 *
 * A hidden layer renders nothing, so its text, its typography and its own paints
 * are not what the component shows — and a hidden layer hides its children too,
 * so a walk stops rather than descending. The commonest real instance is a label
 * placeholder switched off in one variant, whose `characters` were being compared
 * against the story's rendered copy.
 *
 * Deliberately **not** applied to the node a story is bound to. That node is the
 * story's declared counterpart; if it is hidden, the binding is what is wrong,
 * and the registry is where that gets fixed. Silently comparing nothing would
 * hide the misbinding instead of surfacing it.
 */
export function isHiddenNode(node: Record<string, unknown>): boolean {
  if (node["visible"] === false) return true;
  const opacity = node["opacity"];
  return typeof opacity === "number" && Number.isFinite(opacity) && opacity <= 0;
}

/**
 * `0 < opacity < 1` — the paint is visible, but blended, so its own colour is
 * not the colour on screen. Returned as a number so the row can name it.
 *
 * Deliberately NOT folded into the colour's alpha channel, even though Figma
 * documents the effective alpha as `color.a × opacity`. Folding would produce a
 * comparable value, and then a drifted row would point a fix prompt at the token
 * — telling someone to change a token value that is not wrong, when the design's
 * intent is an element-level blend. Correct or absent: the row reports the
 * paint, the token and the opacity, and says no comparison was made.
 */
export function partialPaintOpacity(paint: VisibilityPaint): number | undefined {
  const { opacity } = paint;
  if (typeof opacity !== "number" || !Number.isFinite(opacity)) return undefined;
  if (opacity <= 0 || opacity >= 1) return undefined;
  return opacity;
}

/** The first visible paint, or which flavour of nothing was found. */
export function pickVisiblePaint<P extends VisibilityPaint>(
  paints: readonly P[] | undefined | null,
): PaintSelection<P> {
  if (!Array.isArray(paints)) return { kind: "absent" };
  if (paints.length === 0) return { kind: "empty" };
  let hiddenBefore = 0;
  for (let index = 0; index < paints.length; index++) {
    const paint = paints[index]!;
    if (isHiddenPaint(paint)) {
      hiddenBefore++;
      continue;
    }
    const partial = partialPaintOpacity(paint);
    return {
      kind: "paint",
      paint,
      index,
      hiddenBefore,
      ...(partial !== undefined ? { partialOpacity: partial } : {}),
    };
  }
  return { kind: "all-hidden", hidden: paints.length };
}

/** Which array a note is talking about, in words a designer uses. */
export type PaintKindWord = "fill" | "stroke";

/**
 * Note for a node whose every paint is switched off. Says what the design is
 * declaring — nothing painted — and says plainly that no comparison happened, so
 * the row cannot be mistaken for agreement.
 */
export function allPaintsHiddenNote(word: PaintKindWord, hidden: number): string {
  const plural = hidden === 1 ? "" : "s";
  return (
    `Figma's node has ${hidden} ${word} paint${plural}, all switched off ` +
    `(\`visible: false\` or \`opacity: 0\`), so the design paints no ${word} here. That is a ` +
    `deliberate no-${word} rather than a missing value — but it is not a colour either, so no ` +
    `comparison was made against the code's.`
  );
}

/**
 * Note for the case that used to be silent drift: the paint being compared is
 * NOT the one at index 0, because the ones above it are switched off.
 */
export function hiddenPaintsSkippedNote(word: PaintKindWord, hiddenBefore: number): string {
  const plural = hiddenBefore === 1 ? "" : "s";
  const is = hiddenBefore === 1 ? "is" : "are";
  return (
    `Compared against Figma's first **visible** ${word}: the ${hiddenBefore} paint${plural} above ` +
    `it ${is} switched off (\`visible: false\` or \`opacity: 0\`) and ${
      hiddenBefore === 1 ? "does" : "do"
    } not render.`
  );
}

/**
 * Note for a visible but blended paint. Names the opacity and refuses the
 * comparison rather than comparing the opaque colour.
 */
export function partialOpacityNote(word: PaintKindWord, opacity: number): string {
  const pct = `${Math.round(opacity * 1000) / 10}%`;
  return (
    `Figma's ${word} paint is at ${pct} opacity, so what renders is this colour blended with ` +
    `whatever sits behind it — not the colour itself. The addon does not compare a partially ` +
    `transparent paint against a computed colour (folding the opacity in would produce a value ` +
    `that no token holds, and a fix prompt pointing at the wrong layer), so no comparison was ` +
    `made. The colour and token shown are the paint's own.`
  );
}
