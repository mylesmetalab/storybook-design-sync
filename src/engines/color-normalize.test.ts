import { describe, expect, it } from "vitest";
import {
  isTransparentColor,
  normalizeColor,
  oklabToRgba,
  oklchToRgba,
  parseModernColor,
} from "./color-normalize.js";

/**
 * Reference values come from two independent sources:
 *
 * 1. **Tailwind CSS v4's published palette**, which ships every color as an
 *    `oklch()` value alongside a hand-authored sRGB hex fallback. Reproducing
 *    those pairs exactly checks the whole chain (OKLCh → OKLab → LMS →
 *    linear sRGB → transfer function → 8-bit).
 *      neutral-50  oklch(0.985 0 0)           #fafafa  rgb(250,250,250)
 *      neutral-200 oklch(0.922 0 0)           #e5e5e5  rgb(229,229,229)
 *      neutral-400 oklch(0.708 0 0)           #a1a1a1  rgb(161,161,161)
 *      neutral-800 oklch(0.269 0 0)           #262626  rgb(38,38,38)
 *      neutral-900 oklch(0.205 0 0)           #171717  rgb(23,23,23)
 *      neutral-950 oklch(0.145 0 0)           #0a0a0a  rgb(10,10,10)
 *      blue-500    oklch(0.623 0.214 259.815) #2b7fff  rgb(43,127,255)
 *      red-500     oklch(0.637 0.237 25.331)  #fb2c36  rgb(251,44,54)
 *
 * 2. **The published OKLab coordinates of the sRGB primaries** (red
 *    L 0.62796 a 0.22486 b 0.12585 → C 0.25768 h 29.234°, green L 0.86644
 *    C 0.29483 h 142.495°, blue L 0.45201 C 0.31321 h 264.052°), which must
 *    map back onto pure red / green / blue.
 *
 * The matrices are verbatim from Björn Ottosson's reference implementation,
 * which is what CSS Color 4 describes normatively.
 *
 * No epsilon is used: every assertion is exact equality after rounding to
 * 8 bits. The round-trip block at the bottom pins that down.
 */

describe("normalizeColor — existing behaviour (regression)", () => {
  it("strips whitespace and lowercases", () => {
    expect(normalizeColor("RGB(1, 2, 3)")).toBe("rgb(1,2,3)");
    expect(normalizeColor("  rgb( 4 , 5 , 6 )  ")).toBe("rgb(4,5,6)");
  });

  it("collapses an explicit alpha of 1 onto rgb()", () => {
    expect(normalizeColor("rgba(9, 8, 7, 1)")).toBe("rgb(9,8,7)");
    expect(normalizeColor("rgba(9, 8, 7, 1.0)")).toBe("rgb(9,8,7)");
    expect(normalizeColor("rgba(9,8,7,1)")).toBe(normalizeColor("rgb(9,8,7)"));
  });

  it("keeps a partial alpha", () => {
    expect(normalizeColor("rgba(9, 8, 7, 0.5)")).toBe("rgba(9,8,7,0.5)");
  });

  it("folds every fully-transparent spelling onto one sentinel", () => {
    expect(normalizeColor("rgba(0, 0, 0, 0)")).toBe("transparent");
    expect(normalizeColor("transparent")).toBe("transparent");
    expect(normalizeColor("rgba(0,0,0,0.0)")).toBe("transparent");
  });

  it("passes unrecognised values through, stripped and lowercased", () => {
    expect(normalizeColor("CurrentColor")).toBe("currentcolor");
    expect(normalizeColor("color(rec2020 0.5 0.5 0.5)")).toBe(
      "color(rec20200.50.50.5)",
    );
  });
});

describe("normalizeColor — hex", () => {
  it("folds hex onto the same rgb() form Figma produces", () => {
    expect(normalizeColor("#000000")).toBe("rgb(0,0,0)");
    expect(normalizeColor("#FFFFFF")).toBe("rgb(255,255,255)");
    expect(normalizeColor("#2b7fff")).toBe("rgb(43,127,255)");
    expect(normalizeColor("#fff")).toBe(normalizeColor("rgb(255, 255, 255)"));
    expect(normalizeColor("#0AF")).toBe("rgb(0,170,255)");
  });

  it("reads 8-digit hex alpha", () => {
    expect(normalizeColor("#00000080")).toBe("rgba(0,0,0,0.502)");
    expect(normalizeColor("#2b7fffff")).toBe("rgb(43,127,255)");
    expect(normalizeColor("#12345600")).toBe("rgba(18,52,86,0)");
  });
});

