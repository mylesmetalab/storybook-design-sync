import { afterEach, describe, expect, it, vi } from "vitest";
import type { DimensionDiff } from "../dimensions/types.js";
import { createFigmaRestEngine } from "./figma-rest.js";

/**
 * Issue #57 end-to-end through the engine: a Tailwind consumer binding `primary`
 * against a library that calls the same decision `color/background/brand/default`.
 * `normalizeTokenName` cannot reconcile those, so before v0.0.38 every such row
 * reported `drift` — ~10 per story, 89 on one component whose only real
 * difference was its label text.
 *
 * These tests drive the real `checkDrift` (stubbed HTTP) so the whole chain is
 * covered: the value comparison, the binding comparison that reads it, and the
 * `tokenAliases` map arriving on `CheckDriftInput`.
 */

const FILE_KEY = "file123";
const NODE_ID = "1:2";
const COLLECTION = "VariableCollectionId:1:1";
const BRAND_BG = "VariableID:1:10";
const SPACE_150 = "VariableID:1:11";
const GAP_TOKEN = "VariableID:1:12";

function variablesResponse() {
  return {
    meta: {
      variableCollections: {
        [COLLECTION]: {
          id: COLLECTION,
          name: "Tokens",
          defaultModeId: "1:0",
          modes: [{ modeId: "1:0", name: "Light" }],
        },
      },
      variables: {
        [BRAND_BG]: {
          id: BRAND_BG,
          name: "color/background/brand/default",
          resolvedType: "COLOR",
          variableCollectionId: COLLECTION,
          // rgb(44, 44, 44)
          valuesByMode: { "1:0": { r: 44 / 255, g: 44 / 255, b: 44 / 255, a: 1 } },
        },
        [SPACE_150]: {
          id: SPACE_150,
          name: "space/150",
          resolvedType: "FLOAT",
          variableCollectionId: COLLECTION,
          valuesByMode: { "1:0": 12 },
        },
        [GAP_TOKEN]: {
          id: GAP_TOKEN,
          name: "space/200",
          resolvedType: "FLOAT",
          variableCollectionId: COLLECTION,
          valuesByMode: { "1:0": 16 },
        },
      },
    },
  };
}

function nodeResponse() {
  return {
    nodes: {
      [NODE_ID]: {
        document: {
          id: NODE_ID,
          name: "Button",
          type: "FRAME",
          boundVariables: {
            fills: { type: "VARIABLE_ALIAS", id: BRAND_BG },
            paddingTop: { type: "VARIABLE_ALIAS", id: SPACE_150 },
            itemSpacing: { type: "VARIABLE_ALIAS", id: GAP_TOKEN },
          },
          fills: [{ type: "SOLID", color: { r: 44 / 255, g: 44 / 255, b: 44 / 255 }, boundVariables: { color: { type: "VARIABLE_ALIAS", id: BRAND_BG } } }],
          children: [],
        },
      },
    },
  };
}

function installFetchStub(): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const json = (body: unknown): Response =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (url.includes("/variables/local")) return json(variablesResponse());
    if (url.includes("/nodes?ids=")) return json(nodeResponse());
    if (url.includes("/components")) return json({ meta: { components: [] } });
    return json({ lastModified: "2026-07-28T00:00:00Z" });
  });
}

async function check(opts: {
  styles: Record<string, string>;
  bindings: Record<string, string>;
  tokenAliases?: Record<string, string>;
}): Promise<DimensionDiff[]> {
  installFetchStub();
  // No cachePath — the persistent cache stays out of it.
  const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
  const report = await engine.checkDrift({
    storyId: "ui-button--primary",
    nodeRef: { fileKey: FILE_KEY, nodeId: NODE_ID },
    snapshot: { styles: opts.styles, bindings: opts.bindings },
    ...(opts.tokenAliases ? { tokenAliases: opts.tokenAliases } : {}),
  });
  return report.dimensions;
}

const binding = (dimensions: DimensionDiff[], property: string): DimensionDiff => {
  const found = dimensions.find((d) => d.kind === "token-binding" && d.property === property);
  if (!found) throw new Error(`no token-binding row for "${property}"`);
  return found;
};

const value = (dimensions: DimensionDiff[], property: string): DimensionDiff => {
  const found = dimensions.find((d) => d.kind === "token-value" && d.property === property);
  if (!found) throw new Error(`no token-value row for "${property}"`);
  return found;
};

