import { describe, expect, it } from "vitest";
import {
  partitionRow,
  explainInfo,
  applyControlsEnabled,
  rowHasDrift,
  stagedEditsVisible,
  rowHasAnyValue,
  bindingScanEmpty,
  isUtilityShapedClass,
  modifierClassCandidates,
  variantSetRowApplicable,
  summarizeListCell,
  groupRowsByElement,
  rowChildSelector,
  unresolvedChildBindings,
  type GroupedRow,
} from "./row-triage.js";
import type { ChildBindingReport, DimensionDiff } from "./dimensions/types.js";

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

/**
 * The class lists these tests reason about are real: the shadcn/cva Button as
 * rendered by the consumer that exposed the bug (25 utility classes, variants
 * chosen by props), and the BEM/adjacent-modifier components the variant-set
 * check was designed for.
 */
const CVA_BUTTON_CLASSES = [
  "inline-flex",
  "items-center",
  "justify-center",
  "gap-2",
  "whitespace-nowrap",
  "rounded-md",
  "text-sm",
  "font-medium",
  "transition-all",
  "disabled:pointer-events-none",
  "disabled:opacity-50",
  "[&_svg]:pointer-events-none",
  "[&_svg:not([class*='size-'])]:size-4",
  "shrink-0",
  "outline-none",
  "focus-visible:border-ring",
  "focus-visible:ring-ring/50",
  "focus-visible:ring-[3px]",
  "aria-invalid:ring-destructive/20",
  "bg-primary",
  "text-primary-foreground",
  "shadow-xs",
  "hover:bg-primary/90",
  "h-9",
  "px-4",
];

describe("isUtilityShapedClass — utility framework class vs component modifier", () => {
  it("reads every class of a real cva Button as a utility", () => {
    const notUtilities = CVA_BUTTON_CLASSES.filter((c) => !isUtilityShapedClass(c));
    expect(notUtilities).toEqual([]);
  });

  it("does not mistake hand-authored modifier classes for utilities", () => {
    for (const c of [
      "active",
      "is-open",
      "selected",
      "state-hover",
      "variant-primary",
      "icon-button--accent",
      "file-item",
      "hidden",
      "disabled",
    ]) {
      expect(isUtilityShapedClass(c), c).toBe(false);
    }
  });
});

describe("modifierClassCandidates — the evidence the variant-set check needs", () => {
  it("finds nothing to reason about on a utility class list", () => {
    expect(modifierClassCandidates(CVA_BUTTON_CLASSES)).toEqual([]);
  });

  it("reads BEM `--` suffixes, wherever they sit in the list", () => {
    expect(modifierClassCandidates(["icon-button", "icon-button--accent"])).toEqual(["accent"]);
    // A BEM modifier still counts when the element also carries utilities.
    expect(modifierClassCandidates(["btn", "px-4", "btn--primary"])).toEqual(["primary"]);
  });

  it("reads adjacent modifier classes (`.file-item.active`)", () => {
    expect(modifierClassCandidates(["file-item", "active"])).toEqual(["active"]);
  });

  it("never treats the base class alone as a modifier", () => {
    expect(modifierClassCandidates(["file-item"])).toEqual([]);
  });
});

describe("variantSetRowApplicable — a confident signal that doesn't apply is worse than none", () => {
  it("suppresses the row on a Tailwind/cva component (no modifier convention at all)", () => {
    expect(
      variantSetRowApplicable({
        rootClasses: CVA_BUTTON_CLASSES,
        evaluatedAxes: ["Variant", "Size"],
        propsStatuses: { Variant: "drift", Size: "drift" },
      }),
    ).toBe(false);
  });

  it("keeps the row for a BEM component with a genuinely missing modifier", () => {
    expect(
      variantSetRowApplicable({
        rootClasses: ["icon-button", "icon-button--accent"],
        evaluatedAxes: ["State"],
        propsStatuses: { State: "drift" },
      }),
    ).toBe(true);
  });

  it("keeps the row for a BEM component whose modifiers all match", () => {
    expect(
      variantSetRowApplicable({
        rootClasses: ["icon-button", "icon-button--accent"],
        evaluatedAxes: ["Variant"],
        propsStatuses: { Variant: "drift" },
      }),
    ).toBe(true);
  });

  it("suppresses the row when matching props rows already cover every axis", () => {
    expect(
      variantSetRowApplicable({
        rootClasses: ["icon-button", "icon-button--accent"],
        evaluatedAxes: ["Variant", "Size"],
        propsStatuses: { Variant: "match", Size: "match" },
      }),
    ).toBe(false);
  });

  it("does not count a partially-confirmed or unconfirmable axis as covered", () => {
    const bem = ["icon-button", "icon-button--accent"];
    expect(
      variantSetRowApplicable({
        rootClasses: bem,
        evaluatedAxes: ["Variant", "Size"],
        propsStatuses: { Variant: "match", Size: "drift" },
      }),
    ).toBe(true);
    expect(
      variantSetRowApplicable({
        rootClasses: bem,
        evaluatedAxes: ["Variant"],
        propsStatuses: { Variant: "flag-only" },
      }),
    ).toBe(true);
    // No props row at all for the axis.
    expect(
      variantSetRowApplicable({ rootClasses: bem, evaluatedAxes: ["Variant"] }),
    ).toBe(true);
  });

  it("keeps the row when the snapshot carries no class list (evidence unknown)", () => {
    // Older preview bundle / replayed snapshot: absence of `rootClasses` is not
    // evidence of absence, so behaviour stays as it was.
    expect(variantSetRowApplicable({ evaluatedAxes: ["Variant"] })).toBe(true);
    expect(variantSetRowApplicable({})).toBe(true);
  });

  it("ignores the props rule when no axis was evaluated (all-falsy variants)", () => {
    expect(
      variantSetRowApplicable({
        rootClasses: ["icon-button", "icon-button--accent"],
        evaluatedAxes: [],
        propsStatuses: { Selected: "match" },
      }),
    ).toBe(true);
  });
});

