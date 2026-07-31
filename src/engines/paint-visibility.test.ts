import { afterEach, describe, expect, it, vi } from "vitest";
import type { DimensionDiff } from "../dimensions/types.js";
import type { CodeSnapshot } from "./types.js";
import { createFigmaRestEngine } from "./figma-rest.js";
import {
  isHiddenPaint,
  partialPaintOpacity,
  pickVisiblePaint,
  type VisibilityPaint,
} from "./paint-visibility.js";

/** A paint with the one field the engine's own `FigmaPaint` requires. */
type TestPaint = VisibilityPaint & { type?: string };

/**
 * Issue #85 — a paint switched off was read as the element's colour.
 *
 * `Paint.visible` (optional, default `true`) was checked nowhere in the fill or
 * stroke path, so a toggled-off paint at index 0 was resolved, token-attributed
 * and compared, while the visible paint below it was never compared at all. Both
 * halves of the row were wrong at once: a finding against a colour nobody can
 * see, plus a real property silently unchecked — and unfalsifiable from the
 * panel, because the value the tool named genuinely is in the file.
 *
 * What these tests pin down:
 *
 *  1. The first **visible** paint is the one compared, and its token is the one
 *     named — fills and strokes alike.
 *  2. Every paint hidden is a *deliberate no-paint*: an honest row that says so,
 *     never a comparison and never a silent skip.
 *  3. A paint at `opacity: 0` is hidden by the other route.
 *  4. A paint at partial opacity is visible but not faithfully comparable, so it
 *     is reported and not compared — the opaque colour is never asserted as the
 *     rendered one.
 */

const FILE_KEY = "Nq23XwGfazYZZZ5vr8OezI";
const NODE_ID = "4185:3778";
const COLLECTION = "VariableCollectionId:3919:20";

const BRAND = "VariableID:3919:1";
const LEGACY = "VariableID:3919:2";

/** rgb(44, 44, 44) — the current brand colour. */
const BRAND_FLOAT = 44 / 255;
/** rgb(255, 0, 255) — last month's, parked above it and switched off. */
const LEGACY_R = 1;

function variablesResponse() {
  return {
    meta: {
      variableCollections: {
        [COLLECTION]: {
          id: COLLECTION,
          name: "Color",
          defaultModeId: "3919:21",
          modes: [{ modeId: "3919:21", name: "Value" }],
        },
      },
      variables: {
        [BRAND]: {
          id: BRAND,
          name: "Background/Brand/Default",
          resolvedType: "COLOR",
          variableCollectionId: COLLECTION,
          valuesByMode: {
            "3919:21": { r: BRAND_FLOAT, g: BRAND_FLOAT, b: BRAND_FLOAT, a: 1 },
          },
        },
        [LEGACY]: {
          id: LEGACY,
          name: "Background/Legacy/Magenta",
          resolvedType: "COLOR",
          variableCollectionId: COLLECTION,
          valuesByMode: { "3919:21": { r: LEGACY_R, g: 0, b: LEGACY_R, a: 1 } },
        },
      },
    },
  };
}

function solid(
  variableId: string,
  rgb: { r: number; g: number; b: number },
  extra: Record<string, unknown> = {},
) {
  return {
    blendMode: "NORMAL",
    type: "SOLID",
    color: { ...rgb, a: 1 },
    boundVariables: { color: { type: "VARIABLE_ALIAS", id: variableId } },
    ...extra,
  };
}

const HIDDEN_MAGENTA = solid(LEGACY, { r: LEGACY_R, g: 0, b: LEGACY_R }, { visible: false });
const VISIBLE_BRAND = solid(BRAND, { r: BRAND_FLOAT, g: BRAND_FLOAT, b: BRAND_FLOAT });

function nodeResponse(document: Record<string, unknown>) {
  return {
    nodes: {
      [NODE_ID]: {
        document: {
          id: NODE_ID,
          name: "Button",
          type: "FRAME",
          fills: [],
          strokes: [],
          children: [],
          ...document,
        },
      },
    },
  };
}

function installFetchStub(node: unknown): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const json = (body: unknown): Response =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
    if (url.includes("/variables/local")) return json(variablesResponse());
    if (url.includes("/nodes?ids=")) return json(node);
    if (url.includes("/components")) return json({ meta: { components: [] } });
    return json({ lastModified: "2026-07-31T00:00:00Z" });
  });
}

