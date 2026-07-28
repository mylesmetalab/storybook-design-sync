import type { DimensionDiff } from "../dimensions/types.js";

/**
 * Figma `TypeStyle` → CSS, for the five text properties the snapshot collects
 * but nothing ever compared.
 *
 * `FIGMA_KEY_TO_CSS` in `figma-rest.ts` has mapped `letterSpacing`,
 * `textAlignHorizontal`, `textCase`, `textDecoration` and `fontStyle` to CSS
 * properties since the binding (wiring) dimension was written, but the
 * *value* dimension never read them — so a designer could change any of them
 * in Figma and the auditor said nothing. This module supplies the value side.
 *
 * Every builder here returns `DimensionDiff | null` and returns `null`
 * whenever a faithful comparison isn't available. That is the whole design
 * rule: a confident row that doesn't apply is worse than no row. Concretely,
 * no row is emitted when
 *
 *   - the Figma field is absent and the CSS default carries no information
 *     (both sides sit at the initial value — nothing to confirm);
 *   - the Figma value has no faithful CSS equivalent (`SMALL_CAPS`);
 *   - the computed CSS value isn't one this module can reason about
 *     (`full-width`, `match-parent`, an empty string from a snapshot that
 *     predates the property);
 *   - the Figma side needs a datum we don't have (percent letter-spacing
 *     with no font size).
 *
 * All builders assume the caller only invokes them when the Figma TEXT node
 * actually returned a `style` object. Without one we can't distinguish "not
 * italic" from "this API response has no typography in it", and `font-style`
 * in particular would fabricate a `normal` opinion.
 */

/** Figma REST `TypeStyle`, narrowed to the fields this module reads. */
export interface FigmaTypeStyle {
  fontSize?: number;
  /**
   * REST omits this when the text isn't italic; it is never `false`. Figma's
   * *variable* binding for slant is `fontStyle`, which holds a font **style
   * name** ("Italic", "Semi Bold Italic") — a weight+slant compound with no
   * clean CSS `font-style` equivalent — so the value side reads `italic` and
   * ignores `fontStyle` entirely.
   */
  italic?: boolean;
  /** REST reports px (percent entered in the UI arrives already converted). */
  letterSpacing?: number | { value?: number; unit?: string };
  textCase?: string;
  textDecoration?: string;
  textAlignHorizontal?: string;
  /** `WIDTH_AND_HEIGHT` = hug both axes, where alignment has no visible effect. */
  textAutoResize?: string;
}

/**
 * What the Figma side of one property amounts to.
 *
 * `default` is distinct from `value`: Figma omits `textCase`/`textDecoration`
 * when they're unset, and "unset" is a weaker statement than "explicitly
 * none" — it is what every plain text layer looks like. Rows built from a
 * `default` never accuse the code side of drift on the strength of the
 * omission alone.
 */
export type FigmaTextSide =
  | { kind: "value"; css: string }
  | { kind: "default"; css: string }
  | { kind: "absent" }
  | { kind: "excluded"; reason: string };

/* -------------------------------------------------------------------------- *
 * Figma enum → CSS
 * -------------------------------------------------------------------------- */

/**
 * `textCase` → `text-transform`.
 *
 * `TITLE` → `capitalize` is the closest available pair, and the two disagree
 * at the edges: CSS `capitalize` uppercases the first letter of every word and
 * leaves the rest alone, while Figma's Title Case also lowercases the
 * remainder of each word and treats hyphenated and apostrophised words
 * differently. We still report the pair as a match — the declared intent is
 * the same and the alternative is silence on a property designers change
 * often — but the row says so.
 *
 * `SMALL_CAPS`/`SMALL_CAPS_FORCED` are excluded: they are OpenType features
 * (`font-variant-caps`), not a `text-transform`, so no `text-transform` verdict
 * about them could be right.
 */