describe("summarizeListCell — long list cells collapse, short ones don't", () => {
  it("collapses a long list to a count plus its items", () => {
    const summary = summarizeListCell(CVA_BUTTON_CLASSES);
    expect(summary).not.toBeNull();
    expect(summary?.count).toBe(25);
    expect(summary?.items).toHaveLength(25);
  });

  it("leaves a short list (and any non-list) to render inline", () => {
    expect(summarizeListCell(["accent"])).toBeNull();
    expect(summarizeListCell(["a", "b", "c"])).toBeNull();
    expect(summarizeListCell({ State: "Hover" })).toBeNull();
    expect(summarizeListCell(null)).toBeNull();
  });
});

describe("explainInfo — a variant-set row that does appear stays readable", () => {
  it("keeps the BEM advisory byte-identical (short candidate list)", () => {
    const msg = explainInfo(
      other({
        kind: "variant-set",
        property: "active-variant",
        codeValue: ["accent"],
        figmaValue: { State: "Hover" },
        note: "Figma variants not present in code: [State=Hover]",
      }),
    );
    expect(msg).toBe(
      "Figma variant(s) [State=Hover] have no matching modifier class in code (code has [accent]). " +
        "Fix code-side by adding the BEM modifier rule and story, or Figma-side by removing/renaming the variant. " +
        "No auto-apply: creating an empty CSS rule or deleting a Figma variant would be a guess — see roadmap P3.1 (per-variant-explicit codemod).",
    );
  });

  it("counts instead of dumping when the candidate list is long, keeping the advisory", () => {
    const msg = explainInfo(
      other({
        kind: "variant-set",
        property: "active-variant",
        codeValue: CVA_BUTTON_CLASSES,
        figmaValue: { State: "Hover" },
        note: "Figma variants not present in code: [State=Hover]",
      }),
    );
    expect(msg).toContain("code has 25 candidate modifier classes");
    expect(msg).not.toContain("inline-flex");
    expect(msg).toMatch(/BEM modifier/);
    expect(msg).toMatch(/No auto-apply/);
  });
});

/* ------------------------------------------------------------------------- *
 * per-element grouping (declared child bindings)
 * ------------------------------------------------------------------------- */

function tokenRow(property: string, childSelector?: string): GroupedRow {
  const base: DimensionDiff = {
    kind: "token-value",
    property,
    codeValue: "8px",
    figmaValue: "16px",
    status: "drift",
  };
  return {
    kind: "token",
    property,
    value: childSelector === undefined ? base : { ...base, childSelector },
  };
}

const compared = (selector: string, nodeId: string, nodeName?: string): ChildBindingReport => ({
  selector,
  nodeId,
  status: "compared",
  ...(nodeName ? { nodeName } : {}),
});

describe("rowChildSelector — which element a row describes", () => {
  it("returns undefined for a root row", () => {
    expect(rowChildSelector(tokenRow("padding-top"))).toBeUndefined();
    expect(rowChildSelector(other({ kind: "copy" }))).toBeUndefined();
  });

  it("returns the selector for a child row, from either half of a token row", () => {
    expect(rowChildSelector(tokenRow("padding-top", "[data-slot=header]"))).toBe(
      "[data-slot=header]",
    );
    const bindingOnly: GroupedRow = {
      kind: "token",
      property: "padding-top",
      binding: {
        kind: "token-binding",
        property: "padding-top",
        codeValue: "space-400",
        figmaValue: "space/400",
        status: "match",
        childSelector: "[data-slot=body]",
      },
    };
    expect(rowChildSelector(bindingOnly)).toBe("[data-slot=body]");
  });
});

