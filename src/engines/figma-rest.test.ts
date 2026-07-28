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
