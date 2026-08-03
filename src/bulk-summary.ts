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
 *     `unverified` are their own totals — see `row-triage.ts`'
 *     `countRowStatuses`.
 *
 * The rows fed in are counted in the same unit the per-story table renders — one
 * entry per finding, not per comparison (`countRowStatuses`, not
 * `countStatuses`). Counting comparisons made this summary disagree with the story
 * a reviewer opens to confirm it: 7 drift here against 4 rows there, because three
 * properties each drifted on both their value and their binding (#80).
 *
 * And a third, same shape, from issue #73: a story whose child nodes could not be
 * fetched produced a report, so it was `done` and counted as checked — a green
 * tick over five uncompared children. A report that rests on data we could not
 * read gets its own terminal state (`incomplete`) and its own count. The rule is
 * the one this file already enforced: **only `checked` may be reported as
 * coverage.**
 */

export interface BulkSummaryRow extends StatusCounts {
  /**
   * `incomplete` — the check produced a report, but part of what it covers could
   * not be read from Figma (see `DriftReport.incomplete`). Terminal, and
   * deliberately not `done`: its rows are real, its silences are not.
   */
  status: "pending" | "running" | "done" | "incomplete" | "error";
  error?: string | undefined;
  /** True when the row failed by running out of its per-story budget. */
  timedOut?: boolean | undefined;
  /** Why the report is incomplete. Present when `status === "incomplete"`. */
  incompleteReason?: string | undefined;
  durationMs: number;
}

export interface BulkSummary extends StatusCounts {
  /** Registered stories the run set out to check. */
  stories: number;
  /** Stories that produced a report. The only honest coverage number. */
  checked: number;
  /** Stories that ran out of their per-story budget. Not checked. */
  timedOut: number;
  /**
   * Stories that produced a report resting on data that could not be read from
   * Figma (#73). Not checked: their rows are shown, their coverage is not claimed.
   */
  incomplete: number;
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
    incomplete: 0,
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
    else if (row.status === "incomplete") totals.incomplete++;
    else if (row.status === "error") {
      if (row.timedOut) totals.timedOut++;
      else totals.errored++;
    } else totals.pending++;
  }
  // Mean over checked stories only. An incomplete story's duration is in
  // `totalEngineMs` (the run really did spend it) but dividing by stories that
  // didn't complete would understate what a full check costs.
  totals.avgMs = totals.checked > 0 ? Math.round(totals.totalEngineMs / totals.checked) : 0;
  totals.complete = totals.pending === 0 && rows.length > 0;
  return totals;
}

/**
 * True when the run's numbers describe less than the whole registry. The panel
 * uses it to decide whether a green header is allowed to read as a clean bill of
 * health: with any of these present, "no drift" is a statement about a subset.
 */
export function runHasGaps(summary: BulkSummary): boolean {
  return (
    summary.timedOut > 0 ||
    summary.incomplete > 0 ||
    summary.errored > 0 ||
    summary.pending > 0
  );
}

/**
 * The coverage phrase for the summary header. Says "checked" only about stories
 * that produced a report, and names what happened to the rest — `10/10 stories`
 * over a run with a timed-out story is the claim this replaces.
 */
export function coverageLabel(summary: BulkSummary): string {
  const parts = [`${summary.checked}/${summary.stories} stories checked`];
  if (summary.timedOut > 0) parts.push(`${summary.timedOut} timed out`);
  // Named as its own outcome. "Incomplete" is the word for a story that produced
  // rows but could not read part of what it covers — folding it into `checked`
  // is precisely how a rate-limited story came to read as a pass (#73).
  // No cause named here either — see the note in `check-report.ts`. Figma being
  // unread is one reason a story is incomplete; a stylesheet missing from the
  // preview (#96) is another, and that one reads Figma fine.
  if (summary.incomplete > 0) parts.push(`${summary.incomplete} incomplete`);
  if (summary.errored > 0) parts.push(`${summary.errored} errored`);
  if (summary.pending > 0) parts.push(`${summary.pending} not yet run`);
  return parts.join(" · ");
}
