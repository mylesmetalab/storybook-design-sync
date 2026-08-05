import { describe, expect, it } from "vitest";
import {
  applyEngineCanAct,
  classifyRow,
  rowRank,
  sortRowsByFinding,
  rowHasAdvisory,
  explainInfo,
  applyControlsEnabled,
  rowHasDrift,
  tokenRowFixability,
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
  bindingAdvisory,
  countStatuses,
  countRowStatuses,
  groupDimensions,
  fixLayer,
  codeTokenName,
  EMPTY_STATUS_COUNTS,
  type GroupedRow,
} from "./row-triage.js";
import type { ChildBindingReport, DimensionDiff } from "./dimensions/types.js";

function other(diff: Partial<DimensionDiff> & Pick<DimensionDiff, "kind">): GroupedRow {
  return {
    kind: "other",
    diff: { property: "p", codeValue: null, figmaValue: null, status: "drift", ...diff },
  };
}

/**
 * `applyEngineCanAct` is the old `partitionRow`, renamed to what it actually
 * decides. Its verdicts are unchanged — the Phase-2 honesty invariant ("no Apply
 * button on a row the engine can't honor") is the same assertion — but it no
 * longer has any say in where a row appears. See `classifyRow` below for that.
 */
describe("applyEngineCanAct — the Phase-2 honesty invariant (Apply buttons only)", () => {
  it("props drift NEVER gets an Apply button", () => {
    expect(applyEngineCanAct(other({ kind: "props", property: "Size", figmaValue: "Large" }))).toBe(
      false,
    );
  });

  it("variant-set drift NEVER gets an Apply button", () => {
    expect(
      applyEngineCanAct(
        other({ kind: "variant-set", property: "active-variant", codeValue: ["primary"], figmaValue: { State: "Hover" } }),
      ),
    ).toBe(false);
    expect(
      applyEngineCanAct(
        other({ kind: "variant-set", property: "variant-options", codeValue: ["ghost"], figmaValue: ["primary", "accent"] }),
      ),
    ).toBe(false);
  });

  it("structure/motion drift has no engine", () => {
    expect(applyEngineCanAct(other({ kind: "structure", property: "layout" }))).toBe(false);
    expect(applyEngineCanAct(other({ kind: "motion", property: "transition" }))).toBe(false);
  });

  it("copy drift with both concrete strings does have an engine", () => {
    expect(
      applyEngineCanAct(other({ kind: "copy", property: "text", codeValue: "A", figmaValue: "B" })),
    ).toBe(true);
  });

  it("copy drift with a dynamic (null) side has no engine", () => {
    expect(
      applyEngineCanAct(other({ kind: "copy", property: "text", codeValue: null, figmaValue: "B" })),
    ).toBe(false);
  });

  it("matches answer true regardless of kind — there is nothing to refuse", () => {
    expect(applyEngineCanAct(other({ kind: "props", property: "Size", status: "match" }))).toBe(
      true,
    );
  });
});

/* ------------------------------------------------------------------------- *
 * classification + ordering (replaces the deleted fixability partition)
 * ------------------------------------------------------------------------- */

/**
 * Overrides may set a field to `undefined` explicitly — that is exactly how the
 * engine hands us a row with no `tokenName` — so the helper takes a laxer type
 * than `Partial<DimensionDiff>` under `exactOptionalPropertyTypes`.
 */
type DiffOverride = { [K in keyof DimensionDiff]?: DimensionDiff[K] | undefined };

const valueDiff = (over: DiffOverride = {}): DimensionDiff =>
  ({
    kind: "token-value",
    property: "padding-top",
    codeValue: "6px",
    figmaValue: "12px (token: Space/150)",
    status: "drift",
    tokenName: "Space/150",
    ...over,
  }) as DimensionDiff;

const tokenRowOf = (diff: DimensionDiff): GroupedRow => ({
  kind: "token",
  property: diff.property,
  value: diff,
});

