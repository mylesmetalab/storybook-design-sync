import { afterEach, describe, expect, it, vi } from "vitest";
import { createFigmaRestEngine } from "./figma-rest.js";
import type { CheckDriftInput, CodeSnapshot } from "./types.js";

/**
 * Issue #108 — Figma placeholder text read as a specification.
 *
 * `component-handoff` says "real content, no lorem", so a Dialog story reads
 * "Save changes?" / "Discard" / "Save" while the Figma component still
 * carries its placeholder text: "Text Heading" (on a layer named `Text
 * Heading`), "Body text" (layer `Body text`), "Button" (the label inside a
 * `Button` instance whose default state is unconfigured). Every one of those
 * drifted, forever, on a story that followed the project's own rule — same
 * shape as every other applicability bug in this project: technically true,
 * doesn't apply.
 *
 * The heuristic: Figma placeholder text is recognisable because it **equals
 * its own layer name**, or — for an instance whose label wasn't overridden —
 * **equals the instance's own name**. Neither is proof (a real design could
 * coincidentally name a layer after its content), so a match downgrades the
 * row to `advisory` rather than deleting it: real information, not an
 * accusation. A Figma text that is NOT a name-echo is treated as a genuine
 * specification and still drifts against disagreeing code.
 */

const FILE_KEY = "file-key";

function installFetchStub(nodesById: Record<string, unknown>): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const json = (body: unknown): Response =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (url.includes("/variables/local")) {
      return json({ meta: { variableCollections: {}, variables: {} } });
    }
    if (url.includes("/nodes?ids=")) {
      const nodes: Record<string, unknown> = {};
      for (const [id, doc] of Object.entries(nodesById)) nodes[id] = { document: doc };
      return json({ nodes });
    }
    if (url.includes("/components")) return json({ meta: { components: [] } });
    return json({ lastModified: "2026-07-28T00:00:00Z", version: "1" });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function input(nodeId: string, snapshot: CodeSnapshot): CheckDriftInput {
  return {
    storyId: "ui-dialog--default",
    nodeRef: { fileKey: FILE_KEY, nodeId },
    snapshot,
  } as CheckDriftInput;
}

function copyRow(dimensions: ReadonlyArray<{ kind: string; status: string; note?: string }>) {
  const rows = dimensions.filter((d) => d.kind === "copy");
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

describe("copy placeholder heuristic (#108)", () => {
  it("downgrades to advisory when Figma's text equals its own layer name", async () => {
    const ROOT = "192:31517";
    installFetchStub({
      [ROOT]: {
        id: ROOT,
        name: "Dialog Body",
        type: "FRAME",
        strokes: [],
        fills: [],
        children: [
          {
            id: `${ROOT}:t`,
            name: "Text Heading",
            type: "TEXT",
            characters: "Text Heading",
            strokes: [],
            fills: [],
            children: [],
          },
        ],
      },
    });
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const report = await engine.checkDrift(
      input(ROOT, { styles: {}, texts: ["Save changes?"] }),
    );
    const row = copyRow(report.dimensions);
    expect(row.status).toBe("advisory");
    expect(row.note).toMatch(/placeholder/i);
  });

  it("downgrades when the label equals the instance's own name, not just the TEXT layer's", async () => {
    const ROOT = "9762:5083";
    installFetchStub({
      [ROOT]: {
        id: ROOT,
        name: "Button",
        type: "INSTANCE",
        strokes: [],
        fills: [],
        children: [
          {
            id: `${ROOT}:label`,
            name: "Label",
            type: "TEXT",
            characters: "Button",
            strokes: [],
            fills: [],
            children: [],
          },
        ],
      },
    });
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const report = await engine.checkDrift(input(ROOT, { styles: {}, texts: ["Discard"] }));
    const row = copyRow(report.dimensions);
    expect(row.status).toBe("advisory");
  });

  it("still reports drift when Figma's text is a genuine specification the code disagrees with", async () => {
    const ROOT = "37:30";
    installFetchStub({
      [ROOT]: {
        id: ROOT,
        name: "Card",
        type: "FRAME",
        strokes: [],
        fills: [],
        children: [
          {
            id: `${ROOT}:t`,
            name: "Label",
            type: "TEXT",
            characters: "Save",
            strokes: [],
            fills: [],
            children: [],
          },
        ],
      },
    });
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const report = await engine.checkDrift(input(ROOT, { styles: {}, texts: ["Confirm"] }));
    const row = copyRow(report.dimensions);
    expect(row.status).toBe("drift");
    expect(row.note).toBeUndefined();
  });

  it("stays a match when code happens to render the placeholder text verbatim", async () => {
    const ROOT = "192:31517";
    installFetchStub({
      [ROOT]: {
        id: ROOT,
        name: "Dialog Body",
        type: "FRAME",
        strokes: [],
        fills: [],
        children: [
          {
            id: `${ROOT}:t`,
            name: "Text Heading",
            type: "TEXT",
            characters: "Text Heading",
            strokes: [],
            fills: [],
            children: [],
          },
        ],
      },
    });
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const report = await engine.checkDrift(input(ROOT, { styles: {}, texts: ["Text Heading"] }));
    const row = copyRow(report.dimensions);
    expect(row.status).toBe("match");
  });
});
