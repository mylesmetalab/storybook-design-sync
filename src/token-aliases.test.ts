import { describe, expect, it } from "vitest";
import { aliasSignature, lookupAlias, matchTokenNames } from "./token-aliases.js";

/**
 * The two mechanisms that decide whether two token names are the same design
 * decision, and the order they run in. Alias first, always: it is the project
 * telling us the answer, and the heuristic is a guess about spelling.
 */
describe("matchTokenNames — alias before heuristic", () => {
  const aliases = { "color/background/brand/default": "primary" };

  it("resolves the live #57 case through the alias map", () => {
    // Code binds `primary`; the Figma library calls the same decision
    // `color/background/brand/default`. No amount of spelling normalization can
    // reconcile those, which is why the map exists.
    expect(matchTokenNames("primary", "color/background/brand/default", aliases)).toEqual({
      same: true,
      via: "alias",
    });
  });

  it("says so when nothing reconciles the two names", () => {
    expect(matchTokenNames("primary", "color/background/brand/default", {})).toEqual({
      same: false,
      via: null,
    });
  });

  it("reports `heuristic` when only spelling differs", () => {
    const cases: Array<[string, string]> = [
      ["radius-xl", "radius/xl"],
      ["--radius-xl", "Radius/XL"],
      ["radius.xl", "radius/xl"],
      // design-sync-core v0.0.4: whitespace joins the same separator class as
      // `-`/`/`/`.`, so a real Figma name with spaces matches a dashed code name.
      ["body-font-weight-regular", "Body/Font Weight Regular"],
    ];
    for (const [code, figma] of cases) {
      expect(matchTokenNames(code, figma, {}), `${code} vs ${figma}`).toEqual({
        same: true,
        via: "heuristic",
      });
    }
  });

  it("prefers the alias even when it CONTRADICTS the heuristic", () => {
    // The project has stated that Figma's `space/150` is called `spacing-lg`
    // here. The code binds `space-150`, which the heuristic would happily accept.
    // The explicit statement is the better evidence, including when it disagrees:
    // silently matching on spelling would hide a real mis-binding.
    const result = matchTokenNames("space-150", "space/150", { "space/150": "spacing-lg" });
    expect(result).toEqual({ same: false, via: null, aliasExpected: "spacing-lg" });
  });

  it("is forgiving about how the map itself is spelled", () => {
    for (const key of ["color/background/brand/default", "--color-background-brand-default", "Color/Background/Brand/Default"]) {
      expect(
        matchTokenNames("primary", "color/background/brand/default", { [key]: "primary" }).same,
        key,
      ).toBe(true);
    }
    // …and about the value side, which may be written as a CSS custom property.
    expect(
      matchTokenNames("primary", "color/background/brand/default", {
        "color/background/brand/default": "--primary",
      }).same,
    ).toBe(true);
  });

  it("never matches on an empty code side", () => {
    expect(matchTokenNames("", "radius/xl", {}).same).toBe(false);
    expect(matchTokenNames(null, null, {}).same).toBe(false);
    expect(matchTokenNames(undefined, "radius/xl", {}).same).toBe(false);
  });
});

describe("lookupAlias", () => {
  it("returns the project's name for a Figma variable, or null", () => {
    const aliases = { "color/background/brand/default": "primary" };
    expect(lookupAlias("color/background/brand/default", aliases)).toBe("primary");
    expect(lookupAlias("color/background/brand/hover", aliases)).toBeNull();
    expect(lookupAlias(undefined, aliases)).toBeNull();
    expect(lookupAlias("radius/xl")).toBeNull();
  });
});

describe("aliasSignature — cache identity for the alias map", () => {
  it("is empty for no aliases, so existing cache entries keep hitting", () => {
    expect(aliasSignature(undefined)).toBe("");
    expect(aliasSignature({})).toBe("");
  });

  it("is stable across key order and spelling, and changes with content", () => {
    const a = aliasSignature({ "a/b": "x", "c/d": "y" });
    expect(aliasSignature({ "c/d": "y", "a/b": "x" })).toBe(a);
    expect(aliasSignature({ "A/B": "X", "--c-d": "Y" })).toBe(a);
    expect(aliasSignature({ "a/b": "z", "c/d": "y" })).not.toBe(a);
    expect(aliasSignature({ "a/b": "x" })).not.toBe(a);
  });
});
