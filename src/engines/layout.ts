import type { DimensionDiff } from "../dimensions/types.js";

/**
 * The `structure` dimension: Figma auto-layout ↔ computed CSS layout.
 *
 * Hidden from the panel until v0.0.39 because it emitted a placeholder and
 * nothing else. It is now the four comparisons below — and the reason it was
 * worth building is that without it a component handed off with the wrong
 * *direction* reported clean. A Card whose Figma `Direction` axis says Vertical
 * while the code lays out in a row is not a subtle token difference; it is the
 * whole component being wrong, and it was the largest remaining hole.
 *
 * ## The mappings
 *
 * | Figma                      | CSS               | Values                                                        |
 * | -------------------------- | ----------------- | ------------------------------------------------------------- |
 * | `layoutMode`               | `flex-direction`  | `HORIZONTAL`→`row`, `VERTICAL`→`column`                       |
 * | `primaryAxisAlignItems`    | `justify-content` | `MIN`→`flex-start`, `CENTER`→`center`, `MAX`→`flex-end`, `SPACE_BETWEEN`→`space-between` |
 * | `counterAxisAlignItems`    | `align-items`     | `MIN`→`flex-start`, `CENTER`→`center`, `MAX`→`flex-end`, `BASELINE`→`baseline` |
 * | `layoutWrap`               | `flex-wrap`       | `NO_WRAP`→`nowrap`, `WRAP`→`wrap`                             |
 *
 * ## What is deliberately NOT mapped
 *
 *  - **`layoutMode: "GRID"`** (Figma's grid auto-layout). There is no
 *    `flex-direction` equivalent — the nearest CSS property is
 *    `grid-auto-flow`, which answers a different question (how *auto-placed*
 *    items flow), and Figma's row/column track definitions have no counterpart
 *    in the four properties compared here. No rows.
 *  - **`layoutMode: "NONE"`** — Figma is not laying out children at all, so
 *    there is nothing to compare. No rows. (See the applicability rule below;
 *    this is the Figma half of it.)
 *  - **Any unrecognized enum value.** A future Figma alignment value we don't
 *    know maps to nothing; the row is skipped rather than guessed at. The set
 *    of values that *do* map is closed and listed above.
 *  - **`counterAxisAlignContent`** (`AUTO` / `SPACE_BETWEEN`) → `align-content`.
 *    Only meaningful on a wrapped layout, and CSS's `align-content` has six
 *    values to Figma's two; not compared, so it is listed in the README's
 *    "not detected" section rather than half-compared here.
 *  - **`itemReverseZIndex`** — paint order only. CSS has no per-container
 *    equivalent (`row-reverse` reverses *layout* order, which is a different
 *    thing), so it maps to nothing.
 *  - **`layoutSizingHorizontal` / `layoutSizingVertical` / `layoutGrow` /
 *    `layoutAlign`** (hug / fill / fixed) — sizing, not the four properties
 *    above. Already listed as not detected.
 *
 * CSS values with no Figma counterpart (`space-around`, `space-evenly`,
 * `stretch`, `wrap-reverse`, `row-reverse`, `column-reverse`) are NOT special
 * cases: the code side genuinely says something Figma does not, and the row
 * reports that difference as drift. That is a true finding, not a mapping gap.
 *
 * ## Applicability — the mandatory half
 *
 * Every comparison here is guarded by {@link layoutRowsApplicable}: both sides
 * must actually be laying out children. Figma must have a real auto-layout
 * (`layoutMode` HORIZONTAL or VERTICAL) **and** the computed `display` must be
 * a flex or grid container. `getComputedStyle` reports `flex-direction: row`
 * and `justify-content: normal` on a plain `<div>` that has no layout at all,
 * so an unguarded comparison would report a confident verdict about four
 * properties that do not affect a single pixel of the rendered element. Same
 * shape as `variantSetRowApplicable` (v0.0.34): when the premise doesn't hold,
 * emit **no row**, not a row with a hedge in it.
 *
 * Two further per-property guards, for the same reason:
 *
 *  - On a **grid** container, `flex-direction` and `flex-wrap` have no effect,
 *    so neither is compared (`grid-auto-flow` is not the same property).
 *  - When the two sides' primary axes don't correspond — Figma laying out
 *    VERTICAL against a code `flex-direction: row`, or any Figma VERTICAL
 *    against a grid, where `justify-content` is the inline axis regardless —
 *    `justify-content` and `align-items` are aligning along *different axes* on
 *    the two sides. A `match` there would be a coincidence and a `drift` would
 *    be unactionable, so both rows are emitted as `unresolved` with a note
 *    naming the axis disagreement: reported, never a verdict.
 */

