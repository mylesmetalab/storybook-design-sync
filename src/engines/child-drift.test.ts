import { afterEach, describe, expect, it, vi } from "vitest";
import { createFigmaRestEngine } from "./figma-rest.js";
import type { ChildTarget, CodeSnapshot } from "./types.js";
import type { DimensionDiff, DriftReport } from "../dimensions/types.js";

/**
 * Whole-component drift comparison via declared child bindings.
 *
 * Before this, `checkDrift` compared the story's root element against the
 * registered Figma node and nothing inside it, so a Card's header padding, its
 * body spacing and its nested label typography were all unchecked — a clean
 * report meant "the root element matches", not "the component matches".
 *
 * What these tests defend, in priority order:
 *
 *   1. **A legacy entry is untouched.** No `children` in the registry ⇒ the exact
 *      same rows, byte-identical, no `children` field on the report, and no extra
 *      HTTP requests.
 *   2. **Failures are loud.** A binding that didn't resolve — bad selector,
 *      nothing matched, two things matched, unreachable Figma node, no snapshot —
 *      still appears in `report.children` with an actionable message and zero
 *      rows. A silently-skipped child is what would turn "clean" into a lie.
 *   3. **Child rows are attributable.** Every row a child produces carries its
 *      `childSelector`, so the panel can never present it as the root's.
 */

const FILE_KEY = "file-key";
const ROOT_ID = "2142:11380";
const HEADER_ID = "2142:11381";
const BODY_ID = "2142:11382";

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

/** A frame with `padding-top` bound to `space/400` (16px). */
function frame(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    type: "FRAME",
    strokes: [],
    fills: [],
    children: [],
    boundVariables: { paddingTop: { type: "VARIABLE_ALIAS", id: PAD_VAR } },
    paddingTop: 16,
    ...extra,
  };
}

interface FetchLog {
  urls: string[];
}

/**
 * Fetch stub that serves any subset of node ids from one `ids=` list, so the
 * batching behaviour is observable: `log.urls` records every request made.
 */
function installFetchStub(opts: {
  nodes?: Record<string, unknown>;
  missingIds?: string[];
  nodeStatus?: number;
} = {}): FetchLog {
  const nodes = opts.nodes ?? {
    [ROOT_ID]: frame(ROOT_ID, "Card"),
    [HEADER_ID]: frame(HEADER_ID, "Card header"),
    [BODY_ID]: frame(BODY_ID, "Card body"),
  };
  const missing = new Set(opts.missingIds ?? []);
  const log: FetchLog = { urls: [] };
  vi.stubGlobal("fetch", async (url: string) => {
    log.urls.push(url);
    const json = (body: unknown, status = 200): Response =>
      ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
    if (url.includes("/variables/local")) return json(variablesResponse());
    if (url.includes("/nodes?ids=")) {
      const raw = url.split("ids=")[1] ?? "";
      const ids = raw.split(",").map((s) => decodeURIComponent(s));
      // Only the child batch is allowed to fail / omit; the root always resolves.
      if (opts.nodeStatus && !ids.includes(ROOT_ID)) return json({}, opts.nodeStatus);
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        if (missing.has(id)) continue;
        const doc = nodes[id];
        if (doc) out[id] = { document: doc };
      }
      return json({ nodes: out });
    }
    if (url.includes("/components")) return json({ meta: { components: [] } });
    return json({ lastModified: "2026-07-28T00:00:00Z" });
  });
  return log;
}

function snapshot(paddingTop: string): CodeSnapshot {
  return { styles: { "padding-top": paddingTop } };
}

async function check(children?: ChildTarget[]): Promise<DriftReport> {
  const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
  return engine.checkDrift({
    storyId: "ui-card--default",
    nodeRef: { fileKey: FILE_KEY, nodeId: ROOT_ID },
    snapshot: snapshot("16px"),
    registryPath: ".design-sync/registry.json",
    ...(children ? { children } : {}),
  });
}

function rowsFor(report: DriftReport, selector: string | undefined): DimensionDiff[] {
  return report.dimensions.filter((d) => d.childSelector === selector);
}

