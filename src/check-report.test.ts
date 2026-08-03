import { describe, expect, it } from "vitest";
import type { DimensionDiff, DriftReport } from "./dimensions/types.js";
import type { BulkStoryOutcome } from "./bulk-run.js";
import {
  buildCheckDocument,
  CHECK_EXIT,
  exitCodeFor,
  formatCheckSummary,
  jsonRows,
  summaryRow,
  unperformedModeStories,
} from "./check-report.js";
import { summarizeBulk } from "./bulk-summary.js";
import { countRowStatuses, groupDimensions, visibleDimensions } from "./row-triage.js";

function diff(over: Partial<DimensionDiff> = {}): DimensionDiff {
  return {
    kind: "token-value",
    property: "background-color",
    codeValue: "#ffffff",
    figmaValue: "#000000",
    status: "drift",
    ...over,
  };
}

function report(over: Partial<DriftReport> = {}): DriftReport {
  return {
    storyId: "ui-button--primary",
    nodeId: "1:2",
    generatedAt: "2026-07-31T00:00:00.000Z",
    dimensions: [],
    ...over,
  };
}

function outcome(over: Partial<BulkStoryOutcome<DriftReport>> = {}): BulkStoryOutcome<DriftReport> {
  return { storyId: "ui-button--primary", durationMs: 100, ...over };
}

function doc(outcomes: Array<BulkStoryOutcome<DriftReport>>, dualMode = false) {
  return buildCheckDocument({
    version: "0.0.45",
    storybookUrl: "http://localhost:6006",
    fileKey: "KEY",
    dualMode,
    outcomes,
    nodeIds: {},
    warm: { ms: 500 },
    startedAt: 0,
    finishedAt: 4200,
    includeReports: false,
    generatedAt: "2026-07-31T00:00:00.000Z",
  });
}

/* ------------------------------------------------------------------------- *
 * The exit-code contract
 * ------------------------------------------------------------------------- */

describe("exit-code contract", () => {
  it("0 only when every targeted story was checked and nothing drifted", () => {
    expect(doc([outcome({ report: report({ dimensions: [diff({ status: "match" })] }) })]).exitCode).toBe(
      CHECK_EXIT.Clean,
    );
  });

  it("1 for drift with complete coverage", () => {
    expect(doc([outcome({ report: report({ dimensions: [diff()] }) })]).exitCode).toBe(
      CHECK_EXIT.Drift,
    );
  });

  it("2 when Figma could not be read — never 0, and never 1", () => {
    // The whole point of the code. A rate-limited CI run reporting green is the
    // worst available version of this command (#73).
    const incomplete = doc([
      outcome({
        report: report({
          dimensions: [diff({ status: "match" })],
          incomplete: {
            reason: "Figma rate-limited the request",
            targets: ["root"],
            detail: "429 on /nodes; retry after 60s",
          },
        }),
      }),
    ]);
    expect(incomplete.exitCode).toBe(CHECK_EXIT.IncompleteCoverage);
    expect(incomplete.summary.checked).toBe(0);
    expect(incomplete.summary.incomplete).toBe(1);
  });

  it("2 for a timed-out story and for an errored story", () => {
    expect(doc([outcome({ error: "Timed out (>8s) on s", timedOut: true })]).exitCode).toBe(
      CHECK_EXIT.IncompleteCoverage,
    );
    expect(doc([outcome({ error: "Not registered." })]).exitCode).toBe(
      CHECK_EXIT.IncompleteCoverage,
    );
  });

  it("2 when two modes were asked for and one rendered state was measured", () => {
    // #69's honesty state, carried across: the comparison the caller asked for did
    // not happen, so the run does not cover what it was asked to cover.
    const d = doc(
      [
        outcome({
          report: report({
            dimensions: [diff({ status: "match" })],
            modeComparison: {
              performed: false,
              requested: ["light", "dark"],
              reason: "no verified theme switch was found",
            },
          }),
        }),
      ],
      true,
    );
    expect(d.exitCode).toBe(CHECK_EXIT.IncompleteCoverage);
    // The story still counts as checked — its rows are real — but the run has a gap.
    expect(d.summary.checked).toBe(1);
    expect(d.summary.hasGaps).toBe(true);
  });

  it("ranks incomplete coverage above drift", () => {
    const both = doc([
      outcome({ storyId: "a", report: report({ storyId: "a", dimensions: [diff()] }) }),
      outcome({ storyId: "b", error: "Timed out (>8s) on b", timedOut: true }),
    ]);
    expect(both.summary.drift).toBe(1);
    expect(both.exitCode).toBe(CHECK_EXIT.IncompleteCoverage);
  });

  it("is a pure function of the summary and the mode gaps", () => {
    const summary = summarizeBulk([]);
    expect(exitCodeFor({ summary, unperformedModes: [] })).toBe(CHECK_EXIT.Clean);
    expect(exitCodeFor({ summary, unperformedModes: ["s"] })).toBe(CHECK_EXIT.IncompleteCoverage);
  });

  it("keeps the four codes distinct and stable", () => {
    // Documented in the README; a consumer branches on these numbers.
    expect(CHECK_EXIT).toEqual({ Clean: 0, Drift: 1, IncompleteCoverage: 2, CouldNotRun: 3 });
  });
});

