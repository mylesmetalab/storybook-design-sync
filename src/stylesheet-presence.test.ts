import { describe, expect, it } from "vitest";

import {
  MIN_PROBES_FOR_MISSING,
  PROBE_SAMPLE_SIZE,
  classifyStylesheetPresence,
  probeNamesFromScan,
  type CustomPropertyProbe,
} from "./stylesheet-presence.js";

/**
 * The value of this predicate is entirely in when it stays quiet. A false
 * "missing" suppresses a whole story's comparison, which is worse than the noisy
 * report it exists to prevent — so the silent cases get the coverage.
 */

function probes(...pairs: Array<[string, string]>): CustomPropertyProbe[] {
  return pairs.map(([name, value]) => ({ name, value }));
}

function absent(count: number): CustomPropertyProbe[] {
  return Array.from({ length: count }, (_, i) => ({ name: `--t${i}`, value: "" }));
}

describe("classifyStylesheetPresence", () => {
  it("says loaded when any declared property resolves", () => {
    const result = classifyStylesheetPresence(
      probes(["--color-primary", "#2c2c2c"], ["--radius-md", ""], ["--x", ""]),
    );
    expect(result.kind).toBe("loaded");
  });

  it("says missing when every declared property resolves to nothing", () => {
    // The real shape of #96: the theme file was never imported, so none of the
    // project's own custom properties exist on the document.
    const result = classifyStylesheetPresence(absent(8));
    expect(result.kind).toBe("missing");
    if (result.kind !== "missing") throw new Error("unreachable");
    expect(result.probed).toBe(8);
    expect(result.detail).toMatch(/not loaded in the Storybook preview/);
    // It has to say why the numbers would be wrong, or the reader distrusts the
    // refusal instead of the report.
    expect(result.detail).toMatch(/browser default/);
    expect(result.detail).toMatch(/drift that does not exist/);
  });

  /* ---- the cases that must NOT fire ---- */

  it("is unknown, never missing, when the project declares no custom properties", () => {
    // Vacuously "none resolved". Claiming a missing stylesheet from zero evidence
    // is the #10-shaped bug one layer up.
    const result = classifyStylesheetPresence([]);
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") throw new Error("unreachable");
    expect(result.why).toMatch(/no custom properties/);
  });

  it("is unknown below the probe threshold, because theme-scoping is the likelier cause", () => {
    // One or two properties that don't resolve at :root are far more likely to be
    // theme-scoped than evidence of a missing stylesheet.
    for (let n = 1; n < MIN_PROBES_FOR_MISSING; n++) {
      const result = classifyStylesheetPresence(absent(n));
      expect(result.kind, `${n} probe(s)`).toBe("unknown");
    }
  });

  it("fires at exactly the threshold, so the boundary is pinned", () => {
    expect(classifyStylesheetPresence(absent(MIN_PROBES_FOR_MISSING)).kind).toBe("missing");
  });

  it("treats a whitespace-only value as unresolved", () => {
    // getComputedStyle returns " " for some declared-but-empty properties.
    expect(classifyStylesheetPresence(probes(["--a", "  "], ["--b", ""], ["--c", "\t"])).kind).toBe(
      "missing",
    );
  });

  it("a single resolving property outweighs many absent ones", () => {
    // Partial resolution means the sheet IS there; the absent ones are then a
    // different question (theme scoping), not this one.
    const result = classifyStylesheetPresence([...absent(20), { name: "--x", value: "1px" }]);
    expect(result.kind).toBe("loaded");
  });

  /* ---- the remediation, which is the actionable half ---- */

  it("names the exact import when there is exactly one CSS entry", () => {
    const result = classifyStylesheetPresence(absent(5), { cssEntries: ["src/index.css"] });
    if (result.kind !== "missing") throw new Error("unreachable");
    expect(result.detail).toContain('import "../src/index.css"');
  });

  it("does not name a file when the entry is a glob", () => {
    // Naming a path that may not exist is worse than naming none.
    const result = classifyStylesheetPresence(absent(5), { cssEntries: ["src/**/*.css"] });
    if (result.kind !== "missing") throw new Error("unreachable");
    expect(result.detail).not.toContain("src/**/*.css");
    expect(result.detail).toMatch(/Import your CSS entry/);
  });

  it("gives generic advice when several entries are configured", () => {
    const result = classifyStylesheetPresence(absent(5), {
      cssEntries: ["src/index.css", "src/theme.css"],
    });
    if (result.kind !== "missing") throw new Error("unreachable");
    expect(result.detail).toMatch(/Import your CSS entry/);
  });

  /* ---- the bug that would have suppressed every project's comparison ---- */

  describe("unprefixed probe names", () => {
    it("concludes nothing from names missing the -- prefix", () => {
      // `scan-css.ts` stores custom property names with the prefix STRIPPED, and
      // the first wiring of this check passed them straight through. Every probe
      // then returned "" — so a healthy project was told its stylesheet was
      // missing and its whole comparison was suppressed. Found end to end; the
      // unit fixtures here were already prefixed, so they could not catch it.
      const result = classifyStylesheetPresence([
        { name: "color-primary", value: "" },
        { name: "radius-md", value: "" },
        { name: "font-sans", value: "" },
        { name: "text-base", value: "" },
      ]);
      expect(result.kind).toBe("unknown");
      if (result.kind !== "unknown") throw new Error("unreachable");
      expect(result.why).toMatch(/missing the "--" prefix/);
      expect(result.why).toMatch(/caller bug/);
    });

    it("names one of the offenders, so the caller can find it", () => {
      const result = classifyStylesheetPresence(absent(3).map((p) => ({ ...p, name: "oops" })));
      if (result.kind !== "unknown") throw new Error("unreachable");
      expect(result.why).toContain("oops");
    });

    it("does not let one unprefixed name poison an otherwise valid probe set", () => {
      // Mixed input is still a caller bug; concluding "missing" from it would be
      // the same catastrophic direction.
      const result = classifyStylesheetPresence([...absent(4), { name: "nope", value: "" }]);
      expect(result.kind).toBe("unknown");
    });
  });
});