describe("classifyRow — what the finding IS, not whether a write engine likes it", () => {
  it("value drift backed by a named token is mechanical", () => {
    expect(classifyRow(tokenRowOf(valueDiff()))).toBe("value-drift");
  });

  it("drift where Figma's value has no variable behind it is its own first-class state", () => {
    // The live case: a designer detached the property from its variable and typed
    // a literal. Used to be demoted to the collapsed section for lack of a token
    // name — the single most significant finding, buried under matches.
    const row = tokenRowOf(
      valueDiff({ property: "border-top-left-radius", figmaValue: "12px", tokenName: undefined }),
    );
    expect(classifyRow(row)).toBe("unbound-figma-value");
    expect(rowRank(row)).toBe(0);
  });

  it("drift where Figma has NO value is a judgement call, not a detached token", () => {
    // Code declares a border Figma doesn't have. Routing this to "re-bind it in
    // Figma" would be wrong — there is nothing there to re-bind.
    const row = tokenRowOf(
      valueDiff({ property: "border-width", figmaValue: null, tokenName: undefined }),
    );
    expect(classifyRow(row)).toBe("judgement");
  });

  it("props / variant-set / structure / motion drift are judgement calls", () => {
    for (const kind of ["props", "variant-set", "structure", "motion"] as const) {
      expect(classifyRow(other({ kind, property: "x" })), kind).toBe("judgement");
    }
  });

  it("copy drift is mechanical with two concrete strings, a judgement call otherwise", () => {
    expect(classifyRow(other({ kind: "copy", codeValue: "A", figmaValue: "B" }))).toBe(
      "value-drift",
    );
    expect(classifyRow(other({ kind: "copy", codeValue: null, figmaValue: "B" }))).toBe("judgement");
  });

  it("matches, flag-only and unresolved are all no-drift", () => {
    for (const status of ["match", "flag-only", "unresolved"] as const) {
      expect(classifyRow(tokenRowOf(valueDiff({ status }))), status).toBe("no-drift");
      expect(classifyRow(other({ kind: "props", status })), status).toBe("no-drift");
    }
  });

  it("a binding-name difference whose value matches is not a finding", () => {
    expect(
      classifyRow({
        kind: "token",
        property: "background-color",
        value: valueDiff({ property: "background-color", status: "match" }),
        binding: {
          kind: "token-binding",
          property: "background-color",
          codeValue: "primary",
          figmaValue: "color/background/brand/default",
          status: "drift",
        },
      }),
    ).toBe("no-drift");
  });
});

describe("rowRank / sortRowsByFinding — drift at the top, matches below, nothing hidden", () => {
  const unbound = tokenRowOf(valueDiff({ property: "border-color", figmaValue: "#ddd", tokenName: undefined }));
  const drift = tokenRowOf(valueDiff({ property: "padding-top" }));
  const judgement = other({ kind: "props", property: "Size", figmaValue: "Large" });
  const unset = tokenRowOf(valueDiff({ property: "gap", status: "flag-only" }));
  const match = tokenRowOf(valueDiff({ property: "font-size", status: "match" }));

  it("ranks unbound Figma values above value drift, judgement calls, unset and matches", () => {
    expect([unbound, drift, judgement, unset, match].map(rowRank)).toEqual([0, 1, 2, 3, 4]);
  });

  it("sorts a shuffled report into that order", () => {
    const sorted = sortRowsByFinding([match, judgement, unset, drift, unbound]);
    expect(sorted).toEqual([unbound, drift, judgement, unset, match]);
  });

  it("drops nothing — every input row comes back exactly once", () => {
    const input = [match, judgement, unset, drift, unbound];
    const sorted = sortRowsByFinding(input);
    expect(sorted).toHaveLength(input.length);
    for (const row of input) expect(sorted.filter((r) => r === row)).toHaveLength(1);
  });

  it("is stable within a rank — the engine's row order survives", () => {
    const a = tokenRowOf(valueDiff({ property: "padding-top" }));
    const b = tokenRowOf(valueDiff({ property: "padding-right" }));
    const c = tokenRowOf(valueDiff({ property: "padding-bottom" }));
    expect(sortRowsByFinding([a, b, c])).toEqual([a, b, c]);
    expect(sortRowsByFinding([c, a, b])).toEqual([c, a, b]);
  });
});