/**
 * Figma REST auto-layout fields, narrowed to what this module reads. The index
 * signature is what lets the engine pass a whole `FigmaNode` (every field is
 * optional here, which would otherwise trip TypeScript's weak-type check); the
 * fields are `unknown` because these come straight off a JSON response and are
 * validated at the point of use, not asserted.
 */
export interface FigmaLayoutNode {
  layoutMode?: unknown;
  primaryAxisAlignItems?: unknown;
  counterAxisAlignItems?: unknown;
  layoutWrap?: unknown;
  [key: string]: unknown;
}

/** `HORIZONTAL`/`VERTICAL` → the CSS `flex-direction` keyword. */
const DIRECTION: Record<string, string> = {
  HORIZONTAL: "row",
  VERTICAL: "column",
};

/** `primaryAxisAlignItems` → `justify-content`. */
const PRIMARY_ALIGN: Record<string, string> = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  SPACE_BETWEEN: "space-between",
};

/** `counterAxisAlignItems` → `align-items`. */
const COUNTER_ALIGN: Record<string, string> = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  BASELINE: "baseline",
};

/** `layoutWrap` → `flex-wrap`. */
const WRAP: Record<string, string> = {
  NO_WRAP: "nowrap",
  WRAP: "wrap",
};

/**
 * Computed-value spellings that mean the same thing as the canonical flex
 * keyword. `start`/`end` are the logical keywords (identical to `flex-start`/
 * `flex-end` in a flex container); `left`/`right` are deliberately absent —
 * they are *physical* and resolving them needs the writing direction, the same
 * reason `text-align: start` is not resolved either.
 */
const CODE_ALIASES: Record<string, string> = {
  start: "flex-start",
  end: "flex-end",
  "self-start": "flex-start",
  "self-end": "flex-end",
};

/**
 * Values `getComputedStyle` reports when the property was never set. `normal`
 * is what both `justify-content` and `align-items` compute to by default (and
 * `auto` appears for `align-items` in some engines); neither is a stated
 * opinion, so a row can never call it drift.
 */
const UNSET_CODE_VALUES = new Set(["normal", "auto", ""]);

/**
 * CSS's own default for each property. When Figma specifies exactly this and
 * the code says nothing, the two sides agree on the default and the row would
 * carry no information — so no row is emitted at all. (Same reasoning as the
 * box-shadow comparison skipping "no shadow on either side".)
 */
const CSS_DEFAULTS: Record<string, string> = {
  "justify-content": "flex-start",
  "align-items": "stretch",
  "flex-wrap": "nowrap",
  "flex-direction": "row",
};

/**
 * Computed values (post-{@link CODE_ALIASES}) this module is willing to compare,
 * per property. Anything else — `justify-content: left`, a value from a CSS
 * feature we don't model — yields an `unresolved` row naming the value, never a
 * verdict. `left`/`right` are the concrete case: they are physical keywords, so
 * deciding whether `left` equals Figma's `MIN` needs the writing direction,
 * which the snapshot doesn't carry for this property.
 */
