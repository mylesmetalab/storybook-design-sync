import { describe, expect, it } from "vitest";
import {
  EXPLICIT_CHECK_BUDGET_DUAL_MS,
  EXPLICIT_CHECK_BUDGET_MS,
  checkTimeoutMessage,
  explicitBudgetMs,
  panelBudgetMs,
  panelTimeoutMessage,
  BULK_BUDGET_PER_BINDING_MS,
  BULK_STORY_BUDGET_DUAL_MS,
  BULK_STORY_BUDGET_MS,
  bulkBudgetMs,
} from "./check-budget.js";
import { withBudget } from "./bulk-run.js";

/**
 * Issue #74: the per-story check had no ceiling, so a rate-limited Figma sat in
 * "Checking…" past 90 seconds with no error and no way to tell "still working"
 * from "wedged". Bulk runs had a budget all along; the single-story path — the one
 * a reviewer uses to re-check a story the bulk run got wrong — did not.
 */

describe("the explicit-check budget", () => {
  it("gives a dual-mode check twice the room (two engine passes for one press)", () => {
    expect(explicitBudgetMs(false)).toBe(EXPLICIT_CHECK_BUDGET_MS);
    expect(explicitBudgetMs(true)).toBe(EXPLICIT_CHECK_BUDGET_DUAL_MS);
    expect(explicitBudgetMs(true)).toBe(explicitBudgetMs(false) * 2);
  });

  it("is far more generous than the bulk run's 8s per story", () => {
    // Different jobs: a bulk run has ~90 stories to get through; an explicit
    // check is one story a human is waiting on. The budget is there to guarantee
    // the panel leaves its loading state, not to police performance.
    expect(explicitBudgetMs(false)).toBeGreaterThan(8000);
  });

  it("leaves the panel's own ceiling above the server's, so the server answers first", () => {
    expect(panelBudgetMs(false)).toBeGreaterThan(explicitBudgetMs(false));
    expect(panelBudgetMs(true)).toBeGreaterThan(explicitBudgetMs(true));
  });
});

describe("the messages say what happened and what to do", () => {
  it("names the cause and refuses to imply a clean result", () => {
    const message = checkTimeoutMessage(30_000);
    expect(message).toContain("30s");
    expect(message).toContain("rate-limiting");
    expect(message).toContain("nothing here");
    expect(message).toContain("Nothing was cached");
  });

  it("distinguishes 'the server never answered' from 'the check gave up'", () => {
    const message = panelTimeoutMessage(35_000);
    expect(message).toContain("No reply from the addon server");
    expect(message).toContain("dev server");
  });
});

describe("withBudget rejects rather than hanging (the mechanism #74 was missing)", () => {
  it("rejects with the timeout message when the work never settles", async () => {
    // A check that never settles is exactly the observed shape: a 429 backoff the
    // panel could not see.
    const never = new Promise<string>(() => {});
    await expect(
      withBudget(never, { budgetMs: 10, message: checkTimeoutMessage(30_000) }),
    ).rejects.toThrow(/gave up after 30s/);
  });

  it("resolves normally when the check finishes inside its budget", async () => {
    await expect(
      withBudget(Promise.resolve("report"), { budgetMs: 1000, message: "unused" }),
    ).resolves.toBe("report");
  });

  it("passes a real failure through unchanged rather than reporting a timeout", async () => {
    await expect(
      withBudget(Promise.reject(new Error("Rate limited by Figma (HTTP 429) — retry in 12s.")), {
        budgetMs: 1000,
        message: "unused",
      }),
    ).rejects.toThrow(/retry in 12s/);
  });
});

/**
 * Per-story budget scaling (#72).
 *
 * The flat 8s was the defect: it sat *inside* the observed duration range for
 * stories with child bindings, so the same `Check all` covered 17 of 18 stories on
 * one run and 18 on the next with nothing changed. Timing-dependent coverage is
 * reported honestly but reads as a mysteriously lower drift total.
 */
describe("bulkBudgetMs — scaled by declared bindings", () => {
  it("is unchanged for a story with no bindings", () => {
    // This matters most: the change must only ever RAISE a budget. Nothing that
    // passed before may start timing out because of it.
    expect(bulkBudgetMs(false)).toBe(BULK_STORY_BUDGET_MS);
    expect(bulkBudgetMs(false, 0)).toBe(BULK_STORY_BUDGET_MS);
    expect(bulkBudgetMs(true)).toBe(BULK_STORY_BUDGET_DUAL_MS);
    expect(bulkBudgetMs(true, 0)).toBe(BULK_STORY_BUDGET_DUAL_MS);
  });

  it("adds room per binding", () => {
    expect(bulkBudgetMs(false, 1)).toBe(BULK_STORY_BUDGET_MS + BULK_BUDGET_PER_BINDING_MS);
    expect(bulkBudgetMs(false, 5)).toBe(BULK_STORY_BUDGET_MS + 5 * BULK_BUDGET_PER_BINDING_MS);
  });

  it("clears the duration that actually timed out", () => {
    // The reported repro: a 5-child-binding story hit 8003ms against an 8000ms
    // ceiling. The new budget must be comfortably above the observed band
    // (6769–8003ms), not marginally.
    expect(bulkBudgetMs(false, 5)).toBeGreaterThan(8003);
    expect(bulkBudgetMs(false, 5)).toBeGreaterThanOrEqual(10_000);
  });

  it("doubles the per-binding room in dual mode, as it doubles the base", () => {
    // Two snapshots and two engine passes per binding, for the same reason the
    // base is doubled.
    expect(bulkBudgetMs(true, 5)).toBe(
      BULK_STORY_BUDGET_DUAL_MS + 5 * BULK_BUDGET_PER_BINDING_MS * 2,
    );
  });

  it("never returns less than the base for a nonsense count", () => {
    for (const n of [-1, -100, Number.NaN]) {
      expect(bulkBudgetMs(false, n)).toBe(BULK_STORY_BUDGET_MS);
    }
  });

  it("truncates a fractional count rather than producing a fractional budget", () => {
    expect(bulkBudgetMs(false, 2.9)).toBe(BULK_STORY_BUDGET_MS + 2 * BULK_BUDGET_PER_BINDING_MS);
  });
});