async function check(opts: {
  styles: Record<string, string>;
  document: Record<string, unknown>;
  /** Extra snapshot fields — `texts` / `ownText` for the copy dimension. */
  snapshot?: Partial<CodeSnapshot>;
}): Promise<DimensionDiff[]> {
  installFetchStub(nodeResponse(opts.document));
  const engine = createFigmaRestEngine({ figmaPat: "test-pat" });
  const report = await engine.checkDrift({
    storyId: "components-button--primary",
    nodeRef: { fileKey: FILE_KEY, nodeId: NODE_ID },
    snapshot: { styles: opts.styles, ...opts.snapshot },
  });
  return report.dimensions;
}

/** The single `copy` row, which is not a `token-value` row. */
function copyRow(dimensions: DimensionDiff[]): DimensionDiff {
  const found = dimensions.find((d) => d.kind === "copy");
  if (!found) throw new Error("no copy row");
  return found;
}

function maybeRow(dimensions: DimensionDiff[], property: string): DimensionDiff | undefined {
  return dimensions.find((d) => d.kind === "token-value" && d.property === property);
}

function row(dimensions: DimensionDiff[], property: string): DimensionDiff {
  const found = maybeRow(dimensions, property);
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

/** All four edges, because `pickBorderEdge` picks whichever is actually drawn. */
function borderStyles(color: string): Record<string, string> {
  return {
    "border-top-width": "1px",
    "border-right-width": "1px",
    "border-bottom-width": "1px",
    "border-left-width": "1px",
    "border-top-color": color,
    "border-right-color": color,
    "border-bottom-color": color,
    "border-left-color": color,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pickVisiblePaint", () => {
  it("distinguishes the three flavours of no paint", () => {
    expect(pickVisiblePaint(undefined)).toEqual({ kind: "absent" });
    expect(pickVisiblePaint([])).toEqual({ kind: "empty" });
    expect(pickVisiblePaint([{ visible: false }, { opacity: 0 }])).toEqual({
      kind: "all-hidden",
      hidden: 2,
    });
  });

  it("returns the first visible paint and counts what it skipped", () => {
    const wanted: TestPaint = { type: "SOLID" };
    const paints: TestPaint[] = [{ visible: false }, wanted, { type: "SOLID" }];
    expect(pickVisiblePaint(paints)).toEqual({
      kind: "paint",
      paint: wanted,
      index: 1,
      hiddenBefore: 1,
    });
  });

  it("never skips a visible paint it cannot read — a gradient on top still wins", () => {
    // Skipping to the SOLID underneath would compare something invisible: the
    // same bug in a new dress. The gradient wins and resolves to nothing.
    const gradient: TestPaint = { type: "GRADIENT_LINEAR" };
    const paints: TestPaint[] = [gradient, { type: "SOLID" }];
    const selection = pickVisiblePaint(paints);
    expect(selection).toMatchObject({ kind: "paint", paint: gradient, index: 0 });
  });

  it("treats opacity 0 as hidden and partial opacity as visible-but-blended", () => {
    expect(isHiddenPaint({ opacity: 0 })).toBe(true);
    expect(isHiddenPaint({ opacity: 0.5 })).toBe(false);
    expect(isHiddenPaint({})).toBe(false);
    expect(partialPaintOpacity({ opacity: 0.5 })).toBe(0.5);
    expect(partialPaintOpacity({ opacity: 1 })).toBeUndefined();
    expect(partialPaintOpacity({ opacity: 0 })).toBeUndefined();
    expect(partialPaintOpacity({})).toBeUndefined();
  });
});

describe("background-color: the first VISIBLE fill is the one compared (#85)", () => {
  const document = { fills: [HIDDEN_MAGENTA, VISIBLE_BRAND] };

  it("compares against fills[1] and names fills[1]'s token", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(44, 44, 44)" },
      document,
    });
    const background = row(dimensions, "background-color");

    expect(background.figmaValue).toBe("rgb(44, 44, 44)");
    expect(background.tokenName).toBe("Background/Brand/Default");
    expect(background.status).toBe("match");
  });

  it("no longer reports drift against the switched-off paint", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(44, 44, 44)" },
      document,
    });
    const background = row(dimensions, "background-color");

    expect(background.figmaValue).not.toBe("rgb(255, 0, 255)");
    expect(background.tokenName).not.toBe("Background/Legacy/Magenta");
  });

  it("says the compared paint was not the first one", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(44, 44, 44)" },
      document,
    });

    expect(row(dimensions, "background-color").note).toMatch(/first \*\*visible\*\* fill/);
  });

  it("still reports real drift against the visible paint", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(1, 2, 3)" },
      document,
    });
    const background = row(dimensions, "background-color");

    expect(background.status).toBe("drift");
    expect(background.figmaValue).toBe("rgb(44, 44, 44)");
  });

  it("treats an opacity-0 paint as hidden too", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(44, 44, 44)" },
      document: {
        fills: [solid(LEGACY, { r: LEGACY_R, g: 0, b: LEGACY_R }, { opacity: 0 }), VISIBLE_BRAND],
      },
    });
    const background = row(dimensions, "background-color");

    expect(background.status).toBe("match");
    expect(background.tokenName).toBe("Background/Brand/Default");
  });

  it("leaves an ordinary single visible fill exactly as it was", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(44, 44, 44)" },
      document: { fills: [VISIBLE_BRAND] },
    });
    const background = row(dimensions, "background-color");

    expect(background.status).toBe("match");
    expect(background.note).toBeUndefined();
  });
});

