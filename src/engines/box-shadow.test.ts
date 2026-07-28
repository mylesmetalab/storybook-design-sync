import { describe, expect, it } from "vitest";
import {
  figmaEffectsToShadows,
  formatShadows,
  parseCssBoxShadow,
  shadowsEqual,
  type FigmaEffect,
} from "./box-shadow.js";

/**
 * `box-shadow` used to be compared as a normalized string, which could never
 * match: `getComputedStyle` puts the colour **first** and `inset` last, while
 * the Figma side was assembled offset-first. The status expression it fed was
 * `drift : drift` — literally unable to report agreement. These tests pin the
 * structured comparison that replaced it, and the shapes it refuses.
 */

const BLACK_25 = "rgba(0, 0, 0, 0.25)";

/** The engine supplies colour resolution; here it's just the paint colour. */
const resolveColor = (e: FigmaEffect): string | undefined =>
  e.color ? `rgba(${Math.round(e.color.r * 255)}, ${Math.round(e.color.g * 255)}, ${Math.round(e.color.b * 255)}, ${e.color.a ?? 1})` : undefined;

function dropShadow(overrides: Partial<FigmaEffect> = {}): FigmaEffect {
  return {
    type: "DROP_SHADOW",
    visible: true,
    blendMode: "NORMAL",
    offset: { x: 0, y: 2 },
    radius: 4,
    spread: 0,
    color: { r: 0, g: 0, b: 0, a: 0.25 },
    ...overrides,
  };
}

describe("parseCssBoxShadow", () => {
  it("parses Chrome's colour-first computed form", () => {
    expect(parseCssBoxShadow("rgba(0, 0, 0, 0.25) 0px 2px 4px 0px")).toEqual([
      { inset: false, x: 0, y: 2, blur: 4, spread: 0, color: "rgba(0,0,0,0.25)" },
    ]);
  });

  it("parses the author-order (colour-last) form the same way", () => {
    expect(parseCssBoxShadow("0px 2px 4px 0px rgba(0, 0, 0, 0.25)")).toEqual([
      { inset: false, x: 0, y: 2, blur: 4, spread: 0, color: "rgba(0,0,0,0.25)" },
    ]);
  });

  it("reads the trailing `inset` keyword", () => {
    const parsed = parseCssBoxShadow("rgba(0, 0, 0, 0.25) 0px 2px 4px 0px inset");
    expect(parsed?.[0]?.inset).toBe(true);
  });

  it("splits a multi-shadow list without tripping over rgba's commas", () => {
    const parsed = parseCssBoxShadow(
      "rgba(0, 0, 0, 0.1) 0px 1px 2px 0px, rgba(0, 0, 0, 0.06) 0px 1px 3px 1px",
    );
    expect(parsed).toHaveLength(2);
    expect(parsed?.[1]?.blur).toBe(3);
    expect(parsed?.[1]?.spread).toBe(1);
  });

  it("folds a modern colour space into the same canonical form as Figma's rgba", () => {
    const parsed = parseCssBoxShadow("oklch(0% 0 0 / 0.25) 0px 2px 4px");
    expect(parsed?.[0]?.color).toBe("rgba(0,0,0,0.25)");
    expect(parsed?.[0]?.spread).toBe(0);
  });

  it("keeps a space-separated colour function as one token", () => {
    // The tokenizer must not split `rgb(0 0 0 / 25%)` into four tokens — that
    // would read as several colours and lengths. It's refused for a different
    // reason (see below), but as one unit.
    const parsed = parseCssBoxShadow("rgb(0 0 0 / 25%) 0px 2px 4px");
    expect(parsed).toBeNull();
  });

  it("refuses a colour it cannot fold to the canonical form", () => {
    // `normalizeColor` doesn't understand the space-separated `rgb()` syntax or
    // named colours, and an unfolded string would compare unequal to Figma's
    // `rgba(…)` spelling of the same colour. No comparison beats a fake one.
    expect(parseCssBoxShadow("rebeccapurple 0px 2px 4px")).toBeNull();
    expect(parseCssBoxShadow("rgb(0 0 0 / 25%) 0px 2px 4px")).toBeNull();
  });

  it("treats `none` as a real no-shadow opinion, and absent as unknown", () => {
    expect(parseCssBoxShadow("none")).toEqual([]);
    expect(parseCssBoxShadow(undefined)).toBeNull();
    expect(parseCssBoxShadow("")).toBeNull();
  });

  it("refuses anything it can't fully account for", () => {
    // No colour.
    expect(parseCssBoxShadow("0px 2px 4px")).toBeNull();
    // Two colours.
    expect(parseCssBoxShadow("red blue 0px 2px")).toBeNull();
    // Not enough lengths.
    expect(parseCssBoxShadow("red 2px")).toBeNull();
    // Too many lengths.
    expect(parseCssBoxShadow("red 1px 2px 3px 4px 5px")).toBeNull();
    // One bad entry poisons the whole list — a partial parse is not a comparison.
    expect(parseCssBoxShadow("red 0px 2px, 0px 2px")).toBeNull();
  });
});

