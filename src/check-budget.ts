/**
 * The ceiling on a single **Check drift**.
 *
 * Issue #74: bulk runs had a per-story budget (`bulk-run.ts`, 8s) and reported a
 * timeout honestly, while the per-story path — the one a reviewer reaches for to
 * re-check a story the bulk run got wrong — had no ceiling at all. With Figma
 * rate-limiting, it sat in "Checking…" past 90 seconds with no error, no partial
 * result, and no way to tell "still working" from "wedged". The only recourse was
 * reloading the page, which also discarded whatever the bulk run had computed.
 *
 * Deliberately far more generous than the bulk budget. A bulk run has ~90 stories
 * to get through and a slow one costs the whole run; an explicit check is one
 * story a human is waiting on, and a large file legitimately takes seconds. The
 * budget exists to guarantee the panel always leaves its loading state — not to
 * police performance.
 */

/** Single-mode explicit check. */
export const EXPLICIT_CHECK_BUDGET_MS = 30_000;
/** Dual-mode: two engine passes for one press, so twice the room. */
export const EXPLICIT_CHECK_BUDGET_DUAL_MS = 60_000;

export function explicitBudgetMs(dualMode: boolean): number {
  return dualMode ? EXPLICIT_CHECK_BUDGET_DUAL_MS : EXPLICIT_CHECK_BUDGET_MS;
}

/**
 * What the panel shows when the budget runs out. Names the most likely cause,
 * because with the retry ceiling in `rate-limit.ts` in place, a check that still
 * exceeds this has almost certainly been queueing behind rate-limited requests.
 */
export function checkTimeoutMessage(budgetMs: number): string {
  return (
    `Check drift gave up after ${Math.round(budgetMs / 1000)}s — no report, so nothing here ` +
    `is a verdict. The usual cause is Figma rate-limiting a burst of requests (two Check-all ` +
    `runs in quick succession will do it); wait a minute and try again. Nothing was cached, ` +
    `so the next run starts fresh.`
  );
}

/**
 * The manager's own ceiling, above the server's, so a check still terminates if
 * the server never answers at all — a wedged dev server, a preview that never
 * emitted a snapshot, a channel that dropped the reply. Without it the panel's
 * only guarantee comes from a process that may be the thing that is broken.
 */
export function panelBudgetMs(dualMode: boolean): number {
  return explicitBudgetMs(dualMode) + 5_000;
}

export function panelTimeoutMessage(budgetMs: number): string {
  return (
    `No reply from the addon server after ${Math.round(budgetMs / 1000)}s. The check was ` +
    `abandoned — nothing here is a verdict. Is Storybook's dev server still running? ` +
    `Check its terminal for errors, then re-run.`
  );
}