export function mapTextCase(textCase: string | undefined): FigmaTextSide {
  if (textCase === undefined || textCase === "ORIGINAL") return { kind: "default", css: "none" };
  switch (textCase) {
    case "UPPER":
      return { kind: "value", css: "uppercase" };
    case "LOWER":
      return { kind: "value", css: "lowercase" };
    case "TITLE":
      return { kind: "value", css: "capitalize" };
    case "SMALL_CAPS":
    case "SMALL_CAPS_FORCED":
      return {
        kind: "excluded",
        reason: `Figma "${textCase}" is an OpenType feature (CSS \`font-variant-caps\`), not a \`text-transform\``,
      };
    default:
      return { kind: "excluded", reason: `unrecognised Figma textCase "${textCase}"` };
  }
}

export const TITLE_CASE_NOTE =
  "Figma Title Case ≈ CSS `capitalize`: both uppercase each word's first letter, " +
  "but they differ on the rest of the word and on hyphenated/apostrophised words.";

/** `textDecoration` → `text-decoration-line`. REST omits the field for none. */
export function mapTextDecoration(textDecoration: string | undefined): FigmaTextSide {
  if (textDecoration === undefined || textDecoration === "NONE") {
    return { kind: "default", css: "none" };
  }
  switch (textDecoration) {
    case "UNDERLINE":
      return { kind: "value", css: "underline" };
    case "STRIKETHROUGH":
      return { kind: "value", css: "line-through" };
    default:
      return { kind: "excluded", reason: `unrecognised Figma textDecoration "${textDecoration}"` };
  }
}

/**
 * `textAlignHorizontal` → `text-align`.
 *
 * Absent means "Figma didn't state an alignment", which is *not* the same as
 * `LEFT`: horizontal placement of a hug-width label is decided by the parent's
 * auto-layout, not by the text node. Absent therefore yields no row.
 */
export function mapTextAlign(align: string | undefined): FigmaTextSide {
  if (align === undefined) return { kind: "absent" };
  switch (align) {
    case "LEFT":
      return { kind: "value", css: "left" };
    case "RIGHT":
      return { kind: "value", css: "right" };
    case "CENTER":
      return { kind: "value", css: "center" };
    case "JUSTIFIED":
      return { kind: "value", css: "justify" };
    default:
      return { kind: "excluded", reason: `unrecognised Figma textAlignHorizontal "${align}"` };
  }
}

/** Resolved letter-spacing in px, or why there isn't one. */
export type FigmaLetterSpacing =
  | { kind: "value"; px: number }
  | { kind: "absent" }
  | { kind: "excluded"; reason: string };

/**
 * Figma's letter-spacing in px.
 *
 * REST hands back a plain number already in px. The Plugin-API shape
 * (`{value, unit}`) is accepted too, because cached payloads and plugin-fed
 * fixtures carry it: `PIXELS` is used as-is, `PERCENT` is relative to the font
 * size and is only converted when the font size is known — otherwise no row.
 */
export function figmaLetterSpacingPx(style: FigmaTypeStyle): FigmaLetterSpacing {
  const raw = style.letterSpacing;
  if (raw === undefined || raw === null) return { kind: "absent" };
  if (typeof raw === "number") {
    return Number.isFinite(raw)
      ? { kind: "value", px: raw }
      : { kind: "excluded", reason: "Figma letterSpacing is not a finite number" };
  }
  if (typeof raw !== "object") {
    return { kind: "excluded", reason: "unrecognised Figma letterSpacing shape" };
  }
  const value = raw.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { kind: "excluded", reason: "Figma letterSpacing carries no finite value" };
  }
  const unit = raw.unit;
  if (unit === undefined || unit === "PIXELS") return { kind: "value", px: value };
  if (unit === "PERCENT") {
    const fontSize = style.fontSize;
    if (typeof fontSize !== "number" || !Number.isFinite(fontSize)) {
      return {
        kind: "excluded",
        reason: "percent letter-spacing needs the font size to become px, and Figma reported none",
      };
    }
    return { kind: "value", px: (value / 100) * fontSize };
  }
  return { kind: "excluded", reason: `unrecognised Figma letterSpacing unit "${String(unit)}"` };
}

/* -------------------------------------------------------------------------- *
 * Computed CSS → comparable form
 * -------------------------------------------------------------------------- */

