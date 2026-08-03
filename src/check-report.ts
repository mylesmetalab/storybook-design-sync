import type { DimensionDiff, DimensionKind, DimensionStatus, DriftReport } from "./dimensions/types.js";
import type { BulkStoryOutcome, WarmOutcome } from "./bulk-run.js";
import { coverageLabel, runHasGaps, summarizeBulk, type BulkSummary, type BulkSummaryRow } from "./bulk-summary.js";
import {
  classifyRow,
  countRowStatuses,
  groupDimensions,
  rowChildSelector,
  rowForcedState,
  rowHasAnyValue,
  sortRowsByFinding,
  unresolvedChildBindings,
  visibleDimensions,
  type GroupedRow,
  type RowFinding,
} from "./row-triage.js";

/**
 * `design-sync check`'s output and its exit-code contract.
 *
 * Two rules shape everything here, and they are the same two the panel's summary
 * obeys:
 *
 *  1. **Only a story that produced a complete report counts as checked.** A
 *     timed-out story, an errored story, and a story whose Figma side was partly
 *     unreadable are three different non-passes, counted separately
 *     (`bulk-summary.ts`). CI reading exit 0 over a rate-limited run would be the
 *     worst version of this command, so `incomplete` gets its own exit code and
 *     never the success one.
 *  2. **The numbers are counted in the unit the table renders.** `countRowStatuses`
 *     over `groupDimensions(visibleDimensions(report))` — the same call
 *     `manager.tsx` makes for a Check-all row. A CLI whose totals disagreed with
 *     the panel a reviewer opens to confirm them is #80 again, one layer out.
 */

/* ------------------------------------------------------------------------- *
 * Exit codes
 * ------------------------------------------------------------------------- */

/**
 * The exit-code contract. Stable, and documented in the README.
 *
 * The ordering matters more than the numbers: `IncompleteCoverage` outranks
 * `Drift`, because "I found drift and checked everything" is a stronger claim
 * than the run is entitled to make when a story never reported. A CI job that
 * only distinguishes zero from non-zero gets the right answer either way; one
 * that branches can tell "the design and the code disagree" from "I could not
 * find out".
 */
export const CHECK_EXIT = {
  /** Every targeted story produced a complete report, and no row drifted. */
  Clean: 0,
  /** Every targeted story was checked; at least one row is drift. */
  Drift: 1,
  /**
   * The run's numbers describe less than it set out to check: a story errored,
   * ran out of budget, or produced a report resting on a Figma read that failed
   * (`DriftReport.incomplete`) — or a requested two-mode comparison did not
   * happen. Outranks `Drift`.
   */
  IncompleteCoverage: 2,
  /**
   * The check could not run at all: bad usage, no reachable Storybook, no
   * browser driver, nothing registered, a filter that matched nothing. Nothing
   * was compared, so this is never a statement about drift.
   */
  CouldNotRun: 3,
} as const;

export type CheckExitCode = (typeof CHECK_EXIT)[keyof typeof CHECK_EXIT];

/* ------------------------------------------------------------------------- *
 * Rows
 * ------------------------------------------------------------------------- */

/** One comparison inside a row. A token row carries up to two: value and binding. */
export interface CheckJsonComparison {
  kind: DimensionKind;
  status: DimensionStatus;
  code: unknown;
  figma: unknown;
  tokenName?: string;
  nameDivergence?: string;
  note?: string;
}

/**
 * One row of the panel's table, as data.
 *
 * Shaped like `GroupedRow` rather than like a raw `DimensionDiff`: a property
 * whose value **and** binding both differ is one finding, not two, and flattening
 * it back to dimensions is exactly the recount that made the panel's summary
 * disagree with its own table (#80).
 */
export interface CheckJsonRow {
  /** Declared child selector, or `null` for the story root. */
  element: string | null;
  /**
   * The forced pseudo-state this row was measured in (`"hover"`), or `null` for
   * the default state.
   *
   * A state row has `element: null` because the element measured **is** the story
   * root — only the condition differs. So a row's identity is the triple
   * (`element`, `state`, `property`); keying on element+property alone will
   * collide a default-state row with its forced counterpart.
   */
  state: string | null;
  property: string;
  /** What kind of finding this is — the panel's row ordering key. */
  finding: RowFinding;
  /**
   * False for a row with no value on either side. The panel drops these from the
   * table as uninformative; they are kept here (and counted, as the panel counts
   * them) because a comparison that could not be made must stay visible.
   */
  informative: boolean;
  comparisons: CheckJsonComparison[];
}

