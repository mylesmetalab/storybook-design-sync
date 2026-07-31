import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isTimeoutError,
  planBulkNavigation,
  runBulkCheck,
  timeoutMessage,
  withBudget,
} from "./bulk-run.js";

/**
 * Issue #56, reproduced as arithmetic.
 *
 * Live numbers from a cold Check-all: `ui-button--primary` `8016ms`
 * `✗ Timed out (>8s)`, then `ui-button--primary-small` `1959ms` ✓,
 * `ui-button--primary-disabled` `1130ms` ✓. The first story wasn't slow — it paid
 * for the shared Figma variables fetch that every other story then read for free,
 * inside its own 8s budget, and it was the only story that ever failed.
 *
 * The model below is that situation: a shared fetch costing 7s once, per-story
 * work costing 1.5s, and an 8s per-story budget. With the fetch left inside the
 * first story's budget the first story times out (8.5s > 8s); hoisted, every story
 * finishes. Both are asserted, so the regression can't come back quietly.
 */

const SHARED_FETCH_MS = 7000;
const PER_STORY_MS = 1500;
const BUDGET_MS = 8000;

interface ColdWorld {
  warm: () => Promise<{ ms: number }>;
  check: (storyId: string) => Promise<string>;
  sharedFetches: number;
}

/** A run whose engine caches start cold, exactly as after a Storybook restart. */
function coldWorld(): ColdWorld {
  let warmed = false;
  let sharedFetches = 0;
  const sharedFetch = async (): Promise<void> => {
    if (warmed) return;
    sharedFetches++;
    await sleep(SHARED_FETCH_MS);
    warmed = true;
  };
  const world: ColdWorld = {
    warm: async () => {
      const t0 = now();
      await sharedFetch();
      return { ms: now() - t0 };
    },
    check: async (storyId: string) => {
      // Whatever the per-story path needs, it needs the shared artefacts first.
      await sharedFetch();
      await sleep(PER_STORY_MS);
      return `report:${storyId}`;
    },
    get sharedFetches() {
      return sharedFetches;
    },
  };
  return world;
}

let clock = 0;
const now = (): number => clock;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Drive fake time forward far enough for a whole run to settle. */
async function drive(promise: Promise<unknown>, totalMs: number): Promise<void> {
  const step = 100;
  for (let elapsed = 0; elapsed < totalMs; elapsed += step) {
    clock += step;
    await vi.advanceTimersByTimeAsync(step);
  }
  await promise;
}

describe("runBulkCheck — the shared fetch is the run's cost, not the first story's", () => {
  it("completes the first story of a COLD run within its budget", async () => {
    const world = coldWorld();
    const run = runBulkCheck<string>({
      storyIds: ["ui-button--primary", "ui-button--primary-small", "ui-button--primary-disabled"],
      warm: world.warm,
      check: world.check,
      budgetMs: BUDGET_MS,
      now,
    });
    await drive(run, 20000);
    const outcomes = await run;

    expect(outcomes.map((o) => o.report)).toEqual([
      "report:ui-button--primary",
      "report:ui-button--primary-small",
      "report:ui-button--primary-disabled",
    ]);
    expect(outcomes.some((o) => o.timedOut)).toBe(false);
    // The first story is charged for its own work only.
    expect(outcomes[0]!.durationMs).toBeLessThanOrEqual(BUDGET_MS);
    expect(outcomes[0]!.durationMs).toBeLessThan(SHARED_FETCH_MS);
  });

  it("times the first story out when the shared fetch is NOT hoisted (the bug)", async () => {
    const world = coldWorld();
    const run = runBulkCheck<string>({
      // A no-op warm reproduces v0.0.37: the cold fetch happens lazily inside the
      // first story's check, inside its budget.
      warm: async () => ({ ms: 0 }),
      storyIds: ["ui-button--primary", "ui-button--primary-small"],
      check: world.check,
      budgetMs: BUDGET_MS,
      now,
    });
    await drive(run, 30000);
    const outcomes = await run;

    expect(outcomes[0]!.timedOut).toBe(true);
    expect(outcomes[0]!.error).toContain("Timed out (>8s)");
    // …and the story after it sails through on the cache the failed one warmed.
    expect(outcomes[1]!.report).toBe("report:ui-button--primary-small");
  });

  it("does the shared fetch exactly once, before any story runs", async () => {
    const world = coldWorld();
    const order: string[] = [];
    const run = runBulkCheck<string>({
      storyIds: ["a", "b"],
      warm: async () => {
        const r = await world.warm();
        order.push("warm");
        return r;
      },
      check: async (id) => {
        order.push(`check:${id}`);
        return world.check(id);
      },
      budgetMs: BUDGET_MS,
      onWarmed: (outcome) => order.push(`warmed:${outcome.ms}`),
      now,
    });
    await drive(run, 20000);
    await run;

    expect(order).toEqual(["warm", `warmed:${SHARED_FETCH_MS}`, "check:a", "check:b"]);
    expect(world.sharedFetches).toBe(1);
  });

  it("runs anyway when the warm-up fails — a slow run, not a broken one", async () => {
    const world = coldWorld();
    const warmOutcomes: Array<{ ms: number; error?: string }> = [];
    const run = runBulkCheck<string>({
      storyIds: ["a"],
      warm: async () => ({ ms: 12, error: "No fileKey configured — nothing to warm." }),
      check: world.check,
      budgetMs: 20000,
      onWarmed: (o) => warmOutcomes.push(o),
      now,
    });
    await drive(run, 20000);
    const outcomes = await run;

    expect(warmOutcomes[0]!.error).toMatch(/nothing to warm/);
    expect(outcomes[0]!.report).toBe("report:a");
  });
});

