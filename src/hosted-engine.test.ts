import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodeSnapshotPayload } from "./channels.js";
import type { DriftReport } from "./dimensions/types.js";
import type { CheckDriftInput, Engine } from "./engines/types.js";
import { setAutoScan } from "./auto-tokens.js";
import { runHostedCodeSnapshot } from "./hosted-engine.js";

/**
 * Phase 4, sub-PR 3 of 3 (HOSTED-CHECK-TASKS.md T8: load-artifact /
 * drive-snapshot / wire-to-engine) — the last piece of the second engine
 * host. Turns sub-PR 2's `CodeSnapshotPayload` into a real `DriftReport` by
 * calling `engine.checkDrift`, reusing every one of `server.ts`'s actual
 * merge/build/annotate steps (now exported) rather than reimplementing any
 * of them.
 */

const dirs: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "design-sync-hosted-engine-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  // Reset the module singleton so one test's scan can't leak into another's.
  setAutoScan({ map: {}, themeVars: {}, components: [], classHints: {}, customProperties: {} });
});

function snapshotPayload(over: Partial<CodeSnapshotPayload> = {}): CodeSnapshotPayload {
  return {
    storyId: "ui-button--primary",
    snapshot: { styles: { "background-color": "rgb(0, 0, 0)" } },
    ...over,
  };
}

function report(over: Partial<DriftReport> = {}): DriftReport {
  return {
    storyId: "ui-button--primary",
    nodeId: "1:2",
    generatedAt: "2026-08-07T00:00:00.000Z",
    dimensions: [],
    ...over,
  };
}

function fakeEngine(check: (input: CheckDriftInput) => Promise<DriftReport>): Pick<Engine, "checkDrift"> {
  return { checkDrift: check };
}

const REGISTRY = {
  fileKey: "FIGMA_KEY",
  stories: {
    "ui-button--primary": { nodeId: "1:2", lastSyncedHash: null },
  },
};

const CONFIG = { fileKey: "FIGMA_KEY" };

