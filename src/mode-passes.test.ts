import { describe, expect, it } from "vitest";
import { describeModeComparison, mergeIncomplete, mergeReports, runModePasses } from "./server.js";
import type { CheckDriftInput, ChildTarget, CodeSnapshot } from "./engines/types.js";
import type { DriftReport } from "./dimensions/types.js";
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