function comparisonOf(diff: DimensionDiff): CheckJsonComparison {
  return {
    kind: diff.kind,
    status: diff.status,
    code: diff.codeValue ?? null,
    figma: diff.figmaValue ?? null,
    ...(diff.tokenName !== undefined ? { tokenName: diff.tokenName } : {}),
    ...(diff.nameDivergence !== undefined ? { nameDivergence: diff.nameDivergence } : {}),
    ...(diff.note !== undefined ? { note: diff.note } : {}),
  };
}

export function jsonRow(row: GroupedRow): CheckJsonRow {
  const diffs: DimensionDiff[] =
    row.kind === "token"
      ? [row.value, row.binding].filter((d): d is DimensionDiff => d !== undefined)
      : [row.diff];
  const property = row.kind === "token" ? row.property : row.diff.property;
  const forcedState = rowForcedState(row);
  return {
    // A forced state is measured on the root, so `element` stays null and the
    // condition is reported separately. Emitting `":hover"` here would present
    // the state as a sub-element that does not exist.
    element: forcedState === undefined ? rowChildSelector(row) ?? null : null,
    state: forcedState ?? null,
    property,
    finding: classifyRow(row),
    informative: rowHasAnyValue(row),
    comparisons: diffs.map(comparisonOf),
  };
}

/** The rows of one report, in the order the panel lists them. */
export function jsonRows(report: DriftReport): CheckJsonRow[] {
  return sortRowsByFinding(groupDimensions(visibleDimensions(report))).map(jsonRow);
}

/* ------------------------------------------------------------------------- *
 * JSON document
 * ------------------------------------------------------------------------- */

export interface CheckJsonStory {
  storyId: string;
  nodeId: string | null;
  /** Terminal state. Only `"done"` means checked. */
  status: BulkSummaryRow["status"];
  durationMs: number;
  match: number;
  drift: number;
  advisory: number;
  unverified: number;
  flagOnly: number;
  unresolved: number;
  error?: string;
  timedOut?: boolean;
  /** Why the report covers less than it claims — Figma could not be read. */
  incompleteReason?: string;
  /** Present only when two modes were requested. `performed: false` is a gap. */
  modeComparison?: DriftReport["modeComparison"];
  /** When the Figma values were read, and whether from the cache. */
  source?: DriftReport["source"];
  /** Declared child bindings that produced no comparison. */
  unresolvedChildren?: Array<{ selector: string; status: string; message?: string }>;
  rows?: CheckJsonRow[];
  /** The engine's own report, verbatim. Absent for a story that never produced one. */
  report?: DriftReport;
}

export interface CheckJsonDocument {
  tool: string;
  version: string;
  /** Schema version of THIS document. Bumped when a consumer would have to care. */
  schema: 1;
  generatedAt: string;
  storybookUrl: string;
  fileKey: string;
  dualMode: boolean;
  exitCode: CheckExitCode;
  summary: BulkSummary & {
    coverage: string;
    /** True when the run's numbers describe less than the whole selection. */
    hasGaps: boolean;
    elapsedMs: number;
    warmupMs: number;
    warmupError?: string;
  };
  stories: CheckJsonStory[];
}

/**
 * Turn one bulk outcome into a summary row — the same three-way terminal
 * classification the panel applies in `onStoryDone`, including the one that took
 * a release to get right: a report carrying `incomplete` is **not** done.
 */
export function summaryRow(outcome: BulkStoryOutcome<DriftReport>): BulkSummaryRow {
  if (outcome.report) {
    const incomplete = outcome.report.incomplete;
    return {
      ...countRowStatuses(groupDimensions(visibleDimensions(outcome.report))),
      status: incomplete ? "incomplete" : "done",
      ...(incomplete ? { incompleteReason: incomplete.reason } : {}),
      durationMs: outcome.durationMs,
    };
  }
  return {
    ...countRowStatuses([]),
    status: "error",
    durationMs: outcome.durationMs,
    error: outcome.error,
    ...(outcome.timedOut ? { timedOut: true } : {}),
  };
}