function childReport(report: DriftReport, selector: string) {
  const found = report.children?.find((c) => c.selector === selector);
  if (!found) {
    throw new Error(
      `no child report for "${selector}" — got [${(report.children ?? [])
        .map((c) => c.selector)
        .join(", ")}]`,
    );
  }
  return found;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------------- *
 * 1. legacy entries are untouched
 * ------------------------------------------------------------------------- */

describe("a registry entry with no `children` behaves exactly as before", () => {
  it("produces byte-identical rows with and without an empty children array", async () => {
    installFetchStub();
    const withoutField = await check();
    vi.unstubAllGlobals();
    installFetchStub();
    const withEmptyArray = await check([]);

    // `source.readAt` is a wall-clock timestamp like `generatedAt`, so it is
    // normalised out for the same reason — the comparison is about which ROWS the
    // two calls produce. The rest of `source` (file version / lastModified) stays
    // compared.
    const strip = (r: DriftReport): string =>
      JSON.stringify({
        ...r,
        generatedAt: null,
        timing: null,
        ...(r.source ? { source: { ...r.source, readAt: null } } : {}),
      });
    expect(strip(withEmptyArray)).toBe(strip(withoutField));
  });

  it("omits `children` from the report entirely", async () => {
    installFetchStub();
    const report = await check();

    expect(report.children).toBeUndefined();
    expect("children" in report).toBe(false);
  });

  it("leaves every row without a `childSelector`, so nothing regroups", async () => {
    installFetchStub();
    const report = await check();

    expect(report.dimensions.every((d) => d.childSelector === undefined)).toBe(true);
  });

  it("makes no extra node request", async () => {
    const log = installFetchStub();
    await check();

    const nodeRequests = log.urls.filter((u) => u.includes("/nodes?ids="));
    expect(nodeRequests).toHaveLength(1);
    expect(nodeRequests[0]).toContain(encodeURIComponent(ROOT_ID));
  });
});

/* ------------------------------------------------------------------------- *
 * 2. children that resolve
 * ------------------------------------------------------------------------- */

describe("a bound child that resolves", () => {
  it("reports drift on the child's own property, tagged with its selector", async () => {
    installFetchStub();
    const report = await check([
      { selector: "[data-slot=header]", nodeId: HEADER_ID, snapshot: snapshot("8px") },
    ]);

    const row = rowsFor(report, "[data-slot=header]").find((d) => d.property === "padding-top");
    expect(row?.status).toBe("drift");
    expect(row?.codeValue).toBe("8px");
    expect(row?.figmaValue).toBe("16px (token: space/400)");
    expect(childReport(report, "[data-slot=header]").status).toBe("compared");
  });

  it("reports `match` on a clean child, and does not disturb the root's rows", async () => {
    installFetchStub();
    const report = await check([
      { selector: "[data-slot=header]", nodeId: HEADER_ID, snapshot: snapshot("16px") },
    ]);

    const childRow = rowsFor(report, "[data-slot=header]").find(
      (d) => d.property === "padding-top",
    );
    const rootRow = rowsFor(report, undefined).find((d) => d.property === "padding-top");
    expect(childRow?.status).toBe("match");
    expect(rootRow?.status).toBe("match");
    // Same property on two elements ⇒ two distinct rows, never merged.
    expect(childRow).not.toBe(rootRow);
  });

  it("carries the Figma node's name so the panel can label the group", async () => {
    installFetchStub();
    const report = await check([
      { selector: "[data-slot=header]", nodeId: HEADER_ID, snapshot: snapshot("16px") },
    ]);

    expect(childReport(report, "[data-slot=header]").nodeName).toBe("Card header");
  });

  it("does not emit `variant-set` or `props` rows for a child", async () => {
    installFetchStub();
    const report = await check([
      // A child element carrying a modifier-looking class. The variant-set check
      // would happily claim "code variants not declared in Figma" here — a
      // confident signal about something that has no variant identity.
      {
        selector: "[data-slot=header]",
        nodeId: HEADER_ID,
        snapshot: {
          styles: { "padding-top": "16px" },
          variantClasses: ["accent"],
          rootClasses: ["card__header", "card__header--accent"],
        },
      },
    ]);

    const childKinds = new Set(rowsFor(report, "[data-slot=header]").map((d) => d.kind));
    expect(childKinds.has("variant-set")).toBe(false);
    expect(childKinds.has("props")).toBe(false);
  });

  it("batches every child into ONE request — a 3-child component costs 1 extra call", async () => {
    const log = installFetchStub({
      nodes: {
        [ROOT_ID]: frame(ROOT_ID, "Card"),
        [HEADER_ID]: frame(HEADER_ID, "Card header"),
        [BODY_ID]: frame(BODY_ID, "Card body"),
        "2142:11383": frame("2142:11383", "Card footer"),
      },
    });
    await check([
      { selector: "[data-slot=header]", nodeId: HEADER_ID, snapshot: snapshot("16px") },
      { selector: "[data-slot=body]", nodeId: BODY_ID, snapshot: snapshot("16px") },
      { selector: "[data-slot=footer]", nodeId: "2142:11383", snapshot: snapshot("16px") },
    ]);

    const nodeRequests = log.urls.filter((u) => u.includes("/nodes?ids="));
    // One for the root (pre-existing), one for all three children.
    expect(nodeRequests).toHaveLength(2);
    const batch = nodeRequests[1]!;
    for (const id of [HEADER_ID, BODY_ID, "2142:11383"]) {
      expect(batch).toContain(encodeURIComponent(id));
    }
  });

  it("merges COMPONENT_SET inheritance for a child bound to a nested COMPONENT", async () => {
    const SET_ID = "2142:11400";
    const log = installFetchStub({
      nodes: {
        [ROOT_ID]: frame(ROOT_ID, "Card"),
        // The child is a variant COMPONENT that declares no padding binding of
        // its own; the parent set does.
        [HEADER_ID]: {
          ...frame(HEADER_ID, "Size=Small", { type: "COMPONENT" }),
          boundVariables: {},
          paddingTop: undefined,
        },
        [SET_ID]: frame(SET_ID, "Card header", { type: "COMPONENT_SET" }),
      },
    });
    // The components endpoint is what maps a COMPONENT to its containing set.
    const original = globalThis.fetch as typeof fetch;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/components")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            meta: { components: [{ node_id: HEADER_ID, containing_frame: { nodeId: SET_ID } }] },
          }),
        } as unknown as Response;
      }
      return original(url as never);
    });

    const report = await check([
      { selector: "[data-slot=header]", nodeId: HEADER_ID, snapshot: snapshot("8px") },
    ]);

    // Inherited `space/400` from the set ⇒ a real comparison, not a flag-only.
    const row = rowsFor(report, "[data-slot=header]").find((d) => d.property === "padding-top");
    expect(row?.status).toBe("drift");
    expect(row?.figmaValue).toBe("16px (token: space/400)");
    // The child itself was not re-requested — the batch already cached it.
    const childBatches = log.urls.filter(
      (u) => u.includes("/nodes?ids=") && u.includes(encodeURIComponent(HEADER_ID)),
    );
    expect(childBatches).toHaveLength(1);
  });

  it("re-uses the node cache across a bulk run's checks", async () => {
    const log = installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const input = {
      storyId: "ui-card--default",
      nodeRef: { fileKey: FILE_KEY, nodeId: ROOT_ID },
      snapshot: snapshot("16px"),
      trigger: "bulk" as const,
      children: [
        { selector: "[data-slot=header]", nodeId: HEADER_ID, snapshot: snapshot("16px") },
      ],
    };
    await engine.checkDrift(input);
    const after = log.urls.filter((u) => u.includes("/nodes?ids=")).length;
    await engine.checkDrift(input);

    expect(log.urls.filter((u) => u.includes("/nodes?ids=")).length).toBe(after);
  });

  it("re-fetches the child nodes on a second EXPLICIT check", async () => {
    // This assertion used to be the opposite: a second check of any kind reused
    // the node cache. That is what let a deliberate Check drift report `match`
    // against a node the designer had just edited. Cache sharing is a bulk-run
    // property (above); an explicit re-check is a request for the truth.
    const log = installFetchStub();
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const input = {
      storyId: "ui-card--default",
      nodeRef: { fileKey: FILE_KEY, nodeId: ROOT_ID },
      snapshot: snapshot("16px"),
      children: [
        { selector: "[data-slot=header]", nodeId: HEADER_ID, snapshot: snapshot("16px") },
      ],
    };
    await engine.checkDrift(input);
    const after = log.urls.filter((u) => u.includes("/nodes?ids=")).length;
    await engine.checkDrift(input);

    expect(log.urls.filter((u) => u.includes("/nodes?ids=")).length).toBeGreaterThan(after);
  });
});

