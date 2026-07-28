import { describe, expect, it } from "vitest";
import { coverageLabel, summarizeBulk, type BulkSummaryRow } from "./bulk-summary.js";
import { EMPTY_STATUS_COUNTS } from "./row-triage.js";

const row = (over: Partial<BulkSummaryRow> = {}): BulkSummaryRow => ({
  ...EMPTY_STATUS_COUNTS,
  status: "done",
  durationMs: 1000,
  ...over,
});

/**
 * Issue #56, second half: the summary reported `10/10 stories` while one story had
 * timed out and produced no rows at all. A run that checked nine of ten stories
 * must say nine — "checked" is a coverage claim, and a timed-out story is exactly
 * the coverage the report does not have.
 */
describe("summarizeBulk — checked, timed out and errored are different things", () => {
  it("does not count a timed-out story as checked", () => {
    const s = summarizeBulk([
      row({ status: "error", timedOut: true, error: "Timed out (>8s) on ui-button--primary", durationMs: 8016 }),
      row({ match: 15, durationMs: 1959 }),
      row({ match: 15, durationMs: 1130 }),
    ]);
    expect(s.stories).toBe(3);
    expect(s.checked).toBe(2);
    expect(s.timedOut).toBe(1);
    expect(s.errored).toBe(0);
    expect(coverageLabel(s)).toBe("2/3 stories checked · 1 timed out");
  });

  it("counts a real failure separately from a timeout", () => {
    const s = summarizeBulk([
      row({ status: "error", error: "Not registered." }),
      row({ status: "error", timedOut: true, error: "Timed out (>8s) on x" }),
      row(),
    ]);
    expect(s.checked).toBe(1);
    expect(s.timedOut).toBe(1);
    expect(s.errored).toBe(1);
    expect(coverageLabel(s)).toBe("1/3 stories checked · 1 timed out · 1 errored");
  });

  it("says how many stories have not run yet, mid-run", () => {
    const s = summarizeBulk([row(), row({ status: "running" }), row({ status: "pending" })]);
    expect(s.pending).toBe(2);
    expect(s.complete).toBe(false);
    expect(coverageLabel(s)).toBe("1/3 stories checked · 2 not yet run");
  });

  it("reads plainly when everything was checked", () => {
    const s = summarizeBulk([row(), row()]);
    expect(coverageLabel(s)).toBe("2/2 stories checked");
    expect(s.complete).toBe(true);
  });

  it("averages over checked stories only — a timeout must not flatter the average", () => {
    const s = summarizeBulk([
      row({ durationMs: 1000 }),
      row({ durationMs: 2000 }),
      row({ status: "error", timedOut: true, durationMs: 8016 }),
    ]);
    // Total wall time is still reported (the timeout cost the run 8s), but the
    // per-story average is over the two stories that produced a report.
    expect(s.totalEngineMs).toBe(11016);
    expect(s.avgMs).toBe(Math.round(11016 / 2));
  });

  it("keeps name-only divergence out of the drift total (#57)", () => {
    const s = summarizeBulk([
      row({ match: 149, drift: 9, advisory: 80, flagOnly: 75 }),
      row({ advisory: 3, unverified: 2 }),
    ]);
    expect(s.drift).toBe(9);
    expect(s.advisory).toBe(83);
    expect(s.unverified).toBe(2);
    expect(s.match).toBe(149);
    expect(s.flagOnly).toBe(75);
  });

  it("is empty and incomplete for an empty run", () => {
    const s = summarizeBulk([]);
    expect(s.stories).toBe(0);
    expect(s.checked).toBe(0);
    expect(s.avgMs).toBe(0);
    expect(s.complete).toBe(false);
  });
});
