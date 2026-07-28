import { afterEach, describe, expect, it, vi } from "vitest";
import type { DimensionDiff } from "../dimensions/types.js";
import { createFigmaRestEngine } from "./figma-rest.js";

/**
 * Regression coverage for COLOR-variable resolution in the `token-value`
 * dimension.
 *
 * The bug this pins down: Figma's `GET /variables/local` returns a
 * variable's `valuesByMode` entry either as a literal `{r,g,b,a}` (floats
 * 0..1) **or** as `{type:"VARIABLE_ALIAS", id}` pointing at another
 * variable — semantic tokens almost always take the second form. The reader
 * only understood the first, and on anything else fell back to putting the
 * variable's *name* in the `figmaValue` cell. A name can never equal a
 * computed `rgb()` string, so every colour property reported `drift`.
 *
 * Fixture values are the real shapes from the Simple Design System file
 * (`Nq23XwGfazYZZZ5vr8OezI`):
 *
 *   Border/Neutral/Secondary  [Color / SDS Light]  → alias → Slate/600
 *   Slate/600                 [Color Primitives / Value] → rgb(118, 118, 118)
 *   Border/Neutral/Secondary  [Color / SDS Dark]   → alias → Slate/500
 *   Slate/500                 [Color Primitives / Value] → rgb(148, 148, 148)
 *
 * Note the mode names: `"SDS Light"` / `"SDS Dark"`, not `"light"` / `"dark"`.
 * The alias target lives in a *different* collection with a single `"Value"`
 * mode, so each hop has to resolve modes against its own collection.
 */

const FILE_KEY = "Nq23XwGfazYZZZ5vr8OezI";
const NODE_ID = "4185:3778";

const COLOR_COLLECTION = "VariableCollectionId:3919:20";
const PRIMITIVES_COLLECTION = "VariableCollectionId:3919:1";
const SIZE_COLLECTION = "VariableCollectionId:100:1";

const BORDER_NEUTRAL_SECONDARY = "VariableID:3919:36516";
const SLATE_600 = "VariableID:3919:36539";
const SLATE_500 = "VariableID:3919:36538";
const SPACE_300 = "VariableID:100:10";
const SPACE_300_ALIAS_TARGET = "VariableID:100:11";

/** 118/255 — Slate/600 as Figma stores it. */
const SLATE_600_FLOAT = 0.4628731310367584;
/** 148/255 — Slate/500. */
const SLATE_500_FLOAT = 0.5795747637748718;

function variablesResponse() {
  return {
    meta: {
      variableCollections: {
        [COLOR_COLLECTION]: {
          id: COLOR_COLLECTION,
          name: "Color",
          defaultModeId: "3919:21",
          modes: [
            { modeId: "3919:21", name: "SDS Light" },
            { modeId: "3919:22", name: "SDS Dark" },
          ],
        },
        [PRIMITIVES_COLLECTION]: {
          id: PRIMITIVES_COLLECTION,
          name: "Color Primitives",
          defaultModeId: "3919:2",
          modes: [{ modeId: "3919:2", name: "Value" }],
        },
        [SIZE_COLLECTION]: {
          id: SIZE_COLLECTION,
          name: "Size",
          defaultModeId: "100:2",
          modes: [{ modeId: "100:2", name: "Default" }],
        },
      },
      variables: {
        [BORDER_NEUTRAL_SECONDARY]: {
          id: BORDER_NEUTRAL_SECONDARY,
          name: "Border/Neutral/Secondary",
          resolvedType: "COLOR",
          variableCollectionId: COLOR_COLLECTION,
          valuesByMode: {
            "3919:21": { type: "VARIABLE_ALIAS", id: SLATE_600 },
            "3919:22": { type: "VARIABLE_ALIAS", id: SLATE_500 },
          },
        },
        [SLATE_600]: {
          id: SLATE_600,
          name: "Slate/600",
          resolvedType: "COLOR",
          variableCollectionId: PRIMITIVES_COLLECTION,
          valuesByMode: {
            "3919:2": { r: SLATE_600_FLOAT, g: SLATE_600_FLOAT, b: SLATE_600_FLOAT, a: 1 },
          },
        },
        [SLATE_500]: {
          id: SLATE_500,
          name: "Slate/500",
          resolvedType: "COLOR",
          variableCollectionId: PRIMITIVES_COLLECTION,
          valuesByMode: {
            "3919:2": { r: SLATE_500_FLOAT, g: SLATE_500_FLOAT, b: SLATE_500_FLOAT, a: 1 },
          },
        },
        // A FLOAT variable that also aliases — the same indirection on the
        // numeric side dropped the row entirely instead of mis-reporting it.
        [SPACE_300]: {
          id: SPACE_300,
          name: "Space/300",
          resolvedType: "FLOAT",
          variableCollectionId: SIZE_COLLECTION,
          valuesByMode: { "100:2": { type: "VARIABLE_ALIAS", id: SPACE_300_ALIAS_TARGET } },
        },
        [SPACE_300_ALIAS_TARGET]: {
          id: SPACE_300_ALIAS_TARGET,
          name: "Dimension/300",
          resolvedType: "FLOAT",
          variableCollectionId: SIZE_COLLECTION,
          valuesByMode: { "100:2": 12 },
        },
      },
    },
  };
}