describe("runHostedCodeSnapshot", () => {
  it("calls engine.checkDrift with the same CheckDriftInput shape the live handler builds", async () => {
    const dir = await fixture({
      "design-sync.config.json": JSON.stringify(CONFIG),
      ".design-sync/registry.json": JSON.stringify(REGISTRY),
    });
    let captured: CheckDriftInput | undefined;
    const engine = fakeEngine(async (input) => {
      captured = input;
      return report({ dimensions: [] });
    });

    const result = await runHostedCodeSnapshot({
      payload: snapshotPayload(),
      cwd: dir,
      engine,
    });

    expect(result.report).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(captured).toMatchObject({
      storyId: "ui-button--primary",
      nodeRef: { fileKey: "FIGMA_KEY", nodeId: "1:2" },
      trigger: "explicit",
    });
  });

  it("uses trigger 'bulk' when the payload says bulk, 'explicit' otherwise", async () => {
    const dir = await fixture({
      "design-sync.config.json": JSON.stringify(CONFIG),
      ".design-sync/registry.json": JSON.stringify(REGISTRY),
    });
    let captured: CheckDriftInput | undefined;
    const engine = fakeEngine(async (input) => {
      captured = input;
      return report();
    });

    await runHostedCodeSnapshot({ payload: snapshotPayload({ bulk: true }), cwd: dir, engine });
    expect(captured?.trigger).toBe("bulk");
  });

  it("reports 'not registered' by the same wording the live handler uses, and never calls the engine", async () => {
    const dir = await fixture({
      "design-sync.config.json": JSON.stringify(CONFIG),
      ".design-sync/registry.json": JSON.stringify({ fileKey: "FIGMA_KEY", stories: {} }),
    });
    let called = false;
    const engine = fakeEngine(async () => {
      called = true;
      return report();
    });

    const result = await runHostedCodeSnapshot({
      payload: snapshotPayload({ storyId: "ui-ghost--nope" }),
      cwd: dir,
      engine,
    });

    expect(result.error?.message).toContain("Not registered");
    expect(result.report).toBeUndefined();
    expect(called).toBe(false);
  });

  it("reports a pending entry as info severity, never as an error the panel would alarm on", async () => {
    const dir = await fixture({
      "design-sync.config.json": JSON.stringify(CONFIG),
      ".design-sync/registry.json": JSON.stringify({
        fileKey: "FIGMA_KEY",
        stories: { "ui-button--primary": { nodeId: null, lastSyncedHash: null, status: "pending" } },
      }),
    });
    const engine = fakeEngine(async () => report());

    const result = await runHostedCodeSnapshot({ payload: snapshotPayload(), cwd: dir, engine });

    expect(result.error?.severity).toBe("info");
    expect(result.error?.message).toContain("Pending");
  });

  it("refuses the comparison on a missing stylesheet — same #96 short-circuit, no engine call", async () => {
    const dir = await fixture({
      "design-sync.config.json": JSON.stringify(CONFIG),
      ".design-sync/registry.json": JSON.stringify(REGISTRY),
    });
    let called = false;
    const engine = fakeEngine(async () => {
      called = true;
      return report();
    });

    const result = await runHostedCodeSnapshot({
      payload: snapshotPayload({
        stylesheetMissing: { reason: "no-stylesheet", detail: "nothing loaded", probed: 3 },
      }),
      cwd: dir,
      engine,
    });

    expect(result.report?.incomplete?.reason).toBe("no-stylesheet");
    expect(result.report?.dimensions).toEqual([]);
    expect(called).toBe(false);
  });

  it("merges the loaded scan artifact's bindings into the snapshot before the engine sees it — the reason setAutoScan exists for hosted mode", async () => {
    const dir = await fixture({
      "design-sync.config.json": JSON.stringify(CONFIG),
      ".design-sync/registry.json": JSON.stringify(REGISTRY),
    });
    // Simulates a hosted runner's own startup: setAutoScan(toAutoScan(loadedArtifact)).
    setAutoScan({
      map: { ".btn": { "background-color": "color-brand" } },
      themeVars: {},
      components: [],
      classHints: {},
      customProperties: {},
    });
    let captured: CheckDriftInput | undefined;
    const engine = fakeEngine(async (input) => {
      captured = input;
      return report();
    });

    await runHostedCodeSnapshot({
      payload: snapshotPayload({ target: ".btn" }),
      cwd: dir,
      engine,
    });

    expect(captured?.snapshot?.bindings).toMatchObject({ "background-color": "color-brand" });
  });

  it("annotates token presence from the same loaded scan artifact", async () => {
    const dir = await fixture({
      "design-sync.config.json": JSON.stringify(CONFIG),
      ".design-sync/registry.json": JSON.stringify(REGISTRY),
    });
    setAutoScan({
      map: {},
      themeVars: {},
      components: [],
      classHints: {},
      customProperties: { "color-brand": ["src/theme.css"] },
    });
    const engine = fakeEngine(async () =>
      report({
        dimensions: [
          {
            kind: "token-value",
            property: "background-color",
            status: "match",
            codeValue: "#000",
            figmaValue: "#000",
            tokenName: "color-brand",
          },
        ],
      }),
    );

    const result = await runHostedCodeSnapshot({ payload: snapshotPayload(), cwd: dir, engine });

    expect(result.report?.dimensions[0]?.tokenPresence?.kind).not.toBe("unknown");
  });

  it("propagates an engine throw as an error result, same as the live handler's catch", async () => {
    const dir = await fixture({
      "design-sync.config.json": JSON.stringify(CONFIG),
      ".design-sync/registry.json": JSON.stringify(REGISTRY),
    });
    const engine = fakeEngine(async () => {
      throw new Error("Figma rate limited this request.");
    });

    const result = await runHostedCodeSnapshot({ payload: snapshotPayload(), cwd: dir, engine });

    expect(result.error?.message).toBe("Figma rate limited this request.");
    expect(result.report).toBeUndefined();
  });
});
