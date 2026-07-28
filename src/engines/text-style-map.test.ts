import { describe, expect, it } from "vitest";
import type { DimensionDiff, DimensionStatus } from "../dimensions/types.js";
import {
  figmaLetterSpacingPx,
  fontStyleRow,
  letterSpacingRow,
  mapTextAlign,
  mapTextCase,
  mapTextDecoration,
  normalizeCodeDecorationLine,
  normalizeCodeFontStyle,
  normalizeCodeTextAlign,
  normalizeCodeTextTransform,
  parseLengthPx,
  textAlignRow,
  textDecorationRow,
  textStyleRows,
  textTransformRow,
  type FigmaTypeStyle,
} from "./text-style-map.js";

/**
 * The five text properties that `FIGMA_KEY_TO_CSS` mapped but the value
 * dimension never compared. Each block below covers the three cases that
 * matter: agreement, disagreement, and **no row** — the last one being the
 * point of the module. A confident row about a property whose two sides aren't
 * comparable is worse than silence, so "emits nothing" is a tested behaviour,
 * not an accident.
 */

type Expectation = { status: DimensionStatus } | { absent: true };

function assertRow(row: DimensionDiff | null, expected: Expectation): void {
  if ("absent" in expected) {
    expect(row).toBeNull();
    return;
  }
  expect(row).not.toBeNull();
  expect(row!.status).toBe(expected.status);
}

/* -------------------------------------------------------------------------- *
 * Figma enum → CSS
 * -------------------------------------------------------------------------- */

describe("mapTextCase", () => {
  const cases: Array<[string | undefined, string]> = [
    ["UPPER", "value:uppercase"],
    ["LOWER", "value:lowercase"],
    ["TITLE", "value:capitalize"],
    ["ORIGINAL", "default:none"],
    [undefined, "default:none"],
    ["SMALL_CAPS", "excluded"],
    ["SMALL_CAPS_FORCED", "excluded"],
    ["WHAT_IS_THIS", "excluded"],
  ];
  for (const [input, expected] of cases) {
    it(`${String(input)} → ${expected}`, () => {
      const got = mapTextCase(input);
      expect(got.kind === "excluded" ? "excluded" : `${got.kind}:${"css" in got ? got.css : ""}`).toBe(
        expected,
      );
    });
  }
});

describe("mapTextDecoration", () => {
  const cases: Array<[string | undefined, string]> = [
    ["UNDERLINE", "value:underline"],
    // CSS spells it `line-through`, not `strikethrough`.
    ["STRIKETHROUGH", "value:line-through"],
    ["NONE", "default:none"],
    [undefined, "default:none"],
    ["WAVY", "excluded"],
  ];
  for (const [input, expected] of cases) {
    it(`${String(input)} → ${expected}`, () => {
      const got = mapTextDecoration(input);
      expect(got.kind === "excluded" ? "excluded" : `${got.kind}:${"css" in got ? got.css : ""}`).toBe(
        expected,
      );
    });
  }
});

describe("mapTextAlign", () => {
  const cases: Array<[string | undefined, string]> = [
    ["LEFT", "value:left"],
    ["RIGHT", "value:right"],
    ["CENTER", "value:center"],
    ["JUSTIFIED", "value:justify"],
    // Absent is NOT "LEFT": a hug-width label's horizontal placement is the
    // parent auto-layout's business, so there is nothing to compare.
    [undefined, "absent"],
    ["SIDEWAYS", "excluded"],
  ];
  for (const [input, expected] of cases) {
    it(`${String(input)} → ${expected}`, () => {
      const got = mapTextAlign(input);
      expect(
        got.kind === "excluded" || got.kind === "absent"
          ? got.kind
          : `${got.kind}:${"css" in got ? got.css : ""}`,
      ).toBe(expected);
    });
  }
});