/** A stroked FRAME whose stroke colour is bound to the aliasing variable. */
function nodeResponse(overrides: Record<string, unknown> = {}) {
  return {
    nodes: {
      [NODE_ID]: {
        document: {
          id: NODE_ID,
          name: "Button",
          type: "FRAME",
          strokes: [
            {
              blendMode: "NORMAL",
              type: "SOLID",
              // Figma also hands back the *resolved* paint colour, for the
              // file's own default mode context.
              color: { r: SLATE_600_FLOAT, g: SLATE_600_FLOAT, b: SLATE_600_FLOAT, a: 1 },
              boundVariables: { color: { type: "VARIABLE_ALIAS", id: BORDER_NEUTRAL_SECONDARY } },
            },
          ],
          strokeWeight: 1,
          fills: [],
          boundVariables: { paddingTop: { type: "VARIABLE_ALIAS", id: SPACE_300 } },
          paddingTop: 12,
          children: [],
          ...overrides,
        },
      },
    },
  };
}

function installFetchStub(opts: { variables?: unknown; node?: unknown } = {}): void {
  const variables = opts.variables ?? variablesResponse();
  const node = opts.node ?? nodeResponse();
  vi.stubGlobal("fetch", async (url: string) => {
    const json = (body: unknown): Response =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (url.includes("/variables/local")) return json(variables);
    if (url.includes("/nodes?ids=")) return json(node);
    if (url.includes("/components")) return json({ meta: { components: [] } });
    return json({ lastModified: "2026-07-27T00:00:00Z" });
  });
}

async function check(opts: {
  styles: Record<string, string>;
  mode?: string;
  variables?: unknown;
  node?: unknown;
}): Promise<DimensionDiff[]> {
  installFetchStub({ variables: opts.variables, node: opts.node });
  // No `cachePath` — keeps the persistent cache out of the picture.
  const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
  const report = await engine.checkDrift({
    storyId: "components-button--primary",
    nodeRef: { fileKey: FILE_KEY, nodeId: NODE_ID },
    snapshot: { styles: opts.styles },
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  return report.dimensions;
}

function row(dimensions: DimensionDiff[], property: string): DimensionDiff {
  const found = dimensions.find((d) => d.kind === "token-value" && d.property === property);
  if (!found) {
    throw new Error(
      `no token-value row for "${property}" — got [${dimensions
        .filter((d) => d.kind === "token-value")
        .map((d) => d.property)
        .join(", ")}]`,
    );
  }
  return found;
}

/**
 * Code side of the SDS Button, verified byte-exact by computed-style compare.
 * All four edges carry the colour because `pickBorderEdge` chooses whichever
 * edge is actually drawn (bottom first) — setting only `border-top-color`
 * tests nothing.
 */
function styles(borderColor = "rgb(118, 118, 118)"): Record<string, string> {
  return {
    "border-top-width": "1px",
    "border-right-width": "1px",
    "border-bottom-width": "1px",
    "border-left-width": "1px",
    "border-top-color": borderColor,
    "border-right-color": borderColor,
    "border-bottom-color": borderColor,
    "border-left-color": borderColor,
    "padding-top": "12px",
  };
}

const MATCHING_STYLES = styles();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token-value: COLOR variables that alias another variable", () => {
  it("reports `match` when the code colour equals the aliased variable's value", async () => {
    const dimensions = await check({ styles: MATCHING_STYLES });
    const borderColor = row(dimensions, "border-color");

    expect(borderColor.status).toBe("match");
  });

  it("puts a concrete colour — never a bare token name — in the figma cell", async () => {
    const dimensions = await check({ styles: MATCHING_STYLES });
    const borderColor = row(dimensions, "border-color");

    expect(borderColor.figmaValue).toBe("rgb(118, 118, 118)");
    // The token name belongs in its own field, where the fix-prompt and
    // value-drift paths look for it.
    expect(borderColor.tokenName).toBe("Border/Neutral/Secondary");
  });

  it("still reports `drift` when the code colour genuinely differs", async () => {
    const dimensions = await check({ styles: styles("rgb(255, 0, 0)") });
    const borderColor = row(dimensions, "border-color");

    expect(borderColor.status).toBe("drift");
    expect(borderColor.figmaValue).toBe("rgb(118, 118, 118)");
  });

  it("carries the light/dark map through modes named `SDS Light` / `SDS Dark`", async () => {
    const dimensions = await check({ styles: MATCHING_STYLES });
    const borderColor = row(dimensions, "border-color");

    expect(borderColor.modes).toEqual({
      light: "rgb(118, 118, 118)",
      dark: "rgb(148, 148, 148)",
    });
  });

  it("compares against the dark mode's value when the story renders dark", async () => {
    const dimensions = await check({ styles: styles("rgb(148, 148, 148)"), mode: "dark" });
    const borderColor = row(dimensions, "border-color");

    expect(borderColor.figmaValue).toBe("rgb(148, 148, 148)");
    expect(borderColor.status).toBe("match");
  });

  it("resolves a bound background-color through the same alias chain", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(118, 118, 118)" },
      node: nodeResponse({
        strokes: [],
        fills: [
          {
            type: "SOLID",
            color: { r: SLATE_600_FLOAT, g: SLATE_600_FLOAT, b: SLATE_600_FLOAT, a: 1 },
            boundVariables: { color: { type: "VARIABLE_ALIAS", id: BORDER_NEUTRAL_SECONDARY } },
          },
        ],
      }),
    });
    const background = row(dimensions, "background-color");

    expect(background.figmaValue).toBe("rgb(118, 118, 118)");
    expect(background.status).toBe("match");
    expect(background.tokenName).toBe("Border/Neutral/Secondary");
  });
});