describe("background-color: every fill hidden is a deliberate no-fill (#85)", () => {
  it("produces an honest row rather than a comparison", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(44, 44, 44)" },
      document: { fills: [HIDDEN_MAGENTA] },
    });
    const background = row(dimensions, "background-color");

    // Not a comparison: there is no colour to compare against.
    expect(background.status).toBe("flag-only");
    expect(background.figmaValue).toBeNull();
    // And not a silent skip either.
    expect(background.note).toMatch(/all switched off/);
    expect(background.note).toMatch(/deliberate no-fill/);
  });

  it("does not attribute the hidden paint's token to the row", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(44, 44, 44)" },
      document: { fills: [HIDDEN_MAGENTA] },
    });

    expect(row(dimensions, "background-color").tokenName).toBeUndefined();
  });

  it("reads differently from an empty fills array", async () => {
    const hidden = await check({
      styles: { "background-color": "rgb(44, 44, 44)" },
      document: { fills: [HIDDEN_MAGENTA] },
    });
    const empty = await check({
      styles: { "background-color": "rgb(44, 44, 44)" },
      document: { fills: [] },
    });

    expect(row(hidden, "background-color").note).toMatch(/all switched off/);
    expect(row(empty, "background-color").note).toBeUndefined();
  });

  it("emits no row when the code paints nothing either — both sides agree", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgba(0, 0, 0, 0)" },
      document: { fills: [HIDDEN_MAGENTA] },
    });

    expect(maybeRow(dimensions, "background-color")).toBeUndefined();
  });
});

describe("background-color: a partially transparent paint is not compared (#85)", () => {
  const document = {
    fills: [solid(BRAND, { r: BRAND_FLOAT, g: BRAND_FLOAT, b: BRAND_FLOAT }, { opacity: 0.5 })],
  };

  it("reports the paint and the token but withholds the verdict", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(44, 44, 44)" },
      document,
    });
    const background = row(dimensions, "background-color");

    expect(background.status).toBe("unresolved");
    expect(background.tokenName).toBe("Background/Brand/Default");
    expect(background.note).toMatch(/50% opacity/);
    expect(background.note).toMatch(/no comparison/);
  });

  it("does not call it a match when the opaque colours happen to be equal", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(44, 44, 44)" },
      document,
    });

    expect(row(dimensions, "background-color").status).not.toBe("match");
  });
});

describe("border-color / border-width: the stroke path has the same predicate (#85)", () => {
  it("compares against the first visible stroke", async () => {
    const dimensions = await check({
      styles: borderStyles("rgb(44, 44, 44)"),
      document: { strokes: [HIDDEN_MAGENTA, VISIBLE_BRAND], strokeWeight: 1 },
    });
    const borderColor = row(dimensions, "border-color");

    expect(borderColor.figmaValue).toBe("rgb(44, 44, 44)");
    expect(borderColor.tokenName).toBe("Background/Brand/Default");
    expect(borderColor.status).toBe("match");
    expect(borderColor.note).toMatch(/first \*\*visible\*\* stroke/);
  });

  it("does not claim Figma draws a border when every stroke is switched off", async () => {
    const dimensions = await check({
      styles: borderStyles("rgb(44, 44, 44)"),
      document: { strokes: [HIDDEN_MAGENTA], strokeWeight: 1 },
    });

    // `strokeWeight` defaults to 1 on every variant template, so the old
    // `strokes.length > 0` guard reported a 1px border the design does not draw.
    const width = row(dimensions, "border-width");
    expect(width.figmaValue).toBeNull();
    expect(width.note).toMatch(/all switched off/);

    const color = row(dimensions, "border-color");
    expect(color.status).toBe("flag-only");
    expect(color.figmaValue).toBeNull();
    expect(color.tokenName).toBeUndefined();
    expect(color.note).toMatch(/deliberate no-stroke/);
  });

  it("emits no stroke rows when neither side draws a border", async () => {
    const dimensions = await check({
      styles: { "border-top-width": "0px" },
      document: { strokes: [HIDDEN_MAGENTA], strokeWeight: 1 },
    });

    expect(maybeRow(dimensions, "border-color")).toBeUndefined();
    expect(maybeRow(dimensions, "border-width")).toBeUndefined();
  });

  it("withholds the verdict on a partially transparent stroke", async () => {
    const dimensions = await check({
      styles: borderStyles("rgb(44, 44, 44)"),
      document: {
        strokes: [
          solid(BRAND, { r: BRAND_FLOAT, g: BRAND_FLOAT, b: BRAND_FLOAT }, { opacity: 0.5 }),
        ],
        strokeWeight: 1,
      },
    });
    const borderColor = row(dimensions, "border-color");

    expect(borderColor.status).toBe("unresolved");
    expect(borderColor.note).toMatch(/50% opacity/);
  });
});