const TEXT_TRANSFORM_KEYWORDS = new Set(["none", "uppercase", "lowercase", "capitalize"]);
const DECORATION_LINE_KEYWORDS = new Set(["underline", "overline", "line-through", "blink"]);

/** `full-width`, `full-size-kana`, `math-auto` and friends → null (no Figma peer). */
export function normalizeCodeTextTransform(value: string | undefined): string | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  return TEXT_TRANSFORM_KEYWORDS.has(v) ? v : null;
}

/**
 * `text-decoration-line` can be a set (`underline line-through`); order is not
 * meaningful, so it's sorted before comparison.
 */
export function normalizeCodeDecorationLine(value: string | undefined): string | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  if (v === "none") return "none";
  const parts = v.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || !parts.every((p) => DECORATION_LINE_KEYWORDS.has(p))) return null;
  return [...new Set(parts)].sort().join(" ");
}

/**
 * `text-align` normalization. The initial value is `start`, which is what
 * `getComputedStyle` reports for any element that never sets the property —
 * so `start`/`end` are resolved against the document's writing direction (the
 * snapshot collects `direction` for exactly this reason). `match-parent` is
 * unresolvable from the element alone → null.
 */
export function normalizeCodeTextAlign(
  value: string | undefined,
  direction: string | undefined,
): string | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  const rtl = (direction ?? "ltr").trim().toLowerCase() === "rtl";
  if (v === "start") return rtl ? "right" : "left";
  if (v === "end") return rtl ? "left" : "right";
  if (v === "left" || v === "right" || v === "center" || v === "justify") return v;
  return null;
}

/** `oblique 14deg` folds to `oblique`; anything unknown → null. */
export function normalizeCodeFontStyle(
  value: string | undefined,
): "normal" | "italic" | "oblique" | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  if (v === "normal") return "normal";
  if (v.startsWith("italic")) return "italic";
  if (v.startsWith("oblique")) return "oblique";
  return null;
}

/** Computed lengths are always px; `0` may arrive bare. */
export function parseLengthPx(value: string | undefined): number | null {
  const v = value?.trim().toLowerCase();
  if (!v) return null;
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))(px)?$/.exec(v);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  // A bare number is only a length when it's zero.
  if (m[2] === undefined && n !== 0) return null;
  return n;
}

/* -------------------------------------------------------------------------- *
 * Row builders
 * -------------------------------------------------------------------------- */

/**
 * Letter-spacing is a sub-pixel property — 0.5px vs 0.9px is a visible
 * difference — so it gets a tighter epsilon than the 0.5px used for padding
 * and radii.
 */
const LETTER_SPACING_EPSILON = 0.05;

function valueRow(
  property: string,
  codeValue: string | null,
  figmaValue: string | null,
  status: DimensionDiff["status"],
  note?: string,
): DimensionDiff {
  return {
    kind: "token-value",
    property,
    codeValue,
    figmaValue,
    status,
    ...(note ? { note } : {}),
  };
}

/** Round for display without turning 0.16 into 0.16000000000000003. */
function px(n: number): string {
  return `${Number(n.toFixed(3))}px`;
}

/**
 * Whether applying `transform` to Figma's literal characters leaves them
 * unchanged — i.e. code's transform is a no-op against this label and the
 * rendered result agrees with the design even though Figma declares no case.
 * `capitalize` is never claimed: CSS's word-boundary rules are not something
 * to re-implement here.
 */
function transformIsNoOp(chars: string, transform: string): boolean {
  if (transform === "uppercase") return chars === chars.toUpperCase();
  if (transform === "lowercase") return chars === chars.toLowerCase();
  return false;
}

/**
 * `text-transform` row.
 *
 * The interesting case is Figma declaring no case at all while code
 * transforms. Whether that renders differently depends on how the label is
 * literally typed in Figma: a design that types "SUBMIT" and a component that
 * uppercases "Submit" agree on screen. So the literal characters decide —
 * no-op transform → `flag-only`, genuinely different render → `drift`.
 */