describe("token-value: unresolvable COLOR variables stay honest", () => {
  it("falls back to the paint's own resolved colour when the variable is missing", async () => {
    const stripped = variablesResponse();
    delete (stripped.meta.variables as Record<string, unknown>)[SLATE_600];
    delete (stripped.meta.variables as Record<string, unknown>)[SLATE_500];

    const dimensions = await check({ styles: MATCHING_STYLES, variables: stripped });
    const borderColor = row(dimensions, "border-color");

    // The node's `strokes[0].color` is a real, resolved colour — using it
    // beats reporting the token name and calling it drift.
    expect(borderColor.figmaValue).toBe("rgb(118, 118, 118)");
    expect(borderColor.status).toBe("match");
  });

  it("never reports drift on the strength of a token name alone", async () => {
    const dimensions = await check({
      styles: MATCHING_STYLES,
      variables: variablesResponse(),
      // No resolved paint colour and an alias that leads nowhere: the engine
      // has no Figma-side value at all, so it must not claim drift.
      node: nodeResponse({
        strokes: [
          {
            type: "SOLID",
            boundVariables: { color: { type: "VARIABLE_ALIAS", id: "VariableID:nope" } },
          },
        ],
      }),
    });
    const borderColor = row(dimensions, "border-color");

    expect(borderColor.figmaValue).toBeNull();
    expect(borderColor.status).toBe("flag-only");
  });

  it("does not loop forever on a self-referential alias", async () => {
    const cyclic = variablesResponse();
    (cyclic.meta.variables as Record<string, { valuesByMode: Record<string, unknown> }>)[
      SLATE_600
    ]!.valuesByMode = { "3919:2": { type: "VARIABLE_ALIAS", id: BORDER_NEUTRAL_SECONDARY } };

    const dimensions = await check({ styles: MATCHING_STYLES, variables: cyclic });
    const borderColor = row(dimensions, "border-color");

    // Cycle detected → no variable value → fall back to the paint colour.
    expect(borderColor.figmaValue).toBe("rgb(118, 118, 118)");
  });
});

describe("token-value: mode handling", () => {
  it("does not invent a light/dark map for a single-mode collection", async () => {
    // Move the semantic colour into the primitives collection, which has one
    // `Value` mode. Asking it for "light" must come back empty rather than
    // answering with the default and implying the token is mode-aware.
    const singleMode = variablesResponse();
    const vars = singleMode.meta.variables as Record<
      string,
      { variableCollectionId: string; valuesByMode: Record<string, unknown> }
    >;
    vars[BORDER_NEUTRAL_SECONDARY]!.variableCollectionId = PRIMITIVES_COLLECTION;
    vars[BORDER_NEUTRAL_SECONDARY]!.valuesByMode = {
      "3919:2": { type: "VARIABLE_ALIAS", id: SLATE_600 },
    };

    const dimensions = await check({ styles: MATCHING_STYLES, variables: singleMode });
    const borderColor = row(dimensions, "border-color");

    expect(borderColor.figmaValue).toBe("rgb(118, 118, 118)");
    expect(borderColor.modes).toBeUndefined();
  });

  it("falls back to the default mode when the named mode has no value", async () => {
    // `Color` names an `SDS Dark` mode but this variable only defines a value
    // for `SDS Light` — pre-existing lenient behaviour, kept.
    const partial = variablesResponse();
    (partial.meta.variables as Record<string, { valuesByMode: Record<string, unknown> }>)[
      BORDER_NEUTRAL_SECONDARY
    ]!.valuesByMode = { "3919:21": { type: "VARIABLE_ALIAS", id: SLATE_600 } };

    const dimensions = await check({
      styles: MATCHING_STYLES,
      variables: partial,
      mode: "dark",
    });
    const borderColor = row(dimensions, "border-color");

    expect(borderColor.figmaValue).toBe("rgb(118, 118, 118)");
    expect(borderColor.status).toBe("match");
  });
});

describe("token-value: FLOAT variables that alias another variable", () => {
  it("resolves through the alias instead of dropping the row", async () => {
    const dimensions = await check({ styles: MATCHING_STYLES });
    const paddingTop = row(dimensions, "padding-top");

    expect(paddingTop.figmaValue).toBe("12px (token: Space/300)");
    expect(paddingTop.status).toBe("match");
  });
});
