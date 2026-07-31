import { describe, expect, it } from "vitest";
import { describeModeComparison, mergeIncomplete, mergeReports, runModePasses } from "./server.js";
import type { CheckDriftInput, ChildTarget, CodeSnapshot } from "./engines/types.js";
import type { DimensionDiff, DriftReport } from "./dimensions/types.js";
import type { ChildSnapshotEntry } from "./channels.js";

/**
 * Issue #69, server side: what a two-mode check actually runs, and what the report
 * is allowed to claim about it.
 *
 * The issue read "only the Figma side gains mode values — the code side is
 * snapshotted once". It isn't: the preview captures the rendered story in each
 * mode and sends both, and these passes compare each mode's code snapshot against
 * that mode's Figma value. What was broken was the switch — on a class-themed
 * project `setAttribute("data-theme", …)` changed nothing, so the two snapshots
 * were identical and the two passes measured one state. These tests pin the
 * structure (a code snapshot per mode) and the honesty rule (no two-mode claim
 * without two states).
 */

const snapshotFor = (mode: string): CodeSnapshot => ({
  styles: { "background-color": mode === "dark" ? "rgb(30, 30, 30)" : "rgb(255, 255, 255)" },
});

function baseInput(): CheckDriftInput {
  return {
    storyId: "ui-card--default",
    nodeRef: { fileKey: "file-key", nodeId: "2142:11380" },
    snapshot: snapshotFor("light"),
    mode: "light",
  };
}

/** An engine that records every input it was asked to compare. */
function recordingEngine(reportFor?: (input: CheckDriftInput) => Partial<DriftReport>) {
  const calls: CheckDriftInput[] = [];
  return {
    calls,
    checkDrift: async (input: CheckDriftInput): Promise<DriftReport> => {
      calls.push(input);
      return {
        storyId: input.storyId,
        nodeId: input.nodeRef.nodeId,
        dimensions: [
          {
            kind: "token-value",
            property: "background-color",
            codeValue: input.snapshot?.styles?.["background-color"],
            figmaValue: input.mode === "dark" ? "rgb(30, 30, 30)" : "rgb(255, 255, 255)",
            status: "match",
          },
        ],
        generatedAt: new Date().toISOString(),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(reportFor?.(input) ?? {}),
      };
    },
  };
}

describe("runModePasses — one engine pass per mode, each with that mode's code snapshot", () => {
  it("compares the code snapshot captured in each mode, not one snapshot twice", async () => {
    const engine = recordingEngine();
    await runModePasses({
      engine,
      baseInput: baseInput(),
      mode: "light",
      additionalSnapshots: [{ mode: "dark", snapshot: snapshotFor("dark") }],
      childTargets: [],
      childSnapshots: undefined,
    });

    expect(engine.calls).toHaveLength(2);
    expect(engine.calls.map((c) => c.mode)).toEqual(["light", "dark"]);
    // The load-bearing assertion: the two passes were given DIFFERENT code
    // snapshots. Equal snapshots here is the #69 failure.
    expect(engine.calls[0]!.snapshot).not.toEqual(engine.calls[1]!.snapshot);
    expect(engine.calls[0]!.snapshot?.styles?.["background-color"]).toBe("rgb(255, 255, 255)");
    expect(engine.calls[1]!.snapshot?.styles?.["background-color"]).toBe("rgb(30, 30, 30)");
  });

  it("gives each pass that mode's child snapshots too", async () => {
    const engine = recordingEngine();
    const child: ChildTarget = {
      selector: "[data-slot=header]",
      nodeId: "2142:11381",
      snapshot: { styles: { color: "rgb(10, 10, 10)" } },
    };
    const received: ChildSnapshotEntry[] = [
      {
        selector: "[data-slot=header]",
        nodeId: "2142:11381",
        kind: "found",
        snapshot: { styles: { color: "rgb(10, 10, 10)" } },
        additionalSnapshots: [{ mode: "dark", snapshot: { styles: { color: "rgb(245, 245, 245)" } } }],
      },
    ];
    await runModePasses({
      engine,
      baseInput: { ...baseInput(), children: [child] },
      mode: "light",
      additionalSnapshots: [{ mode: "dark", snapshot: snapshotFor("dark") }],
      childTargets: [child],
      childSnapshots: received,
    });

    expect(engine.calls[0]!.children?.[0]?.snapshot?.styles?.color).toBe("rgb(10, 10, 10)");
    expect(engine.calls[1]!.children?.[0]?.snapshot?.styles?.color).toBe("rgb(245, 245, 245)");
  });

  it("runs exactly once with no second snapshot", async () => {
    const engine = recordingEngine();
    const report = await runModePasses({
      engine,
      baseInput: baseInput(),
      mode: "light",
      additionalSnapshots: undefined,
      childTargets: [],
      childSnapshots: undefined,
    });

    expect(engine.calls).toHaveLength(1);
    expect(report.mode).toBe("light");
  });

  it("merges into per-mode cells and names the modes", async () => {
    const engine = recordingEngine();
    const report = await runModePasses({
      engine,
      baseInput: baseInput(),
      mode: "light",
      additionalSnapshots: [{ mode: "dark", snapshot: snapshotFor("dark") }],
      childTargets: [],
      childSnapshots: undefined,
    });

    expect(report.mode).toBe("light+dark");
    const row = report.dimensions.find((d) => d.property === "background-color");
    expect(row?.codeValue).toEqual({ light: "rgb(255, 255, 255)", dark: "rgb(30, 30, 30)" });
  });
});