describe("text colour: the same predicate on a TEXT node's fill (#85)", () => {
  const textNode = (fills: unknown[]) => ({
    fills: [],
    children: [
      {
        id: "1:2",
        name: "Label",
        type: "TEXT",
        characters: "Save",
        fills,
        style: { fontFamily: "Inter", fontSize: 16, fontWeight: 400 },
        children: [],
      },
    ],
  });

  it("compares against the first visible fill of the TEXT node", async () => {
    const dimensions = await check({
      styles: { color: "rgb(44, 44, 44)" },
      document: textNode([HIDDEN_MAGENTA, VISIBLE_BRAND]),
    });
    const color = row(dimensions, "color");

    expect(color.figmaValue).toBe("rgb(44, 44, 44)");
    expect(color.tokenName).toBe("Background/Brand/Default");
    expect(color.status).toBe("match");
  });

  it("says so when the TEXT node's every fill is switched off", async () => {
    const dimensions = await check({
      styles: { color: "rgb(44, 44, 44)" },
      document: textNode([HIDDEN_MAGENTA]),
    });
    const color = row(dimensions, "color");

    expect(color.status).toBe("flag-only");
    expect(color.figmaValue).toBeNull();
    expect(color.note).toMatch(/all switched off/);
  });
});

describe("hidden descendants render nothing, so they are not read (#85)", () => {
  const label = (name: string, chars: string, extra: Record<string, unknown> = {}) => ({
    id: `1:${name}`,
    name,
    type: "TEXT",
    characters: chars,
    fills: [VISIBLE_BRAND],
    style: { fontFamily: "Inter", fontSize: 16, fontWeight: 400 },
    children: [],
    ...extra,
  });

  it("skips a switched-off TEXT layer when picking the typography source", async () => {
    const dimensions = await check({
      styles: { color: "rgb(44, 44, 44)", "font-size": "16px" },
      snapshot: { texts: ["Save"], ownText: "Save" },
      document: {
        children: [
          // Longer text, so it would win the scoring — but it is switched off.
          label("Placeholder", "A much longer placeholder label", { visible: false }),
          label("Label", "Save"),
        ],
      },
    });

    expect(copyRow(dimensions).figmaValue).toBe("Save");
    expect(copyRow(dimensions).status).toBe("match");
  });

  it("does not compare copy from a hidden layer", async () => {
    const dimensions = await check({
      styles: { color: "rgb(44, 44, 44)" },
      snapshot: { texts: ["Save"], ownText: "Save" },
      document: {
        children: [label("Placeholder", "Lorem ipsum dolor", { visible: false })],
      },
    });

    // Figma has no *visible* text, so the row says code has text Figma does not
    // — never "your copy drifts from a string nobody can see".
    const copy = copyRow(dimensions);
    expect(copy.status).toBe("flag-only");
    expect(copy.figmaValue).toEqual([]);
  });

  it("treats an opacity-0 layer the same way", async () => {
    const dimensions = await check({
      styles: { color: "rgb(44, 44, 44)" },
      snapshot: { texts: ["Save"], ownText: "Save" },
      document: {
        children: [label("Ghost", "Invisible", { opacity: 0 }), label("Label", "Save")],
      },
    });

    expect(copyRow(dimensions).figmaValue).toBe("Save");
  });
});

describe("wiring: a hidden paint's variable is not the element's binding (#85)", () => {
  it("takes the binding from the first visible fill", async () => {
    const dimensions = await check({
      styles: { "background-color": "rgb(44, 44, 44)" },
      document: { fills: [HIDDEN_MAGENTA, VISIBLE_BRAND] },
    });
    const binding = dimensions.find(
      (d) => d.kind === "token-binding" && d.property === "background-color",
    );

    expect(binding?.figmaValue).toBe("Background/Brand/Default");
  });
});