export function textTransformRow(opts: {
  style: FigmaTypeStyle;
  codeValue: string | undefined;
  /** The Figma TEXT node's characters, when known. */
  figmaChars?: string | undefined;
}): DimensionDiff | null {
  const figma = mapTextCase(opts.style.textCase);
  if (figma.kind === "excluded" || figma.kind === "absent") return null;
  const code = normalizeCodeTextTransform(opts.codeValue);
  if (code === null) return null;

  if (figma.kind === "default") {
    if (code === "none") return null; // both at the initial value — nothing to say
    const chars = opts.figmaChars?.trim();
    if (!chars || code === "capitalize") {
      return valueRow(
        "text-transform",
        code,
        "none (Figma declares no text case)",
        "flag-only",
        `Code applies \`text-transform: ${code}\` while Figma declares no text case. ` +
          `Whether that changes the rendered label depends on how the text is typed in Figma, ` +
          `which this comparison can't settle — no drift claimed.`,
      );
    }
    if (transformIsNoOp(chars, code)) {
      return valueRow(
        "text-transform",
        code,
        "none (Figma declares no text case)",
        "flag-only",
        `Code applies \`text-transform: ${code}\`; Figma declares no text case but its text ` +
          `("${chars}") is already in that form, so the rendered label agrees. Nothing to fix.`,
      );
    }
    return valueRow(
      "text-transform",
      code,
      "none (Figma declares no text case)",
      "drift",
      `Figma's text is typed "${chars}" with no text case set; code applies ` +
        `\`text-transform: ${code}\`, so the rendered label differs from the design.`,
    );
  }

  const status: DimensionDiff["status"] = code === figma.css ? "match" : "drift";
  const note = figma.css === "capitalize" ? TITLE_CASE_NOTE : undefined;
  return valueRow("text-transform", code, figma.css, status, note);
}

export const DECORATION_NOT_INHERITED_NOTE =
  "`text-decoration-line` is not inherited, and the snapshot reads the story root only — " +
  "a decoration declared on an inner element (e.g. the label span) would be invisible here. " +
  "No drift claimed for that reason.";

/** `text-decoration-line` row. */
export function textDecorationRow(opts: {
  style: FigmaTypeStyle;
  codeValue: string | undefined;
}): DimensionDiff | null {
  const figma = mapTextDecoration(opts.style.textDecoration);
  if (figma.kind === "excluded" || figma.kind === "absent") return null;
  const code = normalizeCodeDecorationLine(opts.codeValue);
  if (code === null) return null;

  if (figma.kind === "default" && code === "none") return null;
  if (figma.kind === "value" && code === "none") {
    return valueRow(
      "text-decoration-line",
      code,
      figma.css,
      "flag-only",
      DECORATION_NOT_INHERITED_NOTE,
    );
  }
  const figmaLabel =
    figma.kind === "default" ? "none (Figma declares no decoration)" : figma.css;
  const status: DimensionDiff["status"] = code === figma.css ? "match" : "drift";
  return valueRow("text-decoration-line", code, figmaLabel, status);
}

/** `text-align` row. */
export function textAlignRow(opts: {
  style: FigmaTypeStyle;
  codeValue: string | undefined;
  direction: string | undefined;
}): DimensionDiff | null {
  const figma = mapTextAlign(opts.style.textAlignHorizontal);
  if (figma.kind !== "value") return null;
  // Hug-width text: horizontal alignment inside the box has no visible effect,
  // so Figma's value describes nothing the rendered CSS could contradict.
  if (opts.style.textAutoResize === "WIDTH_AND_HEIGHT") return null;
  const code = normalizeCodeTextAlign(opts.codeValue, opts.direction);
  if (code === null) return null;

  const raw = opts.codeValue?.trim().toLowerCase();
  const note =
    raw === "start" || raw === "end"
      ? `Computed CSS reports \`${raw}\` (the initial value); resolved to \`${code}\` for a ` +
        `\`${(opts.direction ?? "ltr").trim().toLowerCase()}\` document.`
      : undefined;
  const status: DimensionDiff["status"] = code === figma.css ? "match" : "drift";
  return valueRow("text-align", opts.codeValue ?? null, figma.css, status, note);
}

