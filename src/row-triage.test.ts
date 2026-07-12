import { describe, expect, it } from "vitest";
import { partitionRow, explainInfo, type GroupedRow } from "./row-triage.js";
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