describe("normalizeColor — oklch (the shadcn / Tailwind v4 case)", () => {
  it("matches a computed oklch value against Figma's rgb", () => {
    // The whole point: Figma reports rgb, the browser reports oklch, and a
    // correct theme must not be flagged as drift.
    expect(normalizeColor("oklch(0.205 0 0)")).toBe(
      normalizeColor("rgb(23, 23, 23)"),
    );
    expect(normalizeColor("oklch(0.623 0.214 259.815)")).toBe(
      normalizeColor("rgb(43, 127, 255)"),
    );
  });

  it("maps the neutral axis onto the Tailwind v4 neutral scale", () => {
    expect(normalizeColor("oklch(0.985 0 0)")).toBe("rgb(250,250,250)");
    expect(normalizeColor("oklch(0.922 0 0)")).toBe("rgb(229,229,229)");
    expect(normalizeColor("oklch(0.708 0 0)")).toBe("rgb(161,161,161)");
    expect(normalizeColor("oklch(0.269 0 0)")).toBe("rgb(38,38,38)");
    expect(normalizeColor("oklch(0.205 0 0)")).toBe("rgb(23,23,23)");
    expect(normalizeColor("oklch(0.145 0 0)")).toBe("rgb(10,10,10)");
  });

  it("maps the endpoints of the lightness axis to white and black", () => {
    expect(normalizeColor("oklch(1 0 0)")).toBe("rgb(255,255,255)");
    expect(normalizeColor("oklch(0 0 0)")).toBe("rgb(0,0,0)");
  });

  it("reproduces the sRGB primaries from their OKLCh coordinates", () => {
    expect(normalizeColor("oklch(0.62796 0.25768 29.234)")).toBe("rgb(255,0,0)");
    expect(normalizeColor("oklch(0.86644 0.29483 142.495)")).toBe("rgb(0,255,0)");
    expect(normalizeColor("oklch(0.45201 0.31321 264.052)")).toBe("rgb(0,0,255)");
  });

  it("reproduces Tailwind v4 blue-500 and red-500 hex fallbacks", () => {
    expect(normalizeColor("oklch(0.623 0.214 259.815)")).toBe("rgb(43,127,255)");
    expect(normalizeColor("oklch(0.637 0.237 25.331)")).toBe("rgb(251,44,54)");
  });

  it("accepts percentage lightness", () => {
    expect(normalizeColor("oklch(52.3% 0.14 250)")).toBe("rgb(18,108,182)");
    expect(normalizeColor("oklch(20.5% 0 0)")).toBe(normalizeColor("oklch(0.205 0 0)"));
    expect(normalizeColor("oklch(100% 0 0)")).toBe("rgb(255,255,255)");
  });

  it("accepts chroma as a percentage of the 0.4 reference range", () => {
    expect(normalizeColor("oklch(0.623 53.5% 259.815)")).toBe(
      normalizeColor("oklch(0.623 0.214 259.815)"),
    );
  });

  it("accepts slash-separated alpha as a number or a percentage", () => {
    expect(normalizeColor("oklch(0.7 0.1 200 / 0.5)")).toBe("rgba(64,177,183,0.5)");
    expect(normalizeColor("oklch(0.7 0.1 200 / 50%)")).toBe("rgba(64,177,183,0.5)");
    // alpha=1 still collapses onto rgb(), same as rgba(…,1) does.
    expect(normalizeColor("oklch(0.7 0.1 200 / 1)")).toBe("rgb(64,177,183)");
    // A fully-transparent conversion folds onto the transparent sentinel.
    expect(normalizeColor("oklch(0 0 0 / 0)")).toBe("transparent");
  });

  it("treats `none` components as zero", () => {
    expect(normalizeColor("oklch(0.5 none none)")).toBe(normalizeColor("oklch(0.5 0 0)"));
    expect(normalizeColor("oklch(none 0 0)")).toBe("rgb(0,0,0)");
  });

  it("accepts the four CSS angle units for hue", () => {
    const deg = normalizeColor("oklch(0.5 0.1 180)");
    expect(normalizeColor("oklch(0.5 0.1 180deg)")).toBe(deg);
    expect(normalizeColor("oklch(0.5 0.1 3.14159265rad)")).toBe(deg);
    expect(normalizeColor("oklch(0.5 0.1 200grad)")).toBe(deg);
    expect(normalizeColor("oklch(0.5 0.1 0.5turn)")).toBe(deg);
  });

  it("tolerates commas, odd whitespace and case", () => {
    expect(normalizeColor("  OKLCH( 0.205 , 0 , 0 )  ")).toBe("rgb(23,23,23)");
  });

  it("clamps out-of-range and out-of-gamut values instead of throwing", () => {
    expect(normalizeColor("oklch(1.5 0 0)")).toBe("rgb(255,255,255)");
    expect(normalizeColor("oklch(-0.2 0 0)")).toBe("rgb(0,0,0)");
    // 0.9 chroma is unreachable in sRGB at any hue — channels clamp, no NaN.
    for (const h of [0, 60, 140, 200, 280, 359]) {
      const c = parseModernColor(`oklch(0.7 0.9 ${h})`);
      expect(c).not.toBeNull();
      for (const channel of [c!.r, c!.g, c!.b]) {
        expect(Number.isInteger(channel)).toBe(true);
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
    // Negative chroma is invalid CSS; fold to achromatic, don't flip the hue.
    expect(normalizeColor("oklch(0.5 -0.1 200)")).toBe(normalizeColor("oklch(0.5 0 0)"));
  });

  it("leaves an unconvertible oklch untouched rather than guessing", () => {
    expect(normalizeColor("oklch(var(--l) 0 0)")).toBe("oklch(var(--l)00)");
    expect(parseModernColor("oklch(0.5 0.1)")).toBeNull();
    expect(parseModernColor("oklch(0.5 0.1 200 40)")).toBeNull();
    expect(parseModernColor("oklch(0.5 0.1 200 / 0.5 / 0.5)")).toBeNull();
    expect(parseModernColor("rgb(1, 2, 3)")).toBeNull();
    expect(parseModernColor("")).toBeNull();
  });
});

describe("normalizeColor — oklab and display-p3", () => {
  it("reproduces sRGB red from its published OKLab coordinates", () => {
    expect(normalizeColor("oklab(0.62796 0.22486 0.12585)")).toBe("rgb(255,0,0)");
  });

  it("agrees with the equivalent oklch() value", () => {
    expect(normalizeColor("oklab(0.5 0 0)")).toBe(normalizeColor("oklch(0.5 0 0)"));
    // a/b percentages use the same ±0.4 reference range as chroma.
    expect(normalizeColor("oklab(0.62796 56.215% 31.4625%)")).toBe("rgb(255,0,0)");
  });

  it("preserves the display-p3 gray axis exactly", () => {
    expect(normalizeColor("color(display-p3 0 0 0)")).toBe("rgb(0,0,0)");
    expect(normalizeColor("color(display-p3 0.5 0.5 0.5)")).toBe("rgb(128,128,128)");
    expect(normalizeColor("color(display-p3 1 1 1)")).toBe("rgb(255,255,255)");
  });

  it("clamps display-p3 primaries that fall outside sRGB", () => {
    expect(normalizeColor("color(display-p3 1 0 0)")).toBe("rgb(255,0,0)");
    expect(normalizeColor("color(display-p3 0 1 0)")).toBe("rgb(0,255,0)");
  });

  it("carries alpha through", () => {
    expect(normalizeColor("oklab(0.62796 0.22486 0.12585 / 0.5)")).toBe(
      "rgba(255,0,0,0.5)",
    );
    expect(normalizeColor("color(display-p3 0.5 0.5 0.5 / 0.25)")).toBe(
      "rgba(128,128,128,0.25)",
    );
  });
});

describe("isTransparentColor", () => {
  it("treats the browser's no-opinion sentinels as transparent", () => {
    expect(isTransparentColor(undefined)).toBe(true);
    expect(isTransparentColor("")).toBe(true);
    expect(isTransparentColor("rgba(0, 0, 0, 0)")).toBe(true);
    expect(isTransparentColor("transparent")).toBe(true);
  });

  it("does not treat an opaque color as transparent", () => {
    expect(isTransparentColor("rgb(0, 0, 0)")).toBe(false);
    expect(isTransparentColor("oklch(0.205 0 0)")).toBe(false);
  });
});

describe("8-bit round trip", () => {
  // Independent inverse (linear sRGB → OKLab), same reference implementation.
  function rgbToOklch(r8: number, g8: number, b8: number) {
    const toLinear = (c: number): number =>
      c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const r = toLinear(r8 / 255);
    const g = toLinear(g8 / 255);
    const b = toLinear(b8 / 255);

    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

    let H = (Math.atan2(bb, a) * 180) / Math.PI;
    if (H < 0) H += 360;
    return { L, C: Math.sqrt(a * a + bb * bb), H, a, b: bb };
  }

  const samples: Array<[number, number, number]> = [
    [0, 0, 0],
    [255, 255, 255],
    [23, 23, 23],
    [10, 10, 10],
    [43, 127, 255],
    [251, 44, 54],
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [127, 63, 191],
    [18, 52, 86],
    [254, 220, 186],
  ];

  it("round-trips sRGB → OKLCh → sRGB with exact 8-bit equality", () => {
    for (const [r, g, b] of samples) {
      const { L, C, H } = rgbToOklch(r, g, b);
      const back = oklchToRgba(L, C, H);
      expect([back.r, back.g, back.b], `round trip for rgb(${r},${g},${b})`).toEqual([
        r,
        g,
        b,
      ]);
    }
  });

  it("round-trips through oklabToRgba as well", () => {
    for (const [r, g, b] of samples) {
      const { L, a, b: bb } = rgbToOklch(r, g, b);
      const back = oklabToRgba(L, a, bb);
      expect([back.r, back.g, back.b], `round trip for rgb(${r},${g},${b})`).toEqual([
        r,
        g,
        b,
      ]);
    }
  });
});
