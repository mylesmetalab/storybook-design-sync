import { describe, expect, it } from "vitest";
import { buildChildTargets, childTargetsForMode } from "./server.js";
import type { ChildSnapshotEntry } from "./channels.js";
import type { CodeSnapshot } from "./engines/types.js";

/**
 * The registry↔preview reconciliation step.
 *
 * `buildChildTargets` is the single place that decides what the engine is asked
 * to compare. It iterates the **registry**, not the preview's reply, and that
 * direction is the whole guarantee: a declaration the preview refused, lost, or
 * never saw still becomes a target carrying its reason, so it reaches the panel
 * as a visible row rather than disappearing into a green report.
 */

const STORY = "ui-card--default";
const REGISTRY = ".design-sync/registry.json";
const HEADER = "2142:11381";
const BODY = "2142:11382";

const snapshot = (paddingTop: string): CodeSnapshot => ({
  styles: { "padding-top": paddingTop },
});

function build(
  declared: Record<string, string> | undefined,
  received?: ChildSnapshotEntry[],
): ReturnType<typeof buildChildTargets> {
  return buildChildTargets({ storyId: STORY, registryPath: REGISTRY, declared, received });
}

describe("buildChildTargets — legacy entries", () => {
  it("produces no targets when the registry declares no children", () => {
    expect(build(undefined)).toEqual([]);
    expect(build({})).toEqual([]);
  });

  it("ignores child snapshots for a story that declares none", () => {
    // Defensive: a stale preview reply must not invent comparisons the registry
    // never asked for.
    const targets = build(undefined, [
      { selector: "[data-slot=header]", nodeId: HEADER, kind: "found", snapshot: snapshot("8px") },
    ]);

    expect(targets).toEqual([]);
  });
});

describe("buildChildTargets — resolved children", () => {
  it("pairs a found snapshot with its declared node id", () => {
    const targets = build({ "[data-slot=header]": HEADER }, [
      { selector: "[data-slot=header]", nodeId: HEADER, kind: "found", snapshot: snapshot("8px") },
    ]);

    expect(targets).toEqual([
      { selector: "[data-slot=header]", nodeId: HEADER, snapshot: snapshot("8px") },
    ]);
  });

  it("keeps registry order, not the order the preview replied in", () => {
    const targets = build(
      { "[data-slot=header]": HEADER, "[data-slot=body]": BODY },
      [
        { selector: "[data-slot=body]", nodeId: BODY, kind: "found", snapshot: snapshot("4px") },
        { selector: "[data-slot=header]", nodeId: HEADER, kind: "found", snapshot: snapshot("8px") },
      ],
    );

    expect(targets.map((t) => t.selector)).toEqual(["[data-slot=header]", "[data-slot=body]"]);
  });

  it("trusts the REGISTRY's node id, not the one echoed back by the preview", () => {
    const targets = build({ "[data-slot=header]": HEADER }, [
      { selector: "[data-slot=header]", nodeId: "tampered", kind: "found", snapshot: snapshot("8px") },
    ]);

    expect(targets[0]!.nodeId).toBe(HEADER);
  });
});

