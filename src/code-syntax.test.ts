import { describe, expect, it } from "vitest";

import {
  customPropertyFromCodeSyntax,
  describeTokenNameSource,
  isAuthoritative,
  resolveTokenName,
} from "./code-syntax.js";

/**
 * The point of #93 is removing inference from the tool's *output*. So the tests
 * weight two things: that an authoritative name is used when there is one, and
 * that an inferred name is never dressed up as authoritative.
 *
 * The heaviest coverage is on the case that made me rewrite the issue's rule —
 * a `codeSyntax` the project does not declare. On the reference file that is
 * **356 of 361 variables**, so treating it as a finding (as #93 specified) would
 * have filled every report with noise.
 */

/** Real values, read from the reference file on 2026-08-04. */
const SDS = {
  brandBg: { name: "Background/Brand/Default", cs: "var(--sds-color-background-brand-default)" },
  radius: { name: "Radius/200", cs: "var(--sds-size-radius-200)" },
};

describe("customPropertyFromCodeSyntax", () => {
  it("reads the `var(--name)` shape the reference file uses", () => {
    expect(customPropertyFromCodeSyntax("var(--sds-color-background-brand-default)")).toBe(
      "--sds-color-background-brand-default",
    );
  });

  it("accepts a bare custom property too", () => {
    expect(customPropertyFromCodeSyntax("--color-primary")).toBe("--color-primary");
  });

  it("tolerates whitespace", () => {
    expect(customPropertyFromCodeSyntax("  var( --a-b )  ")).toBe("--a-b");
  });

  /**
   * A name we cannot parse is not a name we may assert. Coercing any of these
   * would put a fabricated token name into a fix prompt.
   */
  it.each([
    "bg-primary",
    "tokens.color.primary",
    "1px solid var(--a)",
    "var(--a) var(--b)",
    "var(a)",
    "",
    "   ",
  ])("refuses to read %o as a custom property", (raw) => {
    expect(customPropertyFromCodeSyntax(raw)).toBeUndefined();
  });

  it("returns undefined for a non-string", () => {
    expect(customPropertyFromCodeSyntax(undefined)).toBeUndefined();
  });
});