/* ------------------------------------------------------------------------- *
 * 3. failures are loud
 * ------------------------------------------------------------------------- */

describe("a bound child that cannot be compared is reported, never dropped", () => {
  it.each([
    ["selector-not-found", "matched no element"],
    ["selector-ambiguous", "matched 2 elements"],
    ["selector-invalid", "not a valid CSS selector"],
    ["binding-malformed", "malformed"],
    ["snapshot-missing", "no snapshot arrived"],
  ] as const)("passes a pre-computed %s problem through with its message", async (status, gist) => {
    installFetchStub();
    const message = `Not compared — ${gist} …`;
    const report = await check([
      { selector: "[data-slot=header]", nodeId: HEADER_ID, problem: { status, message } },
    ]);

    const entry = childReport(report, "[data-slot=header]");
    expect(entry.status).toBe(status);
    expect(entry.message).toBe(message);
    expect(entry.rowCount).toBe(0);
    // Crucially: zero rows, so nothing about this element is claimed either way.
    expect(rowsFor(report, "[data-slot=header]")).toHaveLength(0);
  });

  it("reports an unreachable Figma child node id, naming the selector and node", async () => {
    installFetchStub({ missingIds: [HEADER_ID] });
    const report = await check([
      { selector: "[data-slot=header]", nodeId: HEADER_ID, snapshot: snapshot("16px") },
    ]);

    const entry = childReport(report, "[data-slot=header]");
    expect(entry.status).toBe("node-unreachable");
    expect(entry.message).toContain("[data-slot=header]");
    expect(entry.message).toContain(HEADER_ID);
    expect(entry.message).toContain("ui-card--default");
    expect(rowsFor(report, "[data-slot=header]")).toHaveLength(0);
  });

  it("reports the HTTP status when the child batch itself fails", async () => {
    installFetchStub({ nodeStatus: 403 });
    const report = await check([
      { selector: "[data-slot=header]", nodeId: HEADER_ID, snapshot: snapshot("16px") },
    ]);

    expect(childReport(report, "[data-slot=header]").message).toContain("403");
  });

  it("does not let one unreachable child suppress a sibling that resolved", async () => {
    installFetchStub({ missingIds: [HEADER_ID] });
    const report = await check([
      { selector: "[data-slot=header]", nodeId: HEADER_ID, snapshot: snapshot("16px") },
      { selector: "[data-slot=body]", nodeId: BODY_ID, snapshot: snapshot("4px") },
    ]);

    expect(childReport(report, "[data-slot=header]").status).toBe("node-unreachable");
    expect(childReport(report, "[data-slot=body]").status).toBe("compared");
    expect(
      rowsFor(report, "[data-slot=body]").find((d) => d.property === "padding-top")?.status,
    ).toBe("drift");
  });

  it("keeps `children` in declaration order regardless of outcome", async () => {
    installFetchStub({ missingIds: [BODY_ID] });
    const report = await check([
      { selector: "[data-slot=body]", nodeId: BODY_ID, snapshot: snapshot("16px") },
      { selector: "[data-slot=header]", nodeId: HEADER_ID, snapshot: snapshot("16px") },
    ]);

    expect(report.children?.map((c) => c.selector)).toEqual([
      "[data-slot=body]",
      "[data-slot=header]",
    ]);
  });

  it("reports a child for every declaration — the count never shrinks", async () => {
    installFetchStub({ missingIds: [BODY_ID] });
    const report = await check([
      { selector: "[data-slot=header]", nodeId: HEADER_ID, snapshot: snapshot("16px") },
      { selector: "[data-slot=body]", nodeId: BODY_ID, snapshot: snapshot("16px") },
      {
        selector: "[data-slot=footer]",
        nodeId: "2142:11383",
        problem: { status: "selector-not-found", message: "Not compared — …" },
      },
    ]);

    expect(report.children).toHaveLength(3);
  });
});
