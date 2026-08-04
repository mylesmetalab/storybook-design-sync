/**
 * Colour folding for **drift comparison** — the addon's canonical form.
 *
 * The code side of a comparison is `getComputedStyle().getPropertyValue()`,
 * which hands back whatever colour space the author wrote when the value can't
 * be represented in legacy `rgb()`. Modern shadcn / Tailwind v4 themes ship
 * `oklch()` by default, so a *correct* themed colour would be reported as drift
 * against Figma, which always arrives as `rgb()`/`rgba()` via `rgbaToCss`.
 *
 * **The conversion maths and parsing now live in `@metalab/design-sync-core`**
 * (`color.ts`), shared with `storybook-design-inspector`, which carried a
 * verbatim fork of them until core v0.0.6. The merge was proved
 * behaviour-preserving first: a differential test ran both copies over 22 parse
 * inputs and a 2,376-point OKLCh grid and found exact agreement.
 *
 * What stays here is the part that is genuinely this product's: the **canonical
 * form**. The engine compares `rgb(R,G,B)` / `rgba(R,G,B,A)`, whitespace-stripped
 * and lowercased, and folds every fully-transparent spelling to `"transparent"`
 * so a "no opinion" colour is distinguishable from a real one. The inspector's
 * canonical form is hex, because it displays rather than compares — that is a
 * product decision and belongs in the product.
 */

import {
  type Rgba,
  oklabToRgba,
  oklchToRgba,
  parseHex,
  parseModernColor,
} from "@metalab/design-sync-core";

/**
 * Re-exported at the old names so callers and tests don't have to care where the
 * maths lives. Deliberately kept rather than deleted: this module's existing test
 * suite covers the conversions thoroughly, and pointing it at core's
 * implementation turns it into a second, consumer-side check that core has not
 * regressed — which is worth more than the duplication cost of two suites.
 */
export { oklabToRgba, oklchToRgba, parseHex, parseModernColor };
export type { Rgba };

/** Render into the engine's canonical `rgb()`/`rgba()` form (no whitespace). */
function toCanonical(c: Rgba): string {
  if (c.a >= 1) return `rgb(${c.r},${c.g},${c.b})`;
  // Alpha is rounded to 3 decimals so float noise from a percentage or an
  // oklch conversion can't split two otherwise-identical colors.
  return `rgba(${c.r},${c.g},${c.b},${Number(c.a.toFixed(3))})`;
}

/** Treat browser's "no opinion" color sentinels as equivalent. */
export function isTransparentColor(value: string | undefined): boolean {
  if (!value) return true;
  const v = value.replace(/\s+/g, "").toLowerCase();
  return v === "rgba(0,0,0,0)" || v === "transparent" || v === "rgba(0,0,0,0.0)";
}

/**
 * Fold colors into a canonical form so semantically-equivalent expressions
 * compare equal. `rgba(R,G,B,1)` ≡ `rgb(R,G,B)`; whitespace and case are
 * ignored. Hex and the modern color spaces (`oklch()`, `oklab()`,
 * `color(display-p3 …)`) convert into the same `rgb()` form. Returns
 * "transparent" for any fully-transparent value so the engine can treat those
 * as "no opinion." Anything unrecognised falls through whitespace-stripped and
 * lowercased, exactly as before.
 */
export function normalizeColor(value: string): string {
  if (isTransparentColor(value)) return "transparent";
  const trimmed = value.trim().toLowerCase();

  // Convert before stripping whitespace — spaces are significant inside
  // oklch()/oklab()/color().
  const converted = parseHex(trimmed) ?? parseModernColor(trimmed);
  const stripped = converted ? toCanonical(converted) : trimmed.replace(/\s+/g, "");

  // A conversion can land on a fully-transparent color too.
  if (isTransparentColor(stripped)) return "transparent";

  // rgba(R, G, B, 1) → rgb(R, G, B). The same channel triple should match
  // regardless of whether the producer wrote it with an alpha=1 suffix.
  const m = /^rgba\((\d+),(\d+),(\d+),1(?:\.0+)?\)$/.exec(stripped);
  if (m) return `rgb(${m[1]},${m[2]},${m[3]})`;
  return stripped;
}