/**
 * Stories where two modes were asked for and one rendered state was measured
 * (#69). Not drift and not an error — a shortfall in what the run covered, so it
 * counts against a clean exit exactly as an unread Figma response does.
 */
export function unperformedModeStories(
  outcomes: readonly BulkStoryOutcome<DriftReport>[],
): string[] {
  return outcomes
    .filter((o) => o.report?.modeComparison && !o.report.modeComparison.performed)
    .map((o) => o.storyId);
}

export function exitCodeFor(opts: {
  summary: BulkSummary;
  unperformedModes: readonly string[];
}): CheckExitCode {
  if (runHasGaps(opts.summary) || opts.unperformedModes.length > 0) {
    return CHECK_EXIT.IncompleteCoverage;
  }
  return opts.summary.drift > 0 ? CHECK_EXIT.Drift : CHECK_EXIT.Clean;
}

export interface BuildDocumentInput {
  version: string;
  storybookUrl: string;
  fileKey: string;
  dualMode: boolean;
  outcomes: Array<BulkStoryOutcome<DriftReport>>;
  nodeIds: Record<string, string>;
  warm: WarmOutcome;
  startedAt: number;
  finishedAt: number;
  /** Whether to embed each story's full `DriftReport`. */
  includeReports: boolean;
  generatedAt?: string;
}

export function buildCheckDocument(input: BuildDocumentInput): CheckJsonDocument {
  const rows = input.outcomes.map(summaryRow);
  const summary = summarizeBulk(rows);
  const unperformedModes = unperformedModeStories(input.outcomes);
  const exitCode = exitCodeFor({ summary, unperformedModes });

  const stories: CheckJsonStory[] = input.outcomes.map((outcome, index) => {
    const row = rows[index]!;
    const report = outcome.report;
    const skipped = unresolvedChildBindings(report?.children);
    const story: CheckJsonStory = {
      storyId: outcome.storyId,
      nodeId: report?.nodeId ?? input.nodeIds[outcome.storyId] ?? null,
      status: row.status,
      durationMs: row.durationMs,
      match: row.match,
      drift: row.drift,
      advisory: row.advisory,
      unverified: row.unverified,
      flagOnly: row.flagOnly,
      unresolved: row.unresolved,
      ...(row.error !== undefined ? { error: row.error } : {}),
      ...(row.timedOut ? { timedOut: true } : {}),
      ...(row.incompleteReason !== undefined ? { incompleteReason: row.incompleteReason } : {}),
    };
    if (report?.modeComparison) story.modeComparison = report.modeComparison;
    if (report?.source) story.source = report.source;
    if (skipped.length > 0) {
      story.unresolvedChildren = skipped.map((c) => ({
        selector: c.selector,
        status: c.status,
        ...(c.message !== undefined ? { message: c.message } : {}),
      }));
    }
    if (report) story.rows = jsonRows(report);
    if (report && input.includeReports) story.report = report;
    return story;
  });

  return {
    tool: "@metalab/storybook-design-sync",
    version: input.version,
    schema: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    storybookUrl: input.storybookUrl,
    fileKey: input.fileKey,
    dualMode: input.dualMode,
    exitCode,
    summary: {
      ...summary,
      coverage: coverageLabel(summary),
      hasGaps: runHasGaps(summary) || unperformedModes.length > 0,
      elapsedMs: input.finishedAt - input.startedAt,
      warmupMs: input.warm.ms,
      ...(input.warm.error !== undefined ? { warmupError: input.warm.error } : {}),
    },
    stories,
  };
}

/* ------------------------------------------------------------------------- *
 * Human summary
 * ------------------------------------------------------------------------- */

/**
 * The readable summary, printed to stderr so `--json` on stdout stays pipeable.
 *
 * Deliberately the same phrases the panel uses — `coverageLabel` for coverage,
 * "name-only" for a value-matched name divergence — because a person reading a CI
 * log and a person reading the panel should not have to translate between them.
 */