describe("describeModeComparison — no two-mode claim without two states (#69)", () => {
  it("reports performed when the switch landed and two snapshots arrived", () => {
    const out = describeModeComparison(
      { requested: ["light", "dark"], applied: true, mechanism: "class `.dark` on <html>" },
      true,
    );
    expect(out).toEqual({
      performed: true,
      requested: ["light", "dark"],
      mechanism: "class `.dark` on <html>",
    });
  });

  it("reports NOT performed when the switch produced no change", () => {
    const out = describeModeComparison(
      {
        requested: ["light", "dark"],
        applied: false,
        mechanism: "attribute `data-theme` on <html>",
        reason: "Not performed — switching produced no change…",
      },
      false,
    );
    expect(out?.performed).toBe(false);
    expect(out?.reason).toContain("Not performed");
  });

  it("refuses the claim even if the preview says applied but sent one snapshot", () => {
    // Belt and braces: `applied` is the preview's word, `dualMode` is what the
    // server can see. One rendered state means one rendered state.
    const out = describeModeComparison(
      { requested: ["light", "dark"], applied: true, mechanism: "class `.dark` on <html>" },
      false,
    );
    expect(out?.performed).toBe(false);
    expect(out?.reason).toContain("single rendered state");
  });

  it("says nothing at all when two modes were never requested", () => {
    expect(describeModeComparison(undefined, false)).toBeUndefined();
  });
});

/**
 * Issue #73, one layer up: a dual-mode check runs two passes, and a Figma read
 * that failed in *either* of them means the merged report is not a verdict either.
 * Dropping it because the other pass read fine is how a rate-limited dark pass
 * would get cached and counted as checked.
 */
describe("mergeIncomplete / mergeReports — unread in one mode is unread overall", () => {
  const report = (over: Partial<DriftReport> = {}): DriftReport => ({
    storyId: "ui-card--default",
    nodeId: "2142:11380",
    dimensions: [],
    generatedAt: new Date().toISOString(),
    ...over,
  });

  const incomplete = (retryAfterMs?: number): NonNullable<DriftReport["incomplete"]> => ({
    reason: "1 child binding could not be read — rate limited by Figma",
    targets: ["[data-slot=header]"],
    detail: "Rate limited by Figma (HTTP 429).",
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });

  it("survives the merge when only one mode failed", () => {
    const merged = mergeReports([
      { mode: "light", report: report() },
      { mode: "dark", report: report({ incomplete: incomplete() }) },
    ]);
    expect(merged.incomplete).toBeDefined();
    expect(merged.incomplete!.targets).toEqual(["[data-slot=header]"]);
  });

  it("is absent when both modes read everything", () => {
    const merged = mergeReports([
      { mode: "light", report: report() },
      { mode: "dark", report: report() },
    ]);
    expect(merged.incomplete).toBeUndefined();
  });

  it("deduplicates targets and keeps the longest wait", () => {
    const out = mergeIncomplete([
      report({ incomplete: incomplete(5000) }),
      report({ incomplete: incomplete(20_000) }),
    ]);
    expect(out!.targets).toEqual(["[data-slot=header]"]);
    expect(out!.retryAfterMs).toBe(20_000);
  });

  it("carries the cache note through the merge", () => {
    const merged = mergeReports([
      { mode: "light", report: report() },
      { mode: "dark", report: report({ cacheStatus: { discardedByVersion: 21 } }) },
    ]);
    expect(merged.cacheStatus?.discardedByVersion).toBe(21);
  });
});

