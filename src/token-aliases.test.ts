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

/**
 * `codeSyntax` as the top-precedence mechanism (#93 follow-up, v0.0.53).
 *
 * This branch was **unreachable against real data** until the reference file had
 * one variable whose `codeSyntax` names a property the consumer declares. Made
 * reachable, it immediately showed the bug: `border-brand` vs
 * `Border/Brand/Default` was reported as a name divergence advising a
 * `tokenAliases` entry that Figma had already made unnecessary.
 *
 * #93 wired `codeSyntax` into token *presence* — "does this project declare the
 * property" — and not into this comparison, which asks the different question
 * "do these two names mean the same decision".
 */
describe("matchTokenNames — codeSyntax outranks everything", () => {
  const FIGMA = "Border/Brand/Default";

  it("matches when Figma's codeSyntax names exactly what the code binds", () => {
    const m = matchTokenNames("border-brand", FIGMA, {}, "var(--border-brand)");
    expect(m).toEqual({ same: true, via: "code-syntax" });
  });

  it("accepts a bare custom property as well as var()", () => {
    expect(matchTokenNames("border-brand", FIGMA, {}, "--border-brand").via).toBe("code-syntax");
  });

  it("normalizes case and slashes on both sides, so spelling cannot cause a false divergence", () => {
    expect(matchTokenNames("Border/Brand", FIGMA, {}, "var(--BORDER-brand)").via).toBe(
      "code-syntax",
    );
  });

  /**
   * Underscores are deliberately NOT collapsed. `normalizeTokenName` folds `/`,
   * `.` and whitespace; an underscore is a legal CSS identifier character, so
   * `--border_brand` and `--border-brand` are two different properties and
   * treating them as one would be a guess dressed as an authoritative match.
   * Asserted because I got this wrong writing these tests.
   */
  it("does not collapse underscores into hyphens", () => {
    expect(matchTokenNames("border_brand", FIGMA, {}, "var(--border-brand)").same).toBe(false);
  });

  /**
   * The precedence that matters: an alias saying something *else* does not
   * demote a codeSyntax agreement to a divergence. Both sides already agree;
   * a stale alias is not evidence against that.
   */
  it("beats a contradicting tokenAliases entry rather than being overridden by it", () => {
    const m = matchTokenNames(
      "border-brand",
      FIGMA,
      { [FIGMA]: "something-else" },
      "var(--border-brand)",
    );
    expect(m).toEqual({ same: true, via: "code-syntax" });
    expect("aliasExpected" in m).toBe(false);
  });

  it("falls through to alias when codeSyntax names a different property", () => {
    // The common real case: SDS's own `--sds-*` vocabulary, consumer's own name.
    const m = matchTokenNames(
      "border-brand",
      FIGMA,
      { [FIGMA]: "border-brand" },
      "var(--sds-color-border-brand-default)",
    );
    expect(m).toEqual({ same: true, via: "alias" });
  });

  it("falls through to the heuristic when there is no codeSyntax at all", () => {
    expect(matchTokenNames("border-brand-default", FIGMA, {}).via).toBe("heuristic");
  });

  /**
   * An unparseable `codeSyntax` must be ignored, not half-used. Coercing
   * `bg-primary` into a property name would invent an authoritative match.
   */
  it.each(["bg-primary", "tokens.color.brand", "1px solid var(--a)", "", "   "])(
    "ignores an unparseable codeSyntax %o rather than coercing it",
    (cs) => {
      expect(matchTokenNames("border-brand", FIGMA, {}, cs).via).not.toBe("code-syntax");
    },
  );

  it("never matches an empty code binding, whatever codeSyntax says", () => {
    // An absent code side is not a match; it is the flag-only path upstream.
    for (const code of [null, undefined, ""]) {
      expect(matchTokenNames(code, FIGMA, {}, "var(--border-brand)").same).toBe(false);
    }
  });

  it("reports a genuine disagreement as a divergence, not a match", () => {
    const m = matchTokenNames("primary", FIGMA, {}, "var(--border-brand)");
    expect(m.same).toBe(false);
  });
});
