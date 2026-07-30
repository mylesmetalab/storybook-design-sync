import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFigmaRestEngine } from "./figma-rest.js";
import type { ChildTarget, CodeSnapshot } from "./types.js";
import type { DriftReport } from "../dimensions/types.js";

/**
 * Issues #73 and #74 — a Figma read that fails must not become a pass.
 *
 * The live sequence: run **Check all** twice in quick succession, Figma
 * rate-limits the second run, and `ui-card--image-default-vertical` came back
 * `status: "done"` with a footnote (`5 child bindings not compared`) — a green
 * tick over 2 compared properties out of ~37. That partial report was then
 * written to `.design-sync/cache.json`, so every later run replayed it:
 * byte-identical totals, `generatedAt` frozen, and no recovery short of deleting
 * the file by hand. The per-story `Check drift` a reviewer would reach for to heal
 * it was the path that hung (>90s, no error).
 *
 * What is pinned here:
 *   1. A 429 on the child batch marks the report `incomplete` — not a verdict.
 *   2. That report is NOT written to the persistent cache, so the next run retries.
 *   3. A node Figma confirms is *absent* is still a finding, and still cacheable —
 *      "could not read" and "is not there" must not be collapsed.
 *   4. The failure surfaces the rate limit and its `Retry-After`, and does not
 *      tell the user to go and check a node id that was never the problem.
 *   5. A rate-limited *variables* fetch is the same class of failure: without it
 *      every token row silently degrades to flag-only and the story reports no
 *      drift at all.
 *   6. It rejects rather than sitting there: a `Retry-After` longer than the
 *      per-request backoff budget fails fast with the cause (#74).
 */

const FILE_KEY = "file-key";
const ROOT_ID = "2142:11380";
const HEADER_ID = "2142:11381";
const PAD_VAR = "VariableID:1:1";
const COLLECTION = "VariableCollectionId:1:0";

function variablesResponse() {
  return {
    meta: {
      variableCollections: {
        [COLLECTION]: {
          id: COLLECTION,
          name: "Size",
          defaultModeId: "1:2",
          modes: [{ modeId: "1:2", name: "Default" }],
        },
      },
      variables: {
        [PAD_VAR]: {
          id: PAD_VAR,
          name: "space/400",
          resolvedType: "FLOAT",
          variableCollectionId: COLLECTION,
          valuesByMode: { "1:2": 16 },
        },
      },
    },
  };
}

function frame(id: string, name: string) {
  return {
    id,
    name,
    type: "FRAME",
    strokes: [],
    fills: [],
    children: [],
    boundVariables: { paddingTop: { type: "VARIABLE_ALIAS", id: PAD_VAR } },
    paddingTop: 16,
  };
}

interface StubOptions {
  /** HTTP status for the CHILD node batch (the root always resolves). */
  childStatus?: number;
  /** `Retry-After` header value served with `childStatus`. */
  childRetryAfter?: string;
  /** Ids to omit from an otherwise-successful response. */
  missingIds?: string[];
  /** HTTP status for `/variables/local`. */
  variablesStatus?: number;
  variablesRetryAfter?: string;
}

interface Stub {
  urls: string[];
  /** Flip mid-test to simulate the rate limit clearing. */
  opts: StubOptions;
}

function installFetchStub(initial: StubOptions = {}): Stub {
  const stub: Stub = { urls: [], opts: { ...initial } };
  const nodes: Record<string, unknown> = {
    [ROOT_ID]: frame(ROOT_ID, "Card"),
    [HEADER_ID]: frame(HEADER_ID, "Card header"),
  };
  vi.stubGlobal("fetch", async (url: string) => {
    stub.urls.push(url);
    const json = (body: unknown, status = 200, retryAfter?: string): Response =>
      ({
        ok: status < 400,
        status,
        headers: { get: (h: string) => (h === "Retry-After" ? (retryAfter ?? null) : null) },
        json: async () => body,
      }) as unknown as Response;

    if (url.includes("/variables/local")) {
      if (stub.opts.variablesStatus) {
        return json({}, stub.opts.variablesStatus, stub.opts.variablesRetryAfter);
      }
      return json(variablesResponse());
    }
    if (url.includes("/nodes?ids=")) {
      const raw = url.split("ids=")[1] ?? "";
      const ids = raw.split(",").map((s) => decodeURIComponent(s));
      if (stub.opts.childStatus && !ids.includes(ROOT_ID)) {
        return json({}, stub.opts.childStatus, stub.opts.childRetryAfter);
      }
      const missing = new Set(stub.opts.missingIds ?? []);
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        if (missing.has(id)) continue;
        const doc = nodes[id];
        if (doc) out[id] = { document: doc };
      }
      return json({ nodes: out });
    }
    if (url.includes("/components")) return json({ meta: { components: [] } });
    return json({ lastModified: "2026-07-30T10:47:54Z" });
  });
  return stub;
}

const snapshot: CodeSnapshot = { styles: { "padding-top": "16px" } };

const header: ChildTarget = {
  selector: "[data-slot=header]",
  nodeId: HEADER_ID,
  snapshot: { styles: { "padding-top": "16px" } },
};

const dirs: string[] = [];

