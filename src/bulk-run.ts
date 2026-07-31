/**
 * Sequencing for a **Check all** run, extracted from `manager.tsx` so the part
 * that went wrong is testable without React or Storybook.
 *
 * What went wrong (issue #56): the run's shared Figma fetch — one
 * `/variables/local` call plus file metadata, which every story in the run reads
 * — happened lazily inside the *first* story's check, and that check was wrapped
 * in an 8s per-story budget. Live: `ui-button--primary` `8016ms` `✗ Timed out
 * (>8s)`, then `ui-button--primary-small` `1959ms` ✓, `ui-button--primary-disabled`
 * `1130ms` ✓. The first story was not slow; it was paying for the other nine, and
 * it was the only one that ever failed.
 *
 * So the shared fetch is hoisted: `warm()` runs to completion BEFORE any story's
 * timer starts, and each story's budget then covers only its own work. The
 * warm-up has its own, longer budget and its own reported cost.
 *
 * The second half of the same issue: the summary said `10/10 stories` while one
 * story produced no rows at all. An outcome here is one of three things —
 * checked, timed out, or errored — and `bulk-summary.ts` counts them separately.
 */

export interface BulkStoryOutcome<R> {
  storyId: string;
  /** Present only when the check completed. */
  report?: R;
  /** Present when the check failed or ran out of budget. */
  error?: string;
  /** True when the budget expired rather than the check failing. */
  timedOut?: boolean;
  durationMs: number;
}

export interface WarmOutcome {
  ms: number;
  /** Present when the shared fetch could not be done. The run continues. */
  error?: string;
}

export interface RunBulkOptions<R> {
  storyIds: readonly string[];
  /**
   * The run's shared, once-only fetch. Awaited before the first story's budget
   * starts. Must resolve, not reject — a warm-up failure makes the run slow, not
   * broken, so it is reported and the loop proceeds.
   */
  warm: () => Promise<WarmOutcome>;
  /** Check one story. Rejects on failure. */
  check: (storyId: string) => Promise<R>;
  /** Per-story wall budget, covering per-story work only. */
  budgetMs: number;
  /**
   * Called when a story's budget expires, so the caller can drop whatever state
   * it was holding for the in-flight check (the manager clears its pending
   * report resolver here). The abandoned check may still settle; its result is
   * ignored.
   */
  onBudgetExpired?: (storyId: string) => void;
  onWarmed?: (outcome: WarmOutcome) => void;
  onStoryStart?: (index: number, storyId: string) => void;
  onStoryDone?: (index: number, outcome: BulkStoryOutcome<R>) => void;
  /** Injectable for tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** The message a timed-out story reports. `isTimeoutError` recognizes it. */
export function timeoutMessage(storyId: string, budgetMs: number): string {
  return `Timed out (>${Math.round(budgetMs / 1000)}s) on ${storyId}`;
}

export async function runBulkCheck<R>(opts: RunBulkOptions<R>): Promise<Array<BulkStoryOutcome<R>>> {
  const now = opts.now ?? (() => Date.now());
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  // The shared fetch, once, outside every story's budget. This line IS the fix
  // for #56 — the ordering is the whole point, not an optimisation.
  const warm = await opts.warm();
  opts.onWarmed?.(warm);

  const outcomes: Array<BulkStoryOutcome<R>> = [];
  for (let i = 0; i < opts.storyIds.length; i++) {
    const storyId = opts.storyIds[i]!;
    opts.onStoryStart?.(i, storyId);
    const startedAt = now();
    let outcome: BulkStoryOutcome<R>;
    try {
      const report = await withBudget(opts.check(storyId), {
        budgetMs: opts.budgetMs,
        message: timeoutMessage(storyId, opts.budgetMs),
        onExpired: () => opts.onBudgetExpired?.(storyId),
        setTimer,
        clearTimer,
      });
      outcome = { storyId, report, durationMs: now() - startedAt };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      outcome = {
        storyId,
        error: message,
        durationMs: now() - startedAt,
        ...(isTimeoutError(message) ? { timedOut: true } : {}),
      };
    }
    outcomes.push(outcome);
    opts.onStoryDone?.(i, outcome);
  }
  return outcomes;
}

/**
 * Reject with `message` if `work` hasn't settled within the budget. The budget is
 * enforced here — in one place, outside the work itself — so "what is a story
 * allowed to cost" has a single answer that does not silently include the run's
 * shared setup.
 */
export function withBudget<T>(
  work: Promise<T>,
  opts: {
    budgetMs: number;
    message: string;
    onExpired?: () => void;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  },
): Promise<T> {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  return new Promise<T>((resolve, reject) => {
    const handle = setTimer(() => {
      opts.onExpired?.();
      reject(new Error(opts.message));
    }, opts.budgetMs);
    work.then(
      (value) => {
        clearTimer(handle);
        resolve(value);
      },
      (err: unknown) => {
        clearTimer(handle);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Whether a failure message is a budget expiry rather than a real error. */
export function isTimeoutError(message: string | undefined): boolean {
  return message !== undefined && /Timed out \(>\d+s\)/.test(message);
}

/** One story of a run, and whether it has to be navigated to first. */
export interface BulkNavigationStep {
  storyId: string;
  /** True when the story is already the rendered one, so no navigation happens. */
  alreadyRendered: boolean;
}

/**
 * Which stories of a run need navigating to, and which is already on screen.
 *
 * This exists because of a defect that only a headless run made visible. Both
 * bulk loops work by navigating to a story and waiting for `STORY_RENDERED` — but
 * Storybook answers a navigation to the story **already showing** with
 * `STORY_UNCHANGED` and no re-render, so `STORY_RENDERED` never fires. The wait
 * then runs the full per-story budget and the run reports:
 *
 *     ui-button--primary   —   —   —   —   8332ms   ⏱ timed out — not checked
 *
 * over a story that was rendered and idle the entire time. In the panel that is
 * whichever story the designer happens to be looking at when they press **Check
 * all** — so the one story they most likely care about is the one the run cannot
 * check. Measured live against the reference consumer: the panel reached 9/10
 * while `design-sync check` reached 10/10, and the 9 they shared were identical
 * row for row. The missing story was the one on screen.
 *
 * A story that is already rendered needs no navigation and no wait: ask about it
 * immediately. Kept here, pure, and used by both loops, so the panel and the CLI
 * cannot disagree about which stories a run has to navigate to.
 */
export function planBulkNavigation(
  storyIds: readonly string[],
  currentStoryId: string | undefined,
): BulkNavigationStep[] {
  let claimed = false;
  return storyIds.map((storyId) => {
    // Only the FIRST occurrence can be already-rendered. A registry that binds
    // the same story twice would otherwise skip navigation on the second visit
    // too, and by then the loop has moved on.
    const alreadyRendered = !claimed && storyId === currentStoryId;
    if (alreadyRendered) claimed = true;
    return { storyId, alreadyRendered };
  });
}
