import { describe, expect, it } from "vitest";
import {
  partitionRow,
  explainInfo,
  applyControlsEnabled,
  rowHasDrift,
  stagedEditsVisible,
  rowHasAnyValue,
  bindingScanEmpty,
  type GroupedRow,
} from "./row-triage.js";
import type { DimensionDiff } from "./dimensions/types.js";

function other(diff: Partial<DimensionDiff> & Pick<DimensionDiff, "kind">): GroupedRow {
  return {
    kind: "other",
    diff: { property: "p", codeValue: null, figmaValue: null, status: "drift", ...diff },
  };
}

describe("partitionRow — the Phase-2 honesty invariant", () => {
  it("props drift NEVER partitions to main (no Apply button possible)", () => {
    expect(
      partitionRow(other({ kind: "props", property: "Size", figmaValue: "Large" })),
    ).toBe("info");
  });

  it("variant-set drift NEVER partitions to main", () => {
    expect(
      partitionRow(
        other({ kind: "variant-set", property: "active-variant", codeValue: ["primary"], figmaValue: { State: "Hover" } }),
      ),
    ).toBe("info");
    expect(
      partitionRow(
        other({ kind: "variant-set", property: "variant-options", codeValue: ["ghost"], figmaValue: ["primary", "accent"] }),
      ),
    ).toBe("info");
  });

  it("structure/motion drift partitions to info", () => {
    expect(partitionRow(other({ kind: "structure", property: "layout" }))).toBe("info");
    expect(partitionRow(other({ kind: "motion", property: "transition" }))).toBe("info");
  });

  it("copy drift with both concrete strings partitions to main (real engine)", () => {
    expect(
      partitionRow(other({ kind: "copy", property: "text", codeValue: "A", figmaValue: "B" })),
    ).toBe("main");
  });

  it("copy drift with a dynamic (null) side partitions to info", () => {
    expect(
      partitionRow(other({ kind: "copy", property: "text", codeValue: null, figmaValue: "B" })),
    ).toBe("info");
  });

  it("matches stay in main regardless of kind", () => {
    expect(partitionRow(other({ kind: "props", property: "Size", status: "match" }))).toBe("main");
  });
});

describe("applyControlsEnabled — v1 audit-only write gating", () => {
  it('only an explicit "experimental" enables write controls', () => {
    expect(applyControlsEnabled("experimental")).toBe(true);
  });

  it('"off", undefined (config not loaded), and junk all stay read-only', () => {
    expect(applyControlsEnabled("off")).toBe(false);
    expect(applyControlsEnabled(undefined)).toBe(false);
    expect(applyControlsEnabled("on")).toBe(false);
    expect(applyControlsEnabled("")).toBe(false);
  });

  it("the honesty invariant survives experimental mode: props/variant-set still partition to info", () => {
    // Even with writes enabled, rows without an engine must never show an
    // Apply button — gating widens what CAN render, never what's honest.
    expect(applyControlsEnabled("experimental")).toBe(true);
    expect(partitionRow(other({ kind: "props", property: "Size", figmaValue: "Large" }))).toBe("info");
    expect(
      partitionRow(other({ kind: "variant-set", property: "active-variant", codeValue: ["a"], figmaValue: { S: "H" } })),
    ).toBe("info");
  });
});

describe('stagedEditsVisible — the Staged edits section is part of the write surface', () => {
  it('renders only under an explicit apply: "experimental"', () => {
    expect(stagedEditsVisible("experimental")).toBe(true);
  });

  it('is hidden entirely in apply:"off", when config is unloaded, and on junk values', () => {
    expect(stagedEditsVisible("off")).toBe(false);
    expect(stagedEditsVisible(undefined)).toBe(false);
    expect(stagedEditsVisible("on")).toBe(false);
    expect(stagedEditsVisible("")).toBe(false);
  });
});

describe("rowHasAnyValue — rows with no code AND no Figma value are dropped", () => {
  const bindingDiff = (
    codeValue: unknown,
    figmaValue: unknown,
  ): DimensionDiff => ({
    kind: "token-binding",
    property: "individualStrokeWeights",
    codeValue,
    figmaValue,
    status: "flag-only",
  });

  it("drops a binding-only token row that is all em-dashes (the live individualStrokeWeights case)", () => {
    expect(
      rowHasAnyValue({
        kind: "token",
        property: "individualStrokeWeights",
        binding: bindingDiff(null, null),
      }),
    ).toBe(false);
  });

  it("keeps a token row when either side of either diff carries a value", () => {
    expect(
      rowHasAnyValue({ kind: "token", property: "p", binding: bindingDiff(null, "radius/xl") }),
    ).toBe(true);
    expect(
      rowHasAnyValue({ kind: "token", property: "p", binding: bindingDiff("--radius-xl", null) }),
    ).toBe(true);
    expect(
      rowHasAnyValue({
        kind: "token",
        property: "p",
        value: { kind: "token-value", property: "p", codeValue: "8px", figmaValue: null, status: "flag-only" },
        binding: bindingDiff(null, null),
      }),
    ).toBe(true);
  });

  it("dual-mode {light, dark} maps count as values", () => {
    expect(
      rowHasAnyValue({
        kind: "token",
        property: "p",
        value: {
          kind: "token-value",
          property: "p",
          codeValue: null,
          figmaValue: { light: "#fff", dark: "#000" },
          status: "drift",
        },
      }),
    ).toBe(true);
  });

  it("token rows with no diffs at all are dropped", () => {
    expect(rowHasAnyValue({ kind: "token", property: "p" })).toBe(false);
  });

  it("other-kind rows are dropped only when both sides are empty", () => {
    expect(rowHasAnyValue(other({ kind: "copy", codeValue: null, figmaValue: null }))).toBe(false);
    expect(rowHasAnyValue(other({ kind: "copy", codeValue: null, figmaValue: "B" }))).toBe(true);
    expect(rowHasAnyValue(other({ kind: "props", codeValue: "sm", figmaValue: null }))).toBe(true);
  });
});