/**
 * The caller-side normalisation. This has its own tests because removing it
 * killed **zero** tests when probed — and it is the step whose absence made the
 * check condemn every healthy project.
 */
describe("probeNamesFromScan", () => {
  it("adds the -- prefix the CSS scan strips", () => {
    // `scan-css.ts` stores `decl.prop.slice(2)`, so the index holds
    // "color-primary", and `getPropertyValue("color-primary")` is always "".
    expect(probeNamesFromScan({ "color-primary": [], "radius-md": [] })).toEqual([
      "--color-primary",
      "--radius-md",
    ]);
  });

  it("leaves an already-prefixed name alone rather than doubling it", () => {
    expect(probeNamesFromScan({ "--already": [] })).toEqual(["--already"]);
  });

  it("sorts, so the probe sample is deterministic across runs", () => {
    // A sample that varied per run would make a refusal unreproducible.
    expect(probeNamesFromScan({ zeta: [], alpha: [], mid: [] })).toEqual([
      "--alpha",
      "--mid",
      "--zeta",
    ]);
  });

  it("samples rather than sending hundreds of names", () => {
    const many = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`t${String(i).padStart(3, "0")}`, []]),
    );
    expect(probeNamesFromScan(many)).toHaveLength(PROBE_SAMPLE_SIZE);
  });

  it("samples the SAME names every time, not a moving window", () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`t${i}`, []]));
    expect(probeNamesFromScan(many)).toEqual(probeNamesFromScan(many));
  });

  it("returns nothing for an empty index, so the predicate reports unknown", () => {
    expect(probeNamesFromScan({})).toEqual([]);
  });

  it("produces names the predicate will actually accept", () => {
    // The two halves have to agree: names from here must never trip the
    // unprefixed-name guard in classifyStylesheetPresence.
    const names = probeNamesFromScan({ "color-primary": [], "radius-md": [], "font-sans": [] });
    const verdict = classifyStylesheetPresence(names.map((name) => ({ name, value: "" })));
    expect(verdict.kind).toBe("missing");
  });
});
