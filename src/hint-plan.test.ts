import { describe, expect, it } from "vitest";

import { applyHintPlan, isPendingEntry, planHintRegistration } from "./hint-plan.js";
import type { RegistryEntry } from "./registry.js";

/**
 * The bug (#97) was a **silent** no-op that exited 0, so these tests weight the
 * two things that make it non-silent: a hint upgrades a pending stub, and a hint
 * that is discarded is still reported.
 */

const stories = [{ id: "ui-button--primary" }, { id: "ui-button--neutral" }];
const bound = (nodeId: string): RegistryEntry => ({ nodeId, lastSyncedHash: null });
const pending = (): RegistryEntry => ({ nodeId: null, lastSyncedHash: null, status: "pending" });

describe("planHintRegistration", () => {
  it("adds a hinted story that has no entry", () => {
    const plan = planHintRegistration([{ id: "a" }], { a: "1:1" }, {});
    expect(plan.actions).toEqual([{ kind: "add", storyId: "a", nodeId: "1:1" }]);
  });

  it("stubs an unhinted story that has no entry", () => {
    const plan = planHintRegistration([{ id: "a" }], {}, {});
    expect(plan.actions).toEqual([{ kind: "stub", storyId: "a" }]);
  });

  /**
   * The headline fix. Running `register` before writing hints.json used to make
   * the hints permanently unusable, because the pending stub it created then
   * shadowed them — silently, and with exit 0.
   */
  it("upgrades a pending stub when a hint arrives", () => {
    const plan = planHintRegistration([{ id: "a" }], { a: "1:1" }, { a: pending() });
    expect(plan.actions[0]).toMatchObject({ kind: "upgrade", storyId: "a", nodeId: "1:1" });
  });

  it("treats an entry with a null nodeId as pending even without the status field", () => {
    // Both spellings exist in the wild; keying only off `status` would miss one.
    const plan = planHintRegistration(
      [{ id: "a" }],
      { a: "1:1" },
      { a: { nodeId: null, lastSyncedHash: null } },
    );
    expect(plan.actions[0]!.kind).toBe("upgrade");
  });

  /**
   * "register only adds" still protects a deliberate binding from a stale hints
   * file — but the discarded hint has to be visible, which is the half that was
   * missing.
   */
  it("reports a conflict rather than overwriting a real binding", () => {
    const plan = planHintRegistration([{ id: "a" }], { a: "9:9" }, { a: bound("1:1") });
    expect(plan.actions[0]).toEqual({
      kind: "conflict",
      storyId: "a",
      nodeId: "9:9",
      boundTo: "1:1",
    });
  });

  it("says nothing when the hint agrees with the existing binding", () => {
    const plan = planHintRegistration([{ id: "a" }], { a: "1:1" }, { a: bound("1:1") });
    expect(plan.actions[0]!.kind).toBe("unchanged");
  });

  it("leaves a bound story with no hint alone", () => {
    const plan = planHintRegistration([{ id: "a" }], {}, { a: bound("1:1") });
    expect(plan.actions[0]!.kind).toBe("unchanged");
  });

  it("ignores a hint that is not a non-empty string", () => {
    for (const bad of [42, null, "", "   ", {}, []]) {
      const plan = planHintRegistration([{ id: "a" }], { a: bad }, {});
      expect(plan.actions[0]!.kind).toBe("stub");
    }
  });

  it("trims a hint's whitespace", () => {
    const plan = planHintRegistration([{ id: "a" }], { a: "  1:1  " }, {});
    expect(plan.actions[0]).toEqual({ kind: "add", storyId: "a", nodeId: "1:1" });
  });

  it("counts each kind, so the summary cannot disagree with the actions", () => {
    const plan = planHintRegistration(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      { a: "1:1", b: "2:2", c: "9:9" },
      { b: pending(), c: bound("3:3"), d: bound("4:4") },
    );
    expect(plan.counts).toEqual({ add: 1, stub: 0, upgrade: 1, conflict: 1, unchanged: 1 });
    expect(plan.actions).toHaveLength(4);
  });

  it("plans nothing for a story not on disk, even if the registry knows it", () => {
    // `audit` owns the extra-entry report; `register` only walks discovered stories.
    const plan = planHintRegistration([], { z: "1:1" }, { z: pending() });
    expect(plan.actions).toEqual([]);
  });
});

describe("applyHintPlan", () => {
  it("writes an added binding", () => {
    const plan = planHintRegistration([{ id: "a" }], { a: "1:1" }, {});
    expect(applyHintPlan(plan, {})).toEqual({ a: { nodeId: "1:1", lastSyncedHash: null } });
  });

  /**
   * `status` must go, not merely be joined by a nodeId: `isPending` keys off it, so
   * a bound-but-still-`pending` entry would be skipped by every consumer that asks
   * "is this registered" — including the drift check and `ls`.
   */
  it("drops the pending status on upgrade rather than leaving it beside a nodeId", () => {
    const plan = planHintRegistration([{ id: "a" }], { a: "1:1" }, { a: pending() });
    const out = applyHintPlan(plan, { a: pending() });
    expect(out["a"]).toEqual({ nodeId: "1:1", lastSyncedHash: null });
    expect("status" in out["a"]!).toBe(false);
    expect(isPendingEntry(out["a"]!)).toBe(false);
  });

  it("preserves other fields on upgrade", () => {
    const withChildren: RegistryEntry = {
      nodeId: null,
      lastSyncedHash: "abc",
      status: "pending",
      children: { "[data-slot=title]": "5:5" },
    };
    const plan = planHintRegistration([{ id: "a" }], { a: "1:1" }, { a: withChildren });
    const out = applyHintPlan(plan, { a: withChildren });
    expect(out["a"]!.children).toEqual({ "[data-slot=title]": "5:5" });
    expect(out["a"]!.lastSyncedHash).toBe("abc");
  });

  it("writes nothing for a conflict — the real binding survives", () => {
    const existing = { a: bound("1:1") };
    const plan = planHintRegistration([{ id: "a" }], { a: "9:9" }, existing);
    expect(applyHintPlan(plan, existing)).toEqual({ a: bound("1:1") });
  });

  it("does not mutate the input registry", () => {
    const existing = { a: pending() };
    const plan = planHintRegistration([{ id: "a" }], { a: "1:1" }, existing);
    applyHintPlan(plan, existing);
    expect(existing["a"]).toEqual(pending());
  });

  it("leaves entries the plan never mentions untouched", () => {
    const existing = { a: pending(), untouched: bound("7:7") };
    const plan = planHintRegistration([{ id: "a" }], { a: "1:1" }, existing);
    expect(applyHintPlan(plan, existing)["untouched"]).toEqual(bound("7:7"));
  });

  it("round-trips the reproduction from #97", () => {
    // 1. `register` with no hints file → pending stub.
    const first = applyHintPlan(planHintRegistration(stories, {}, {}), {});
    expect(Object.values(first).every(isPendingEntry)).toBe(true);
    // 2. write hints, run again → both bind. Previously: "0 registered", exit 0.
    const hints = { "ui-button--primary": "4185:3779", "ui-button--neutral": "4185:3791" };
    const second = planHintRegistration(stories, hints, first);
    expect(second.counts.upgrade).toBe(2);
    const final = applyHintPlan(second, first);
    expect(final["ui-button--primary"]!.nodeId).toBe("4185:3779");
    expect(Object.values(final).some(isPendingEntry)).toBe(false);
  });
});