// The panel no longer renders a Wiring column (v0.0.29) — this helper is
// retained for the future static/contract checker. Tests keep it honest.
describe("bindingScanEmpty — zero-scanned-bindings detection (retained, unused by the panel)", () => {
  const tokenRow = (codeBinding: string | null, figmaBinding: string | null = "space/md"): GroupedRow => ({
    kind: "token",
    property: "gap",
    binding: {
      kind: "token-binding",
      property: "gap",
      codeValue: codeBinding,
      figmaValue: figmaBinding,
      status: codeBinding === null ? "flag-only" : "match",
    },
  });

  it("true when every binding diff lacks a code-side declaration (Tailwind/inline-styled case)", () => {
    expect(bindingScanEmpty([tokenRow(null), tokenRow(null), tokenRow(null)])).toBe(true);
  });

  it("false when the scanner found at least one binding", () => {
    expect(bindingScanEmpty([tokenRow(null), tokenRow("--space-md")])).toBe(false);
  });

  it("false when there are no binding diffs at all (nothing to collapse)", () => {
    expect(bindingScanEmpty([])).toBe(false);
    expect(
      bindingScanEmpty([
        { kind: "token", property: "gap" },
        other({ kind: "copy", codeValue: "A", figmaValue: "B" }),
      ]),
    ).toBe(false);
  });
});

describe("rowHasDrift — drives the Copy fix prompt button (both modes)", () => {
  it("other rows report drift from their diff status", () => {
    expect(rowHasDrift(other({ kind: "copy", property: "text" }))).toBe(true);
    expect(rowHasDrift(other({ kind: "copy", property: "text", status: "match" }))).toBe(false);
  });

  it("token rows offer a fix only when the VALUE drifted", () => {
    const diff = (status: DimensionDiff["status"]): DimensionDiff => ({
      kind: "token-value",
      property: "gap",
      codeValue: "8px",
      figmaValue: "4px",
      status,
    });
    expect(rowHasDrift({ kind: "token", property: "gap", value: diff("drift") })).toBe(true);
    expect(rowHasDrift({ kind: "token", property: "gap", value: diff("match") })).toBe(false);
    expect(rowHasDrift({ kind: "token", property: "gap" })).toBe(false);
  });

  it("a binding-name difference whose value matches offers NO fix", () => {
    // Both sides are bound to a token and the render is correct — the systems
    // just spell the token differently (`primary` vs
    // `color/background/brand/default`). Token-name matching is heuristic, so
    // a name mismatch is not evidence of a defect and must not grow a button.
    const value: DimensionDiff = {
      kind: "token-value",
      property: "background-color",
      codeValue: "rgb(44, 44, 44)",
      figmaValue: "rgb(44, 44, 44)",
      status: "match",
    };
    const binding: DimensionDiff = {
      kind: "token-binding",
      property: "background-color",
      codeValue: "primary",
      figmaValue: "color/background/brand/default",
      status: "drift",
    };
    expect(rowHasDrift({ kind: "token", property: "background-color", value, binding })).toBe(
      false,
    );
  });

  it("binding drift alone — with no value comparison — offers no fix either", () => {
    const binding: DimensionDiff = {
      kind: "token-binding",
      property: "gap",
      codeValue: "space-2",
      figmaValue: "Space/200",
      status: "drift",
    };
    expect(rowHasDrift({ kind: "token", property: "gap", binding })).toBe(false);
  });
});

describe("explainInfo — advisories are specific, actionable, never generic (P2.2/P2.3)", () => {
  it("variant-set active-variant names the missing variant and both fixes", () => {
    const msg = explainInfo(
      other({
        kind: "variant-set",
        property: "active-variant",
        codeValue: ["primary"],
        figmaValue: { State: "Hover" },
        note: "Figma variants not present in code: [State=Hover]",
      }),
    );
    expect(msg).toContain("State=Hover");
    expect(msg).toMatch(/BEM modifier/);
    expect(msg).toMatch(/No auto-apply/);
    expect(msg).not.toMatch(/no auto-apply engine yet/i);
  });

  it("variant-set variant-options names the unknown code variants and both fixes", () => {
    const msg = explainInfo(
      other({
        kind: "variant-set",
        property: "variant-options",
        codeValue: ["ghost"],
        figmaValue: ["primary", "accent"],
      }),
    );
    expect(msg).toContain("ghost");
    expect(msg).toContain("primary");
    expect(msg).toMatch(/adding the option|renaming\/removing/);
  });

  it("props drift names the Figma prop/value and states why auto-write is deferred", () => {
    const msg = explainInfo(other({ kind: "props", property: "Size", figmaValue: "Large" }));
    expect(msg).toContain("Size=Large");
    expect(msg).toMatch(/args/);
    expect(msg).toMatch(/deferred/i);
    expect(msg).toMatch(/no unambiguous write target/i);
  });
});
