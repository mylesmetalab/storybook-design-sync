import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFigmaRestEngine } from "./figma-rest.js";
import type { CheckDriftInput, CodeSnapshot } from "./types.js";

/**
 * Issue #76 — a report says WHEN its Figma values were read, and a cache hit says
 * when the **cached** read happened.
 *
 * The live failure: starter PR #5 applied a fix prompt faithfully, verified the
 * computed style, re-ran a check, got `match`, and opened a well-reasoned PR. Figma
 * was then reverted, the PR sat open, and merging it would have *introduced* the
 * drift it existed to remove. Nothing in the loop was wrong except that the artefact
 * carried no notion of when it was true.
 *
 * The trap these tests exist for is the second one: a report replayed out of
 * `.design-sync/cache.json` must report the **cache's** read time. Restamping it as
 * `now` on the way out turns a two-day-old reading into a confident statement about
 * the present, which is worse than having no timestamp at all.
 */

const FILE_KEY = "file-key";
const NODE_ID = "37:30";
const LAST_MODIFIED = "2026-07-28T00:00:00Z";
const FILE_VERSION = "4412998877";

function node() {
  return {
    id: NODE_ID,
    name: "Card",
    type: "FRAME",
    strokes: [],
    fills: [],
    children: [],
    paddingTop: 16,
  };
}

function installFetchStub(): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    const json = (body: unknown): Response =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (url.includes("/variables/local")) return json({ meta: { variableCollections: {}, variables: {} } });
    if (url.includes("/nodes?ids=")) return json({ nodes: { [NODE_ID]: { document: node() } } });
    if (url.includes("/components")) return json({ meta: { components: [] } });
    return json({ lastModified: LAST_MODIFIED, version: FILE_VERSION });
  });
  return { urls };
}

const snapshot: CodeSnapshot = { styles: { "padding-top": "16px" } };

function input(over: Partial<CheckDriftInput> = {}): CheckDriftInput {
  return {
    storyId: "ui-card--default",
    nodeRef: { fileKey: FILE_KEY, nodeId: NODE_ID },
    snapshot,
    ...over,
  } as CheckDriftInput;
}

const dirs: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("a report carries the provenance of its Figma read", () => {
  it("stamps the read time, the file's lastModified and its version", async () => {
    installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const report = await engine.checkDrift(input());

    expect(report.source).toBeDefined();
    expect(Date.parse(report.source!.readAt)).not.toBeNaN();
    expect(report.source!.fileLastModified).toBe(LAST_MODIFIED);
    expect(report.source!.fileVersion).toBe(FILE_VERSION);
    expect(report.source!.fromCache).toBeUndefined();
  });

  it("records no version rather than inventing one when Figma sends none", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      const json = (body: unknown): Response =>
        ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (url.includes("/variables/local")) return json({ meta: { variableCollections: {}, variables: {} } });
      if (url.includes("/nodes?ids=")) return json({ nodes: { [NODE_ID]: { document: node() } } });
      if (url.includes("/components")) return json({ meta: { components: [] } });
      return json({ lastModified: LAST_MODIFIED });
    });
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const report = await engine.checkDrift(input());
    expect(report.source!.fileVersion).toBeUndefined();
  });

  /**
   * The trap, spelled out. `Date.now` is moved forward two days between the two
   * bulk checks; the second is served from the persistent cache and must still
   * report the FIRST read's time.
   */
  it("a cache hit reports the cache's read time, not now", async () => {
    installFetchStub();
    const dir = await mkdtemp(join(tmpdir(), "design-sync-provenance-"));
    dirs.push(dir);
    const engine = createFigmaRestEngine({
      figmaPat: "test-pat",
      cachePath: join(dir, "cache.json"),
    });

    const real = Date.now();
    const firstAt = Date.parse("2026-07-28T11:00:00.000Z");
    const secondAt = Date.parse("2026-07-30T09:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(firstAt);

    // `trigger: "bulk"` is the path that READS the persistent cache; an explicit
    // check deliberately bypasses it (a click is a request for the truth).
    const first = await engine.checkDrift(input({ trigger: "bulk" }));
    expect(first.source!.readAt).toBe("2026-07-28T11:00:00.000Z");
    expect(first.source!.fromCache).toBeUndefined();

    clock.mockReturnValue(secondAt);
    const second = await engine.checkDrift(input({ trigger: "bulk" }));

    // Served from cache…
    expect(second.timing?.cacheHits).toBe(1);
    expect(second.source!.fromCache).toBe(true);
    // …and still honest about when Figma was actually read.
    expect(second.source!.readAt).toBe("2026-07-28T11:00:00.000Z");
    expect(second.source!.readAt).not.toBe("2026-07-30T09:00:00.000Z");
    clock.mockReturnValue(real);
  });
});