describe("rowHasAdvisory — only rows whose next step isn't 'paste the prompt'", () => {
  it("is true for judgement calls and unbound Figma values", () => {
    expect(rowHasAdvisory(other({ kind: "props", property: "Size", figmaValue: "Large" }))).toBe(
      true,
    );
    expect(
      rowHasAdvisory(tokenRowOf(valueDiff({ figmaValue: "12px", tokenName: undefined }))),
    ).toBe(true);
  });

  it("is false for mechanical drift and for matches", () => {
    expect(rowHasAdvisory(tokenRowOf(valueDiff()))).toBe(false);
    expect(rowHasAdvisory(tokenRowOf(valueDiff({ status: "match" })))).toBe(false);
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

  it("the honesty invariant survives experimental mode: props/variant-set still get no Apply", () => {
    // Even with writes enabled, rows without an engine must never show an
    // Apply button — gating widens what CAN render, never what's honest.
    expect(applyControlsEnabled("experimental")).toBe(true);
    expect(applyEngineCanAct(other({ kind: "props", property: "Size", figmaValue: "Large" }))).toBe(
      false,
    );
    expect(
      applyEngineCanAct(other({ kind: "variant-set", property: "active-variant", codeValue: ["a"], figmaValue: { S: "H" } })),
    ).toBe(false);
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
 * Removing the fixability partition was a *presentation* change. These pin the
 * advisory text byte-for-byte against what the collapsed section used to show,
 * so a row moving into the main table can never quietly lose or soften the
 * sentence that told the user what to do.
 */
describe("explainInfo — advisory text is byte-identical to the pre-v0.0.37 wording", () => {
  it("props", () => {
    expect(explainInfo(other({ kind: "props", property: "Size", figmaValue: "Large" }))).toBe(
      "Figma variant sets Size=Large, but the story args carry no matching value. " +
        "Fix code-side by setting the matching value in the story's `args`, or re-register the story against the variant node that matches the current args. " +
        "Prop-default auto-writes are deferred: this diff has no unambiguous write target (arg? registry binding? Figma default?) — guessing would violate the honesty contract.",
    );
  });

  it("variant-set variant-options", () => {
    expect(
      explainInfo(
        other({
          kind: "variant-set",
          property: "variant-options",
          codeValue: ["ghost"],
          figmaValue: ["primary", "accent"],
        }),
      ),
    ).toBe(
      "Code declares variant class(es) [ghost] not in the Figma component set's options [primary, accent]. " +
        "Fix Figma-side by adding the option to the variant property, or code-side by renaming/removing the modifier class. " +
        "No auto-apply: which side is wrong isn't inferable from the diff.",
    );
  });

  it("copy with a dynamic code side", () => {
    expect(
      explainInfo(other({ kind: "copy", property: "text", codeValue: null, figmaValue: "Save" })),
    ).toBe(
      'Code renders no static text matching "Save". The component likely uses a dynamic child (e.g. `{label}`) — copy auto-apply can only rewrite literal JSX text.',
    );
  });

  it("copy with an empty Figma side", () => {
    expect(
      explainInfo(other({ kind: "copy", property: "text", codeValue: "Save", figmaValue: null })),
    ).toBe(
      "Figma's matching TEXT node is empty or missing — nothing to compare against, fix manually.",
    );
  });

  it("structure names both layout values and says the fix is a human one", () => {
    // v0.0.39: `structure` is a visible dimension with real values, so its
    // advisory must describe the disagreement — the old "reserved for a future
    // engine" line would be false on a row carrying two computed values.
    expect(
      explainInfo(
        other({
          kind: "structure",
          property: "flex-direction",
          codeValue: "row",
          figmaValue: "column",
        }),
      ),
    ).toBe(
      "Figma's auto-layout implies `flex-direction: column`, the rendered element computes `row`. " +
        "Decide which side is right: change the layout in code, or change the auto-layout in Figma. " +
        "No auto-apply — a layout property is a component decision, and the addon will not rewrite one from a diff.",
    );
  });

  it("motion is still reserved", () => {
    expect(explainInfo(other({ kind: "motion", property: "transition" }))).toBe(
      "`motion` dimension is reserved for a future engine — surfaced for awareness only.",
    );
  });

  it("token binding drift", () => {
    expect(
      explainInfo({
        kind: "token",
        property: "gap",
        binding: {
          kind: "token-binding",
          property: "gap",
          codeValue: null,
          figmaValue: "Space/200",
          status: "drift",
        },
      }),
    ).toBe(
      "Wiring drift, but the scanner couldn't find a clean var(--token) binding on the code side. Convert the inline value to `\"var(--token)\"` (or the equivalent CSS) so the engine has something to rewrite.",
    );
  });
});

describe("explainInfo — the unbound-Figma-value advisory says what actually happened", () => {
  it("names the detachment and routes the fix to Figma", () => {
    const msg = explainInfo(
      tokenRowOf(valueDiff({ property: "border-color", figmaValue: "#ddd", tokenName: undefined })),
    );
    expect(msg).toMatch(/NOT bound to a variable/);
    expect(msg).toMatch(/Fix it in Figma/);
    expect(msg).toMatch(/Do not hardcode/);
    expect(msg).toMatch(/do not retune a theme token/);
    // The old wording described the addon's inconvenience, not the violation.
    expect(msg).not.toMatch(/no token to promote the code literal to/);
  });

  it("says something different when Figma simply has no value for the property", () => {
    const msg = explainInfo(
      tokenRowOf(valueDiff({ property: "border-width", figmaValue: null, tokenName: undefined })),
    );
    expect(msg).toMatch(/Figma's node has no value for it/);
    expect(msg).not.toMatch(/NOT bound to a variable/);
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

/* ------------------------------------------------------------------------- *
 * issue #57 — a name-only binding divergence is an advisory, not drift
 * ------------------------------------------------------------------------- */

/**
 * The live report: one real difference on the component, `89 drift` in the panel,
 * and no fix offered on any of the 89. v0.0.33 had already made `rowHasDrift`
 * value-only, so the button was right and everything else — the row's status, the
 * bulk tally, the per-story column — still said drift. Half-fixed was worse than
 * either extreme.
 *
 * These assertions pin the whole verdict chain for the four shapes a binding row
 * can take, so status, count and rank can never drift apart again.
 */
describe("name-only binding divergence — status, counts and rank agree", () => {
  const valueOf = (status: DimensionDiff["status"]): DimensionDiff => ({
    kind: "token-value",
    property: "background-color",
    codeValue: "rgb(44, 44, 44)",
    figmaValue: "rgb(44, 44, 44)",
    status,
    tokenName: "color/background/brand/default",
  });

  const bindingOf = (
    status: DimensionDiff["status"],
    nameDivergence?: "value-matched" | "unverified",
  ): DimensionDiff => ({
    kind: "token-binding",
    property: "background-color",
    codeValue: "primary",
    figmaValue: "color/background/brand/default",
    status,
    ...(nameDivergence ? { nameDivergence } : {}),
    note: "Name-only divergence …",
  });

  const table: Array<{
    what: string;
    row: GroupedRow;
    drift: boolean;
    finding: string;
    rank: number;
    advisoryLabel: string | null;
  }> = [
    {
      what: "names differ, value matches → advisory, never drift",
      row: {
        kind: "token",
        property: "background-color",
        value: valueOf("match"),
        binding: bindingOf("advisory", "value-matched"),
      },
      drift: false,
      finding: "no-drift",
      rank: 3,
      advisoryLabel: "name differs",
    },
    {
      what: "names differ with NO value comparison → advisory, marked unverified",
      row: {
        kind: "token",
        property: "background-color",
        binding: bindingOf("advisory", "unverified"),
      },
      drift: false,
      finding: "no-drift",
      rank: 3,
      advisoryLabel: "name differs · unverified",
    },
    {
      what: "names differ AND value drifts → still drift, and no advisory pill",
      row: {
        kind: "token",
        property: "background-color",
        value: valueOf("drift"),
        binding: bindingOf("drift"),
      },
      drift: true,
      finding: "value-drift",
      rank: 1,
      advisoryLabel: null,
    },
    {
      what: "names agree → an ordinary match",
      row: {
        kind: "token",
        property: "background-color",
        value: valueOf("match"),
        binding: { ...bindingOf("match"), nameResolvedBy: "alias" },
      },
      drift: false,
      finding: "no-drift",
      rank: 4,
      advisoryLabel: null,
    },
  ];

  for (const c of table) {
    it(c.what, () => {
      expect(rowHasDrift(c.row), "rowHasDrift").toBe(c.drift);
      expect(classifyRow(c.row), "classifyRow").toBe(c.finding);
      expect(rowRank(c.row), "rowRank").toBe(c.rank);
      expect(bindingAdvisory(c.row)?.label ?? null, "advisory label").toBe(c.advisoryLabel);
    });
  }

  it("keeps the divergence visible: both names and the alias suggestion travel with the row", () => {
    const row: GroupedRow = {
      kind: "token",
      property: "background-color",
      value: valueOf("match"),
      binding: {
        ...bindingOf("advisory", "value-matched"),
        note: 'Name-only divergence: … Add "color/background/brand/default": "primary" to `tokenAliases` …',
      },
    };
    const advisory = bindingAdvisory(row)!;
    expect(advisory.codeName).toBe("primary");
    expect(advisory.figmaName).toBe("color/background/brand/default");
    expect(advisory.detail).toContain("tokenAliases");
    expect(advisory.kind).toBe("value-matched");
  });

  it("sorts advisories above matches and below everything that needs doing", () => {
    const drift = tokenRowOf(valueDiff({ property: "padding-top" }));
    const advisory: GroupedRow = {
      kind: "token",
      property: "background-color",
      value: valueOf("match"),
      binding: bindingOf("advisory", "value-matched"),
    };
    const unset = tokenRowOf(valueDiff({ property: "gap", status: "flag-only" }));
    const match = tokenRowOf(valueDiff({ property: "font-size", status: "match" }));
    // Advisory and "unset" share rank 3 (both are "no drift, but read me"), so
    // within that rank the engine's order is preserved exactly.
    expect(sortRowsByFinding([match, advisory, unset, drift])).toEqual([
      drift,
      advisory,
      unset,
      match,
    ]);
  });

  it("an `advisory` row never grows a write path either", () => {
    const row: GroupedRow = {
      kind: "token",
      property: "background-color",
      value: valueOf("match"),
      binding: bindingOf("advisory", "value-matched"),
    };
    // `applyEngineCanAct` answers true only because there is nothing to refuse —
    // the row is not drift. What matters is that no Apply target is derived.
    expect(tokenRowFixability(row.kind === "token" ? row.value : undefined, row.kind === "token" ? row.binding : undefined)).toEqual({
      bindingFixable: false,
      valueFixable: false,
    });
  });
});

describe("countStatuses — the tallies the panel prints", () => {
  const diff = (
    over: Partial<DimensionDiff> & Pick<DimensionDiff, "status">,
  ): DimensionDiff => ({
    kind: "token-value",
    property: "p",
    codeValue: null,
    figmaValue: null,
    ...over,
  });

  it("counts each status once, splitting advisory from unverified", () => {
    expect(
      countStatuses([
        diff({ status: "match" }),
        diff({ status: "match" }),
        diff({ status: "drift" }),
        diff({ kind: "token-binding", status: "advisory", nameDivergence: "value-matched" }),
        diff({ kind: "token-binding", status: "advisory", nameDivergence: "value-matched" }),
        diff({ kind: "token-binding", status: "advisory", nameDivergence: "unverified" }),
        diff({ status: "flag-only" }),
        diff({ status: "unresolved" }),
      ]),
    ).toEqual({ match: 2, drift: 1, advisory: 2, unverified: 1, flagOnly: 1, unresolved: 1 });
  });

  it("does not fold a name-only divergence into drift OR match — the 89-vs-1 report", () => {
    // Ten binding rows whose values all matched, plus the one genuine difference.
    const rows = [
      ...Array.from({ length: 10 }, () =>
        diff({ kind: "token-binding", status: "advisory", nameDivergence: "value-matched" }),
      ),
      diff({ kind: "copy", status: "drift" }),
    ];
    const counts = countStatuses(rows);
    expect(counts.drift).toBe(1);
    expect(counts.advisory).toBe(10);
    expect(counts.match).toBe(0);
  });

  it("treats an advisory with no `nameDivergence` field as unverified — the weaker claim", () => {
    expect(countStatuses([diff({ status: "advisory" })]).unverified).toBe(1);
  });

  it("is empty for an empty report", () => {
    expect(countStatuses([])).toEqual(EMPTY_STATUS_COUNTS);
  });
});

describe("groupDimensions — value and binding for one property become one row", () => {
  const d = (over: Partial<DimensionDiff> & Pick<DimensionDiff, "kind">): DimensionDiff => ({
    property: "padding-top",
    codeValue: null,
    figmaValue: null,
    status: "match",
    ...over,
  });

  it("pairs by property", () => {
    const rows = groupDimensions([d({ kind: "token-value" }), d({ kind: "token-binding" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("token");
  });

  it("never pairs the root's value with a child's binding", () => {
    const rows = groupDimensions([
      d({ kind: "token-value" }),
      d({ kind: "token-binding", childSelector: "[data-slot=header]" }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("leaves every other kind as its own row, in engine order", () => {
    const rows = groupDimensions([d({ kind: "copy", property: "text" }), d({ kind: "props", property: "Size" })]);
    expect(rows.map((r) => (r.kind === "other" ? r.diff.property : r.property))).toEqual([
      "text",
      "Size",
    ]);
  });
});

/* ------------------------------------------------------------------------- *
 * one story, one verdict (issue #80)
 * ------------------------------------------------------------------------- */

describe("countRowStatuses — the summary counts what the table shows", () => {
  const dim = (over: Partial<DimensionDiff> & Pick<DimensionDiff, "kind" | "status">): DimensionDiff => ({
    property: "background-color",
    codeValue: "rgb(56, 56, 56)",
    figmaValue: "rgb(48, 48, 48)",
    ...over,
  });

  /**
   * The `ui-button--neutral` report that produced issue #80, in miniature: three
   * colour properties whose value AND binding both drifted (Figma had detached
   * them from their variables), one drifted `copy` row, one property whose value
   * matched while the two sides spelled the token differently, and one match.
   */
  const NEUTRAL_DIMENSIONS: DimensionDiff[] = [
    dim({ kind: "token-value", property: "background-color", status: "drift" }),
    dim({ kind: "token-binding", property: "background-color", status: "drift" }),
    dim({ kind: "token-value", property: "border-color", status: "drift" }),
    dim({ kind: "token-binding", property: "border-color", status: "drift" }),
    dim({ kind: "token-value", property: "color", status: "drift" }),
    dim({ kind: "token-binding", property: "color", status: "drift" }),
    dim({ kind: "copy", property: "text", status: "drift", codeValue: "Cancel", figmaValue: "Button" }),
    dim({ kind: "token-value", property: "border-top-left-radius", status: "match", codeValue: "8px", figmaValue: "8px" }),
    dim({
      kind: "token-binding",
      property: "border-top-left-radius",
      status: "advisory",
      nameDivergence: "value-matched",
      codeValue: "radius",
      figmaValue: "Radius/200",
    }),
    dim({ kind: "token-value", property: "gap", status: "match", codeValue: "8px", figmaValue: "8px" }),
  ];

  /**
   * The assertion issue #80 is actually about. `ui-button--neutral` rendered four
   * drifted rows and the Check-all summary said seven, because three properties
   * drifted twice each — once on the value, once on the binding. A reviewer at the
   * definition-of-done gate reads the summary; the story they open to confirm it
   * disagreed, with nothing saying which number was right.
   */
  it("reports one drift per drifted row, not one per drifted comparison", () => {
    const rows = groupDimensions(NEUTRAL_DIMENSIONS);
    const counts = countRowStatuses(rows);
    expect(counts.drift).toBe(4);
    // The number the table renders, by the table's own predicate.
    expect(rows.filter(rowHasDrift)).toHaveLength(4);
    // And the old unit, for the record: seven comparisons drifted.
    expect(countStatuses(NEUTRAL_DIMENSIONS).drift).toBe(7);
  });

  /**
   * Stated as an invariant over an arbitrary dimension list rather than over one
   * fixture, so a new dimension kind, or a change to how rows are grouped, has to
   * keep the two surfaces agreeing.
   */
  it("drift count equals the drifted rows the table shows, for any report", () => {
    const reports: DimensionDiff[][] = [
      NEUTRAL_DIMENSIONS,
      [],
      [dim({ kind: "token-binding", property: "color", status: "drift" })],
      [
        dim({ kind: "token-value", property: "color", status: "match", codeValue: "a", figmaValue: "a" }),
        dim({ kind: "token-binding", property: "color", status: "drift" }),
      ],
      [
        dim({ kind: "props", property: "Size", status: "drift" }),
        dim({ kind: "variant-set", property: "active-variant", status: "flag-only" }),
        dim({ kind: "token-value", property: "gap", status: "unresolved" }),
      ],
    ];
    for (const dimensions of reports) {
      const rows = groupDimensions(dimensions);
      expect(countRowStatuses(rows).drift).toBe(rows.filter(rowHasDrift).length);
      // The table drops rows with no value on either side; none of them can be
      // drift, so the visible drift count matches too.
      expect(countRowStatuses(rows).drift).toBe(
        rows.filter(rowHasAnyValue).filter(rowHasDrift).length,
      );
    }
  });

  it("gives every row exactly one bucket", () => {
    const rows = groupDimensions(NEUTRAL_DIMENSIONS);
    const counts = countRowStatuses(rows);
    const total =
      counts.match + counts.drift + counts.advisory + counts.unverified + counts.flagOnly + counts.unresolved;
    expect(total).toBe(rows.length);
    expect(counts).toEqual({
      match: 1,
      drift: 4,
      advisory: 1,
      unverified: 0,
      flagOnly: 0,
      unresolved: 0,
    });
  });

  it("counts a name-only divergence as the advisory it is, never as drift or match", () => {
    // The #57 rule, restated at row level: the row's value matched, so it is not
    // drift; the names differ, so it is not a plain match either.
    const rows = groupDimensions([
      dim({ kind: "token-value", property: "gap", status: "match", codeValue: "8px", figmaValue: "8px" }),
      dim({
        kind: "token-binding",
        property: "gap",
        status: "advisory",
        nameDivergence: "value-matched",
      }),
    ]);
    expect(countRowStatuses(rows)).toEqual({
      ...EMPTY_STATUS_COUNTS,
      advisory: 1,
    });
  });

  it("will not call a binding-only drift a match — nothing compared the render", () => {
    const rows = groupDimensions([dim({ kind: "token-binding", property: "color", status: "drift" })]);
    expect(countRowStatuses(rows)).toEqual({ ...EMPTY_STATUS_COUNTS, unverified: 1 });
  });

  it("treats an advisory with no `nameDivergence` as unverified, like countStatuses", () => {
    const rows = groupDimensions([dim({ kind: "token-value", property: "gap", status: "advisory" })]);
    expect(countRowStatuses(rows).unverified).toBe(1);
  });

  /**
   * #108 — the `copy` placeholder heuristic is a SECOND source of
   * `status: "advisory"`, and it carries no `nameDivergence` (that field is
   * about token names, not copy) — instead it names itself via
   * `advisoryReason: "copy-placeholder"`. Before this existed, it fell into
   * the same "missing nameDivergence → unverified" fallback as a stale
   * token-binding cache, and `bindingAdvisory` would even hand it the wrong
   * "name differs" label. It must count as `advisory`, sort at rank 3 (no
   * drift, but worth seeing), and never carry a name-divergence label.
   */
  it("counts a copy-placeholder advisory as advisory, not unverified, and gives it no name-divergence label", () => {
    const row: GroupedRow = {
      kind: "other",
      diff: dim({
        kind: "copy",
        property: "text",
        status: "advisory",
        advisoryReason: "copy-placeholder",
        codeValue: "Save changes?",
        figmaValue: "Text Heading",
        note: "Figma's text repeats its own layer name — read as placeholder copy (heuristic, #108).",
      }),
    };
    expect(countRowStatuses([row])).toEqual({ ...EMPTY_STATUS_COUNTS, advisory: 1 });
    expect(rowRank(row)).toBe(3);
    expect(bindingAdvisory(row)).toBeNull();
  });

  /**
   * #107 — the `rounded-full` idiom against a finite Figma literal is a
   * THIRD source of `status: "advisory"`, this time on a `token-value` diff
   * (grouped as a `"token"` row, not `"other"`) — the same kind a hypothetical
   * stale-cache/future-source `advisory` row would carry (see the test above
   * this one). Only `advisoryReason: "radius-idiom"` tells them apart; kind
   * alone can't, which is why `advisoryBucket` keys off the field.
   */
  it("counts a radius-idiom advisory as advisory too, on a token-kind row", () => {
    const rows = groupDimensions([
      dim({
        kind: "token-value",
        property: "border-top-left-radius",
        status: "advisory",
        advisoryReason: "radius-idiom",
        codeValue: "fully rounded (pill)",
        figmaValue: "32px",
      }),
    ]);
    expect(countRowStatuses(rows)).toEqual({ ...EMPTY_STATUS_COUNTS, advisory: 1 });
    expect(rowRank(rows[0]!)).toBe(3);
  });

  it("is empty for an empty report", () => {
    expect(countRowStatuses([])).toEqual(EMPTY_STATUS_COUNTS);
  });
});

/* ------------------------------------------------------------------------- *
 * which layer a fix belongs in (the impossible-instruction fix)
 * ------------------------------------------------------------------------- */

describe("fixLayer — the panel already knows which layer this is", () => {
  const value = (over: DiffOverride = {}): DimensionDiff =>
    valueDiff({ property: "background-color", codeValue: "rgb(0,0,0)", figmaValue: "rgb(255,0,0)", tokenName: "color/background/brand/default", ...over });

  const binding = (status: DimensionDiff["status"]): DimensionDiff => ({
    kind: "token-binding",
    property: "background-color",
    codeValue: "primary",
    figmaValue: "color/background/brand/default",
    status,
  });

  it("is `token` when the code binds the same token and only the value moved", () => {
    const row: GroupedRow = {
      kind: "token",
      property: "background-color",
      value: value(),
      binding: binding("match"),
    };
    expect(fixLayer(row)).toBe("token");
    expect(codeTokenName(row)).toBe("primary");
  });

  it("is `component` when the two token names were never reconciled", () => {
    // This is the live case that produced the impossible prompt: we do NOT know
    // the code-side name for Figma's variable, so nothing may be derived from it.
    for (const status of ["advisory", "drift", "flag-only"] as const) {
      expect(
        fixLayer({
          kind: "token",
          property: "background-color",
          value: value(),
          binding: binding(status),
        }),
        status,
      ).toBe("component");
    }
  });

  it("is `component` when the code binds no token at all (a literal)", () => {
    expect(fixLayer({ kind: "token", property: "background-color", value: value() })).toBe(
      "component",
    );
    expect(codeTokenName({ kind: "token", property: "background-color", value: value() })).toBeUndefined();
  });

  it("is `design` when Figma's value is not bound to a variable", () => {
    expect(
      fixLayer(
        tokenRowOf(valueDiff({ property: "border-color", figmaValue: "#ddd", tokenName: undefined })),
      ),
    ).toBe("design");
  });

  it("is `component` for a row that isn't drifted, and for non-token rows", () => {
    expect(
      fixLayer({
        kind: "token",
        property: "background-color",
        value: value({ status: "match" }),
        binding: binding("match"),
      }),
    ).toBe("component");
    expect(fixLayer(other({ kind: "copy", property: "text" }))).toBe("component");
  });
});
