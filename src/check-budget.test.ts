import { describe, expect, it } from "vitest";
import {
  EXPLICIT_CHECK_BUDGET_DUAL_MS,
  EXPLICIT_CHECK_BUDGET_MS,
  checkTimeoutMessage,
  explicitBudgetMs,
  panelBudgetMs,
  panelTimeoutMessage,
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