/**
 * The dual-mode merge must not lose what makes a row a DESIGN DECISION.
 *
 * Found while fixing #66: the merge rebuilt each row from `kind`, `property`,
 * per-mode values and status, and dropped `tokenName`. `classifyRow` then read a
 * bound, drifted row as `unbound-figma-value` and its prompt opened with "in Figma,
 * this property is set to a literal value that is NOT bound to a variable" — a
 * fabricated claim about a row that is bound, routing the fix to the wrong side
 * entirely. Every dual-mode drift row in the product was affected.
 */
describe("mergeReports — a merged row keeps the decision, not just the measurements", () => {
  const base = (over: { [K in keyof DimensionDiff]?: DimensionDiff[K] | undefined } = {}): DimensionDiff => ({
    kind: "token-value",
    property: "background-color",
    codeValue: "rgb(56, 56, 56)",
    figmaValue: "rgb(48, 48, 48)",
    status: "drift",
    tokenName: "Background/Neutral/Tertiary",
    codeClassName: "bg-secondary",
    ...over,
  }) as DimensionDiff;

  const withRow = (row: DimensionDiff): DriftReport => ({
    storyId: "ui-button--neutral",
    nodeId: "1:2",
    dimensions: [row],
    generatedAt: new Date().toISOString(),
  });

  it("keeps the token name when both modes name the same one", () => {
    const merged = mergeReports([
      { mode: "light", report: withRow(base({ status: "match", figmaValue: "rgb(56, 56, 56)" })) },
      { mode: "dark", report: withRow(base()) },
    ]);
    const row = merged.dimensions[0]!;
    expect(row.status).toBe("drift");
    expect(row.tokenName).toBe("Background/Neutral/Tertiary");
    expect(row.codeClassName).toBe("bg-secondary");
  });

  it("drops it rather than picking when the two modes disagree on the name", () => {
    const merged = mergeReports([
      { mode: "light", report: withRow(base()) },
      { mode: "dark", report: withRow(base({ tokenName: "Background/Other" })) },
    ]);
    // Two modes reporting two token names is not one decision, and choosing either
    // would be a guess dressed as a reading.
    expect(merged.dimensions[0]!.tokenName).toBeUndefined();
  });

  it("exposes the per-mode Figma values as `modes`, so a prompt can carry both (#66)", () => {
    const merged = mergeReports([
      { mode: "light", report: withRow(base({ figmaValue: "rgb(0, 153, 81)" })) },
      { mode: "dark", report: withRow(base({ figmaValue: "rgb(133, 224, 163)" })) },
    ]);
    expect(merged.dimensions[0]!.modes).toEqual({
      light: "rgb(0, 153, 81)",
      dark: "rgb(133, 224, 163)",
    });
  });

  it("does not relabel a project's own mode names as light/dark", () => {
    const merged = mergeReports([
      { mode: "day", report: withRow(base({ figmaValue: "a" })) },
      { mode: "night", report: withRow(base({ figmaValue: "b" })) },
    ]);
    // A mislabelled mode value in a fix prompt would send the change to the wrong
    // block, so a `["day","night"]` project gets no `modes` field at all.
    expect(merged.dimensions[0]!.modes).toBeUndefined();
  });

  it("reports the EARLIEST read of the two passes, and flags a cached half (#76)", () => {
    const report = (readAt: string, fromCache?: boolean): DriftReport => ({
      ...withRow(base()),
      source: { readAt, fileVersion: "9", ...(fromCache ? { fromCache: true } : {}) },
    });
    const merged = mergeReports([
      { mode: "light", report: report("2026-07-30T09:00:00.000Z") },
      { mode: "dark", report: report("2026-07-28T11:00:00.000Z", true) },
    ]);
    // A prompt built from this report is only as fresh as its stalest half.
    expect(merged.source).toEqual({
      readAt: "2026-07-28T11:00:00.000Z",
      fileVersion: "9",
      fromCache: true,
    });
  });
});