/* ------------------------------------------------------------------------- *
 * Counting in the panel's unit
 * ------------------------------------------------------------------------- */

describe("counting matches the panel", () => {
  /**
   * #80, restated for the CLI: a property that drifted on BOTH its value and its
   * binding is one finding. Counting comparisons gave 7 where the table showed 4,
   * and nothing said which was right.
   */
  it("counts a value+binding drift on one property as one row", () => {
    const r = report({
      dimensions: [
        diff({ kind: "token-value", property: "background-color", status: "drift" }),
        diff({ kind: "token-binding", property: "background-color", status: "drift" }),
      ],
    });
    const row = summaryRow(outcome({ report: r }));
    expect(row.drift).toBe(1);
    expect(jsonRows(r)).toHaveLength(1);
    expect(jsonRows(r)[0]!.comparisons).toHaveLength(2);
  });

  it("uses exactly the panel's tally expression", () => {
    const r = report({
      dimensions: [
        diff({ status: "match" }),
        diff({ kind: "token-binding", property: "color", status: "advisory", nameDivergence: "value-matched" }),
        diff({ kind: "motion", property: "transition", status: "flag-only" }),
      ],
    });
    // `countRows` in manager.tsx is this, verbatim.
    const panel = countRowStatuses(groupDimensions(visibleDimensions(r)));
    const row = summaryRow(outcome({ report: r }));
    expect({
      match: row.match,
      drift: row.drift,
      advisory: row.advisory,
      unverified: row.unverified,
      flagOnly: row.flagOnly,
      unresolved: row.unresolved,
    }).toEqual(panel);
  });

  it("hides the same dimension kinds the panel hides", () => {
    const r = report({ dimensions: [diff({ kind: "motion", status: "drift" })] });
    expect(jsonRows(r)).toEqual([]);
    expect(summaryRow(outcome({ report: r })).drift).toBe(0);
  });

  it("treats an incomplete report as not done", () => {
    const row = summaryRow(
      outcome({
        report: report({
          incomplete: { reason: "Figma unread", targets: ["root"], detail: "429" },
        }),
      }),
    );
    expect(row.status).toBe("incomplete");
    expect(row.incompleteReason).toBe("Figma unread");
  });
});

/* ------------------------------------------------------------------------- *
 * The JSON document
 * ------------------------------------------------------------------------- */