describe("figmaLetterSpacingPx", () => {
  const cases: Array<[string, FigmaTypeStyle, string]> = [
    ["REST number is already px", { letterSpacing: 0.5 }, "value:0.5"],
    ["negative px", { letterSpacing: -0.25 }, "value:-0.25"],
    ["absent", {}, "absent"],
    ["plugin PIXELS shape", { letterSpacing: { value: 1.5, unit: "PIXELS" } }, "value:1.5"],
    [
      "plugin PERCENT converts against the font size",
      { letterSpacing: { value: 10, unit: "PERCENT" }, fontSize: 16 },
      "value:1.6",
    ],
    [
      "plugin PERCENT with no font size is excluded, not guessed",
      { letterSpacing: { value: 10, unit: "PERCENT" } },
      "excluded",
    ],
    ["unknown unit", { letterSpacing: { value: 1, unit: "REM" } }, "excluded"],
    ["non-finite", { letterSpacing: Number.NaN }, "excluded"],
  ];
  for (const [name, style, expected] of cases) {
    it(name, () => {
      const got = figmaLetterSpacingPx(style);
      expect(got.kind === "value" ? `value:${got.px}` : got.kind).toBe(expected);
    });
  }
});

/* -------------------------------------------------------------------------- *
 * Computed CSS normalization
 * -------------------------------------------------------------------------- */

