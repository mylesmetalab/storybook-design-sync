import { describe, expect, it, vi } from "vitest";
import { createLiveValue } from "./live-value.js";
import { runBulkCheck } from "./bulk-run.js";

/**
 * Issue #78, third finding: **Check all ignored the Both modes checkbox.**
 *
 * Storybook's `useChannel(eventMap, deps = [])` registers a panel's channel
 * handlers once on mount and never again. The handler that starts a Check-all run
 * therefore held the `runBulk` closure from the first render, which captured
 * `dualMode === false`. Ticking the box and pressing Check all ran the entire
 * registry in single mode, and the summary reported a completed run — with a
 * ticked checkbox above it.
 *
 * These tests pin the property that fixes it: a long-lived handler must read the
 * option **when it runs**, not when it was created.
 */

describe("createLiveValue — captured early, read late", () => {
  it("gives a consumer captured before the update the updated value", () => {
    const dualMode = createLiveValue(false);
    // Captured at "first render", exactly like the Check-all handler.
    const readAtRunTime = () => dualMode.get();

    dualMode.set(true); // the user ticks the checkbox afterwards

    expect(readAtRunTime()).toBe(true);
  });

  it("a plain closure over the initial value does NOT — this is the bug", () => {
    let dualMode = false;
    const capturedAtMount = () => dualMode;
    const snapshotAtMount = ((value: boolean) => () => value)(dualMode);

    dualMode = true;

    // A closure over the binding does see it…
    expect(capturedAtMount()).toBe(true);
    // …but a value copied into the closure at creation time (which is what a
    // `useCallback` dependency capture is) does not. That copy was the bug.
    expect(snapshotAtMount()).toBe(false);
  });

  it("reflects every subsequent change, not just the first", () => {
    const box = createLiveValue<string | undefined>(undefined);
    const read = () => box.get();
    box.set("class");
    expect(read()).toBe("class");
    box.set(undefined);
    expect(read()).toBeUndefined();
  });
});

describe("a bulk run reads the checkbox per story, at run time (#78)", () => {
  it("passes the ticked value to every story's check", async () => {
    const dualMode = createLiveValue(false);
    const seen: boolean[] = [];
    // The wiring the manager uses: options are resolved inside `check`, which
    // `runBulkCheck` calls once per story.
    const check = vi.fn(async (_storyId: string) => {
      seen.push(dualMode.get());
      return { ok: true };
    });

    // The user ticks Both modes after the panel mounted but before pressing
    // Check all — the exact sequence that produced a single-mode run.
    dualMode.set(true);

    await runBulkCheck({
      storyIds: ["a", "b", "c"],
      warm: async () => ({ ms: 0 }),
      check,
      budgetMs: 1000,
    });

    expect(seen).toEqual([true, true, true]);
  });

  it("picks up a change made mid-run", async () => {
    const dualMode = createLiveValue(true);
    const seen: boolean[] = [];
    const check = async (storyId: string): Promise<{ ok: true }> => {
      seen.push(dualMode.get());
      if (storyId === "a") dualMode.set(false);
      return { ok: true };
    };

    await runBulkCheck({
      storyIds: ["a", "b"],
      warm: async () => ({ ms: 0 }),
      check,
      budgetMs: 1000,
    });

    expect(seen).toEqual([true, false]);
  });
});