describe("--json output shape", () => {
  it("has a stable top level", () => {
    const d = doc([outcome({ report: report({ dimensions: [diff()] }) })]);
    expect(Object.keys(d).sort()).toEqual([
      "dualMode",
      "exitCode",
      "fileKey",
      "generatedAt",
      "schema",
      "stories",
      "storybookUrl",
      "summary",
      "tool",
      "version",
    ]);
    expect(d.schema).toBe(1);
    expect(d.tool).toBe("@metalab/storybook-design-sync");
  });

  it("has a stable per-story shape", () => {
    const d = doc([outcome({ report: report({ dimensions: [diff()] }) })]);
    const story = d.stories[0]!;
    expect(Object.keys(story).sort()).toEqual([
      "advisory",
      "drift",
      "durationMs",
      "flagOnly",
      "match",
      "nodeId",
      "rows",
      "status",
      "storyId",
      "unresolved",
      "unverified",
    ]);
  });

  /**
   * A forced-state row is the story **root** measured under a condition, not a
   * sub-element. Reporting `element: ":hover"` would invite every consumer of
   * this JSON to render a child element that does not exist — the
   * technically-true-but-inapplicable failure this project keeps closing.
   */
  it("reports a forced state as a condition on the root, not as an element", () => {
    const d = doc([
      outcome({
        report: report({
          dimensions: [diff({ childSelector: ":hover", forcedState: "hover" })],
        }),
      }),
    ]);
    const row = d.stories[0]!.rows![0]!;
    expect(row.state).toBe("hover");
    expect(row.element).toBeNull();
  });

  it("keeps element and state independent, so a child row still reports its selector", () => {
    const d = doc([
      outcome({
        report: report({
          dimensions: [diff({ childSelector: "[data-slot=title]" })],
        }),
      }),
    ]);
    const row = d.stories[0]!.rows![0]!;
    expect(row.element).toBe("[data-slot=title]");
    expect(row.state).toBeNull();
  });

  it("distinguishes a default-state row from its forced counterpart", () => {
    // Identity is the (element, state, property) triple. Keying on
    // element+property alone collides these two into one contradictory row.
    const d = doc([
      outcome({
        report: report({
          dimensions: [
            diff({ property: "background-color", codeValue: "rgb(44,44,44)" }),
            diff({
              property: "background-color",
              codeValue: "rgb(30,30,30)",
              childSelector: ":hover",
              forcedState: "hover",
            }),
          ],
        }),
      }),
    ]);
    const rows = d.stories[0]!.rows!;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.element, r.state])).toEqual(
      expect.arrayContaining([
        [null, null],
        [null, "hover"],
      ]),
    );
  });

  it("has a stable per-row shape, grouped the way the table groups", () => {
    const d = doc([
      outcome({
        report: report({
          dimensions: [
            diff({ kind: "token-value", tokenName: "color/bg" }),
            diff({ kind: "token-binding", codeValue: "primary", figmaValue: "color/bg", status: "advisory", nameDivergence: "value-matched" }),
          ],
        }),
      }),
    ]);
    expect(d.stories[0]!.rows).toEqual([
      {
        element: null,
        state: null,
        property: "background-color",
        finding: "value-drift",
        informative: true,
        comparisons: [
          {
            kind: "token-value",
            status: "drift",
            code: "#ffffff",
            figma: "#000000",
            tokenName: "color/bg",
          },
          {
            kind: "token-binding",
            status: "advisory",
            code: "primary",
            figma: "color/bg",
            nameDivergence: "value-matched",
          },
        ],
      },
    ]);
  });

  it("names the element for a bound child's row", () => {
    const d = doc([
      outcome({
        report: report({
          dimensions: [diff({ childSelector: "[data-slot=header]", property: "padding-top" })],
        }),
      }),
    ]);
    expect(d.stories[0]!.rows![0]!.element).toBe("[data-slot=header]");
  });

  it("keeps an uninformative row visible but flagged", () => {
    // A comparison that could not be made is what the summary must keep saying out
    // loud; the panel merely declines to render it as a table row.
    const d = doc([
      outcome({
        report: report({
          dimensions: [diff({ codeValue: null, figmaValue: null, status: "flag-only" })],
        }),
      }),
    ]);
    expect(d.stories[0]!.rows![0]!.informative).toBe(false);
    expect(d.summary.flagOnly).toBe(1);
  });

  it("carries the read's provenance and the unresolved children", () => {
    const d = doc([
      outcome({
        report: report({
          source: { readAt: "2026-07-30T12:00:00.000Z", fromCache: true },
          children: [
            { selector: "[data-slot=x]", nodeId: "9:9", status: "selector-not-found", message: "nothing matched" },
          ],
        }),
      }),
    ]);
    expect(d.stories[0]!.source).toEqual({ readAt: "2026-07-30T12:00:00.000Z", fromCache: true });
    expect(d.stories[0]!.unresolvedChildren).toEqual([
      { selector: "[data-slot=x]", status: "selector-not-found", message: "nothing matched" },
    ]);
  });

  it("embeds the engine's own report only when asked", () => {
    const r = report({ dimensions: [diff()] });
    expect(doc([outcome({ report: r })]).stories[0]!.report).toBeUndefined();
    const full = buildCheckDocument({
      version: "0.0.45",
      storybookUrl: "http://x",
      fileKey: "K",
      dualMode: false,
      outcomes: [outcome({ report: r })],
      nodeIds: {},
      warm: { ms: 0 },
      startedAt: 0,
      finishedAt: 1,
      includeReports: true,
    });
    expect(full.stories[0]!.report).toEqual(r);
  });

  it("falls back to the registry's node id for a story that never reported", () => {
    const d = buildCheckDocument({
      version: "0.0.45",
      storybookUrl: "http://x",
      fileKey: "K",
      dualMode: false,
      outcomes: [outcome({ error: "boom" })],
      nodeIds: { "ui-button--primary": "4185:3779" },
      warm: { ms: 0 },
      startedAt: 0,
      finishedAt: 1,
      includeReports: false,
    });
    expect(d.stories[0]!.nodeId).toBe("4185:3779");
    expect(d.stories[0]!.rows).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------- *
 * The human summary
 * ------------------------------------------------------------------------- */

describe("the readable summary", () => {
  it("says PASS only for a clean, complete run", () => {
    const clean = formatCheckSummary(
      doc([outcome({ report: report({ dimensions: [diff({ status: "match" })] }) })]),
    );
    expect(clean).toContain("PASS");
    expect(clean).toContain("1/1 stories checked");
  });

  it("never says PASS over a gap, and names the gap first", () => {
    const text = formatCheckSummary(
      doc([
        outcome({ storyId: "a", report: report({ storyId: "a", dimensions: [diff()] }) }),
        outcome({ storyId: "b", error: "Timed out (>8s) on b", timedOut: true }),
      ]),
    );
    expect(text).not.toContain("PASS");
    expect(text).toContain("INCOMPLETE");
    expect(text).toContain("1 timed out");
    expect(text).toContain("does not cover the whole selection");
  });

  it("distinguishes name-only divergence from drift, as the panel does", () => {
    const text = formatCheckSummary(
      doc([
        outcome({
          report: report({
            dimensions: [
              diff({ kind: "token-binding", status: "advisory", nameDivergence: "value-matched" }),
            ],
          }),
        }),
      ]),
    );
    expect(text).toContain("0 drift");
    expect(text).toContain("1 name-only");
  });

  it("reports an unperformed mode comparison per story", () => {
    const text = formatCheckSummary(
      doc(
        [
          outcome({
            report: report({
              modeComparison: {
                performed: false,
                requested: ["light", "dark"],
                reason: "the theme switch changed nothing",
              },
            }),
          }),
        ],
        true,
      ),
    );
    expect(text).toContain("two modes requested, one rendered state measured");
    expect(text).toContain("the theme switch changed nothing");
  });

  it("lists a child binding that produced no comparison", () => {
    const text = formatCheckSummary(
      doc([
        outcome({
          report: report({
            children: [
              { selector: "[data-slot=body]", nodeId: "1:9", status: "selector-not-found", message: "nothing matched" },
            ],
          }),
        }),
      ]),
    );
    expect(text).toContain("[data-slot=body]");
    expect(text).toContain("nothing matched");
  });

  it("reports a warm-up failure rather than absorbing it", () => {
    const d = buildCheckDocument({
      version: "0.0.45",
      storybookUrl: "http://x",
      fileKey: "K",
      dualMode: false,
      outcomes: [outcome({ report: report() })],
      nodeIds: {},
      warm: { ms: 30_000, error: "Shared Figma fetch did not finish within 30s" },
      startedAt: 0,
      finishedAt: 1,
      includeReports: false,
    });
    expect(d.summary.warmupError).toContain("did not finish");
    expect(formatCheckSummary(d)).toContain("did not finish");
  });
});

describe("unperformedModeStories", () => {
  it("lists only the stories whose requested two-mode comparison did not happen", () => {
    expect(
      unperformedModeStories([
        outcome({ storyId: "a", report: report({ storyId: "a" }) }),
        outcome({
          storyId: "b",
          report: report({
            storyId: "b",
            modeComparison: { performed: true, requested: ["light", "dark"] },
          }),
        }),
        outcome({
          storyId: "c",
          report: report({
            storyId: "c",
            modeComparison: { performed: false, requested: ["light", "dark"] },
          }),
        }),
      ]),
    ).toEqual(["c"]);
  });
});