/** The rendered component matches Figma exactly; only the token *names* differ. */
const MATCHING_STYLES = {
  "background-color": "rgb(44, 44, 44)",
  "padding-top": "12px",
  gap: "normal",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token-binding: a name divergence whose value matches is an advisory", () => {
  it("does not report drift for `primary` vs `color/background/brand/default`", async () => {
    const dimensions = await check({
      styles: MATCHING_STYLES,
      bindings: { "background-color": "primary" },
    });

    expect(value(dimensions, "background-color").status).toBe("match");
    const row = binding(dimensions, "background-color");
    expect(row.status).toBe("advisory");
    expect(row.nameDivergence).toBe("value-matched");
    // Both names survive on the row — the divergence is real information.
    expect(row.codeValue).toBe("primary");
    expect(row.figmaValue).toBe("color/background/brand/default");
    expect(row.note).toContain("this is not drift");
    expect(row.note).toContain(`"color/background/brand/default": "primary"`);
  });

  it("no comparison in the whole report is drift when only names differ", async () => {
    const dimensions = await check({
      styles: MATCHING_STYLES,
      bindings: { "background-color": "primary", "padding-top": "spacing-md" },
    });
    expect(dimensions.filter((d) => d.status === "drift")).toEqual([]);
    expect(dimensions.filter((d) => d.status === "advisory")).toHaveLength(2);
  });

  it("still reports drift when the VALUE disagrees too", async () => {
    const dimensions = await check({
      styles: { ...MATCHING_STYLES, "padding-top": "6px" },
      bindings: { "padding-top": "spacing-md" },
    });
    expect(value(dimensions, "padding-top").status).toBe("drift");
    const row = binding(dimensions, "padding-top");
    expect(row.status).toBe("drift");
    expect(row.nameDivergence).toBeUndefined();
    expect(row.note).toContain("the values also disagree");
  });

  it("marks a divergence with no value comparison `unverified`, never `match`", async () => {
    // Code declares no `gap` (computed `normal`), so the value row is flag-only —
    // no comparison landed, and the addon cannot claim the render is right.
    const dimensions = await check({
      styles: MATCHING_STYLES,
      bindings: { gap: "spacing-lg" },
    });
    expect(value(dimensions, "gap").status).toBe("flag-only");
    const row = binding(dimensions, "gap");
    expect(row.status).toBe("advisory");
    expect(row.nameDivergence).toBe("unverified");
    expect(row.note).toContain("it is NOT a match");
  });
});

describe("token-binding: tokenAliases resolves the name before the heuristic", () => {
  it("reports `match` and records that an alias did it", async () => {
    const dimensions = await check({
      styles: MATCHING_STYLES,
      bindings: { "background-color": "primary" },
      tokenAliases: { "color/background/brand/default": "primary" },
    });
    const row = binding(dimensions, "background-color");
    expect(row.status).toBe("match");
    expect(row.nameResolvedBy).toBe("alias");
    expect(row.note).toContain("Same token by `tokenAliases`");
  });

  it("records `heuristic` when spelling alone reconciled the two", async () => {
    const dimensions = await check({
      styles: MATCHING_STYLES,
      bindings: { "padding-top": "--space-150" },
    });
    const row = binding(dimensions, "padding-top");
    expect(row.status).toBe("match");
    expect(row.nameResolvedBy).toBe("heuristic");
    expect(row.note).toContain("different naming convention");
  });

  it("turns a value drift into a TOKEN-layer finding once the alias reconciles the names", async () => {
    // With the alias in place the binding matches, so the row says "the code
    // points at the right token and its value moved" — which is what makes the
    // fix prompt state the layer instead of proposing a class swap.
    const dimensions = await check({
      styles: { ...MATCHING_STYLES, "background-color": "rgb(255, 0, 0)" },
      bindings: { "background-color": "primary" },
      tokenAliases: { "color/background/brand/default": "primary" },
    });
    expect(value(dimensions, "background-color").status).toBe("drift");
    expect(binding(dimensions, "background-color").status).toBe("match");
  });

  it("contradicting the alias is not silently matched on spelling", async () => {
    const dimensions = await check({
      styles: MATCHING_STYLES,
      bindings: { "padding-top": "space-150" },
      tokenAliases: { "space/150": "spacing-lg" },
    });
    const row = binding(dimensions, "padding-top");
    expect(row.status).toBe("advisory");
    expect(row.note).toContain("maps `space/150` to `spacing-lg`");
  });
});
