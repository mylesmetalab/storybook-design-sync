import { describe, expect, it } from "vitest";

import {
  customPropertyFromCodeSyntax,
  isAuthoritative,
  resolveTokenName,
} from "./code-syntax.js";
import SDS from "./fixtures/sds-code-syntax.json" with { type: "json" };

/**
 * #93 against the real thing.
 *
 * `code-syntax.test.ts` exercises the tiers with hand-written inputs. This file
 * runs them over **every variable in the reference Figma file** — all 361, read
 * live from `/v1/files/:key/variables/local` on 2026-08-04 and committed as a
 * fixture. It exists because the unit tests could not answer one question that
 * matters: does tier 1 ever actually fire, and does it fire on real names?
 *
 * ## What is real here and what is not — precisely
 *
 * **Real:** every variable name and every `codeSyntax.WEB` string. Untouched.
 *
 * **Constructed:** the `declaredCustomProperties` set. Tier 1 requires a consumer
 * whose own CSS declares the property Figma names, and no consumer we have does —
 * the starter deliberately maps SDS onto shadcn's vocabulary, so it declares
 * `--primary`, not `--sds-color-background-brand-default`. So the set below is
 * derived *from the fixture itself*, standing in for a consumer that adopts SDS's
 * own CSS. That is a real and common way to adopt a design system, but it is a
 * modelled consumer, not an observed one.
 *
 * This is stated rather than glossed because a test over a real fixture reads as
 * end-to-end evidence, and half of this one isn't.
 */

const ENTRIES = Object.entries(SDS as Record<string, { codeSyntax?: string }>);

/** Bare property names (`--x` → `x`) for every parseable codeSyntax in the file. */
const SDS_DECLARED = new Set(
  ENTRIES.map(([, v]) => customPropertyFromCodeSyntax(v.codeSyntax))
    .filter((p): p is string => p !== undefined)
    .map((p) => p.replace(/^--/, "")),
);

describe("the reference file, as a fact", () => {
  it("has 360 uniquely-named variables from 361 entries", () => {
    // 361 variables, 360 names. `Stroke/Border` is declared twice.
    expect(ENTRIES).toHaveLength(360);
  });

  /**
   * The counts in this file are **per name**; the 356/361 quoted in the README,
   * CLAUDE.md and #93 are **per variable**. Both are right and they differ by one,
   * because the duplicated `Stroke/Border` carries a codeSyntax on both entries
   * and collapses to a single key here. Worth an assertion so nobody "fixes" one
   * number to match the other.
   */
  it("is keyed by name, so its codeSyntax count is one below the per-variable 356", () => {
    const withCs = ENTRIES.filter(([, v]) => v.codeSyntax !== undefined);
    expect(withCs).toHaveLength(355);
  });

  /**
   * Worth its own assertion because the whole heuristic path matches **by name**.
   * Two variables sharing one name means a name-based match is ambiguous for that
   * name no matter how good the normalisation is — the answer has to come from
   * somewhere else, which is the argument for `codeSyntax` in one line.
   */
  it("contains a duplicated variable name, which name-matching cannot disambiguate", () => {
    expect(SDS["Stroke/Border"]).toBeDefined();
  });

  it("uses the `var(--sds-…)` shape universally — no exceptions", () => {
    const odd = ENTRIES.filter(([, v]) => v.codeSyntax !== undefined).filter(
      ([, v]) => !/^var\(--sds-[a-z0-9-]+\)$/.test(v.codeSyntax as string),
    );
    expect(odd).toEqual([]);
  });

  /**
   * The measurement that rewrote #93's precedence rule. The issue said a
   * `codeSyntax` naming an undeclared property is *a finding*; against a consumer
   * with its own vocabulary that is 355 findings by name (356 by variable), all noise.
   */
  it("would produce 355 findings under the issue's original rule", () => {
    const shadcnish = new Set(["primary", "border-brand", "radius", "background", "foreground"]);
    const wouldFlag = ENTRIES.filter(([name, v]) => {
      const r = resolveTokenName({
        figmaVariableName: name,
        codeSyntax: v.codeSyntax,
        declaredCustomProperties: shadcnish,
      });
      return r.source === "code-syntax-foreign";
    });
    expect(wouldFlag).toHaveLength(355);
  });
});

describe("tier 1 over real codeSyntax values (modelled consumer — see file header)", () => {
  it("is authoritative for every one of the 355, with no conflicts", () => {
    const results = ENTRIES.filter(([, v]) => v.codeSyntax !== undefined).map(([name, v]) =>
      resolveTokenName({
        figmaVariableName: name,
        codeSyntax: v.codeSyntax,
        declaredCustomProperties: SDS_DECLARED,
      }),
    );

    expect(results).toHaveLength(355);
    expect(results.filter((r) => r.source !== "code-syntax")).toEqual([]);
    expect(results.every((r) => isAuthoritative(r.source))).toBe(true);
    expect(results.filter((r) => r.conflict !== undefined)).toEqual([]);
  });

  /**
   * The point of tier 1: the resolved name comes from Figma's string, never from
   * normalising the variable name. On this file those two answers differ for
   * every single variable — `Background/Brand/Default` normalises to
   * `background-brand-default`, and Figma says `sds-color-background-brand-default`.
   * So if tier 1 were silently falling through to the heuristic, this assertion
   * would fail 355 times rather than pass by coincidence.
   */
  it("returns Figma's property, not a normalisation of the variable name", () => {
    const wrong = ENTRIES.filter(([, v]) => v.codeSyntax !== undefined).filter(([name, v]) => {
      const r = resolveTokenName({
        figmaVariableName: name,
        codeSyntax: v.codeSyntax,
        declaredCustomProperties: SDS_DECLARED,
      });
      const expected = customPropertyFromCodeSyntax(v.codeSyntax)?.replace(/^--/, "");
      return r.name !== expected;
    });
    expect(wrong).toEqual([]);
  });

  it("still falls to the heuristic for the 5 with no codeSyntax", () => {
    const none = ENTRIES.filter(([, v]) => v.codeSyntax === undefined);
    // Named, so a reader can see they are a coherent group rather than random
    // omissions: four typography primitives plus one raw colour.
    expect(none.map(([n]) => n)).toEqual([
      "Fonts/Font Sans",
      "Size/Text Sm",
      "Weight/Font Normal",
      "Leading/Leading Tight",
      "black/100",
    ]);
    for (const [name] of none) {
      const r = resolveTokenName({
        figmaVariableName: name,
        declaredCustomProperties: SDS_DECLARED,
      });
      expect(r.source).toBe("heuristic");
      expect(isAuthoritative(r.source)).toBe(false);
      expect(r.figmaCodeSyntax).toBeUndefined();
    }
  });
});

describe("an empty scan cannot promote real data to authoritative", () => {
  /**
   * The guard that matters most in production: if the CSS scan reaches no files,
   * every one of these 355 real `codeSyntax` values must still be non-authoritative.
   * A scan that read nothing is not evidence of a match, and this is the exact
   * shape of a misconfigured consumer.
   */
  it("keeps all 355 non-authoritative when nothing was scanned", () => {
    const promoted = ENTRIES.filter(([, v]) => v.codeSyntax !== undefined).filter(([name, v]) =>
      isAuthoritative(
        resolveTokenName({
          figmaVariableName: name,
          codeSyntax: v.codeSyntax,
          declaredCustomProperties: new Set(),
        }).source,
      ),
    );
    expect(promoted).toEqual([]);
  });
});
