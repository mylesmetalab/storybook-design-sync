import { describe, expect, it, vi } from "vitest";

import type { StateSnapshotEntry } from "./channels.js";
import type { ChildTarget, CodeSnapshot } from "./engines/types.js";
import { chooseStateTargets, hasPerModeStates, runModePasses, stateTargetsForMode } from "./server.js";

/**
 * Modes × states (#103).
 *
 * Until v0.0.52 a two-mode run **refused** every declared state: states were
 * forced once, after both mode passes, so there was no measurement to attribute
 * to the second mode. Now the preview forces each state inside each pass.
 *
 * The thing under test is not "does it compare" — it is **the choice**, and the
 * two ways that choice can be wrong:
 *
 *  1. claiming a comparison the preview never made (reusing one mode's snapshot
 *     for both), and
 *  2. dropping a state silently in the second mode, which is what the old refusal
 *     existed to prevent and what `stateTargetsForMode` now has to guarantee.
 *
 * #91's own post-mortem is the reason these are written as choice tests: with the
 * branch inline, a mutation replacing `dualMode` with `false` killed zero tests,
 * because both branches were covered individually and nothing exercised the pick.
 */

const snap = (bg: string): CodeSnapshot => ({ styles: { "background-color": bg } });

/** A state the preview measured in both modes. */
const compared = (state: string, light: string, dark: string): StateSnapshotEntry => ({
  state,
  nodeId: `node-${state}`,
  kind: "compared",
  snapshot: snap(light),
  changed: ["background-color"],
  additionalSnapshots: [{ mode: "dark", snapshot: snap(dark) }],
});

/** A state the preview measured in the first mode only. */
const firstModeOnly = (state: string, light: string): StateSnapshotEntry => ({
  state,
  nodeId: `node-${state}`,
  kind: "compared",
  snapshot: snap(light),
  changed: ["background-color"],
});

describe("hasPerModeStates — the condition the choice turns on", () => {
  it("is false for an empty or absent list", () => {
    expect(hasPerModeStates(undefined)).toBe(false);
    expect(hasPerModeStates([])).toBe(false);
  });

  it("is false when states were measured but only in one mode", () => {
    expect(hasPerModeStates([firstModeOnly("hover", "red")])).toBe(false);
  });

  /**
   * Deliberately "at least one", not "all". A state that could not be forced in
   * the second mode is a per-state refusal produced downstream; refusing the whole
   * story for it would discard the states that *were* measured in both modes.
   */
  it("is true when at least one state carries a second mode", () => {
    expect(hasPerModeStates([firstModeOnly("active", "red"), compared("hover", "a", "b")])).toBe(
      true,
    );
  });

  it("is false for an entry whose additionalSnapshots is present but empty", () => {
    // The shape a future preview bug could produce. An empty array is not a
    // measurement, and treating it as one is the false-pass this guards.
    expect(hasPerModeStates([{ ...firstModeOnly("hover", "red"), additionalSnapshots: [] }])).toBe(
      false,
    );
  });
});

describe("chooseStateTargets — dual mode now compares, but only on evidence", () => {
  const base = {
    storyId: "ui-button--primary",
    registryPath: ".design-sync/registry.json",
    declared: { hover: "4185:3783" },
  };

  it("compares when the preview forced the state in each mode", () => {
    const [target] = chooseStateTargets({
      ...base,
      dualMode: true,
      received: [compared("hover", "rgb(1,1,1)", "rgb(2,2,2)")],
    });
    expect(target!.kind).toBe("state");
    expect(target!.snapshot).toEqual(snap("rgb(1,1,1)"));
    expect(target!.problem).toBeUndefined();
  });

  /**
   * The regression that matters most. If this ever starts comparing, the tool is
   * attributing a measurement taken in one mode to the other — the exact
   * comparison-that-did-not-happen the pre-v0.0.52 refusal was written to prevent.
   */
  it("still refuses when the preview only measured one mode", () => {
    const [target] = chooseStateTargets({
      ...base,
      dualMode: true,
      received: [firstModeOnly("hover", "rgb(1,1,1)")],
    });
    expect(target!.snapshot).toBeUndefined();
    expect(target!.problem!.message).toMatch(/NOT compared/);
    expect(target!.problem!.message).toMatch(/two modes/);
  });

  it("still refuses when the preview sent no states at all", () => {
    const [target] = chooseStateTargets({ ...base, dualMode: true, received: undefined });
    expect(target!.snapshot).toBeUndefined();
    expect(target!.problem!.message).toMatch(/NOT compared/);
  });

  it("is unaffected in a single-mode run", () => {
    const [target] = chooseStateTargets({
      ...base,
      dualMode: false,
      received: [firstModeOnly("hover", "rgb(1,1,1)")],
    });
    expect(target!.snapshot).toEqual(snap("rgb(1,1,1)"));
  });
});

