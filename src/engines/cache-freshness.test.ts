import { afterEach, describe, expect, it, vi } from "vitest";
import { createFigmaRestEngine } from "./figma-rest.js";
import type { CheckDriftInput, CodeSnapshot } from "./types.js";
import type { DriftReport } from "../dimensions/types.js";

/**
 * Cache freshness: an explicit **Check drift** must never report `match` against
 * Figma data that has changed.
 *
 * The live failure: the owner changed a token's *value* in Figma, pressed Check
 * drift, and the row came back `match`. Two things combined to produce it —
 * a 5-minute variables TTL justified by the comment "variables are stable for the
 * lifetime of a working session" (a designer changing a token mid-session is
 * exactly what this tool exists to detect), and the v0.0.28 engine memoization,
 * which turned that per-check cache into a cross-check one. The result was a
 * five-minute window of confident, false `match`.
 *
 * The contract these tests pin:
 *   1. An explicit check re-reads variables and nodes, so it sees a new value.
 *   2. A bulk run still shares ONE variables fetch across its stories — the
 *      caches exist so a ~90-story Check all doesn't hit Figma's rate limits.
 *   3. When the file's `lastModified` moves, cached artefacts for that file are
 *      dropped even on the bulk path.
 *   4. A dual-mode check revalidates once per user action, not once per mode.
 *   5. The report's cache hit/miss counters keep describing real HTTP traffic —
 *      they were the diagnostic that made this findable.
 */

const FILE_KEY = "file-key";
const NODE_ID = "37:30";
const PAD_VAR = "VariableID:1:1";
const COLLECTION = "VariableCollectionId:1:0";

function variablesResponse(paddingPx: number) {
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
          valuesByMode: { "1:2": paddingPx },
        },
      },
    },
  };
}

function node() {
  return {
    id: NODE_ID,
    name: "Card",
    type: "FRAME",
    strokes: [],
    fills: [],
    children: [],
    boundVariables: { paddingTop: { type: "VARIABLE_ALIAS", id: PAD_VAR } },
    paddingTop: 16,
  };
}

interface Stub {
  urls: string[];
  /** Value `space/400` currently resolves to in Figma. Mutate mid-test. */
  paddingPx: number;
  /** The file's `lastModified`. Mutate mid-test. */
  lastModified: string;
  counts: () => { variables: number; nodes: number; meta: number };
}

function installFetchStub(): Stub {
  const stub: Stub = {
    urls: [],
    paddingPx: 16,
    lastModified: "2026-07-28T00:00:00Z",
    counts: () => ({
      variables: stub.urls.filter((u) => u.includes("/variables/local")).length,
      nodes: stub.urls.filter((u) => u.includes("/nodes?ids=")).length,
      meta: stub.urls.filter((u) => u.includes("depth=1")).length,
    }),
  };
  vi.stubGlobal("fetch", async (url: string) => {
    stub.urls.push(url);
    const json = (body: unknown, status = 200): Response =>
      ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    if (url.includes("/variables/local")) return json(variablesResponse(stub.paddingPx));
    if (url.includes("/nodes?ids=")) return json({ nodes: { [NODE_ID]: { document: node() } } });
    if (url.includes("/components")) return json({ meta: { components: [] } });
    return json({ lastModified: stub.lastModified });
  });
  return stub;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const snapshot: CodeSnapshot = { styles: { "padding-top": "16px" } };

/** Overrides may set a field to `undefined` explicitly (that is the point of the
 *  "absent trigger" case), so this is laxer than `Partial<CheckDriftInput>`
 *  under `exactOptionalPropertyTypes`. */
type InputOverride = { [K in keyof CheckDriftInput]?: CheckDriftInput[K] | undefined };

function input(over: InputOverride = {}): CheckDriftInput {
  return {
    storyId: "ui-card--default",
    nodeRef: { fileKey: FILE_KEY, nodeId: NODE_ID },
    snapshot,
    ...over,
  } as CheckDriftInput;
}

const paddingRow = (report: DriftReport) =>
  report.dimensions.find((d) => d.kind === "token-value" && d.property === "padding-top");

describe("an explicit Check drift never answers from a stale cache", () => {
  it("sees a token VALUE change made between two checks (the live bug)", async () => {
    const stub = installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });

    const first = await engine.checkDrift(input());
    expect(paddingRow(first)?.status).toBe("match");

    // The designer edits the token's value in Figma. Nothing else changes — in
    // particular we do NOT move `lastModified`, because we have not verified that
    // a variable-value-only edit bumps it.
    stub.paddingPx = 24;

    const second = await engine.checkDrift(input());
    expect(paddingRow(second)?.status).toBe("drift");
    expect(paddingRow(second)?.figmaValue).toBe("24px (token: space/400)");
  });

  it("re-fetches variables and the node rather than reusing them", async () => {
    const stub = installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });

    await engine.checkDrift(input());
    const afterFirst = stub.counts();
    await engine.checkDrift(input());
    const afterSecond = stub.counts();

    expect(afterSecond.variables).toBeGreaterThan(afterFirst.variables);
    expect(afterSecond.nodes).toBeGreaterThan(afterFirst.nodes);
  });

  it("treats an absent trigger as explicit — a caller that forgets gets correctness", async () => {
    const stub = installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    await engine.checkDrift(input({ trigger: undefined }));
    stub.paddingPx = 24;
    expect(paddingRow(await engine.checkDrift(input({ trigger: undefined })))?.status).toBe("drift");
  });

  it("revalidates once per user action, not once per mode, in a dual-mode check", async () => {
    const stub = installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });

    // Two engine passes for one press of Check drift — the server gives both the
    // same checkId. Nothing can change between them, so Figma is read once.
    await engine.checkDrift(input({ checkId: "press-1", mode: "light" }));
    const afterLight = stub.counts();
    await engine.checkDrift(input({ checkId: "press-1", mode: "dark" }));
    const afterDark = stub.counts();

    expect(afterDark.variables).toBe(afterLight.variables);
    expect(afterDark.nodes).toBe(afterLight.nodes);

    // The next press is a new action and does revalidate.
    await engine.checkDrift(input({ checkId: "press-2", mode: "light" }));
    expect(stub.counts().variables).toBeGreaterThan(afterDark.variables);
  });
});

