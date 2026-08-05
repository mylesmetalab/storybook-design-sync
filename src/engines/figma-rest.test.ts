import { afterEach, describe, expect, it, vi } from "vitest";
import type { DimensionDiff } from "../dimensions/types.js";
import type { CodeSnapshot } from "./types.js";
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
  /**
   * Extra snapshot fields. Left off by default so every pre-existing case keeps
   * sending a snapshot with no `ownText` — which the applicability predicate
   * treats as "not probed" and therefore compares exactly as before.
   */
  snapshot?: Partial<CodeSnapshot>;
  nodeId?: string;
}): Promise<DimensionDiff[]> {
  installFetchStub({ variables: opts.variables, node: opts.node });
  // No `cachePath` — keeps the persistent cache out of the picture.
  const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
  const report = await engine.checkDrift({
    storyId: "components-button--primary",
    nodeRef: { fileKey: FILE_KEY, nodeId: opts.nodeId ?? NODE_ID },
    snapshot: { styles: opts.styles, ...opts.snapshot },
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  return report.dimensions;
}

function maybeRow(dimensions: DimensionDiff[], property: string): DimensionDiff | undefined {
  return dimensions.find((d) => d.kind === "token-value" && d.property === property);
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

/**
 * The `variant-set` row is a CSS-era comparison: it matches Figma's variant
 * values against BEM `--` suffixes and adjacent modifier classes. On a
 * shadcn/cva component that premise is structurally false — variants are cva
 * keys selected by props — and reported anyway the row swept all 25 utility
 * classes into its "code variants" cell, claimed the Figma variants were
 * missing from code, and advised adding a BEM modifier rule.
 *
 * These pin the row's applicability end-to-end, through the report the panel
 * and the CLI both read.
 */
const CVA_BUTTON_CLASSES = [
  "inline-flex", "items-center", "justify-center", "gap-2", "whitespace-nowrap",
  "rounded-md", "text-sm", "font-medium", "transition-all",
  "disabled:pointer-events-none", "disabled:opacity-50",
  "[&_svg]:pointer-events-none", "shrink-0", "outline-none",
  "focus-visible:border-ring", "focus-visible:ring-ring/50", "bg-primary",
  "text-primary-foreground", "shadow-xs", "hover:bg-primary/90", "h-9", "px-4",
];

async function variantCheck(opts: {
  variantName: string;
  rootClasses: string[];
  variantClasses?: string[];
  args?: Record<string, unknown>;
  storyId?: string;
}): Promise<DimensionDiff[]> {
  installFetchStub({
    node: nodeResponse({ name: opts.variantName, type: "COMPONENT" }),
  });
  const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
  const report = await engine.checkDrift({
    storyId: opts.storyId ?? "components-button--default",
    nodeRef: { fileKey: FILE_KEY, nodeId: NODE_ID },
    snapshot: {
      styles: MATCHING_STYLES,
      rootClasses: opts.rootClasses,
      variantClasses: opts.variantClasses ?? [],
    },
    args: opts.args ?? {},
  });
  return report.dimensions;
}

function variantSetRow(dimensions: DimensionDiff[]): DimensionDiff | undefined {
  return dimensions.find((d) => d.kind === "variant-set");
}

describe("variant-set: only reported when modifier classes are the actual mechanism", () => {
  it("emits no row for a cva/Tailwind component (props select the variant, not classes)", async () => {
    const dimensions = await variantCheck({
      variantName: "Variant=Primary, Size=Medium",
      rootClasses: CVA_BUTTON_CLASSES,
      variantClasses: CVA_BUTTON_CLASSES.slice(1),
      args: { variant: "primary", size: "medium" },
    });

    expect(variantSetRow(dimensions)).toBeUndefined();
    // …and the check that DOES apply to this architecture still runs.
    const props = dimensions.filter((d) => d.kind === "props");
    expect(props.map((d) => d.property).sort()).toEqual(["Size", "Variant"]);
    expect(props.every((d) => d.status === "match")).toBe(true);
  });

  it("stays suppressed on a cva component even when the props rows drift", async () => {
    // The class-list evidence rule has to carry this on its own: with props
    // disagreeing there is no redundancy argument, and the row would still be
    // reporting a modifier convention the component doesn't use.
    const dimensions = await variantCheck({
      variantName: "Variant=Primary, Size=Medium",
      rootClasses: CVA_BUTTON_CLASSES,
      variantClasses: CVA_BUTTON_CLASSES.slice(1),
      args: { variant: "ghost", size: "large" },
    });

    expect(variantSetRow(dimensions)).toBeUndefined();
    expect(dimensions.filter((d) => d.kind === "props" && d.status === "drift")).toHaveLength(2);
  });

  it("still reports a BEM component's genuinely missing modifier, message unchanged", async () => {
    const dimensions = await variantCheck({
      variantName: "Variant=Accent, State=Hover",
      rootClasses: ["icon-button", "icon-button--accent"],
      variantClasses: ["accent"],
      args: { variant: "accent" },
      storyId: "components-iconbutton--accent",
    });

    const row = variantSetRow(dimensions);
    expect(row?.property).toBe("active-variant");
    expect(row?.status).toBe("drift");
    expect(row?.note).toBe("Figma variants not present in code: [State=Hover]");
  });

  it("still reports `match` for a BEM component whose modifiers are all present", async () => {
    const dimensions = await variantCheck({
      variantName: "Variant=Accent",
      rootClasses: ["icon-button", "icon-button--accent"],
      variantClasses: ["accent"],
      storyId: "components-iconbutton--accent",
    });

    expect(variantSetRow(dimensions)?.status).toBe("match");
  });

  it("drops the row once matching props rows cover every Figma axis", async () => {
    const dimensions = await variantCheck({
      variantName: "Variant=Accent",
      rootClasses: ["icon-button", "icon-button--accent"],
      variantClasses: ["accent"],
      args: { variant: "accent" },
      storyId: "components-iconbutton--accent",
    });

    expect(variantSetRow(dimensions)).toBeUndefined();
    expect(dimensions.find((d) => d.kind === "props" && d.property === "Variant")?.status).toBe(
      "match",
    );
  });

  it("keeps the row when the snapshot predates rootClasses (evidence unknown)", async () => {
    installFetchStub({
      node: nodeResponse({ name: "Variant=Accent, State=Hover", type: "COMPONENT" }),
    });
    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const report = await engine.checkDrift({
      storyId: "components-iconbutton--accent",
      nodeRef: { fileKey: FILE_KEY, nodeId: NODE_ID },
      snapshot: { styles: MATCHING_STYLES, variantClasses: ["accent"] },
      args: { variant: "accent" },
    });

    expect(variantSetRow(report.dimensions)?.status).toBe("drift");
  });
});

/* -------------------------------------------------------------------------- *
 * Text-style properties, end to end
 * -------------------------------------------------------------------------- */

/**
 * `letter-spacing`, `text-align`, `text-transform`, `text-decoration-line`,
 * `font-style` and `box-shadow` were all mapped in `FIGMA_KEY_TO_CSS` and all
 * collected (or, for `font-style`, now collected) by the snapshot — but the
 * value dimension read none of them, so a designer could change any of them in
 * Figma and the auditor said nothing at all.
 *
 * These run through the real engine, because the property that matters most is
 * the *absence* of a row: `text-style-map.ts` covers the mapping tables, and
 * this covers what actually reaches the report.
 */
function textChild(style: Record<string, unknown> | undefined, characters = "Submit") {
  return {
    id: "4185:3779",
    name: "Label",
    type: "TEXT",
    characters,
    ...(style ? { style } : {}),
    fills: [],
    children: [],
  };
}

async function textCheck(opts: {
  style: Record<string, unknown> | undefined;
  styles: Record<string, string>;
  characters?: string;
  effects?: unknown;
}): Promise<DimensionDiff[]> {
  return check({
    styles: opts.styles,
    node: nodeResponse({
      strokes: [],
      children: [textChild(opts.style, opts.characters)],
      ...(opts.effects !== undefined ? { effects: opts.effects } : {}),
    }),
  });
}

interface TextStyleCase {
  name: string;
  style: Record<string, unknown> | undefined;
  styles: Record<string, string>;
  characters?: string;
  /** Expected status, or `null` for "no row must be emitted". */
  expected: DimensionDiff["status"] | null;
}

const TEXT_STYLE_CASES: Record<string, TextStyleCase[]> = {
  "letter-spacing": [
    {
      name: "match",
      style: { fontSize: 14, letterSpacing: 0.5 },
      styles: { "letter-spacing": "0.5px" },
      expected: "match",
    },
    {
      name: "drift",
      style: { fontSize: 14, letterSpacing: 0.5 },
      styles: { "letter-spacing": "1.5px" },
      expected: "drift",
    },
    {
      name: "absent on the Figma side → no row",
      style: { fontSize: 14 },
      styles: { "letter-spacing": "1.5px" },
      expected: null,
    },
  ],
  "text-align": [
    {
      name: "match",
      style: { fontSize: 14, textAlignHorizontal: "CENTER" },
      styles: { "text-align": "center", direction: "ltr" },
      expected: "match",
    },
    {
      name: "drift",
      style: { fontSize: 14, textAlignHorizontal: "CENTER" },
      styles: { "text-align": "right", direction: "ltr" },
      expected: "drift",
    },
    {
      name: "absent on the Figma side → no row (auto-layout owns placement)",
      style: { fontSize: 14 },
      styles: { "text-align": "center", direction: "ltr" },
      expected: null,
    },
  ],
  "text-transform": [
    {
      name: "match",
      style: { fontSize: 14, textCase: "UPPER" },
      styles: { "text-transform": "uppercase" },
      expected: "match",
    },
    {
      name: "drift",
      style: { fontSize: 14, textCase: "UPPER" },
      styles: { "text-transform": "none" },
      expected: "drift",
    },
    {
      name: "small-caps has no `text-transform` equivalent → no row",
      style: { fontSize: 14, textCase: "SMALL_CAPS" },
      styles: { "text-transform": "uppercase" },
      expected: null,
    },
  ],
  "text-decoration-line": [
    {
      name: "match",
      style: { fontSize: 14, textDecoration: "STRIKETHROUGH" },
      styles: { "text-decoration-line": "line-through" },
      expected: "match",
    },
    {
      name: "drift",
      style: { fontSize: 14, textDecoration: "STRIKETHROUGH" },
      styles: { "text-decoration-line": "underline" },
      expected: "drift",
    },
    {
      name: "neither side decorates → no row",
      style: { fontSize: 14 },
      styles: { "text-decoration-line": "none" },
      expected: null,
    },
  ],
  "font-style": [
    {
      name: "match",
      style: { fontSize: 14, italic: true },
      styles: { "font-style": "italic" },
      expected: "match",
    },
    {
      name: "drift",
      style: { fontSize: 14, italic: true },
      styles: { "font-style": "normal" },
      expected: "drift",
    },
    {
      // Without a `style` object we can't tell "not italic" from "this response
      // has no typography in it", so nothing is claimed.
      name: "TEXT node with no style object → no row",
      style: undefined,
      styles: { "font-style": "italic" },
      expected: null,
    },
  ],
};

for (const [property, cases] of Object.entries(TEXT_STYLE_CASES)) {
  describe(`token-value: ${property}`, () => {
    for (const c of cases) {
      it(c.name, async () => {
        const dimensions = await textCheck({
          style: c.style,
          styles: c.styles,
          ...(c.characters ? { characters: c.characters } : {}),
        });
        const found = maybeRow(dimensions, property);
        if (c.expected === null) {
          expect(found).toBeUndefined();
        } else {
          expect(found?.status).toBe(c.expected);
        }
      });
    }
  });
}

describe("token-value: text-transform when Figma declares no case", () => {
  it("drifts when code uppercases a mixed-case Figma label", async () => {
    const dimensions = await textCheck({
      style: { fontSize: 14 },
      styles: { "text-transform": "uppercase" },
      characters: "Submit",
    });
    expect(row(dimensions, "text-transform").status).toBe("drift");
  });

  it("does not drift when the Figma label is already typed in caps", async () => {
    const dimensions = await textCheck({
      style: { fontSize: 14 },
      styles: { "text-transform": "uppercase" },
      characters: "SUBMIT",
    });
    expect(row(dimensions, "text-transform").status).toBe("flag-only");
  });
});

/* -------------------------------------------------------------------------- *
 * box-shadow, end to end
 * -------------------------------------------------------------------------- */

const FIGMA_DROP_SHADOW = {
  type: "DROP_SHADOW",
  visible: true,
  blendMode: "NORMAL",
  offset: { x: 0, y: 2 },
  radius: 4,
  spread: 0,
  color: { r: 0, g: 0, b: 0, a: 0.25 },
};

describe("token-value: box-shadow", () => {
  it("matches the same shadow despite the computed string putting colour first", async () => {
    // The pre-fix code compared normalized strings and its status expression was
    // `drift : drift` — this exact case could never be reported as agreement.
    const dimensions = await textCheck({
      style: { fontSize: 14 },
      styles: { "box-shadow": "rgba(0, 0, 0, 0.25) 0px 2px 4px 0px" },
      effects: [FIGMA_DROP_SHADOW],
    });
    const shadow = row(dimensions, "box-shadow");
    expect(shadow.status).toBe("match");
    expect(shadow.figmaValue).toBe("0px 2px 4px 0px rgba(0,0,0,0.25)");
  });

  it("reports drift on a real difference", async () => {
    const dimensions = await textCheck({
      style: { fontSize: 14 },
      styles: { "box-shadow": "rgba(0, 0, 0, 0.25) 0px 8px 4px 0px" },
      effects: [FIGMA_DROP_SHADOW],
    });
    expect(row(dimensions, "box-shadow").status).toBe("drift");
  });

  it("maps INNER_SHADOW to `inset`", async () => {
    const dimensions = await textCheck({
      style: { fontSize: 14 },
      styles: { "box-shadow": "rgba(0, 0, 0, 0.25) 0px 2px 4px 0px inset" },
      effects: [{ ...FIGMA_DROP_SHADOW, type: "INNER_SHADOW" }],
    });
    expect(row(dimensions, "box-shadow").status).toBe("match");
  });

  it("drifts when Figma declares no shadow and code draws one", async () => {
    const dimensions = await textCheck({
      style: { fontSize: 14 },
      styles: { "box-shadow": "rgba(0, 0, 0, 0.25) 0px 2px 4px 0px" },
      effects: [],
    });
    const shadow = row(dimensions, "box-shadow");
    expect(shadow.status).toBe("drift");
    expect(shadow.figmaValue).toBe("none");
  });

  it("emits no row when an effect shape can't be faithfully compared", async () => {
    const dimensions = await textCheck({
      style: { fontSize: 14 },
      styles: { "box-shadow": "rgba(0, 0, 0, 0.25) 0px 2px 4px 0px" },
      effects: [{ ...FIGMA_DROP_SHADOW, blendMode: "MULTIPLY" }],
    });
    expect(maybeRow(dimensions, "box-shadow")).toBeUndefined();
  });

  it("emits no row when Figma reported no effects at all", async () => {
    const dimensions = await textCheck({
      style: { fontSize: 14 },
      styles: { "box-shadow": "rgba(0, 0, 0, 0.25) 0px 2px 4px 0px" },
    });
    expect(maybeRow(dimensions, "box-shadow")).toBeUndefined();
  });

  it("emits no row when neither side has a shadow", async () => {
    const dimensions = await textCheck({
      style: { fontSize: 14 },
      styles: { "box-shadow": "none" },
      effects: [],
    });
    expect(maybeRow(dimensions, "box-shadow")).toBeUndefined();
  });

  it("names the bound effect token in the Figma cell", async () => {
    const dimensions = await check({
      styles: { "box-shadow": "rgba(0, 0, 0, 0.25) 0px 2px 4px 0px" },
      node: nodeResponse({
        strokes: [],
        effects: [FIGMA_DROP_SHADOW],
        boundVariables: { effects: { type: "VARIABLE_ALIAS", id: BORDER_NEUTRAL_SECONDARY } },
      }),
    });
    const shadow = row(dimensions, "box-shadow");
    expect(shadow.figmaValue).toContain("(token: Border/Neutral/Secondary)");
    expect(shadow.status).toBe("match");
  });

  /**
   * addon#106 — Tailwind v4 composes `box-shadow` from independent
   * inset-ring/ring-offset/ring/shadow slots and fills every UNUSED slot with
   * `0 0 #0000` rather than omitting it, so `getComputedStyle` hands back six
   * layers for a component with two real shadows. Figma has no opinion about
   * the four placeholder slots — they paint nothing — so comparing them was
   * the wrong question, and reported drift on every shadowed Tailwind v4
   * component forever.
   */
  describe("Tailwind v4's transparent placeholder shadow layers", () => {
    const TAILWIND_V4_SHADOW =
      "0px 0px #0000, 0px 0px #0000, 0px 0px #0000, 0px 0px #0000, " +
      "0px 2px 4px 0px rgba(0, 0, 0, 0.25)";

    it("matches when the real layers agree, ignoring the four transparent placeholders", async () => {
      const dimensions = await textCheck({
        style: { fontSize: 14 },
        styles: { "box-shadow": TAILWIND_V4_SHADOW },
        effects: [FIGMA_DROP_SHADOW],
      });
      const shadow = row(dimensions, "box-shadow");
      expect(shadow.status).toBe("match");
    });

    it("says how many placeholder layers were dropped and why", async () => {
      const dimensions = await textCheck({
        style: { fontSize: 14 },
        styles: { "box-shadow": TAILWIND_V4_SHADOW },
        effects: [FIGMA_DROP_SHADOW],
      });
      const shadow = row(dimensions, "box-shadow");
      expect(shadow.note).toMatch(/4.*transparent/i);
    });

    it("still reports drift when a real layer genuinely differs", async () => {
      const dimensions = await textCheck({
        style: { fontSize: 14 },
        // Real layer's blur (8px) doesn't match Figma's (4px).
        styles: {
          "box-shadow":
            "0px 0px #0000, 0px 0px #0000, 0px 0px #0000, 0px 0px #0000, " +
            "0px 2px 8px 0px rgba(0, 0, 0, 0.25)",
        },
        effects: [FIGMA_DROP_SHADOW],
      });
      expect(row(dimensions, "box-shadow").status).toBe("drift");
    });

    it("emits no row when every code-side layer is a transparent placeholder and Figma has no shadow", async () => {
      const dimensions = await textCheck({
        style: { fontSize: 14 },
        styles: {
          "box-shadow": "0px 0px #0000, 0px 0px #0000, 0px 0px #0000, 0px 0px #0000",
        },
        effects: [],
      });
      expect(maybeRow(dimensions, "box-shadow")).toBeUndefined();
    });
  });
});

/* -------------------------------------------------------------------------- *
 * Component properties (props dimension), end to end
 * -------------------------------------------------------------------------- */

function propsRows(dimensions: DimensionDiff[]): DimensionDiff[] {
  return dimensions.filter((d) => d.kind === "props");
}

function propsRow(dimensions: DimensionDiff[], property: string): DimensionDiff | undefined {
  return dimensions.find((d) => d.kind === "props" && d.property === property);
}

async function propsCheck(opts: {
  node: Record<string, unknown>;
  args: Record<string, unknown>;
}): Promise<DimensionDiff[]> {
  installFetchStub({ node: nodeResponse({ strokes: [], ...opts.node }) });
  const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
  const report = await engine.checkDrift({
    storyId: "components-button--with-icon",
    nodeRef: { fileKey: FILE_KEY, nodeId: NODE_ID },
    snapshot: { styles: MATCHING_STYLES, rootClasses: ["button", "button--primary"] },
    args: opts.args,
  });
  return report.dimensions;
}

describe("props: Figma component properties vs story args", () => {
  it("confirms a BOOLEAN property against the presence of the matching arg", async () => {
    const dimensions = await propsCheck({
      node: {
        type: "INSTANCE",
        componentProperties: { "Has Icon Start#4611:0": { type: "BOOLEAN", value: true } },
      },
      args: { iconStart: "★" },
    });
    expect(propsRow(dimensions, "Has Icon Start")).toMatchObject({
      status: "match",
      figmaValue: true,
    });
  });

  it("reports drift when the instance carries the icon and the story doesn't", async () => {
    const dimensions = await propsCheck({
      node: {
        type: "INSTANCE",
        componentProperties: { "Has Icon Start#4611:0": { type: "BOOLEAN", value: true } },
      },
      args: { iconStart: null },
    });
    expect(propsRow(dimensions, "Has Icon Start")?.status).toBe("drift");
  });

  it("emits no row when the arg correspondence is ambiguous", async () => {
    const dimensions = await propsCheck({
      node: {
        type: "INSTANCE",
        componentProperties: { "Has Icon Start#4611:0": { type: "BOOLEAN", value: true } },
      },
      args: { iconStart: "★", isIconStart: true },
    });
    expect(propsRow(dimensions, "Has Icon Start")).toBeUndefined();
  });

  it("emits no comparison row for an INSTANCE_SWAP, only an unmodelled note", async () => {
    const dimensions = await propsCheck({
      node: {
        type: "INSTANCE",
        componentProperties: { "Icon Start#4611:2": { type: "INSTANCE_SWAP", value: "1:23" } },
      },
      args: { iconStart: "★" },
    });
    expect(propsRow(dimensions, "Icon Start")).toBeUndefined();
    const unmodelled = propsRow(dimensions, "instance-swap");
    expect(unmodelled?.status).toBe("flag-only");
    expect(unmodelled?.figmaValue).toEqual(["Icon Start"]);
  });

  it("reports a TEXT property once — via `copy`, not twice", async () => {
    const dimensions = await propsCheck({
      node: {
        type: "INSTANCE",
        componentProperties: { "Label#4611:1": { type: "TEXT", value: "Submit" } },
        children: [textChild({ fontSize: 14 }, "Submit")],
      },
      args: { label: "Submit" },
    });
    // `copy` owns the string…
    const copy = dimensions.filter((d) => d.kind === "copy");
    expect(copy).toHaveLength(1);
    expect(copy[0]?.figmaValue).toBe("Submit");
    // …so the component property adds nothing.
    expect(propsRow(dimensions, "Label")).toBeUndefined();
  });

  it("compares a TEXT property that `copy` does not already cover", async () => {
    const dimensions = await propsCheck({
      node: {
        type: "INSTANCE",
        componentProperties: { "Badge Text#4611:3": { type: "TEXT", value: "New" } },
        children: [textChild({ fontSize: 14 }, "Submit")],
      },
      args: { badgeText: "Old" },
    });
    expect(propsRow(dimensions, "Badge Text")?.status).toBe("drift");
  });

  it("keeps component-property rows alongside the variant-axis rows", async () => {
    const dimensions = await propsCheck({
      node: {
        type: "COMPONENT",
        name: "Variant=Primary",
        componentPropertyDefinitions: {
          Variant: { type: "VARIANT", defaultValue: "Primary", variantOptions: ["Primary"] },
          "Has Icon Start#4611:0": { type: "BOOLEAN", defaultValue: true },
        },
      },
      args: { variant: "primary", iconStart: "★" },
    });
    expect(propsRows(dimensions).map((d) => d.property)).toEqual(["Variant", "Has Icon Start"]);
    expect(propsRows(dimensions).every((d) => d.status === "match")).toBe(true);
  });

  it("does not report drift against a component *default*", async () => {
    const dimensions = await propsCheck({
      node: {
        type: "COMPONENT",
        name: "Variant=Primary",
        componentPropertyDefinitions: {
          "Has Icon Start#4611:0": { type: "BOOLEAN", defaultValue: false },
        },
      },
      args: { variant: "primary", iconStart: "★" },
    });
    const iconRow = propsRow(dimensions, "Has Icon Start");
    expect(iconRow?.status).toBe("flag-only");
    expect(iconRow?.note).toContain("default");
  });

  it("inherits the parent COMPONENT_SET's component properties for a variant node", async () => {
    // Figma declares BOOLEAN/TEXT/INSTANCE_SWAP properties on the SET, not on
    // each variant, and registries normally pin a variant.
    const PARENT_ID = "4185:3700";
    vi.stubGlobal("fetch", async (url: string) => {
      const json = (body: unknown): Response =>
        ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (url.includes("/variables/local")) return json(variablesResponse());
      if (url.includes("/components")) {
        return json({
          meta: { components: [{ node_id: NODE_ID, containing_frame: { nodeId: PARENT_ID } }] },
        });
      }
      if (url.includes(encodeURIComponent(PARENT_ID))) {
        return json({
          nodes: {
            [PARENT_ID]: {
              document: {
                id: PARENT_ID,
                name: "Button",
                type: "COMPONENT_SET",
                componentPropertyDefinitions: {
                  Variant: { type: "VARIANT", defaultValue: "Primary", variantOptions: ["Primary"] },
                  "Has Icon Start#4611:0": { type: "BOOLEAN", defaultValue: true },
                },
                children: [],
              },
            },
          },
        });
      }
      if (url.includes("/nodes?ids=")) {
        return json(nodeResponse({ strokes: [], type: "COMPONENT", name: "Variant=Primary" }));
      }
      return json({ lastModified: "2026-07-27T00:00:00Z" });
    });

    const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
    const report = await engine.checkDrift({
      storyId: "components-button--with-icon",
      nodeRef: { fileKey: FILE_KEY, nodeId: NODE_ID },
      snapshot: { styles: MATCHING_STYLES, rootClasses: ["button", "button--primary"] },
      args: { variant: "primary", iconStart: "★" },
    });

    expect(propsRow(report.dimensions, "Has Icon Start")?.status).toBe("match");
    // The parent's VARIANT entries are deliberately NOT inherited — the
    // variant's own name already supplies its axes.
    expect(propsRow(report.dimensions, "Variant")?.status).toBe("match");
  });

  it("says so when a node has neither variant axes nor component properties", async () => {
    const dimensions = await propsCheck({ node: {}, args: { size: "lg" } });
    const only = propsRows(dimensions);
    expect(only).toHaveLength(1);
    expect(only[0]).toMatchObject({ property: "story.args", status: "flag-only" });
  });
});

/**
 * `opacity` — the last trivially-comparable property, wired in v0.0.39. Both
 * sides are a 0..1 scalar over the whole element, so the only thing that can go
 * wrong is what a *missing* value is taken to mean.
 */
describe("token-value: opacity", () => {
  it("matches when both sides agree", async () => {
    const dimensions = await check({
      styles: { ...MATCHING_STYLES, opacity: "0.5" },
      node: nodeResponse({ opacity: 0.5 }),
    });
    expect(row(dimensions, "opacity")).toMatchObject({
      codeValue: "0.5",
      figmaValue: "0.5",
      status: "match",
    });
  });

  it("reports drift when Figma dims the node and the code does not", async () => {
    const dimensions = await check({
      styles: { ...MATCHING_STYLES, opacity: "1" },
      node: nodeResponse({ opacity: 0.4 }),
    });
    expect(row(dimensions, "opacity")).toMatchObject({
      codeValue: "1",
      figmaValue: "0.4",
      status: "drift",
    });
  });

  it("emits no row when neither side sets opacity", async () => {
    // Figma serializes `opacity` only when it isn't 1, so "absent" means 1.
    // Both sides at 1 is agreement nobody authored — no information, no row.
    const dimensions = await check({ styles: { ...MATCHING_STYLES, opacity: "1" } });
    expect(maybeRow(dimensions, "opacity")).toBeUndefined();
  });

  it("says so when Figma's 1 is the implicit default", async () => {
    const dimensions = await check({ styles: { ...MATCHING_STYLES, opacity: "0.5" } });
    const opacity = row(dimensions, "opacity");
    expect(opacity.status).toBe("drift");
    expect(opacity.note).toContain("no explicit opacity");
  });

  it("emits no row when the snapshot predates the property", async () => {
    const withoutOpacity = { ...MATCHING_STYLES };
    delete withoutOpacity["opacity"];
    const dimensions = await check({
      styles: withoutOpacity,
      node: nodeResponse({ opacity: 0.4 }),
    });
    expect(maybeRow(dimensions, "opacity")).toBeUndefined();
  });
});

/**
 * `structure` — the engine wiring only. The mappings and the applicability
 * rules have their own suite in `layout.test.ts`; this pins down that the rows
 * reach a real report, and that a non-flex story root still produces none.
 */
describe("structure: Figma auto-layout vs computed layout", () => {
  function structureRows(dimensions: DimensionDiff[]): DimensionDiff[] {
    return dimensions.filter((d) => d.kind === "structure");
  }

  it("reports the direction drift a Card handed off the wrong way round has", async () => {
    const dimensions = await check({
      styles: { ...MATCHING_STYLES, display: "flex", "flex-direction": "row" },
      node: nodeResponse({ layoutMode: "VERTICAL" }),
    });
    expect(structureRows(dimensions)).toEqual([
      expect.objectContaining({
        kind: "structure",
        property: "flex-direction",
        codeValue: "row",
        figmaValue: "column",
        status: "drift",
      }),
    ]);
  });

  it("emits no structure row when the story root is not a flex/grid container", async () => {
    const dimensions = await check({
      styles: { ...MATCHING_STYLES, display: "block", "flex-direction": "row" },
      node: nodeResponse({ layoutMode: "VERTICAL", primaryAxisAlignItems: "CENTER" }),
    });
    expect(structureRows(dimensions)).toEqual([]);
  });

  it("no longer emits a `structure` placeholder row", async () => {
    // The placeholder was the whole dimension before v0.0.39; alongside real
    // rows it would be a row asserting the dimension does nothing.
    const dimensions = await check({ styles: MATCHING_STYLES });
    expect(dimensions.find((d) => d.property === "story.structure")).toBeUndefined();
    expect(dimensions.find((d) => d.property === "story.motion")).toBeDefined();
  });
});

/* ------------------------------------------------------------------------- *
 * F1 — a fill delivered by a shared paint style
 * ------------------------------------------------------------------------- */

/**
 * Figma flattens a paint style into the node's own `fills`, `boundVariables`
 * included, and returns the style's *metadata* in a `styles` map alongside the
 * `document` in the same `/nodes` response. Verified against the live SDS file:
 * the Card's Image placeholder carries `styles: {fill, fills} → "293:27519"`,
 * `fills[0].boundVariables.color → Slate/200`, and a top-level
 * `boundVariables.fills`. So there is no indirection left to follow and no extra
 * request to make — what was missing was that the report never *said* a style
 * was involved, and never said the bound variable was a palette primitive that
 * cannot theme.
 */
const PLACEHOLDER_STYLE_ID = "293:27519";
const SLATE_200 = "VariableID:3919:36535";
const SLATE_900 = "VariableID:3919:36542";
const BACKGROUND_NEUTRAL_TERTIARY = "VariableID:106:12468";
/** 227/255 — Slate/200, the live placeholder grey. */
const SLATE_200_FLOAT = 0.8918150663375854;
/** 48/255 — Slate/900, what the semantic token resolves to under SDS Dark. */
const SLATE_900_FLOAT = 0.18823529411764706;

const PLACEHOLDER_STYLE_META = {
  [PLACEHOLDER_STYLE_ID]: {
    key: "583a43e2ed38bcf2d7fa300cd60392ad7dfadfbd",
    name: "Image Placeholder",
    styleType: "FILL",
    remote: false,
    description: "",
  },
};

/**
 * The shared fixture plus the palette/semantic pair the tier check reads:
 * `Slate/200` alone in single-mode `Color Primitives`, and
 * `Background/Neutral/Tertiary` in two-mode `Color` aliasing it under SDS Light
 * and `Slate/900` under SDS Dark.
 */
interface VariablesFixture {
  meta: {
    variableCollections: Record<string, unknown>;
    variables: Record<string, unknown>;
  };
}

function variablesWithPalette(): VariablesFixture {
  const base = variablesResponse();
  return {
    meta: {
      variableCollections: { ...base.meta.variableCollections },
      variables: {
        ...base.meta.variables,
        [SLATE_200]: {
          id: SLATE_200,
          name: "Slate/200",
          resolvedType: "COLOR",
          variableCollectionId: PRIMITIVES_COLLECTION,
          valuesByMode: {
            "3919:2": { r: SLATE_200_FLOAT, g: SLATE_200_FLOAT, b: SLATE_200_FLOAT, a: 1 },
          },
        },
        [SLATE_900]: {
          id: SLATE_900,
          name: "Slate/900",
          resolvedType: "COLOR",
          variableCollectionId: PRIMITIVES_COLLECTION,
          valuesByMode: {
            "3919:2": { r: SLATE_900_FLOAT, g: SLATE_900_FLOAT, b: SLATE_900_FLOAT, a: 1 },
          },
        },
        [BACKGROUND_NEUTRAL_TERTIARY]: {
          id: BACKGROUND_NEUTRAL_TERTIARY,
          name: "Background/Neutral/Tertiary",
          resolvedType: "COLOR",
          variableCollectionId: COLOR_COLLECTION,
          valuesByMode: {
            "3919:21": { type: "VARIABLE_ALIAS", id: SLATE_200 },
            "3919:22": { type: "VARIABLE_ALIAS", id: SLATE_900 },
          },
        },
      },
    },
  };
}

/** Same file with its only multi-mode colour collection collapsed to one mode. */
function variablesSingleTheme(): VariablesFixture {
  const vars = variablesWithPalette();
  const color = vars.meta.variableCollections[COLOR_COLLECTION] as Record<string, unknown>;
  vars.meta.variableCollections[COLOR_COLLECTION] = {
    ...color,
    modes: [{ modeId: "3919:21", name: "SDS Light" }],
  };
  return vars;
}

const SLATE_200_PAINT = {
  blendMode: "NORMAL",
  type: "SOLID",
  color: { r: SLATE_200_FLOAT, g: SLATE_200_FLOAT, b: SLATE_200_FLOAT, a: 1 },
  boundVariables: { color: { type: "VARIABLE_ALIAS", id: SLATE_200 } },
};

function fillNode(
  opts: {
    fills?: unknown[];
    styles?: Record<string, string>;
    styleMeta?: Record<string, unknown>;
    type?: string;
  } = {},
) {
  return {
    nodes: {
      [NODE_ID]: {
        document: {
          id: NODE_ID,
          name: "Image",
          type: opts.type ?? "FRAME",
          fills: opts.fills ?? [SLATE_200_PAINT],
          strokes: [],
          children: [],
          ...(opts.styles ? { styles: opts.styles } : {}),
        },
        ...(opts.styleMeta ? { styles: opts.styleMeta } : {}),
      },
    },
  };
}

const STYLE_DELIVERED = {
  styles: { fill: PLACEHOLDER_STYLE_ID, fills: PLACEHOLDER_STYLE_ID },
  styleMeta: PLACEHOLDER_STYLE_META,
};

describe("token-value: a fill delivered by a shared paint style", () => {
  const PLACEHOLDER_STYLES = { "background-color": "rgb(227, 227, 227)" };

  it("names the variable the style's paint binds", async () => {
    const dimensions = await check({
      styles: PLACEHOLDER_STYLES,
      variables: variablesWithPalette(),
      node: fillNode(STYLE_DELIVERED),
    });
    const background = row(dimensions, "background-color");

    expect(background.status).toBe("match");
    expect(background.figmaValue).toBe("rgb(227, 227, 227)");
    // The whole point: a style-delivered binding is no longer untracked.
    expect(background.tokenName).toBe("Slate/200");
  });

  it("says which paint style delivers it, and where a fix belongs", async () => {
    const dimensions = await check({
      styles: PLACEHOLDER_STYLES,
      variables: variablesWithPalette(),
      node: fillNode(STYLE_DELIVERED),
    });
    const background = row(dimensions, "background-color");

    expect(background.sourceAdvisory).toContain('shared paint style "Image Placeholder"');
    expect(background.sourceAdvisory).toContain("belongs in the style");
  });

  it("falls back to the style id when the response carries no style metadata", async () => {
    const dimensions = await check({
      styles: PLACEHOLDER_STYLES,
      variables: variablesWithPalette(),
      node: fillNode({ styles: STYLE_DELIVERED.styles }),
    });
    const background = row(dimensions, "background-color");

    // An id is a worse answer than a name, and still the truth. Never a token.
    expect(background.sourceAdvisory).toContain(PLACEHOLDER_STYLE_ID);
    expect(background.tokenName).toBe("Slate/200");
  });

  it("leaves a node with a direct bound fill exactly as it was", async () => {
    const dimensions = await check({
      styles: PLACEHOLDER_STYLES,
      variables: variablesWithPalette(),
      node: fillNode(),
    });
    const background = row(dimensions, "background-color");

    expect(background.status).toBe("match");
    expect(background.tokenName).toBe("Slate/200");
    // No style in play, so nothing is said about one.
    expect(background.sourceAdvisory ?? "").not.toContain("paint style");
    expect(background.note).toBeUndefined();
  });

  /**
   * A gradient or image-only style: Figma has an opinion, we cannot read a
   * colour from it. `flag-only` would claim Figma declares nothing and `match`
   * would be a verdict on a comparison that never ran.
   */
  it("reports `unresolved` — never `match` — for a style with no readable paint", async () => {
    const dimensions = await check({
      styles: PLACEHOLDER_STYLES,
      variables: variablesWithPalette(),
      node: fillNode({
        ...STYLE_DELIVERED,
        fills: [{ blendMode: "NORMAL", type: "GRADIENT_LINEAR", gradientStops: [] }],
      }),
    });
    const background = row(dimensions, "background-color");

    expect(background.status).toBe("unresolved");
    expect(background.figmaValue).toBeNull();
    expect(background.note).toContain('"Image Placeholder"');
    expect(background.note).toContain("no comparison was made");
  });

  it("compares a style whose paint binds nothing, and says the design names no token", async () => {
    const { boundVariables: _dropped, ...unbound } = SLATE_200_PAINT;
    const dimensions = await check({
      styles: PLACEHOLDER_STYLES,
      variables: variablesWithPalette(),
      node: fillNode({ ...STYLE_DELIVERED, fills: [unbound] }),
    });
    const background = row(dimensions, "background-color");

    expect(background.status).toBe("match");
    expect(background.tokenName).toBeUndefined();
    expect(background.note).toContain("not bound");
    expect(background.note).toContain('"Image Placeholder"');
  });
});

describe("token-value: palette-vs-semantic tier", () => {
  const PLACEHOLDER_STYLES = { "background-color": "rgb(227, 227, 227)" };

  it("flags a single-mode primitive in a file that themes colour elsewhere", async () => {
    const dimensions = await check({
      styles: PLACEHOLDER_STYLES,
      variables: variablesWithPalette(),
      node: fillNode(),
    });
    const background = row(dimensions, "background-color");

    expect(background.sourceAdvisory).toContain('"Slate/200" is a single-mode variable');
    expect(background.sourceAdvisory).toContain("cannot follow the theme");
    // The semantic equivalent, established by the alias it actually holds — not
    // by its name looking more semantic.
    expect(background.sourceAdvisory).toContain('"Background/Neutral/Tertiary" (Color)');
    // Information, never a verdict.
    expect(background.status).toBe("match");
  });

  it("says nothing when the bound variable's own collection has modes", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(227, 227, 227)" },
      variables: variablesWithPalette(),
      node: fillNode({
        fills: [
          {
            type: "SOLID",
            color: { r: SLATE_200_FLOAT, g: SLATE_200_FLOAT, b: SLATE_200_FLOAT, a: 1 },
            boundVariables: {
              color: { type: "VARIABLE_ALIAS", id: BACKGROUND_NEUTRAL_TERTIARY },
            },
          },
        ],
      }),
    });
    const background = row(dimensions, "background-color");

    expect(background.tokenName).toBe("Background/Neutral/Tertiary");
    expect(background.sourceAdvisory).toBeUndefined();
  });

  /**
   * Tier is undeterminable in a single-theme file: one mode is the only tier
   * there is, so calling `Slate/200` a bypassed primitive would be a claim about
   * a themed layer that doesn't exist. No name heuristic stands in for it.
   */
  it("says nothing when the file themes no colour at all", async () => {
    const dimensions = await check({
      styles: PLACEHOLDER_STYLES,
      variables: variablesSingleTheme(),
      node: fillNode(),
    });
    const background = row(dimensions, "background-color");

    expect(background.tokenName).toBe("Slate/200");
    expect(background.sourceAdvisory).toBeUndefined();
  });

  it("says nothing about tier when the variables response is unavailable", async () => {
    const dimensions = await check({
      styles: PLACEHOLDER_STYLES,
      // 404 on /variables/local → the engine runs with `variables: null`.
      variables: null,
      node: fillNode(),
    });
    const background = maybeRow(dimensions, "background-color");

    expect(background?.sourceAdvisory).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------- *
 * F4 — a TEXT node's fill is its text colour, never a background
 * ------------------------------------------------------------------------- */

const TEXT_FILL = {
  blendMode: "NORMAL",
  type: "SOLID",
  color: { r: SLATE_600_FLOAT, g: SLATE_600_FLOAT, b: SLATE_600_FLOAT, a: 1 },
  boundVariables: { color: { type: "VARIABLE_ALIAS", id: BORDER_NEUTRAL_SECONDARY } },
};

const TEXT_STYLE = {
  fontFamily: "Inter",
  fontSize: 24,
  fontWeight: 600,
  lineHeightPx: 28.8,
  lineHeightUnit: "PIXELS",
};

function textNodeResponse(overrides: Record<string, unknown> = {}) {
  return {
    nodes: {
      [NODE_ID]: {
        document: {
          id: NODE_ID,
          name: "Title",
          type: "TEXT",
          characters: "Title",
          style: TEXT_STYLE,
          fills: [TEXT_FILL],
          strokes: [],
          boundVariables: { fills: [{ type: "VARIABLE_ALIAS", id: BORDER_NEUTRAL_SECONDARY }] },
          ...overrides,
        },
      },
    },
  };
}

/**
 * Live Card, `[data-slot=title]`: `background-color` rgba(0,0,0,0) vs
 * rgb(30,30,30) → drift, and the very next row `color` rgb(30,30,30) vs
 * rgb(30,30,30) → match. One Figma fill, compared twice, right once. A TEXT node
 * has no background paint in Figma at all, so the code side reads transparent
 * and the row could only ever be drift.
 */
describe("a TEXT node's fill is not a background", () => {
  const TITLE_STYLES = {
    "background-color": "rgba(0, 0, 0, 0)",
    color: "rgb(118, 118, 118)",
    "font-family": '"Inter", sans-serif',
    "font-size": "24px",
    "font-weight": "600",
    "line-height": "28.8px",
  };

  it("emits no `background-color` row for a bound TEXT node", async () => {
    const dimensions = await check({
      styles: TITLE_STYLES,
      snapshot: { ownText: "Title", tagName: "H3", texts: ["Title"] },
      node: textNodeResponse(),
    });

    expect(maybeRow(dimensions, "background-color")).toBeUndefined();
    expect(
      dimensions.find((d) => d.kind === "token-binding" && d.property === "background-color"),
    ).toBeUndefined();
  });

  it("keeps the `color` row, values and token name untouched", async () => {
    const dimensions = await check({
      styles: TITLE_STYLES,
      snapshot: { ownText: "Title", tagName: "H3", texts: ["Title"] },
      node: textNodeResponse(),
    });
    const color = row(dimensions, "color");

    expect(color.status).toBe("match");
    expect(color.codeValue).toBe("rgb(118, 118, 118)");
    expect(color.figmaValue).toBe("rgb(118, 118, 118)");
    expect(color.tokenName).toBe("Border/Neutral/Secondary");
    // The TEXT node's `fills` binding lands on `color`, once.
    const bindings = dimensions.filter(
      (d) => d.kind === "token-binding" && d.property === "color",
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.figmaValue).toBe("Border/Neutral/Secondary");
  });

  it("still compares `background-color` on a FRAME", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(227, 227, 227)" },
      variables: variablesWithPalette(),
      node: fillNode({ type: "FRAME" }),
    });

    expect(row(dimensions, "background-color").status).toBe("match");
  });
});

/* ------------------------------------------------------------------------- *
 * F3 — typography, colour and copy belong to the element that owns the text
 * ------------------------------------------------------------------------- */

/** A layout FRAME whose type lives on a TEXT descendant, as a Card's body does. */
function frameWithTextChild() {
  return {
    nodes: {
      [NODE_ID]: {
        document: {
          id: NODE_ID,
          name: "Body",
          type: "FRAME",
          fills: [],
          strokes: [],
          paddingTop: 12,
          boundVariables: { paddingTop: { type: "VARIABLE_ALIAS", id: SPACE_300 } },
          children: [
            {
              id: "1:2",
              name: "Title",
              type: "TEXT",
              characters: "Title",
              style: TEXT_STYLE,
              fills: [TEXT_FILL],
              boundVariables: {},
              children: [],
            },
          ],
        },
      },
    },
  };
}

/**
 * The container's computed values, as a browser reports them: a font size
 * inherited from the page, a colour inherited from the page, and a subtree that
 * contains the title's text. Every typography row built from these compares the
 * wrapper's inheritance against a TEXT node several levels down.
 */
const CONTAINER_STYLES = {
  "padding-top": "12px",
  "background-color": "rgba(0, 0, 0, 0)",
  color: "rgb(10, 10, 10)",
  "font-family": '"Inter", sans-serif',
  "font-size": "16px",
  "font-weight": "400",
  "line-height": "24px",
};

const TEXT_ROW_PROPERTIES = [
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
];

function textRows(dimensions: DimensionDiff[]): DimensionDiff[] {
  return dimensions.filter(
    (d) =>
      (d.kind === "token-value" || d.kind === "token-binding") &&
      TEXT_ROW_PROPERTIES.includes(d.property),
  );
}

function copyRows(dimensions: DimensionDiff[]): DimensionDiff[] {
  return dimensions.filter((d) => d.kind === "copy");
}

describe("typography/colour/copy are compared on the element that owns the text", () => {
  const cases: Array<{
    what: string;
    snapshot: Partial<CodeSnapshot>;
    compared: boolean;
  }> = [
    {
      what: "an element that renders its own text",
      snapshot: { ownText: "Title", tagName: "H3", texts: ["Title"] },
      compared: true,
    },
    {
      what: "a wrapper whose only text lives in descendants",
      snapshot: { ownText: "\n      \n    ", tagName: "DIV", texts: ["Title"] },
      compared: false,
    },
    {
      // The hazard the predicate must not be written as a leaf check: font
      // properties declared here cascade into the badge, so the drift is real.
      what: "a text-bearing container — own text alongside element children",
      snapshot: { ownText: "Title ", tagName: "H3", texts: ["Title", "New"] },
      compared: true,
    },
    {
      what: "a form control, whose value never reaches textContent",
      snapshot: { ownText: "", tagName: "INPUT", inputType: "text", texts: [] },
      compared: true,
    },
    {
      // An older preview bundle, or a snapshot replayed from its cache.
      what: "a snapshot that never probed its own text",
      snapshot: { texts: ["Title"] },
      compared: true,
    },
  ];

  for (const { what, snapshot, compared } of cases) {
    it(`${compared ? "compares" : "skips"} typography and colour for ${what}`, async () => {
      const dimensions = await check({
        styles: CONTAINER_STYLES,
        snapshot,
        node: frameWithTextChild(),
      });

      if (compared) {
        expect(textRows(dimensions).length).toBeGreaterThan(0);
        expect(textRows(dimensions).map((d) => d.property)).toContain("font-size");
      } else {
        expect(textRows(dimensions)).toEqual([]);
      }
    });

    it(`${compared ? "compares" : "skips"} copy for ${what}`, async () => {
      const dimensions = await check({
        styles: CONTAINER_STYLES,
        snapshot,
        node: frameWithTextChild(),
      });

      if (compared) expect(copyRows(dimensions).length).toBeGreaterThan(0);
      else expect(copyRows(dimensions)).toEqual([]);
    });
  }

  it("still compares everything the wrapper paints itself", async () => {
    const dimensions = await check({
      styles: CONTAINER_STYLES,
      snapshot: { ownText: "   ", tagName: "DIV", texts: ["Title"] },
      node: frameWithTextChild(),
    });

    // Suppressing box properties would be the mirror-image bug.
    expect(row(dimensions, "padding-top").status).toBe("match");
    expect(
      dimensions.find((d) => d.kind === "token-binding" && d.property === "padding-top"),
    ).toBeDefined();
  });

  it("does not suppress the `line-height` design-side prompt on a real text element", async () => {
    // The row F3 reported as noise on three wrappers is a genuine finding on an
    // element that owns its text — the suppression must not reach it.
    const dimensions = await check({
      styles: { ...CONTAINER_STYLES, "line-height": "20px" },
      snapshot: { ownText: "Title", tagName: "H3", texts: ["Title"] },
      node: frameWithTextChild(),
    });

    expect(row(dimensions, "line-height").status).toBe("drift");
  });
});