/** `letter-spacing` row. */
export function letterSpacingRow(opts: {
  style: FigmaTypeStyle;
  codeValue: string | undefined;
  tokenName?: string | undefined;
}): DimensionDiff | null {
  const figma = figmaLetterSpacingPx(opts.style);
  if (figma.kind !== "value") return null;

  const raw = opts.codeValue?.trim().toLowerCase();
  if (!raw) return null;
  const figmaLabel = opts.tokenName
    ? `${px(figma.px)} (token: ${opts.tokenName})`
    : px(figma.px);
  const withToken = (row: DimensionDiff): DimensionDiff =>
    opts.tokenName ? { ...row, tokenName: opts.tokenName } : row;

  if (raw === "normal") {
    // `normal` is the browser's "no letter-spacing opinion" — near zero but not
    // literally 0, so it is neither compared to 0 nor called drift.
    if (Math.abs(figma.px) < LETTER_SPACING_EPSILON) return null;
    return withToken(
      valueRow(
        "letter-spacing",
        opts.codeValue ?? null,
        figmaLabel,
        "flag-only",
        `Code declares no letter-spacing (computed \`normal\`); Figma specifies ${px(figma.px)}.`,
      ),
    );
  }

  const codePx = parseLengthPx(raw);
  if (codePx === null) return null;
  const status: DimensionDiff["status"] =
    Math.abs(codePx - figma.px) < LETTER_SPACING_EPSILON ? "match" : "drift";
  return withToken(valueRow("letter-spacing", opts.codeValue ?? null, figmaLabel, status));
}

export const OBLIQUE_NOTE =
  "Code uses `oblique` (synthesised slant); Figma has no oblique concept — its text is either " +
  "italic (a real italic face) or upright. Not comparable, so no drift claimed.";

/**
 * `font-style` row.
 *
 * Figma expresses slant two ways and only one is trustworthy here:
 * `TypeStyle.italic` (a boolean REST omits when false) is read; the
 * variable-bindable `fontStyle` field is **not**, because it holds a font
 * style *name* ("Italic", "Semi Bold Italic") that fuses weight and slant and
 * has no faithful CSS `font-style` value.
 */
export function fontStyleRow(opts: {
  style: FigmaTypeStyle;
  codeValue: string | undefined;
}): DimensionDiff | null {
  const figmaCss = opts.style.italic === true ? "italic" : "normal";
  const code = normalizeCodeFontStyle(opts.codeValue);
  if (code === null) return null;
  if (figmaCss === "normal" && code === "normal") return null; // both upright — no information
  if (code === "oblique") {
    return valueRow("font-style", code, figmaCss, "flag-only", OBLIQUE_NOTE);
  }
  const status: DimensionDiff["status"] = code === figmaCss ? "match" : "drift";
  return valueRow("font-style", code, figmaCss, status);
}

/**
 * Every text-style row for one TEXT node, in a stable order. Callers pass the
 * TEXT node's `style` only when Figma returned one — see the module note on
 * why an absent `style` must produce nothing rather than defaults.
 */
export function textStyleRows(opts: {
  style: FigmaTypeStyle;
  codeStyles: Record<string, string>;
  figmaChars?: string | undefined;
  letterSpacingTokenName?: string | undefined;
}): DimensionDiff[] {
  const { style, codeStyles } = opts;
  const rows: Array<DimensionDiff | null> = [
    letterSpacingRow({
      style,
      codeValue: codeStyles["letter-spacing"],
      tokenName: opts.letterSpacingTokenName,
    }),
    textAlignRow({
      style,
      codeValue: codeStyles["text-align"],
      direction: codeStyles["direction"],
    }),
    textTransformRow({
      style,
      codeValue: codeStyles["text-transform"],
      figmaChars: opts.figmaChars,
    }),
    textDecorationRow({ style, codeValue: codeStyles["text-decoration-line"] }),
    fontStyleRow({ style, codeValue: codeStyles["font-style"] }),
  ];
  return rows.filter((r): r is DimensionDiff => r !== null);
}
