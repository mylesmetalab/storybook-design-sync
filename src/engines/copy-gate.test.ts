import { afterEach, describe, expect, it, vi } from "vitest";
import { createFigmaRestEngine } from "./figma-rest.js";
import type { CheckDriftInput, ChildTarget, CodeSnapshot } from "./types.js";

/**
 * Issue #63 — the `copy` dimension is only meaningful when the design intends the
 * literal string, and Figma has no way to say whether it does.
 *
 * On the SDS Card, comparing story copy against Figma's placeholders produced **16
 * of 20** remaining rows, on every card story, permanently: the `component-handoff`
 * skill mandates realistic story content while the design holds lorem, so the tool
 * was comparing a deliberate code decision against a deliberate design placeholder
 * and calling the difference a defect. Same shape as the other applicability bugs —
 * technically true, doesn't apply.
 *
 * Since neither side can be inferred (lorem detection is a heuristic that misfires
 * on real copy, and a button Figma labels `Save` genuinely should say Save), the
 * consumer declares it. Two switches, and the important property of both is that
 * "off" means **no rows** — not rows with their verdict withheld, which is the empty
 * row v0.0.29 removed.
 */

const FILE_KEY = "file-key";
const NODE_ID = "37:30";
const CHILD_NODE = "37:31";

function textNode(id: string, characters: string) {
  return {
    id,
    name: "Label",
    type: "TEXT",
    characters,
    strokes: [],
    fills: [],
    children: [],
  };
}

function node(id: string, characters: string) {
  return {
    id,
    name: "Card",
    type: "FRAME",
    strokes: [],
    fills: [],
    children: [textNode(`${id}:t`, characters)],
  };
}

function installFetchStub(): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const json = (body: unknown): Response =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (url.includes("/variables/local")) {
      return json({ meta: { variableCollections: {}, variables: {} } });
    }
    if (url.includes("/nodes?ids=")) {
      return json({
        nodes: {
          [NODE_ID]: { document: node(NODE_ID, "Button") },
          [CHILD_NODE]: { document: node(CHILD_NODE, "Title") },
        },
      });
    }
    if (url.includes("/components")) return json({ meta: { components: [] } });
    return json({ lastModified: "2026-07-28T00:00:00Z", version: "1" });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A story deliberately rendering product copy against a Figma placeholder. */
const snapshot: CodeSnapshot = { styles: {}, texts: ["Cancel"] };

function input(over: Partial<CheckDriftInput> = {}): CheckDriftInput {
  return {
    storyId: "ui-card--horizontal",
    nodeRef: { fileKey: FILE_KEY, nodeId: NODE_ID },
    snapshot,
    ...over,
  } as CheckDriftInput;
}

describe("the copy dimension can be declared inapplicable", () => {
  it("compares by default, exactly as before", async () => {
    installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const report = await engine.checkDrift(input());
    const copy = report.dimensions.filter((d) => d.kind === "copy");
    expect(copy).toHaveLength(1);
    expect(copy[0]!.status).toBe("drift");
  });

  it("emits NO copy rows when the check says not to compare", async () => {
    installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const report = await engine.checkDrift(input({ compareCopy: false }));
    expect(report.dimensions.filter((d) => d.kind === "copy")).toHaveLength(0);
  });

  it("suppresses no other dimension along with it", async () => {
    installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const on = await engine.checkDrift(input());
    const off = await engine.checkDrift(input({ compareCopy: false }));
    const nonCopy = (kinds: typeof on.dimensions) =>
      kinds.filter((d) => d.kind !== "copy").map((d) => `${d.kind}|${d.property}`);
    expect(nonCopy(off.dimensions)).toEqual(nonCopy(on.dimensions));
  });

  it("gates a declared CHILD's copy rows too", async () => {
    installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const children: ChildTarget[] = [
      {
        selector: "[data-slot=title]",
        nodeId: CHILD_NODE,
        snapshot: { styles: {}, texts: ["Deploy to production"] },
      },
    ];
    const on = await engine.checkDrift(input({ children }));
    expect(on.dimensions.some((d) => d.kind === "copy" && d.childSelector)).toBe(true);

    const off = await engine.checkDrift(input({ children, compareCopy: false }));
    expect(off.dimensions.some((d) => d.kind === "copy")).toBe(false);
    // The child was still compared — turning copy off must not silently drop the
    // element from the report.
    expect(off.children?.[0]?.status).toBe("compared");
  });

  it("keys the persistent cache on the setting, so toggling it takes effect", async () => {
    installFetchStub();
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "design-sync-copy-"));
    try {
      const engine = createFigmaRestEngine({
        figmaPat: "test-pat",
        cachePath: join(dir, "cache.json"),
      });
      // Bulk is the trigger that reads the cache. Without the setting in the cache
      // identity, the second call would replay the first report — copy rows and all
      // — and `"copy": "off"` would appear not to work until Figma moved.
      const on = await engine.checkDrift(input({ trigger: "bulk" }));
      expect(on.dimensions.some((d) => d.kind === "copy")).toBe(true);
      const off = await engine.checkDrift(input({ trigger: "bulk", compareCopy: false }));
      expect(off.dimensions.some((d) => d.kind === "copy")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