describe("computed-CSS normalization", () => {
  it("text-transform keeps the four comparable keywords and refuses the rest", () => {
    expect(normalizeCodeTextTransform("uppercase")).toBe("uppercase");
    expect(normalizeCodeTextTransform("  NONE ")).toBe("none");
    expect(normalizeCodeTextTransform("full-width")).toBeNull();
    expect(normalizeCodeTextTransform("")).toBeNull();
    expect(normalizeCodeTextTransform(undefined)).toBeNull();
  });

  it("text-decoration-line sorts multi-value sets so order can't fake drift", () => {
    expect(normalizeCodeDecorationLine("underline line-through")).toBe("line-through underline");
    expect(normalizeCodeDecorationLine("line-through underline")).toBe("line-through underline");
    expect(normalizeCodeDecorationLine("none")).toBe("none");
    expect(normalizeCodeDecorationLine("wavy")).toBeNull();
  });

  it("text-align resolves the initial `start` against the writing direction", () => {
    expect(normalizeCodeTextAlign("start", "ltr")).toBe("left");
    expect(normalizeCodeTextAlign("start", "rtl")).toBe("right");
    expect(normalizeCodeTextAlign("end", "rtl")).toBe("left");
    // No direction collected (older preview bundle) → assume ltr, as browsers do.
    expect(normalizeCodeTextAlign("start", undefined)).toBe("left");
    expect(normalizeCodeTextAlign("center", "ltr")).toBe("center");
    // Unresolvable from the element alone.
    expect(normalizeCodeTextAlign("match-parent", "ltr")).toBeNull();
  });

  it("font-style folds oblique's angle and refuses anything unknown", () => {
    expect(normalizeCodeFontStyle("italic")).toBe("italic");
    expect(normalizeCodeFontStyle("oblique 14deg")).toBe("oblique");
    expect(normalizeCodeFontStyle("normal")).toBe("normal");
    expect(normalizeCodeFontStyle("bananas")).toBeNull();
  });

  it("parseLengthPx accepts px and bare zero only", () => {
    expect(parseLengthPx("0.5px")).toBe(0.5);
    expect(parseLengthPx("-1px")).toBe(-1);
    expect(parseLengthPx("0")).toBe(0);
    expect(parseLengthPx("2")).toBeNull();
    expect(parseLengthPx("normal")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- *
 * Row builders
 * -------------------------------------------------------------------------- */

describe("letterSpacingRow", () => {
  const cases: Array<[string, FigmaTypeStyle, string | undefined, Expectation]> = [
    ["match", { letterSpacing: 0.5 }, "0.5px", { status: "match" }],
    ["drift", { letterSpacing: 0.5 }, "1px", { status: "drift" }],
    ["absent Figma field → no row", {}, "1px", { absent: true }],
    ["percent with no font size → no row", { letterSpacing: { value: 5, unit: "PERCENT" } }, "1px", { absent: true }],
    // `normal` is the browser's no-opinion value, not literally 0.
    ["Figma 0 + code `normal` → no row", { letterSpacing: 0 }, "normal", { absent: true }],
    ["Figma 0 + explicit 0px → match", { letterSpacing: 0 }, "0px", { status: "match" }],
    ["Figma value + code `normal` → flag-only", { letterSpacing: 0.5 }, "normal", { status: "flag-only" }],
    ["no code value → no row", { letterSpacing: 0.5 }, undefined, { absent: true }],
    // Sub-pixel: 0.5 vs 0.52 is the same spacing, 0.5 vs 0.9 is not.
    ["within epsilon → match", { letterSpacing: 0.5 }, "0.52px", { status: "match" }],
    ["outside epsilon → drift", { letterSpacing: 0.5 }, "0.9px", { status: "drift" }],
  ];
  for (const [name, style, codeValue, expected] of cases) {
    it(name, () => {
      assertRow(letterSpacingRow({ style, codeValue }), expected);
    });
  }

  it("carries the bound variable name so a drift row can offer a fix", () => {
    const row = letterSpacingRow({
      style: { letterSpacing: 0.5 },
      codeValue: "1px",
      tokenName: "Typography/Tracking/Wide",
    });
    expect(row?.tokenName).toBe("Typography/Tracking/Wide");
    expect(row?.figmaValue).toBe("0.5px (token: Typography/Tracking/Wide)");
  });
});

describe("textAlignRow", () => {
  const cases: Array<[string, FigmaTypeStyle, string | undefined, Expectation]> = [
    ["match", { textAlignHorizontal: "CENTER" }, "center", { status: "match" }],
    ["drift", { textAlignHorizontal: "CENTER" }, "left", { status: "drift" }],
    ["absent Figma field → no row", {}, "center", { absent: true }],
    [
      "hug-width text → no row (alignment has no visible effect)",
      { textAlignHorizontal: "CENTER", textAutoResize: "WIDTH_AND_HEIGHT" },
      "left",
      { absent: true },
    ],
    [
      "`start` resolves to left and matches Figma LEFT",
      { textAlignHorizontal: "LEFT" },
      "start",
      { status: "match" },
    ],
    ["unusable computed value → no row", { textAlignHorizontal: "LEFT" }, "match-parent", { absent: true }],
  ];
  for (const [name, style, codeValue, expected] of cases) {
    it(name, () => {
      assertRow(textAlignRow({ style, codeValue, direction: "ltr" }), expected);
    });
  }

  it("says so when the verdict rested on normalizing `start`", () => {
    const row = textAlignRow({
      style: { textAlignHorizontal: "LEFT" },
      codeValue: "start",
      direction: "ltr",
    });
    expect(row?.note).toContain("`start`");
    expect(row?.note).toContain("ltr");
  });
});

describe("textTransformRow", () => {
  const cases: Array<[string, FigmaTypeStyle, string | undefined, string | undefined, Expectation]> = [
    ["match", { textCase: "UPPER" }, "uppercase", "Submit", { status: "match" }],
    ["drift", { textCase: "UPPER" }, "none", "Submit", { status: "drift" }],
    ["small-caps has no text-transform equivalent → no row", { textCase: "SMALL_CAPS" }, "uppercase", "Submit", { absent: true }],
    ["both at the initial value → no row", {}, "none", "Submit", { absent: true }],
    ["unusable computed value → no row", { textCase: "UPPER" }, "full-width", "Submit", { absent: true }],
    // Figma declares no case: whether the render differs depends on the literal text.
    ["no Figma case + code uppercases mixed-case text → drift", {}, "uppercase", "Submit", { status: "drift" }],
    ["no Figma case + text already caps → flag-only, not drift", {}, "uppercase", "SUBMIT", { status: "flag-only" }],
    ["no Figma case + capitalize is never adjudicated", {}, "capitalize", "Submit", { status: "flag-only" }],
    ["no Figma case + characters unknown → flag-only", {}, "uppercase", undefined, { status: "flag-only" }],
  ];
  for (const [name, style, codeValue, figmaChars, expected] of cases) {
    it(name, () => {
      assertRow(textTransformRow({ style, codeValue, figmaChars }), expected);
    });
  }

  it("flags the Title-Case ≈ capitalize caveat on the row itself", () => {
    const row = textTransformRow({ style: { textCase: "TITLE" }, codeValue: "capitalize" });
    expect(row?.status).toBe("match");
    expect(row?.note).toContain("Title Case");
  });
});

describe("textDecorationRow", () => {
  const cases: Array<[string, FigmaTypeStyle, string | undefined, Expectation]> = [
    ["match", { textDecoration: "UNDERLINE" }, "underline", { status: "match" }],
    ["strikethrough matches CSS line-through", { textDecoration: "STRIKETHROUGH" }, "line-through", { status: "match" }],
    ["drift", { textDecoration: "UNDERLINE" }, "line-through", { status: "drift" }],
    ["both none → no row", {}, "none", { absent: true }],
    ["unknown Figma value → no row", { textDecoration: "WAVY" }, "underline", { absent: true }],
    ["unusable computed value → no row", { textDecoration: "UNDERLINE" }, "wavy", { absent: true }],
    // Code decorates where the design doesn't: the story root really does
    // render a decoration, so this one is safe to call.
    ["code decorates, Figma doesn't → drift", {}, "underline", { status: "drift" }],
    // The reverse isn't safe: the decoration may live on an inner element.
    ["Figma decorates, root reports none → flag-only", { textDecoration: "UNDERLINE" }, "none", { status: "flag-only" }],
  ];
  for (const [name, style, codeValue, expected] of cases) {
    it(name, () => {
      assertRow(textDecorationRow({ style, codeValue }), expected);
    });
  }

  it("explains the non-inherited caveat rather than shrugging", () => {
    const row = textDecorationRow({ style: { textDecoration: "UNDERLINE" }, codeValue: "none" });
    expect(row?.note).toContain("not inherited");
  });
});

describe("fontStyleRow", () => {
  const cases: Array<[string, FigmaTypeStyle, string | undefined, Expectation]> = [
    ["match", { italic: true }, "italic", { status: "match" }],
    ["drift", { italic: true }, "normal", { status: "drift" }],
    ["code italicises where Figma is upright → drift", {}, "italic", { status: "drift" }],
    ["both upright → no row", {}, "normal", { absent: true }],
    ["no computed value → no row", { italic: true }, undefined, { absent: true }],
    ["oblique is not comparable to Figma's italic → flag-only", { italic: true }, "oblique 14deg", { status: "flag-only" }],
  ];
  for (const [name, style, codeValue, expected] of cases) {
    it(name, () => {
      assertRow(fontStyleRow({ style, codeValue }), expected);
    });
  }
});

describe("textStyleRows", () => {
  it("emits nothing when the code side has no opinion on any of the five", () => {
    expect(
      textStyleRows({
        style: {},
        codeStyles: {
          "letter-spacing": "normal",
          "text-align": "start",
          "text-transform": "none",
          "text-decoration-line": "none",
          "font-style": "normal",
        },
      }),
    ).toEqual([]);
  });

  it("emits one row per comparable property, in a stable order", () => {
    const rows = textStyleRows({
      style: {
        letterSpacing: 0.5,
        textAlignHorizontal: "CENTER",
        textCase: "UPPER",
        textDecoration: "UNDERLINE",
        italic: true,
      },
      codeStyles: {
        "letter-spacing": "0.5px",
        "text-align": "center",
        "text-transform": "uppercase",
        "text-decoration-line": "underline",
        "font-style": "italic",
        direction: "ltr",
      },
      figmaChars: "Submit",
    });
    expect(rows.map((r) => r.property)).toEqual([
      "letter-spacing",
      "text-align",
      "text-transform",
      "text-decoration-line",
      "font-style",
    ]);
    expect(rows.every((r) => r.status === "match")).toBe(true);
    expect(rows.every((r) => r.kind === "token-value")).toBe(true);
  });
});