describe("stateTargetsForMode — no silent drop in the second mode", () => {
  const targets: ChildTarget[] = [
    { selector: ":hover", kind: "state", nodeId: "n1", snapshot: snap("light-hover") },
    { selector: ":active", kind: "state", nodeId: "n2", snapshot: snap("light-active") },
  ];

  it("swaps in the requested mode's snapshot", () => {
    const out = stateTargetsForMode(
      targets,
      [compared("hover", "light-hover", "dark-hover"), compared("active", "light-active", "dark-active")],
      "dark",
    );
    expect(out.map((t) => t.snapshot)).toEqual([snap("dark-hover"), snap("dark-active")]);
    expect(out.every((t) => t.problem === undefined)).toBe(true);
  });

  /**
   * The whole point. Before this function existed, state targets went through
   * `childTargetsForMode`, which keys by CSS selector and finds nothing for
   * `:hover` — so the target came back with no snapshot and, worse, the row
   * vanished rather than saying so.
   */
  it("refuses per state, naming the mode, when that mode has no measurement", () => {
    const out = stateTargetsForMode(targets, [compared("hover", "l", "d")], "dark");
    expect(out[0]!.snapshot).toEqual(snap("d"));
    expect(out[1]!.snapshot).toBeUndefined();
    const message = out[1]!.problem!.message;
    expect(message).toMatch(/:active was NOT compared in mode "dark"/);
    // A reader must not conclude the light-mode result is void too.
    expect(message).toMatch(/other mode's result for :active is still reported/);
  });

  it("returns the same number of targets it was given, always", () => {
    // A dropped row is the failure class; count is the cheapest guard on it.
    for (const received of [undefined, [], [compared("hover", "l", "d")]]) {
      expect(stateTargetsForMode(targets, received, "dark")).toHaveLength(targets.length);
    }
  });

  it("leaves a target that already carries a refusal untouched", () => {
    const refused: ChildTarget[] = [
      {
        selector: ":focus",
        kind: "state",
        nodeId: "n3",
        problem: { status: "snapshot-missing", message: "forcing moved nothing" },
      },
    ];
    expect(stateTargetsForMode(refused, [], "dark")).toEqual(refused);
  });

  it("does not touch child targets that happen to be in the list", () => {
    const child: ChildTarget[] = [
      { selector: ".btn-label", kind: "child", nodeId: "n4", snapshot: snap("x") },
    ];
    expect(stateTargetsForMode(child, [], "dark")).toEqual(child);
  });
});

describe("runModePasses — states are remapped by state, children by selector", () => {
  it("sends each pass its own mode's state snapshot", async () => {
    const seen: Array<{ mode: string | undefined; children: ChildTarget[] | undefined }> = [];
    const engine = {
      checkDrift: vi.fn(async (input: { mode?: string; children?: ChildTarget[] }) => {
        seen.push({ mode: input.mode, children: input.children });
        return { storyId: "s", nodeId: "n", generatedAt: "", dimensions: [] };
      }),
    };

    const stateTargets: ChildTarget[] = [
      { selector: ":hover", kind: "state", nodeId: "n1", snapshot: snap("light-hover") },
    ];

    await runModePasses({
      engine: engine as never,
      baseInput: { snapshot: snap("light"), children: stateTargets } as never,
      mode: "light",
      additionalSnapshots: [{ mode: "dark", snapshot: snap("dark") }],
      childTargets: [],
      childSnapshots: undefined,
      stateTargets,
      stateSnapshots: [compared("hover", "light-hover", "dark-hover")],
    });

    expect(seen).toHaveLength(2);
    // Pass 1 keeps what the caller built; pass 2 must carry dark's measurement.
    expect(seen[0]!.children![0]!.snapshot).toEqual(snap("light-hover"));
    expect(seen[1]!.mode).toBe("dark");
    expect(seen[1]!.children![0]!.snapshot).toEqual(snap("dark-hover"));
  });

  /**
   * Ordering is load-bearing: `mergeReports` pairs rows across modes, and the
   * second pass rebuilds `children` from scratch. Children then states, matching
   * how the primary pass concatenates them.
   */
  it("keeps children before states in the rebuilt list", async () => {
    let secondPass: ChildTarget[] | undefined;
    let call = 0;
    const engine = {
      checkDrift: vi.fn(async (input: { children?: ChildTarget[] }) => {
        if (++call === 2) secondPass = input.children;
        return { storyId: "s", nodeId: "n", generatedAt: "", dimensions: [] };
      }),
    };
    const childTargets: ChildTarget[] = [
      { selector: ".btn-label", kind: "child", nodeId: "c1", snapshot: snap("l") },
    ];
    const stateTargets: ChildTarget[] = [
      { selector: ":hover", kind: "state", nodeId: "n1", snapshot: snap("lh") },
    ];

    await runModePasses({
      engine: engine as never,
      baseInput: { snapshot: snap("light") } as never,
      mode: "light",
      additionalSnapshots: [{ mode: "dark", snapshot: snap("dark") }],
      childTargets,
      childSnapshots: [
        {
          selector: ".btn-label",
          kind: "found",
          snapshot: snap("l"),
          additionalSnapshots: [{ mode: "dark", snapshot: snap("d") }],
        } as never,
      ],
      stateTargets,
      stateSnapshots: [compared("hover", "lh", "dh")],
    });

    expect(secondPass!.map((t) => t.selector)).toEqual([".btn-label", ":hover"]);
  });

  it("runs one pass and remaps nothing when only one mode was captured", async () => {
    const engine = {
      checkDrift: vi.fn(async () => ({
        storyId: "s",
        nodeId: "n",
        generatedAt: "",
        dimensions: [],
      })),
    };
    await runModePasses({
      engine: engine as never,
      baseInput: { snapshot: snap("light") } as never,
      mode: "light",
      additionalSnapshots: undefined,
      childTargets: [],
      childSnapshots: undefined,
      stateTargets: [{ selector: ":hover", kind: "state", nodeId: "n1", snapshot: snap("lh") }],
      stateSnapshots: [compared("hover", "lh", "dh")],
    });
    expect(engine.checkDrift).toHaveBeenCalledTimes(1);
  });
});
