import { describe, expect, it } from "vitest";

import {
  annotateStateClassHints,
  buildStateTargets,
  chooseStateTargets,
  refusedStateTargets,
} from "./server.js";
import type { StateSnapshotEntry } from "./channels.js";

/**
 * The registry is authoritative here, exactly as it is for child bindings: every
 * declaration produces a target even when the preview reported nothing, so a
 * state that was never measured cannot turn into silence.
 *
 * These tests are almost entirely about the non-comparable outcomes. A real
 * comparison fails visibly; a state quietly missing from the report does not.
 */

const OPTS = { storyId: "ui-button--primary", registryPath: ".design-sync/registry.json" };

function compared(state: string): StateSnapshotEntry {
  return {
    state,
    nodeId: "4185:3783",
    kind: "compared",
    snapshot: { styles: { "background-color": "rgb(30, 30, 30)" } },
    changed: ["background-color"],
  };
}

describe("buildStateTargets", () => {
  it("produces nothing for a story with no state bindings", () => {
    expect(buildStateTargets({ ...OPTS, declared: undefined, received: undefined })).toEqual([]);
  });

  it("passes a compared state through as a comparable target", () => {
    const targets = buildStateTargets({
      ...OPTS,
      declared: { hover: "4185:3783" },
      received: [compared("hover")],
    });
    expect(targets).toEqual([
      {
        selector: ":hover",
        kind: "state",
        nodeId: "4185:3783",
        snapshot: { styles: { "background-color": "rgb(30, 30, 30)" } },
      },
    ]);
  });

  it("marks every target as kind: state, so a forced state is never shown as an element", () => {
    const targets = buildStateTargets({
      ...OPTS,
      declared: { hover: "1:1", active: "2:2" },
      received: [compared("hover")],
    });
    expect(targets.every((t) => t.kind === "state")).toBe(true);
  });

  /**
   * The headline case. Forcing that moves nothing means either the state is
   * genuinely identical or the forcing failed — indistinguishable from here, so
   * it must not be reported as a match.
   */
  it("refuses to compare a state whose forcing changed nothing, and explains both causes", () => {
    const targets = buildStateTargets({
      ...OPTS,
      declared: { hover: "4185:3783" },
      received: [{ state: "hover", nodeId: "4185:3783", kind: "no-computed-change" }],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.snapshot).toBeUndefined();
    const message = targets[0]!.problem!.message;
    expect(message).toMatch(/NOT compared/);
    // Both explanations have to be offered, or a reader assumes the wrong one.
    expect(message).toMatch(/visually identical/);
    expect(message).toMatch(/forcing did not take/);
    // And it should point at the one cause the reader can actually check.
    expect(message).toMatch(/cross-origin/);
  });

  it("passes a not-forceable reason straight through", () => {
    const targets = buildStateTargets({
      ...OPTS,
      declared: { disabled: "4185:3787" },
      received: [
        {
          state: "disabled",
          nodeId: "4185:3787",
          kind: "not-forceable",
          detail: "the library writes data-disabled from its own state.",
        },
      ],
    });
    expect(targets[0]!.problem!.message).toContain("the library writes data-disabled");
    expect(targets[0]!.snapshot).toBeUndefined();
  });

  it("reports a declaration the preview never answered", () => {
    // The registry knows about it, so it must appear. A dropped entry here is the
    // silence the feature exists to prevent.
    const targets = buildStateTargets({
      ...OPTS,
      declared: { hover: "4185:3783" },
      received: [],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.problem!.message).toMatch(/No measurement arrived/);
    expect(targets[0]!.problem!.message).toContain(".design-sync/registry.json");
  });

  it("keeps the declared node id on a refusal, so the report can still name the node", () => {
    const targets = buildStateTargets({
      ...OPTS,
      declared: { hover: "4185:3783" },
      received: [{ state: "hover", nodeId: "4185:3783", kind: "no-computed-change" }],
    });
    expect(targets[0]!.nodeId).toBe("4185:3783");
  });

  it("reports a malformed declaration rather than dropping it", () => {
    const targets = buildStateTargets({
      ...OPTS,
      // `error` is a prop, not a pseudo-state — rejected by the vocabulary.
      declared: { error: "1:1" },
      received: [],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.problem!.status).toBe("binding-malformed");
    expect(targets[0]!.problem!.message).toMatch(/not a pseudo-state/);
  });

  it("reports a fatally-shaped `states` field once, and compares nothing", () => {
    const targets = buildStateTargets({
      ...OPTS,
      declared: ["hover"] as unknown as Record<string, string>,
      received: [],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.selector).toBe("states");
    expect(targets[0]!.problem!.message).toMatch(/malformed/);
    expect(targets[0]!.problem!.message).toMatch(/No state comparison ran/);
  });

  it("emits targets in vocabulary order regardless of registry key order", () => {
    const targets = buildStateTargets({
      ...OPTS,
      declared: { disabled: "3:3", active: "2:2", hover: "1:1" },
      received: [],
    });
    expect(targets.map((t) => t.selector)).toEqual([":hover", ":active", ":disabled"]);
  });

  it("keeps good and bad declarations side by side", () => {
    const targets = buildStateTargets({
      ...OPTS,
      declared: { hover: "4185:3783", error: "1:1" },
      received: [compared("hover")],
    });
    expect(targets).toHaveLength(2);
    expect(targets.find((t) => t.selector === ":hover")!.snapshot).toBeDefined();
    expect(targets.find((t) => t.selector === ":error")!.problem).toBeDefined();
  });
});

/**
 * Dual mode + states. Found by a mutation probe: replacing the `dualMode`
 * branch with `false` — i.e. claiming a state comparison that never happened —
 * killed **zero** tests. The refusal was written carefully and then left
 * unguarded, which is the same shape as the bug it exists to prevent.
 */
describe("refusedStateTargets", () => {
  it("refuses every declared state, rather than dropping them", () => {
    // The silent-drop this replaces: the dual-mode pass rebuilds `children`
    // through `childTargetsForMode`, which knows only about child selectors, so
    // state targets vanished with no row and no message.
    const targets = refusedStateTargets(
      { hover: "4185:3783", active: "4185:3790" },
      ".design-sync/registry.json",
      "ui-button--primary",
    );
    expect(targets.map((t) => t.selector)).toEqual([":hover", ":active"]);
    expect(targets.every((t) => t.kind === "state")).toBe(true);
    expect(targets.every((t) => t.snapshot === undefined)).toBe(true);
  });

  it("says why, and what to do instead", () => {
    const [target] = refusedStateTargets(
      { hover: "4185:3783" },
      ".design-sync/registry.json",
      "ui-button--primary",
    );
    const message = target!.problem!.message;
    expect(message).toMatch(/NOT compared/);
    expect(message).toMatch(/two modes/);
    // The actionable half: a designer who ticked Both modes needs to know the
    // states were skipped *and* how to get them.
    expect(message).toMatch(/Both modes.*unticked/);
    expect(message).toContain("ui-button--primary");
  });

  it("keeps the declared node id, so the row can still name the node", () => {
    const [target] = refusedStateTargets({ hover: "4185:3783" }, "r.json", "s");
    expect(target!.nodeId).toBe("4185:3783");
  });

  it("returns nothing for a story with no state bindings", () => {
    expect(refusedStateTargets(undefined, "r.json", "s")).toEqual([]);
  });

  it("ignores a malformed declaration rather than refusing a state that is not real", () => {
    // `error` is not a pseudo-state, so there is no state comparison to refuse.
    // `buildStateTargets` reports it as malformed on the single-mode path; a
    // dual-mode run must not invent a second, contradictory message for it.
    expect(refusedStateTargets({ error: "1:1" }, "r.json", "s")).toEqual([]);
  });
});

/**
 * The decision, not just the two outcomes.
 *
 * This exists because of a specific mutation-probe result: with the `dualMode ?`
 * branch inline in the CodeSnapshot handler, flipping it to `false` — claiming a
 * state comparison that never happened — killed **zero** tests. Both branches
 * were covered individually; nothing covered the choice between them.
 */
describe("chooseStateTargets", () => {
  const BASE = {
    storyId: "ui-button--primary",
    registryPath: ".design-sync/registry.json",
    declared: { hover: "4185:3783" },
    received: [compared("hover")],
  };

  it("compares the state on a single-mode run", () => {
    const [target] = chooseStateTargets({ ...BASE, dualMode: false });
    expect(target!.snapshot).toBeDefined();
    expect(target!.problem).toBeUndefined();
  });

  it("refuses instead of comparing on a dual-mode run", () => {
    // Even though a perfectly good snapshot is available: it was measured in one
    // mode, and a two-mode report has nowhere honest to put it.
    const [target] = chooseStateTargets({ ...BASE, dualMode: true });
    expect(target!.snapshot).toBeUndefined();
    expect(target!.problem!.message).toMatch(/two modes/);
  });

  it("never reports a state as compared when two modes were requested", () => {
    // The invariant, stated so it cannot be lost to a refactor of the branch.
    const targets = chooseStateTargets({
      ...BASE,
      declared: { hover: "1:1", active: "2:2", disabled: "3:3" },
      dualMode: true,
    });
    expect(targets).toHaveLength(3);
    expect(targets.some((t) => t.snapshot !== undefined)).toBe(false);
  });
});

/**
 * State class hints. Probed: leaking them onto resting rows killed **zero**
 * tests, and that leak is a specific wrong instruction — "edit
 * `hover:bg-primary-hover`" to fix the *default* background.
 */
describe("annotateStateClassHints", () => {
  const dim = (over: Record<string, unknown>) =>
    ({
      kind: "token-value",
      property: "background-color",
      codeValue: "x",
      figmaValue: "y",
      status: "drift",
      ...over,
    }) as never;

  function report(dimensions: unknown[]) {
    return {
      storyId: "ui-button--primary",
      nodeId: "1:2",
      generatedAt: "2026-08-03T00:00:00.000Z",
      dimensions,
    } as never;
  }

  it("pins the state's class onto the state's row", () => {
    const r = report([dim({ forcedState: "hover", childSelector: ":hover" })]);
    annotateStateClassHints(r, { hover: { "background-color": "hover:bg-primary-hover" } });
    expect((r as { dimensions: Array<{ codeClassName?: string }> }).dimensions[0]!.codeClassName).toBe(
      "hover:bg-primary-hover",
    );
  });

  it("never pins a state's class onto the resting row", () => {
    // A root row and its forced counterpart share `property`, so a map keyed by
    // property alone would tell someone to edit the hover class to fix the base.
    const r = report([dim({})]);
    annotateStateClassHints(r, { hover: { "background-color": "hover:bg-primary-hover" } });
    expect((r as { dimensions: Array<{ codeClassName?: string }> }).dimensions[0]!.codeClassName).toBeUndefined();
  });

  it("does not cross states", () => {
    const r = report([dim({ forcedState: "active", childSelector: ":active" })]);
    annotateStateClassHints(r, { hover: { "background-color": "hover:bg-primary-hover" } });
    expect((r as { dimensions: Array<{ codeClassName?: string }> }).dimensions[0]!.codeClassName).toBeUndefined();
  });

  it("is a no-op with no state classes", () => {
    const r = report([dim({ forcedState: "hover", childSelector: ":hover" })]);
    annotateStateClassHints(r, {});
    expect((r as { dimensions: Array<{ codeClassName?: string }> }).dimensions[0]!.codeClassName).toBeUndefined();
  });
});
