import { describe, expect, it } from "vitest";
import { variantScopeFor, type SiblingStoryRows } from "./variant-scope.js";
import type { DimensionDiff } from "./dimensions/types.js";

/**
 * Issue #68 — an edit's blast radius across sibling variants.
 *
 * The reproduction, from the live Card: rebind the Title of the `Icon, Stroke,
 * Horizontal` variant only, then `Check all`.
 *
 *   ui-card--icon-stroke-horizontal → [data-slot=title] color DRIFT, expects Text/Positive/Secondary
 *   the other 7 bound Card stories   → same selector, same property, MATCH at Text/Default/Default
 *
 * `card.tsx:187` puts the title colour in one shared class on the shared `TitleTag`.
 * There is no variant seam. Applying the prompt would turn all ten Card titles green
 * and put 7 previously-clean stories into drift.
 *
 * The addon held all of that inside one bulk run. These tests pin that it now looks,
 * and — just as importantly — that it reports "not established" rather than
 * "established, no problem" when the run holds no sibling.
 */

/** Laxer than `Partial<DimensionDiff>`: several cases set a field to `undefined`
 *  on purpose (an unreadable expected value, a root row), which
 *  `exactOptionalPropertyTypes` forbids on the strict shape. */
type RowOverride = { [K in keyof DimensionDiff]?: DimensionDiff[K] | undefined };

function row(over: RowOverride = {}): DimensionDiff {
  return {
    kind: "token-value",
    property: "color",
    codeValue: "rgb(30, 30, 30)",
    figmaValue: "rgb(30, 30, 30)",
    status: "match",
    tokenName: "Text/Default/Default",
    childSelector: "[data-slot=title]",
    ...over,
  } as DimensionDiff;
}

function story(storyId: string, dims: DimensionDiff[]): SiblingStoryRows {
  return { storyId, dimensions: dims };
}

const subject = {
  storyId: "ui-card--icon-stroke-horizontal",
  property: "color",
  childSelector: "[data-slot=title]",
  tokenName: "Text/Positive/Secondary",
  figmaValue: "rgb(0, 153, 81)",
};

describe("variantScopeFor", () => {
  it("names the sibling stories that expect a different value", () => {
    const scope = variantScopeFor(subject, [
      story("ui-card--horizontal", [row()]),
      story("ui-card--vertical", [row()]),
      story("ui-card--icon-stroke-horizontal", [row({ status: "drift" })]),
    ]);
    expect(scope).toEqual({
      comparedStories: ["ui-card--horizontal", "ui-card--vertical"],
      conflicting: [
        { storyId: "ui-card--horizontal", expected: "Text/Default/Default" },
        { storyId: "ui-card--vertical", expected: "Text/Default/Default" },
      ],
    });
  });

  it("counts a MATCHING sibling as a conflict — it is the one that would break", () => {
    const scope = variantScopeFor(subject, [story("ui-card--horizontal", [row()])]);
    expect(scope?.conflicting).toHaveLength(1);
  });

  it("reports agreement when the siblings expect the same thing", () => {
    const agreeing = row({ tokenName: "Text/Positive/Secondary", status: "drift" });
    const scope = variantScopeFor(subject, [
      story("ui-card--horizontal", [agreeing]),
      story("ui-card--vertical", [agreeing]),
    ]);
    expect(scope).toEqual({
      comparedStories: ["ui-card--horizontal", "ui-card--vertical"],
      conflicting: [],
    });
  });

  /**
   * `undefined` is a real answer, not an empty one. An empty-but-present scope would
   * read as "we checked and found nothing", which is the opposite of the truth for a
   * single-story check.
   */
  it("is undefined when the run held no comparable sibling", () => {
    expect(variantScopeFor(subject, [])).toBeUndefined();
    expect(
      variantScopeFor(subject, [story("ui-card--horizontal", [row({ property: "gap" })])]),
    ).toBeUndefined();
    expect(
      variantScopeFor(subject, [
        story("ui-card--horizontal", [row({ childSelector: "[data-slot=body]" })]),
      ]),
    ).toBeUndefined();
  });

  it("ignores the subject's own story", () => {
    expect(
      variantScopeFor(subject, [story("ui-card--icon-stroke-horizontal", [row()])]),
    ).toBeUndefined();
  });

  it("skips a sibling whose expected value is unreadable rather than counting it as agreeing", () => {
    const unreadable = row({ status: "drift", tokenName: undefined, figmaValue: null });
    expect(variantScopeFor(subject, [story("ui-card--horizontal", [unreadable])])).toBeUndefined();
  });

  it("skips a sibling row that is flag-only or unresolved — no comparison happened there", () => {
    expect(
      variantScopeFor(subject, [
        story("ui-card--horizontal", [row({ status: "flag-only" })]),
        story("ui-card--vertical", [row({ status: "unresolved" })]),
      ]),
    ).toBeUndefined();
  });

  it("is undefined when the subject itself has no readable expected value", () => {
    expect(
      variantScopeFor(
        { ...subject, tokenName: undefined, figmaValue: null },
        [story("ui-card--horizontal", [row()])],
      ),
    ).toBeUndefined();
  });

  it("falls back to the resolved value when Figma named no token", () => {
    const scope = variantScopeFor(
      { ...subject, tokenName: undefined },
      [story("ui-card--horizontal", [row({ tokenName: undefined, figmaValue: "rgb(1, 2, 3)" })])],
    );
    expect(scope?.conflicting).toEqual([
      { storyId: "ui-card--horizontal", expected: "rgb(1, 2, 3)" },
    ]);
  });

  it("compares the root's rows separately from a child's", () => {
    const rootSubject = { ...subject, childSelector: undefined };
    // A child's `color` says nothing about the root's, and vice versa.
    expect(variantScopeFor(rootSubject, [story("ui-card--horizontal", [row()])])).toBeUndefined();
    const scope = variantScopeFor(rootSubject, [
      story("ui-card--horizontal", [row({ childSelector: undefined })]),
    ]);
    expect(scope?.comparedStories).toEqual(["ui-card--horizontal"]);
  });
});