async function cacheDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "design-sync-ratelimit-"));
  dirs.push(dir);
  return join(dir, "cache.json");
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function check(
  opts: { cachePath?: string; trigger?: "bulk" | "explicit"; children?: ChildTarget[] } = {},
): Promise<DriftReport> {
  const engine = createFigmaRestEngine({
    figmaPat: "test-pat",
    ...(opts.cachePath ? { cachePath: opts.cachePath } : {}),
  });
  return engine.checkDrift({
    storyId: "ui-card--image-default-vertical",
    nodeRef: { fileKey: FILE_KEY, nodeId: ROOT_ID },
    snapshot,
    registryPath: ".design-sync/registry.json",
    trigger: opts.trigger ?? "bulk",
    children: opts.children ?? [header],
  });
}

describe("a rate-limited child fetch is not a pass (#73)", () => {
  it("marks the report incomplete, naming the child and the cause", async () => {
    installFetchStub({ childStatus: 429, childRetryAfter: "30" });
    const report = await check();

    expect(report.incomplete).toBeDefined();
    expect(report.incomplete!.targets).toContain("[data-slot=header]");
    expect(report.incomplete!.reason).toContain("rate limited");
    expect(report.incomplete!.detail).toContain("429");
    expect(report.incomplete!.retryAfterMs).toBe(30_000);
  });

  it("still reports the child as not compared, with no rows for it", async () => {
    installFetchStub({ childStatus: 429, childRetryAfter: "30" });
    const report = await check();

    const child = report.children?.find((c) => c.selector === "[data-slot=header]");
    expect(child?.status).toBe("node-unreachable");
    expect(child?.rowCount).toBe(0);
    expect(report.dimensions.some((d) => d.childSelector === "[data-slot=header]")).toBe(false);
  });

  it("does not send the user after a node id that was never wrong", async () => {
    installFetchStub({ childStatus: 429, childRetryAfter: "30" });
    const report = await check();
    const message = report.children?.[0]?.message ?? "";

    expect(message).toContain("429");
    expect(message).toContain("not cached");
    expect(message).not.toContain("Copy link to selection");
  });

  it("refuses to persist it, so the next run retries instead of replaying", async () => {
    const cachePath = await cacheDir();
    const stub = installFetchStub({ childStatus: 429, childRetryAfter: "30" });

    const first = await check({ cachePath });
    expect(first.incomplete).toBeDefined();
    expect(first.cacheStatus?.notPersisted).toContain("rate limited");

    // Nothing was written — not even an empty stories map with this entry in it.
    const onDisk = await readFile(cachePath, "utf8").catch(() => "");
    expect(onDisk).not.toContain("ui-card--image-default-vertical");

    // The limit clears. A fresh engine (a restarted Storybook) reading the same
    // cache file gets a real comparison, not the green tick from before.
    stub.opts.childStatus = undefined as unknown as number;
    const second = await check({ cachePath });
    expect(second.incomplete).toBeUndefined();
    expect(second.children?.[0]?.status).toBe("compared");
    expect(second.dimensions.some((d) => d.childSelector === "[data-slot=header]")).toBe(true);
  });

  it("keeps a genuinely absent node cacheable — 'not there' is a finding, not a hole", async () => {
    const cachePath = await cacheDir();
    installFetchStub({ missingIds: [HEADER_ID] });

    const report = await check({ cachePath });
    expect(report.children?.[0]?.status).toBe("node-unreachable");
    // Figma answered; the id simply isn't in the file. That is stable, it is
    // already reported per child, and it is not a failure to look.
    expect(report.incomplete).toBeUndefined();
    expect(report.cacheStatus?.notPersisted).toBeUndefined();
  });

  it("leaves a story with no children untouched", async () => {
    installFetchStub({ childStatus: 429, childRetryAfter: "30" });
    const report = await check({ children: [] });

    expect(report.incomplete).toBeUndefined();
    expect(report.children).toBeUndefined();
  });
});

describe("a rate-limited variables fetch is the same failure (#73)", () => {
  it("is incomplete rather than a story with nothing to compare", async () => {
    installFetchStub({ variablesStatus: 429, variablesRetryAfter: "20" });
    const report = await check({ children: [] });

    expect(report.incomplete).toBeDefined();
    expect(report.incomplete!.targets).toContain("the file's variables");
    expect(report.incomplete!.retryAfterMs).toBe(20_000);
  });

  it("still treats a 403/404 variables endpoint as a legitimate absence", async () => {
    // Not an Enterprise file, or the PAT has no variables scope. Figma answered;
    // there is nothing to read. That is not a hole in the run.
    installFetchStub({ variablesStatus: 403 });
    const report = await check({ children: [] });

    expect(report.incomplete).toBeUndefined();
  });
});

describe("the per-request wait is bounded and reported, never slept through (#74)", () => {
  it("rejects with the rate limit and the retry-after instead of hanging", async () => {
    // A `Retry-After` of 30s used to be honoured up to four times — over 90
    // seconds of a spinner. The root node's fetch has no fallback, so this is
    // the path that surfaces to the panel as an error.
    installFetchStub({ childStatus: 429, childRetryAfter: "45" });

    const startedAt = Date.now();
    const report = await check();
    const elapsed = Date.now() - startedAt;

    expect(report.incomplete).toBeDefined();
    expect(report.incomplete!.detail).toContain("retry in 45s");
    // The point of the fix: it did not wait the 45s out (nor four of them).
    expect(elapsed).toBeLessThan(3000);
  });

  it("makes exactly one attempt when the wait exceeds the budget", async () => {
    const stub = installFetchStub({ childStatus: 429, childRetryAfter: "45" });
    await check();

    const childRequests = stub.urls.filter(
      (u) => u.includes("/nodes?ids=") && u.includes(encodeURIComponent(HEADER_ID)),
    );
    expect(childRequests).toHaveLength(1);
  });
});
