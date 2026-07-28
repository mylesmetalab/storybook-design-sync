import { describe, expect, it } from "vitest";
import { divergenceNote, nameDivergenceStatus, suggestAliasEntry } from "./binding-divergence.js";
import type { DimensionDiff } from "./dimensions/types.js";

const value = (status: DimensionDiff["status"], property = "background-color"): DimensionDiff => ({
  kind: "token-value",
  property,
  codeValue: "rgb(0, 0, 0)",
  figmaValue: "rgb(0, 0, 0)",
  status,
});

/**
 * The triage at the heart of issue #57: what a name divergence is *worth* is
 * decided by the value comparison, never by the names alone.
 */
describe("nameDivergenceStatus", () => {
  const cases: Array<{
    what: string;
    valueDiffs: DimensionDiff[];
    expected: "drift" | "value-matched" | "unverified";
  }> = [
    {
      what: "value matched — spelling only, not a defect",
      valueDiffs: [value("match")],
      expected: "value-matched",
    },
    {
      what: "value drifted — a real defect on this property",
      valueDiffs: [value("drift")],
      expected: "drift",
    },
    {
      what: "no value row at all — nothing to fall back on",
      valueDiffs: [],
      expected: "unverified",
    },
    {
      what: "value row for a DIFFERENT property — still nothing to fall back on",
      valueDiffs: [value("match", "padding-top")],
      expected: "unverified",
    },
    {
      what: "value flag-only — no comparison landed",
      valueDiffs: [value("flag-only")],
      expected: "unverified",
    },
    {
      what: "value unresolved — Figma's side couldn't be read",
      valueDiffs: [value("unresolved")],
      expected: "unverified",
    },
  ];

  for (const c of cases) {
    it(c.what, () => {
      expect(nameDivergenceStatus("background-color", c.valueDiffs)).toBe(c.expected);
    });
  }

  it("ignores non-token-value rows with the same property name", () => {
    const binding: DimensionDiff = {
      kind: "token-binding",
      property: "background-color",
      codeValue: "primary",
      figmaValue: "color/background/brand/default",
      status: "match",
    };
    expect(nameDivergenceStatus("background-color", [binding])).toBe("unverified");
  });
});

describe("divergenceNote — every note carries the fix, not just the finding", () => {
  const base = { codeValue: "primary", figmaName: "color/background/brand/default" };

  it("says a value-matched divergence is NOT drift, and quotes the alias entry", () => {
    const note = divergenceNote({ ...base, kind: "value-matched" });
    expect(note).toContain("Name-only divergence");
    expect(note).toContain("the resolved values match");
    expect(note).toContain("this is not drift");
    expect(note).toContain(`"color/background/brand/default": "primary"`);
    expect(note).toContain("tokenAliases");
  });

  it("says an unverified divergence is NOT a match", () => {
    const note = divergenceNote({ ...base, kind: "unverified" });
    expect(note).toContain("no value comparison was available");
    expect(note).toContain("it is NOT a match");
  });

  it("leads with the contradiction when an alias exists and the code binds something else", () => {
    const note = divergenceNote({ ...base, kind: "value-matched", aliasExpected: "brand" });
    expect(note).toContain("maps `color/background/brand/default` to `brand`");
    expect(note).toContain("the code binds `primary`");
    // No point suggesting an entry that already exists.
    expect(note).not.toContain("Add \"color/background/brand/default\"");
  });

  it("still reports the names when the values disagree too", () => {
    const note = divergenceNote({ ...base, kind: "drift" });
    expect(note).toContain("the values also disagree");
  });
});

describe("suggestAliasEntry", () => {
  it("is copy-pasteable JSON", () => {
    expect(suggestAliasEntry("color/background/brand/default", "primary")).toBe(
      `"color/background/brand/default": "primary"`,
    );
  });
});