describe("resolveTokenName — tier 1: Figma names it AND the project declares it", () => {
  it("is authoritative, with no inference", () => {
    const r = resolveTokenName({
      figmaVariableName: SDS.brandBg.name,
      codeSyntax: SDS.brandBg.cs,
      declaredCustomProperties: new Set(["sds-color-background-brand-default"]),
    });
    expect(r).toMatchObject({
      name: "sds-color-background-brand-default",
      source: "code-syntax",
      figmaCodeSyntax: "--sds-color-background-brand-default",
    });
    expect(isAuthoritative(r.source)).toBe(true);
    expect(describeTokenNameSource(r)).toMatch(/Figma's own `codeSyntax` names/);
    expect(describeTokenNameSource(r)).not.toMatch(/convention|NOT confirmed/);
  });

  it("reports a disagreement with tokenAliases rather than picking one", () => {
    // Two explicit authorities contradicting each other is information, not
    // something to silently resolve.
    const r = resolveTokenName({
      figmaVariableName: SDS.brandBg.name,
      codeSyntax: SDS.brandBg.cs,
      aliases: { [SDS.brandBg.name]: "--primary" },
      declaredCustomProperties: new Set(["sds-color-background-brand-default"]),
    });
    expect(r.source).toBe("code-syntax");
    expect(r.conflict).toMatch(/disagree/);
    expect(r.conflict).toContain("--primary");
  });

  it("has no conflict when tokenAliases agrees", () => {
    const r = resolveTokenName({
      figmaVariableName: SDS.brandBg.name,
      codeSyntax: "var(--primary)",
      aliases: { [SDS.brandBg.name]: "--primary" },
      declaredCustomProperties: new Set(["primary"]),
    });
    expect(r.conflict).toBeUndefined();
  });
});

/**
 * The case that rewrote the issue's rule. #93 said this should be a **finding**.
 * On the reference file it is 356 of 361 variables, because SDS ships its own CSS
 * (`--sds-*`) and the starter maps it onto shadcn's names. It is a legitimate
 * re-mapping, not a disagreement.
 */
describe("resolveTokenName — tier 2/3: a codeSyntax this project does not declare", () => {
  it("is NOT authoritative and NOT a finding", () => {
    const r = resolveTokenName({
      figmaVariableName: SDS.brandBg.name,
      codeSyntax: SDS.brandBg.cs,
      declaredCustomProperties: new Set(["primary", "border-brand"]),
    });
    expect(r.source).toBe("code-syntax-foreign");
    expect(isAuthoritative(r.source)).toBe(false);
    expect(r.conflict).toBeUndefined();
  });

  it("still quotes Figma's name, so only ONE half is inferred", () => {
    // The gain over the old heuristic-only path: the message can say what Figma
    // calls it instead of guessing at that too.
    const r = resolveTokenName({
      figmaVariableName: SDS.radius.name,
      codeSyntax: SDS.radius.cs,
      declaredCustomProperties: new Set(["radius"]),
    });
    const described = describeTokenNameSource(r);
    expect(described).toContain("--sds-size-radius-200");
    expect(described).toMatch(/does not declare/);
    expect(described).toMatch(/NOT confirmed/);
    expect(described).toMatch(/tokenAliases/);
  });

  it("lets an explicit alias win over the foreign name", () => {
    const r = resolveTokenName({
      figmaVariableName: SDS.brandBg.name,
      codeSyntax: SDS.brandBg.cs,
      aliases: { [SDS.brandBg.name]: "--primary" },
      declaredCustomProperties: new Set(["primary"]),
    });
    expect(r).toMatchObject({ name: "primary", source: "alias" });
    // …and still says what Figma calls it, so the mapping is visible.
    expect(describeTokenNameSource(r)).toContain("--sds-color-background-brand-default");
  });

  /**
   * An empty declared-property set means the CSS scan reached nothing. That must
   * NOT promote a foreign name to authoritative — a scan that read no files is
   * not evidence that a name matches.
   */
  it("never reaches tier 1 when no custom properties were scanned", () => {
    for (const declared of [undefined, new Set<string>()]) {
      const r = resolveTokenName({
        figmaVariableName: SDS.brandBg.name,
        codeSyntax: SDS.brandBg.cs,
        declaredCustomProperties: declared,
      });
      expect(r.source).toBe("code-syntax-foreign");
    }
  });
});

describe("resolveTokenName — tier 4: no codeSyntax at all", () => {
  it("falls back to the heuristic and says so", () => {
    // 5 of 361 reference variables have no codeSyntax, so this path stays live.
    const r = resolveTokenName({
      figmaVariableName: "Space/300",
      declaredCustomProperties: new Set(["radius"]),
    });
    expect(r.source).toBe("heuristic");
    expect(r.figmaCodeSyntax).toBeUndefined();
    expect(isAuthoritative(r.source)).toBe(false);
    const described = describeTokenNameSource(r);
    expect(described).toMatch(/declares no `codeSyntax`/);
    expect(described).toMatch(/NOT confirmed/);
  });

  it("prefers an alias over the heuristic", () => {
    const r = resolveTokenName({
      figmaVariableName: "Space/300",
      aliases: { "Space/300": "--spacing-3" },
    });
    expect(r).toMatchObject({ name: "spacing-3", source: "alias" });
    // No codeSyntax to cite, so the wording must not imply one exists.
    expect(describeTokenNameSource(r)).not.toMatch(/codeSyntax/);
  });

  it("ignores a codeSyntax it could not parse, rather than half-using it", () => {
    const r = resolveTokenName({
      figmaVariableName: "Space/300",
      codeSyntax: "p-3",
      declaredCustomProperties: new Set(["spacing-3"]),
    });
    expect(r.source).toBe("heuristic");
    expect(r.figmaCodeSyntax).toBeUndefined();
  });
});

describe("the honesty invariant", () => {
  /**
   * Every non-authoritative wording must admit it. This is the whole feature: a
   * v0.0.44 prompt said "by convention Figma's `Space/300` converts to
   * `--space-300`" and asked a human to trust the clause before the comma.
   */
  it.each([
    ["heuristic", { figmaVariableName: "Space/300" }],
    [
      "code-syntax-foreign",
      { figmaVariableName: SDS.radius.name, codeSyntax: SDS.radius.cs },
    ],
  ])("%s wording admits the name is unconfirmed", (_label, input) => {
    const described = describeTokenNameSource(resolveTokenName(input));
    expect(described).toMatch(/NOT confirmed/);
  });

  it("authoritative wording never claims convention", () => {
    for (const input of [
      {
        figmaVariableName: SDS.radius.name,
        codeSyntax: "var(--radius)",
        declaredCustomProperties: new Set(["radius"]),
      },
      { figmaVariableName: "Space/300", aliases: { "Space/300": "--spacing-3" } },
    ]) {
      expect(describeTokenNameSource(resolveTokenName(input))).not.toMatch(
        /convention|NOT confirmed/,
      );
    }
  });
});
