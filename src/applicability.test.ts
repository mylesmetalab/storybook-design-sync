import { describe, expect, it } from "vitest";
import {
  isTextOwnedProperty,
  ownsRenderedText,
  TEXT_OWNED_PROPERTIES,
} from "./applicability.js";

/**
 * The predicate behind F3: which element is the one whose type/colour/copy a
 * verdict can be about.
 *
 * Ported from `storybook-design-inspector`'s `typographyApplies()` with one
 * deliberate change — `ownText` (this element's own text nodes) instead of
 * `textContent` (the whole subtree). The inspector is deciding whether to *show*
 * a section, and font properties cascade, so a wrapper is worth inspecting. The
 * auditor is deciding whether to *state a verdict* against a Figma node, and on
 * a wrapper the two sides describe different elements.
 */

describe("ownsRenderedText", () => {
  const cases: Array<{
    what: string;
    probe: Parameters<typeof ownsRenderedText>[0];
    owns: boolean;
  }> = [
    {
      what: "a leaf that renders its own text",
      probe: { ownText: "Title", tagName: "H3" },
      owns: true,
    },
    {
      what: "an element whose only text lives in descendants",
      probe: { ownText: "", tagName: "DIV" },
      owns: false,
    },
    {
      what: "a wrapper whose own text nodes are the whitespace between children",
      probe: { ownText: "\n        \n      ", tagName: "DIV" },
      owns: false,
    },
    {
      what: "a text-bearing container — own text AND element children",
      probe: { ownText: "Title ", tagName: "H3" },
      owns: true,
    },
    { what: "a <textarea>", probe: { ownText: "", tagName: "TEXTAREA" }, owns: true },
    { what: "a <select>", probe: { ownText: "", tagName: "SELECT" }, owns: true },
    {
      what: "a text <input> (its value never reaches textContent)",
      probe: { ownText: "", tagName: "INPUT", inputType: "text" },
      owns: true,
    },
    {
      what: "an <input> with no type attribute (defaults to text)",
      probe: { ownText: "", tagName: "INPUT" },
      owns: true,
    },
    {
      what: "an <input type=email>",
      probe: { ownText: "", tagName: "INPUT", inputType: "email" },
      owns: true,
    },
    {
      what: "an <input type=checkbox> — paints no text",
      probe: { ownText: "", tagName: "INPUT", inputType: "checkbox" },
      owns: false,
    },
    {
      what: "an <input type=range> — paints no text",
      probe: { ownText: "", tagName: "INPUT", inputType: "range" },
      owns: false,
    },
  ];

  for (const { what, probe, owns } of cases) {
    it(`${owns ? "counts" : "does not count"} ${what}`, () => {
      expect(ownsRenderedText(probe)).toBe(owns);
    });
  }

  /**
   * The load-bearing fallback. A snapshot from a preview bundle older than
   * v0.0.40 (or replayed from a cache one wrote) carries no `ownText`. Absence
   * of a probe is not absence of text, and suppressing rows on it would delete
   * real comparisons — the same call the inspector makes with `ALL_APPLICABLE`.
   */
  it("treats an unprobed snapshot as text-bearing rather than suppressing rows", () => {
    expect(ownsRenderedText({ tagName: "DIV" })).toBe(true);
    expect(ownsRenderedText({})).toBe(true);
    expect(ownsRenderedText(undefined)).toBe(true);
    expect(ownsRenderedText(null)).toBe(true);
  });

  it("distinguishes an unprobed snapshot from a probed empty one", () => {
    expect(ownsRenderedText({ ownText: undefined, tagName: "DIV" })).toBe(true);
    expect(ownsRenderedText({ ownText: "", tagName: "DIV" })).toBe(false);
  });
});

describe("TEXT_OWNED_PROPERTIES", () => {
  it("covers the typography family and `color`", () => {
    for (const property of [
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
    ]) {
      expect(isTextOwnedProperty(property)).toBe(true);
    }
  });

  /**
   * A wrapper paints its own box. Suppressing these would be the mirror-image
   * bug: hiding drift on a property the element really does own.
   */
  it("excludes every property a text-less wrapper still paints itself", () => {
    for (const property of [
      "background-color",
      "border-color",
      "border-width",
      "border-top-left-radius",
      "padding-top",
      "gap",
      "box-shadow",
      "opacity",
    ]) {
      expect(isTextOwnedProperty(property)).toBe(false);
      expect(TEXT_OWNED_PROPERTIES.has(property)).toBe(false);
    }
  });
});
