import { describe, expect, it } from "vitest";

import { buildStateTargets } from "./server.js";
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