describe("runBulkCheck — an outcome is checked, timed out, or errored", () => {
  it("marks a budget expiry as timedOut and tells the caller to drop its state", async () => {
    const expired: string[] = [];
    const run = runBulkCheck<string>({
      storyIds: ["slow"],
      warm: async () => ({ ms: 0 }),
      check: () => sleep(30000).then(() => "never"),
      budgetMs: 1000,
      onBudgetExpired: (id) => expired.push(id),
      now,
    });
    await drive(run, 5000);
    const outcomes = await run;

    expect(outcomes[0]!.timedOut).toBe(true);
    expect(outcomes[0]!.report).toBeUndefined();
    expect(expired).toEqual(["slow"]);
  });

  it("distinguishes a real failure from a timeout, and keeps going", async () => {
    const run = runBulkCheck<string>({
      storyIds: ["broken", "fine"],
      warm: async () => ({ ms: 0 }),
      check: async (id) => {
        if (id === "broken") throw new Error("Not registered. Add \"broken\" to …");
        return `report:${id}`;
      },
      budgetMs: 1000,
      now,
    });
    await drive(run, 5000);
    const outcomes = await run;

    expect(outcomes[0]!.timedOut).toBeUndefined();
    expect(outcomes[0]!.error).toMatch(/Not registered/);
    expect(outcomes[1]!.report).toBe("report:fine");
  });

  it("reports per-story durations from the injected clock", async () => {
    const run = runBulkCheck<string>({
      storyIds: ["a"],
      warm: async () => ({ ms: 0 }),
      check: () => sleep(PER_STORY_MS).then(() => "r"),
      budgetMs: BUDGET_MS,
      now,
    });
    await drive(run, 5000);
    const outcomes = await run;
    // Within one tick of the driver's 100ms granularity — the point is that the
    // duration is the story's own work, not the run's shared fetch.
    expect(outcomes[0]!.durationMs).toBeGreaterThanOrEqual(PER_STORY_MS - 100);
    expect(outcomes[0]!.durationMs).toBeLessThan(PER_STORY_MS + 200);
  });
});

describe("withBudget / isTimeoutError", () => {
  it("resolves work that finishes in time and clears its timer", async () => {
    const p = withBudget(sleep(500).then(() => "ok"), {
      budgetMs: 1000,
      message: timeoutMessage("a", 1000),
    });
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toBe("ok");
    // If the timer were still live, advancing past it would produce an unhandled
    // rejection; advancing here asserts it was cleared.
    await vi.advanceTimersByTimeAsync(2000);
  });

  it("rejects with a message `isTimeoutError` recognizes", async () => {
    const p = withBudget(sleep(5000), { budgetMs: 1000, message: timeoutMessage("a", 1000) });
    const settled = expect(p).rejects.toThrow(/Timed out \(>1s\) on a/);
    await vi.advanceTimersByTimeAsync(1100);
    await settled;
    expect(isTimeoutError(timeoutMessage("a", 8000))).toBe(true);
  });

  it("does not mistake other failures for timeouts", () => {
    expect(isTimeoutError(undefined)).toBe(false);
    expect(isTimeoutError("Storybook API unavailable")).toBe(false);
    expect(isTimeoutError("Pipeline unreachable (timed out)")).toBe(false);
  });
});

/**
 * The story on screen was the one story a run could not check.
 *
 * Reproduced from the live measurement that found it: comparing the panel's
 * `Check all` against `design-sync check` over the reference consumer's ten
 * registered Button stories, the panel reported `9/10 stories checked · 1 timed
 * out` and the timed-out story was `ui-button--primary` — the story the panel
 * happened to be showing. The nine they shared were identical row for row, so the
 * loop was fine and the navigation was not: `selectStory` on the current story is
 * answered with STORY_UNCHANGED and no re-render, so the wait for STORY_RENDERED
 * ran the whole 8s budget over a story that was rendered the entire time.
 */
describe("planBulkNavigation — the story already on screen", () => {
  it("marks the current story as already rendered and every other story as not", () => {
    expect(planBulkNavigation(["a", "b", "c"], "b")).toEqual([
      { storyId: "a", alreadyRendered: false },
      { storyId: "b", alreadyRendered: true },
      { storyId: "c", alreadyRendered: false },
    ]);
  });

  it("navigates to every story when nothing is on screen", () => {
    // A headless run before its first page load, and a panel whose state has no
    // story yet. Neither may assume something is rendered.
    for (const current of [undefined, ""]) {
      expect(planBulkNavigation(["a", "b"], current).every((s) => !s.alreadyRendered)).toBe(true);
    }
  });

  it("does not match a story that is not in the run", () => {
    expect(planBulkNavigation(["a", "b"], "z").some((s) => s.alreadyRendered)).toBe(false);
  });

  it("claims the current story at most once", () => {
    // A registry binding the same id twice would otherwise skip navigation on the
    // second visit, by which point the loop has moved on and it really does need
    // navigating back to.
    expect(planBulkNavigation(["a", "a"], "a")).toEqual([
      { storyId: "a", alreadyRendered: true },
      { storyId: "a", alreadyRendered: false },
    ]);
  });

  it("preserves the run's order and length", () => {
    const ids = ["x", "y", "z"];
    expect(planBulkNavigation(ids, "z").map((s) => s.storyId)).toEqual(ids);
    expect(planBulkNavigation([], "z")).toEqual([]);
  });
});