const RECOGNIZED_CODE_VALUES: Record<string, Set<string>> = {
  "flex-direction": new Set(["row", "column", "row-reverse", "column-reverse"]),
  "flex-wrap": new Set(["nowrap", "wrap", "wrap-reverse"]),
  "justify-content": new Set([
    "flex-start",
    "flex-end",
    "center",
    "space-between",
    "space-around",
    "space-evenly",
    "stretch",
  ]),
  "align-items": new Set(["flex-start", "flex-end", "center", "baseline", "stretch"]),
};

function displayTokens(display: string | undefined): string[] {
  return (display ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Flex container (not grid): `flex`, `inline-flex`, or the two-value `block flex`. */
export function isFlexDisplay(display: string | undefined): boolean {
  const tokens = displayTokens(display);
  return tokens.includes("flex") || tokens.includes("inline-flex");
}

/** Grid container: `grid`, `inline-grid`, or the two-value `block grid`. */
export function isGridDisplay(display: string | undefined): boolean {
  const tokens = displayTokens(display);
  return tokens.includes("grid") || tokens.includes("inline-grid");
}

export interface LayoutApplicabilityContext {
  /** Figma's `layoutMode`, exactly as the REST node reports it. */
  layoutMode?: unknown;
  /**
   * Computed `display` from the snapshot. `undefined` when the snapshot
   * predates the property (an older preview bundle) — treated as "not a
   * container", so an out-of-date consumer gets no layout rows rather than
   * four invented ones.
   */
  display?: string | undefined;
}

/**
 * Whether ANY layout comparison may run: Figma is laying out children with a
 * flex-equivalent auto-layout, and the code element is a flex or grid
 * container. Everything in this module is gated on it.
 */
export function layoutRowsApplicable(ctx: LayoutApplicabilityContext): boolean {
  const mode = typeof ctx.layoutMode === "string" ? ctx.layoutMode : undefined;
  if (!mode || DIRECTION[mode] === undefined) return false;
  return isFlexDisplay(ctx.display) || isGridDisplay(ctx.display);
}

/**
 * Fold a computed value into the canonical keyword. Returns null when the value
 * is not one this module compares (see {@link RECOGNIZED_CODE_VALUES}); callers
 * must treat null as "no comparison possible", never as a difference.
 */
function canonicalCodeValue(raw: string | undefined, property: string): string | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return null;
  const folded = CODE_ALIASES[v] ?? v;
  return RECOGNIZED_CODE_VALUES[property]?.has(folded) ? folded : null;
}

interface RowSpec {
  property: string;
  figmaEnum: unknown;
  map: Record<string, string>;
  /** Set when this row's verdict would compare two different axes. */
  axisMismatchNote?: string;
  /**
   * Skip the row when BOTH sides sit on their own default. `flex-wrap` is the
   * case that matters: Figma's default is `NO_WRAP` and CSS's is `nowrap`, so a
   * "match" there reports agreement nobody authored. `flex-direction` is
   * deliberately NOT in this class — `row` on both sides is the confirmation
   * this dimension exists to give.
   */
  skipWhenBothDefault?: boolean;
}

function buildRow(spec: RowSpec, styles: Record<string, string>): DimensionDiff | null {
  const figmaEnum = typeof spec.figmaEnum === "string" ? spec.figmaEnum : undefined;
  // Figma said nothing, or said something this module refuses to map (see the
  // module docblock). Either way there is no comparison to make.
  if (!figmaEnum) return null;
  const figmaValue = spec.map[figmaEnum];
  if (figmaValue === undefined) return null;

  const rawCode = styles[spec.property];
  const codeUnset = UNSET_CODE_VALUES.has((rawCode ?? "").trim().toLowerCase());
  const cssDefault = CSS_DEFAULTS[spec.property];
  // Both sides at the CSS default: no information in either direction.
  if (codeUnset && figmaValue === cssDefault) return null;
  if (
    spec.skipWhenBothDefault &&
    figmaValue === cssDefault &&
    canonicalCodeValue(rawCode, spec.property) === cssDefault
  ) {
    return null;
  }

  const base = {
    kind: "structure" as const,
    property: spec.property,
    codeValue: rawCode ?? null,
    figmaValue,
  };

  if (spec.axisMismatchNote) {
    return { ...base, status: "unresolved", note: spec.axisMismatchNote };
  }

  if (codeUnset) {
    return {
      ...base,
      status: "flag-only",
      note:
        `Figma specifies ${spec.property}: ${figmaValue}; the code element declares no ${spec.property} ` +
        `(computed \`${rawCode ?? "—"}\`, which is the CSS default). Nothing is claimed about the render — ` +
        `declare the property in code, or confirm the default is intended.`,
    };
  }

  const codeValue = canonicalCodeValue(rawCode, spec.property);
  if (codeValue === null) {
    return {
      ...base,
      status: "unresolved",
      note: `Computed \`${spec.property}: ${rawCode}\` has no direction-independent flex equivalent, so no comparison was made.`,
    };
  }

  return { ...base, status: codeValue === figmaValue ? "match" : "drift" };
}

/**
 * The `structure` rows for one element. Empty whenever the comparison doesn't
 * apply — which is the point of the dimension being shippable at all.
 */
export function layoutRows(
  node: FigmaLayoutNode,
  styles: Record<string, string> | undefined,
): DimensionDiff[] {
  if (!styles) return [];
  const display = styles["display"];
  if (!layoutRowsApplicable({ layoutMode: node.layoutMode, display })) return [];

  const mode = node.layoutMode as string;
  const figmaAxis = mode === "HORIZONTAL" ? "horizontal" : "vertical";
  const grid = isGridDisplay(display);

  const out: DimensionDiff[] = [];

  // `flex-direction` / `flex-wrap` do nothing on a grid container, so they are
  // not compared there — `grid-auto-flow` is a different property, not a
  // spelling of the same one.
  if (!grid) {
    const direction = buildRow(
      { property: "flex-direction", figmaEnum: mode, map: DIRECTION },
      styles,
    );
    if (direction) out.push(direction);
    const wrap = buildRow(
      {
        property: "flex-wrap",
        figmaEnum: node.layoutWrap,
        map: WRAP,
        skipWhenBothDefault: true,
      },
      styles,
    );
    if (wrap) out.push(wrap);
  }

  // Which axis does the CODE align along? For flex it follows
  // `flex-direction`; for grid, `justify-content` is always the inline
  // (horizontal) axis whatever the tracks do.
  const codeAxis = grid
    ? "horizontal"
    : (canonicalCodeValue(styles["flex-direction"], "flex-direction") ?? "row").startsWith("column")
      ? "vertical"
      : "horizontal";

  const axisMismatchNote =
    codeAxis === figmaAxis
      ? undefined
      : `Figma's primary axis is ${figmaAxis} (layoutMode ${mode}) but the code element's is ${codeAxis}` +
        (grid
          ? ` (a grid container's \`justify-content\` is the inline axis regardless of its tracks)`
          : ` (\`flex-direction: ${styles["flex-direction"] ?? "—"}\`)`) +
        `, so the two sides align along different axes and no comparison was made. Reconcile the direction first.`;

  const justify = buildRow(
    {
      property: "justify-content",
      figmaEnum: node.primaryAxisAlignItems,
      map: PRIMARY_ALIGN,
      ...(axisMismatchNote ? { axisMismatchNote } : {}),
    },
    styles,
  );
  if (justify) out.push(justify);

  const align = buildRow(
    {
      property: "align-items",
      figmaEnum: node.counterAxisAlignItems,
      map: COUNTER_ALIGN,
      ...(axisMismatchNote ? { axisMismatchNote } : {}),
    },
    styles,
  );
  if (align) out.push(align);

  return out;
}
