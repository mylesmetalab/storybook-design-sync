import { describe, expect, it } from "vitest";
import {
  coverageLabel,
  runHasGaps,
  summarizeBulk,
  type BulkSummaryRow,
} from "./bulk-summary.js";
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

/**
 * Issue #73. A story whose child nodes 429'd produced a report, so it was `done`,
 * so it was counted as checked — `18/18 stories checked` over a run where one
 * story compared 2 properties out of ~37 and showed a tick. An incomplete story is
 * a fourth outcome, not a variety of success.
 */
describe("summarizeBulk — a story with unread Figma data is not checked", () => {
  const incomplete = (over: Partial<BulkSummaryRow> = {}): BulkSummaryRow =>
    row({
      status: "incomplete",
      incompleteReason: "5 child bindings could not be read — rate limited by Figma",
      match: 2,
      ...over,
    });

  it("counts it separately and keeps it out of the coverage claim", () => {
    const s = summarizeBulk([incomplete(), row({ match: 15 }), row({ match: 15 })]);
    expect(s.stories).toBe(3);
    expect(s.checked).toBe(2);
    expect(s.incomplete).toBe(1);
    expect(s.errored).toBe(0);
    expect(s.timedOut).toBe(0);
    expect(coverageLabel(s)).toBe("2/3 stories checked · 1 incomplete (Figma unread)");
  });

  it("still totals the rows it did produce — they are real", () => {
    const s = summarizeBulk([incomplete({ match: 2, drift: 1 }), row({ match: 10 })]);
    expect(s.match).toBe(12);
    expect(s.drift).toBe(1);
  });

  it("is terminal — the run is complete with one in it", () => {
    const s = summarizeBulk([incomplete(), row()]);
    expect(s.pending).toBe(0);
    expect(s.complete).toBe(true);
  });

  it("is not counted in the average's denominator", () => {
    const s = summarizeBulk([
      row({ durationMs: 1000 }),
      row({ durationMs: 2000 }),
      incomplete({ durationMs: 6000 }),
    ]);
    // Same rule the timed-out case follows: the run really spent the time, so it
    // stays in the total, but only stories that completed divide it.
    expect(s.totalEngineMs).toBe(9000);
    expect(s.avgMs).toBe(4500);
  });

  it("names all three shortfalls at once when a run manages it", () => {
    const s = summarizeBulk([
      row(),
      incomplete(),
      row({ status: "error", timedOut: true }),
      row({ status: "error", error: "Not registered." }),
    ]);
    expect(coverageLabel(s)).toBe(
      "1/4 stories checked · 1 timed out · 1 incomplete (Figma unread) · 1 errored",
    );
  });
});

describe("runHasGaps — whether the numbers describe the whole registry", () => {
  it("is false only for a run where every story was checked", () => {
    expect(runHasGaps(summarizeBulk([row(), row()]))).toBe(false);
  });

  it("is true for an incomplete, a timeout, an error, or an unfinished run", () => {
    expect(runHasGaps(summarizeBulk([row(), row({ status: "incomplete" })]))).toBe(true);
    expect(runHasGaps(summarizeBulk([row(), row({ status: "error", timedOut: true })]))).toBe(true);
    expect(runHasGaps(summarizeBulk([row(), row({ status: "error" })]))).toBe(true);
    expect(runHasGaps(summarizeBulk([row(), row({ status: "pending" })]))).toBe(true);
  });
});