describe("figmaEffectsToShadows", () => {
  it("maps DROP_SHADOW to an outer shadow and INNER_SHADOW to `inset`", () => {
    const got = figmaEffectsToShadows(
      [dropShadow(), dropShadow({ type: "INNER_SHADOW" })],
      resolveColor,
    );
    expect(got?.excluded).toEqual([]);
    expect(got?.shadows.map((s) => s.inset)).toEqual([false, true]);
  });

  it("defaults a missing spread/offset to Figma's own defaults", () => {
    const got = figmaEffectsToShadows([{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 } }], resolveColor);
    expect(got?.shadows[0]).toEqual({
      inset: false,
      x: 0,
      y: 0,
      blur: 0,
      spread: 0,
      color: "rgba(0,0,0,0.25)",
    });
  });

  it("skips invisible effects and non-shadow effect types", () => {
    const got = figmaEffectsToShadows(
      [
        dropShadow({ visible: false }),
        { type: "LAYER_BLUR", radius: 4 },
        { type: "BACKGROUND_BLUR", radius: 4 },
      ],
      resolveColor,
    );
    // Blurs belong to `filter`, not `box-shadow`, so they don't spoil the row.
    expect(got).toEqual({ shadows: [], excluded: [] });
  });

  it("excludes a shadow whose blend mode CSS box-shadow cannot express", () => {
    const got = figmaEffectsToShadows([dropShadow({ blendMode: "MULTIPLY" })], resolveColor);
    expect(got?.shadows).toEqual([]);
    expect(got?.excluded[0]).toContain("MULTIPLY");
  });

  it("excludes a shadow whose colour can't be read", () => {
    const { color: _dropped, ...colourless } = dropShadow();
    const got = figmaEffectsToShadows([colourless], resolveColor);
    expect(got?.shadows).toEqual([]);
    expect(got?.excluded[0]).toContain("colour");
  });

  it("returns null when Figma reported no effects field at all", () => {
    expect(figmaEffectsToShadows(undefined, resolveColor)).toBeNull();
  });

  it("distinguishes that from an empty effects array (an explicit `none`)", () => {
    expect(figmaEffectsToShadows([], resolveColor)).toEqual({ shadows: [], excluded: [] });
  });
});

describe("shadowsEqual", () => {
  const figma = figmaEffectsToShadows([dropShadow()], resolveColor)!.shadows;

  it("matches the same shadow written colour-first with rgba spacing", () => {
    expect(shadowsEqual(figma, parseCssBoxShadow(`${BLACK_25} 0px 2px 4px 0px`)!)).toBe(true);
  });

  it("matches across colour spellings (oklch code vs Figma rgba)", () => {
    // oklch(0% 0 0 / 0.25) folds to rgba(0,0,0,0.25).
    expect(shadowsEqual(figma, parseCssBoxShadow("oklch(0% 0 0 / 0.25) 0px 2px 4px 0px")!)).toBe(
      true,
    );
  });

  it("does not match a different offset, blur, spread, colour or inset-ness", () => {
    expect(shadowsEqual(figma, parseCssBoxShadow(`${BLACK_25} 0px 4px 4px 0px`)!)).toBe(false);
    expect(shadowsEqual(figma, parseCssBoxShadow(`${BLACK_25} 0px 2px 8px 0px`)!)).toBe(false);
    expect(shadowsEqual(figma, parseCssBoxShadow(`${BLACK_25} 0px 2px 4px 2px`)!)).toBe(false);
    expect(shadowsEqual(figma, parseCssBoxShadow("rgba(255, 0, 0, 0.25) 0px 2px 4px 0px")!)).toBe(
      false,
    );
    expect(shadowsEqual(figma, parseCssBoxShadow(`${BLACK_25} 0px 2px 4px 0px inset`)!)).toBe(false);
  });

  it("is order-sensitive — the first shadow paints on top on both sides", () => {
    const two = figmaEffectsToShadows(
      [dropShadow({ offset: { x: 0, y: 1 } }), dropShadow({ offset: { x: 0, y: 8 } })],
      resolveColor,
    )!.shadows;
    expect(shadowsEqual(two, parseCssBoxShadow(`${BLACK_25} 0px 1px 4px 0px, ${BLACK_25} 0px 8px 4px 0px`)!)).toBe(true);
    expect(shadowsEqual(two, parseCssBoxShadow(`${BLACK_25} 0px 8px 4px 0px, ${BLACK_25} 0px 1px 4px 0px`)!)).toBe(false);
  });

  it("counts a sub-half-pixel difference as the same shadow", () => {
    expect(shadowsEqual(figma, parseCssBoxShadow(`${BLACK_25} 0px 2.2px 4px 0px`)!)).toBe(true);
  });

  it("never matches lists of different length", () => {
    expect(shadowsEqual(figma, [])).toBe(false);
  });
});

describe("formatShadows", () => {
  it("renders an empty list as `none`", () => {
    expect(formatShadows([])).toBe("none");
  });

  it("renders canonical CSS, inset first", () => {
    const shadows = figmaEffectsToShadows([dropShadow({ type: "INNER_SHADOW" })], resolveColor)!.shadows;
    expect(formatShadows(shadows)).toBe("inset 0px 2px 4px 0px rgba(0,0,0,0.25)");
  });
});