describe("a bulk run keeps the caching that makes it affordable", () => {
  it("shares ONE variables fetch across many stories", async () => {
    const stub = installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });

    for (let i = 0; i < 5; i++) {
      await engine.checkDrift(input({ storyId: `ui-card--story-${i}`, trigger: "bulk" }));
    }

    expect(stub.counts().variables).toBe(1);
    // …and one node fetch, since every story here points at the same node.
    expect(stub.counts().nodes).toBe(1);
  });

  it("drops the shared caches when the file's lastModified moves mid-run", async () => {
    const stub = installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });

    await engine.checkDrift(input({ storyId: "a", trigger: "bulk" }));
    expect(stub.counts().variables).toBe(1);

    // A cheap truth signal beats a timer: the file changed, so everything cached
    // for it is suspect — including the variables, whose own TTL (5 min) has not
    // expired. The clock jump is only there to let the bulk path re-read the
    // 60s-cached `lastModified`; that re-read is what notices the change.
    stub.lastModified = "2026-07-28T09:30:00Z";
    stub.paddingPx = 24;
    vi.setSystemTime(Date.now() + 61_000);
    try {
      const after = await engine.checkDrift(input({ storyId: "b", trigger: "bulk" }));
      expect(stub.counts().variables).toBe(2);
      expect(paddingRow(after)?.status).toBe("drift");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the report's cache counters keep describing real HTTP traffic", () => {
  it("counts a bulk cache hit as a hit and a re-read as a miss", async () => {
    installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });

    const cold = await engine.checkDrift(input({ trigger: "bulk" }));
    expect(cold.timing?.cacheMisses).toBeGreaterThan(0);
    expect(cold.timing?.cacheHits).toBe(0);

    const warm = await engine.checkDrift(input({ trigger: "bulk" }));
    expect(warm.timing?.cacheHits).toBeGreaterThan(0);
    expect(warm.timing?.cacheMisses).toBe(0);
  });

  it("reports misses (never phantom hits) for an explicit re-check that dropped the cache", async () => {
    installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });

    await engine.checkDrift(input());
    const second = await engine.checkDrift(input());

    // The dropped entries must show up as misses — a bypass that recorded hits
    // would hide exactly the traffic these numbers exist to reveal.
    expect(second.timing?.cacheMisses).toBeGreaterThan(0);
    expect(second.timing?.cacheHits).toBe(0);
  });
});
