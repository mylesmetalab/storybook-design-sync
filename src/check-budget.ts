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

/* ------------------------------------------------------------------------- *
 * Bulk-run budgets
 * ------------------------------------------------------------------------- */

/**
 * Per-story ceiling for a **whole-registry** run — the panel's `Check all` and
 * the CLI's `design-sync check`, which must agree: a story that fails headlessly
 * has to fail in the panel too, or the two answers diverge on timing alone.
 *
 * Far tighter than the explicit budget above, and for the opposite reason. An
 * explicit check is one story a human is waiting on; a bulk run has the whole
 * registry to get through, and a story that hangs costs every story after it.
 *
 * These numbers lived as a literal in `manager.tsx` (`dualMode ? 16000 : 8000`).
 * They are here now because a second caller appeared, and "the budget the panel
 * uses" had to stop being a number typed in one file.
 */
export const BULK_STORY_BUDGET_MS = 8_000;
/** Dual-mode: two snapshots and two engine passes per story, so twice the room. */
export const BULK_STORY_BUDGET_DUAL_MS = 16_000;

/**
 * Extra room per declared binding — each child or state binding adds a snapshot
 * and a Figma node to the story's work (#72).
 *
 * Chosen from the observed distribution, not picked: on the reference consumer the
 * childless stories sat around 5.0s while the two with **five** child bindings
 * each sat at 6.8–7.5s and intermittently crossed 8s (8003ms on one run). That is
 * roughly 500ms per binding, so 600 gives headroom without being arbitrary.
 *
 * The flat 8s was the actual defect: it sits *inside* the observed range for
 * bound stories, so the same command covered 17 of 18 stories on one run and 18
 * on the next with nothing changed. Timing-dependent coverage is the worst kind —
 * it is reported honestly, but a designer comparing against a baseline sees a
 * lower drift total with no visible cause.
 */
export const BULK_BUDGET_PER_BINDING_MS = 600;

/**
 * Per-story ceiling, scaled by how much the story actually has to do.
 *
 * `bindings` is the number of declared child **and** state bindings: each is one
 * more element to snapshot and one more Figma node to resolve. Absent or zero
 * gives exactly the previous numbers, so this can only ever *raise* a budget —
 * nothing that passed before can start timing out because of this change.
 */
export function bulkBudgetMs(dualMode: boolean, bindings = 0): number {
  const base = dualMode ? BULK_STORY_BUDGET_DUAL_MS : BULK_STORY_BUDGET_MS;
  // `bindings` arrives over the channel, so it can be anything. `Math.trunc(NaN)`
  // is NaN and `Math.max(0, NaN)` is NaN, which would yield a NaN budget — and a
  // NaN timeout neither fires nor holds. Coerce to 0 and fall back to the base.
  const count = Number.isFinite(bindings) ? Math.max(0, Math.trunc(bindings)) : 0;
  const extra = count * BULK_BUDGET_PER_BINDING_MS;
  // Dual mode measures every binding twice, so its per-binding cost is doubled
  // for the same reason its base is.
  return base + (dualMode ? extra * 2 : extra);
}

/**
 * Budget for a run's shared Figma fetch (`WarmCacheRequest` → `WarmCacheDone`),
 * outside every story's own budget (#56). Generous: on a cold cache this is one
 * `/variables/local` call plus file metadata for a whole design system.
 */
export const WARM_BUDGET_MS = 30_000;
