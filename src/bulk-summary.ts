import { EMPTY_STATUS_COUNTS, type StatusCounts } from "./row-triage.js";

/**
 * The Check-all summary line, as arithmetic rather than JSX, so what it claims is
 * testable.
 *
 * Two claims it used to get wrong, both from issue #56/#57:
 *
 *  1. `10/10 stories` while one story had timed out and produced no rows at all.
 *     A run that checked nine of ten stories must say nine. `checked`,
 *     `timedOut` and `errored` are separate counts and only `checked` may be
 *     reported as coverage.
 *  2. `149 match · 89 drift · 75 flag-only` where 80 of the "drift" were
 *     name-only binding divergences whose values matched. `advisory` and
 *     `unverified` are their own totals — see `row-triage.ts`' `countStatuses`.
 */

export interface BulkSummaryRow extends StatusCounts {
  status: "pending" | "running" | "done" | "error";
  error?: string | undefined;
  /** True when the row failed by running out of its per-story budget. */
  timedOut?: boolean | undefined;
  durationMs: number;
}

export interface BulkSummary extends StatusCounts {
  /** Registered stories the run set out to check. */
  stories: number;
  /** Stories that produced a report. The only honest coverage number. */
  checked: number;
  /** Stories that ran out of their per-story budget. Not checked. */
  timedOut: number;
  /** Stories that failed for any other reason. Not checked. */
  errored: number;
  /** Stories not yet reached. */
  pending: number;
  /** Sum of per-story durations (excludes the run's shared warm-up). */
  totalEngineMs: number;
  /** Mean duration over *checked* stories only. */
  avgMs: number;
  /** True once every story reached a terminal state. */
  complete: boolean;
}

export function summarizeBulk(rows: readonly BulkSummaryRow[]): BulkSummary {
  const totals: BulkSummary = {
    ...EMPTY_STATUS_COUNTS,
    stories: rows.length,
    checked: 0,
    timedOut: 0,
    errored: 0,
    pending: 0,
    totalEngineMs: 0,
    avgMs: 0,
    complete: false,
  };
  for (const row of rows) {
    totals.match += row.match;
    totals.drift += row.drift;
    totals.advisory += row.advisory;
    totals.unverified += row.unverified;
    totals.flagOnly += row.flagOnly;
    totals.unresolved += row.unresolved;
    totals.totalEngineMs += row.durationMs;
    if (row.status === "done") totals.checked++;
    else if (row.status === "error") {
      if (row.timedOut) totals.timedOut++;
      else totals.errored++;
    } else totals.pending++;
  }
  totals.avgMs = totals.checked > 0 ? Math.round(totals.totalEngineMs / totals.checked) : 0;
  totals.complete = totals.pending === 0 && rows.length > 0;
  return totals;
}

/**
 * The coverage phrase for the summary header. Says "checked" only about stories
 * that produced a report, and names what happened to the rest — `10/10 stories`
 * over a run with a timed-out story is the claim this replaces.
 */
export function coverageLabel(summary: BulkSummary): string {
  const parts = [`${summary.checked}/${summary.stories} stories checked`];
  if (summary.timedOut > 0) parts.push(`${summary.timedOut} timed out`);
  if (summary.errored > 0) parts.push(`${summary.errored} errored`);
  if (summary.pending > 0) parts.push(`${summary.pending} not yet run`);
  return parts.join(" · ");
}