describe("groupRowsByElement — root first, then declared children in order", () => {
  it("returns a single unlabelled root group for a story with no child bindings", () => {
    const rows = [tokenRow("padding-top"), tokenRow("gap")];
    const groups = groupRowsByElement(rows, undefined);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.selector).toBeUndefined();
    expect(groups[0]!.label).toBe("Story root");
    // Order within the root group is preserved exactly.
    expect(groups[0]!.rows).toEqual(rows);
  });

  it("puts the root group first even when child rows came first in the list", () => {
    const groups = groupRowsByElement(
      [tokenRow("padding-top", "[data-slot=header]"), tokenRow("gap")],
      [compared("[data-slot=header]", "2142:11381")],
    );

    expect(groups.map((g) => g.selector)).toEqual([undefined, "[data-slot=header]"]);
  });

  it("follows registry order for the child groups, not row order", () => {
    const groups = groupRowsByElement(
      [tokenRow("gap", "[data-slot=body]"), tokenRow("gap", "[data-slot=header]")],
      [compared("[data-slot=header]", "2142:11381"), compared("[data-slot=body]", "2142:11382")],
    );

    expect(groups.map((g) => g.selector)).toEqual([
      undefined,
      "[data-slot=header]",
      "[data-slot=body]",
    ]);
  });

  it("never mixes a child's rows into the root group", () => {
    const groups = groupRowsByElement(
      [tokenRow("padding-top"), tokenRow("padding-top", "[data-slot=header]")],
      [compared("[data-slot=header]", "2142:11381")],
    );

    expect(groups[0]!.rows).toHaveLength(1);
    expect(rowChildSelector(groups[0]!.rows[0]!)).toBeUndefined();
    expect(groups[1]!.rows).toHaveLength(1);
    expect(rowChildSelector(groups[1]!.rows[0]!)).toBe("[data-slot=header]");
  });

  it("labels a child group with the Figma node name when it is known", () => {
    const groups = groupRowsByElement(
      [tokenRow("gap", "[data-slot=header]")],
      [compared("[data-slot=header]", "2142:11381", "Card header")],
    );

    expect(groups[1]!.label).toBe("[data-slot=header] → Card header");
    expect(groups[1]!.nodeName).toBe("Card header");
    expect(groups[1]!.nodeId).toBe("2142:11381");
  });

  it("falls back to the bare selector when Figma gave no node name", () => {
    const groups = groupRowsByElement(
      [tokenRow("gap", "[data-slot=header]")],
      [compared("[data-slot=header]", "2142:11381")],
    );

    expect(groups[1]!.label).toBe("[data-slot=header]");
    expect(groups[1]!.nodeName).toBeUndefined();
  });

  it("keeps an empty group for a declared child that produced no rows", () => {
    // The panel filters empty groups out of the table; the *group* still exists
    // so the caller can tell "declared but silent" from "not declared".
    const groups = groupRowsByElement([tokenRow("gap")], [
      { selector: "[data-slot=header]", nodeId: "2142:11381", status: "selector-not-found", message: "…" },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[1]!.rows).toEqual([]);
  });

  it("still shows rows whose selector has no report entry rather than dropping them", () => {
    const groups = groupRowsByElement([tokenRow("gap", "[data-slot=orphan]")], []);

    expect(groups.map((g) => g.selector)).toEqual([undefined, "[data-slot=orphan]"]);
    expect(groups[1]!.rows).toHaveLength(1);
  });
});

describe("unresolvedChildBindings", () => {
  it("is empty for a legacy story and for an all-compared story", () => {
    expect(unresolvedChildBindings(undefined)).toEqual([]);
    expect(unresolvedChildBindings([compared("[data-slot=header]", "2142:11381")])).toEqual([]);
  });

  it("returns every binding that produced no comparison", () => {
    const children: ChildBindingReport[] = [
      compared("[data-slot=header]", "2142:11381"),
      { selector: "[data-slot=body]", nodeId: "2142:11382", status: "selector-ambiguous", message: "…" },
      { selector: "[data-slot=foot]", nodeId: "2142:11383", status: "node-unreachable", message: "…" },
    ];

    expect(unresolvedChildBindings(children).map((c) => c.selector)).toEqual([
      "[data-slot=body]",
      "[data-slot=foot]",
    ]);
  });
});