export function formatCheckSummary(doc: CheckJsonDocument): string {
  const s = doc.summary;
  const lines: string[] = [];
  lines.push("");
  for (const story of doc.stories) {
    lines.push(`${storyMark(story)} ${story.storyId.padEnd(34)} ${storyDetail(story)}`);
    for (const child of story.unresolvedChildren ?? []) {
      lines.push(`    ↳ child ${child.selector} — ${child.status}: ${child.message ?? "not compared"}`);
    }
    if (story.modeComparison && !story.modeComparison.performed) {
      lines.push(
        `    ↳ two modes requested, one rendered state measured — ${story.modeComparison.reason ?? "not performed"}`,
      );
    }
  }
  lines.push("");
  lines.push(`Coverage: ${coverageLabel(s)}`);
  lines.push(
    `Findings: ${s.drift} drift · ${s.advisory} name-only · ${s.unverified} unverified · ` +
      `${s.flagOnly} flag-only · ${s.unresolved} unresolved · ${s.match} match`,
  );
  lines.push(
    `Elapsed:  ${(s.elapsedMs / 1000).toFixed(1)}s` +
      (s.warmupMs > 0 ? ` (shared Figma fetch ${s.warmupMs}ms)` : "") +
      (s.avgMs > 0 ? ` · avg ${s.avgMs}ms/story` : ""),
  );
  if (s.warmupError) lines.push(`Warm-up:  ${s.warmupError}`);
  lines.push("");
  lines.push(verdictLine(doc));
  return lines.join("\n");
}

/**
 * The one line a reader will quote, so it must not overstate.
 *
 * `exit 0` is the only case allowed to say the selection is clean. Every other
 * code names what is missing first: with a gap present, "no drift" is a statement
 * about a subset and saying it plainly is the whole point of this command.
 */
function verdictLine(doc: CheckJsonDocument): string {
  const s = doc.summary;
  if (doc.exitCode === CHECK_EXIT.Clean) {
    return `PASS — ${s.checked}/${s.stories} stories checked, no drift. (exit 0)`;
  }
  if (doc.exitCode === CHECK_EXIT.Drift) {
    return `DRIFT — ${s.drift} drifted row(s) across ${driftedStoryCount(doc)} story(ies), everything checked. (exit 1)`;
  }
  const gaps: string[] = [];
  if (s.timedOut > 0) gaps.push(`${s.timedOut} timed out`);
  if (s.incomplete > 0) gaps.push(`${s.incomplete} incomplete (Figma unread)`);
  if (s.errored > 0) gaps.push(`${s.errored} errored`);
  if (s.pending > 0) gaps.push(`${s.pending} never ran`);
  const unperformed = doc.stories.filter((st) => st.modeComparison && !st.modeComparison.performed);
  if (unperformed.length > 0) gaps.push(`${unperformed.length} without the requested two-mode comparison`);
  return (
    `INCOMPLETE — ${gaps.join(", ")}. ` +
    `${s.drift} drifted row(s) found in what was checked, but this run does not cover the whole ` +
    `selection, so it is not a verdict on it. (exit 2)`
  );
}

function driftedStoryCount(doc: CheckJsonDocument): number {
  return doc.stories.filter((s) => s.drift > 0).length;
}

function storyMark(story: CheckJsonStory): string {
  if (story.status === "error") return story.timedOut ? "⏱" : "✗";
  if (story.status === "incomplete") return "⚠";
  if (story.status === "pending" || story.status === "running") return "·";
  return story.drift > 0 ? "✗" : "✓";
}

function storyDetail(story: CheckJsonStory): string {
  if (story.status === "error") return story.error ?? "failed";
  const parts = [`${story.drift} drift`, `${story.match} match`];
  if (story.advisory > 0) parts.push(`${story.advisory} name-only`);
  if (story.unverified > 0) parts.push(`${story.unverified} unverified`);
  if (story.flagOnly > 0) parts.push(`${story.flagOnly} flag-only`);
  if (story.unresolved > 0) parts.push(`${story.unresolved} unresolved`);
  const suffix = story.incompleteReason ? `  — INCOMPLETE: ${story.incompleteReason}` : "";
  return `${parts.join(" · ")}  ${story.durationMs}ms${suffix}`;
}