describe("buildChildTargets — every failure mode becomes a visible target", () => {
  it.each([
    [
      "a selector that matched nothing",
      { selector: "[data-slot=header]", nodeId: HEADER, kind: "not-found" as const },
      "selector-not-found",
      "matched no element",
    ],
    [
      "a selector that matched two elements",
      {
        selector: "[data-slot=header]",
        nodeId: HEADER,
        kind: "ambiguous" as const,
        candidates: ["button.a", "button.b"],
      },
      "selector-ambiguous",
      "matched 2 elements",
    ],
    [
      "an invalid selector",
      {
        selector: "[data-slot=",
        nodeId: HEADER,
        kind: "invalid" as const,
        detail: "unterminated attribute selector",
      },
      "selector-invalid",
      "not a valid CSS selector",
    ],
  ])("reports %s", (_label, entry, status, gist) => {
    const targets = build({ [entry.selector]: HEADER }, [entry]);

    expect(targets).toHaveLength(1);
    expect(targets[0]!.snapshot).toBeUndefined();
    expect(targets[0]!.problem?.status).toBe(status);
    expect(targets[0]!.problem?.message).toContain(gist);
    expect(targets[0]!.problem?.message).toContain(STORY);
    expect(targets[0]!.problem?.message).toContain(REGISTRY);
  });

  it("reports a declaration the preview never answered as `snapshot-missing`", () => {
    const targets = build({ "[data-slot=header]": HEADER, "[data-slot=body]": BODY }, [
      { selector: "[data-slot=header]", nodeId: HEADER, kind: "found", snapshot: snapshot("8px") },
    ]);

    expect(targets).toHaveLength(2);
    expect(targets[1]!.problem?.status).toBe("snapshot-missing");
  });

  it("reports every declaration as `snapshot-missing` when no reply arrived at all", () => {
    // What a preview-bundle/server version skew looks like: the request timed
    // out, so the check must say "not compared", not "clean".
    const targets = build({ "[data-slot=header]": HEADER, "[data-slot=body]": BODY }, undefined);

    expect(targets.map((t) => t.problem?.status)).toEqual([
      "snapshot-missing",
      "snapshot-missing",
    ]);
  });

  it("reports a `found` reply that carries no snapshot as `snapshot-missing`", () => {
    const targets = build({ "[data-slot=header]": HEADER }, [
      { selector: "[data-slot=header]", nodeId: HEADER, kind: "found" },
    ]);

    expect(targets[0]!.problem?.status).toBe("snapshot-missing");
  });

  it("surfaces the root-matching hint through to the message", () => {
    const targets = build({ ".card": HEADER }, [
      { selector: ".card", nodeId: HEADER, kind: "not-found", rootMatches: true },
    ]);

    expect(targets[0]!.problem?.message).toContain("root's descendants only");
  });

  it("reports a malformed registry value alongside the well-formed siblings", () => {
    const targets = build(
      { "[data-slot=header]": HEADER, "[data-slot=body]": 7 as unknown as string },
      [{ selector: "[data-slot=header]", nodeId: HEADER, kind: "found", snapshot: snapshot("8px") }],
    );

    expect(targets).toHaveLength(2);
    expect(targets[0]!.snapshot).toBeDefined();
    expect(targets[1]!.problem?.status).toBe("binding-malformed");
    expect(targets[1]!.problem?.message).toContain("[data-slot=body]");
  });

  it("reports a wholly malformed `children` field as one target, not silence", () => {
    const targets = build(["2142:11381"] as unknown as Record<string, string>);

    expect(targets).toHaveLength(1);
    expect(targets[0]!.problem?.status).toBe("binding-malformed");
    expect(targets[0]!.problem?.message).toContain('"children" must be an object');
  });
});

describe("childTargetsForMode — dual-mode runs", () => {
  const received: ChildSnapshotEntry[] = [
    {
      selector: "[data-slot=header]",
      nodeId: HEADER,
      kind: "found",
      snapshot: snapshot("8px"),
      additionalSnapshots: [{ mode: "dark", snapshot: snapshot("12px") }],
    },
  ];

  it("swaps in the snapshot captured in the requested mode", () => {
    const base = build({ "[data-slot=header]": HEADER }, received);
    const dark = childTargetsForMode(base, received, "dark");

    expect(dark[0]!.snapshot).toEqual(snapshot("12px"));
  });

  it("refuses to re-use the first mode's snapshot when the second is missing", () => {
    const base = build({ "[data-slot=header]": HEADER }, received);
    const other = childTargetsForMode(base, received, "high-contrast");

    // Comparing a light-mode measurement against dark-mode Figma values would
    // produce a real number describing the wrong thing.
    expect(other[0]!.snapshot).toBeUndefined();
    expect(other[0]!.problem?.status).toBe("snapshot-missing");
    expect(other[0]!.problem?.message).toContain("high-contrast");
  });

  it("leaves already-failed targets untouched", () => {
    const base = build({ "[data-slot=header]": HEADER }, [
      { selector: "[data-slot=header]", nodeId: HEADER, kind: "not-found" },
    ]);
    const dark = childTargetsForMode(base, received, "dark");

    expect(dark[0]!.problem?.status).toBe("selector-not-found");
  });
});
