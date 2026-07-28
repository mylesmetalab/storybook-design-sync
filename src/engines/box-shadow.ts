import { normalizeColor } from "./color-normalize.js";

/**
 * `box-shadow` comparison: Figma effects ↔ computed CSS.
 *
 * Why this exists as a parser rather than a string compare: the two sides
 * spell the same shadow in different orders. Figma's effect is
 * `{offset, radius, spread, color}`; `getComputedStyle().boxShadow` puts the
 * **colour first** (`rgba(0, 0, 0, 0.25) 0px 2px 4px 0px`) and the `inset`
 * keyword last. The engine's old string compare therefore could never match,
 * and the status expression it fed was `drift : drift` either way — a row that
 * always accused. Both sides are parsed into a structured shadow list and
 * compared field by field, with colours folded through `normalizeColor` so
 * `rgb()`/`rgba()`/`oklch()` spellings of one colour agree.
 *
 * Deliberately excluded effect shapes — when any of these is present the
 * comparison is abandoned and **no row is emitted**, because a partial shadow
 * list cannot be faithfully compared to a complete one:
 *
 *   - a shadow with a `blendMode` other than `NORMAL`/`PASS_THROUGH`
 *     (CSS `box-shadow` has no per-shadow blend mode);
 *   - a shadow whose colour can't be read (no `color`, and no resolvable
 *     bound colour variable).
 *
 * Not excluded, just not shadows: `LAYER_BLUR`, `BACKGROUND_BLUR`, and any
 * other non-shadow effect type belong to `filter`/`backdrop-filter`, so they
 * are skipped without affecting the `box-shadow` verdict. Invisible effects
 * (`visible: false`) are skipped for the same reason — they render nothing.
 *
 * Also not modelled: Figma's "show shadow behind transparent areas"
 * (`showShadowBehindNode`). It changes how the shadow is *painted*, not the
 * offset/blur/spread/colour a design system specifies, so it doesn't affect
 * the comparison either way.
 */

export interface ParsedShadow {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  /** Folded through `normalizeColor` — compare these, don't display them raw. */
  color: string;
}

/** Figma REST effect, narrowed to the fields this module reads. */
export interface FigmaEffect {
  type?: string;
  visible?: boolean;
  blendMode?: string;
  offset?: { x?: number; y?: number };
  radius?: number;
  spread?: number;
  color?: { r: number; g: number; b: number; a?: number };
  [key: string]: unknown;
}

const SHADOW_TYPES = new Set(["DROP_SHADOW", "INNER_SHADOW"]);
const NEUTRAL_BLEND_MODES = new Set(["NORMAL", "PASS_THROUGH"]);

/** Offsets/blur/spread agree within half a pixel, matching the engine's other px rows. */
const SHADOW_EPSILON = 0.5;

/** Split on commas that aren't inside a function's parentheses. */
function splitTopLevel(value: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Whitespace-tokenize, keeping `rgb(0 0 0 / 50%)` as one token. */
function tokenize(part: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of part) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(ch)) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

const LENGTH_RE = /^([-+]?(?:\d+\.?\d*|\.\d+))(px)?$/i;

/**
 * `normalizeColor` folds hex, `rgb()`/`rgba()`, `oklch()`, `oklab()` and
 * `color(display-p3 …)` into a canonical `rgb()`/`rgba()`/`transparent`, and
 * passes anything else through whitespace-stripped. A passed-through string
 * would compare unequal to the same colour spelled Figma's way, so a colour
 * that doesn't fold is treated as unreadable — the shadow is refused and no
 * row is emitted, rather than a colour difference being invented.
 */
const CANONICAL_COLOR_RE = /^(?:transparent|rgb\(\d+,\d+,\d+\)|rgba\(\d+,\d+,\d+,[\d.]+\))$/;

function canonicalColor(raw: string): string | null {
  const folded = normalizeColor(raw);
  return CANONICAL_COLOR_RE.test(folded) ? folded : null;
}

function asLengthPx(token: string): number | null {
  const m = LENGTH_RE.exec(token);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  // A unitless number is only a length when it's zero.
  if (m[2] === undefined && n !== 0) return null;
  return n;
}

function parseOneShadow(part: string): ParsedShadow | null {
  const tokens = tokenize(part);
  if (tokens.length === 0) return null;
  let inset = false;
  const lengths: number[] = [];
  const colors: string[] = [];
  for (const token of tokens) {
    if (token.toLowerCase() === "inset") {
      if (inset) return null; // `inset inset` isn't valid
      inset = true;
      continue;
    }
    const len = asLengthPx(token);
    if (len !== null) {
      lengths.push(len);
      continue;
    }
    colors.push(token);
  }
  // Exactly one colour, and the two required lengths (offset-x, offset-y).
  if (colors.length !== 1 || lengths.length < 2 || lengths.length > 4) return null;
  const color = canonicalColor(colors[0]!);
  if (color === null) return null;
  return {
    inset,
    x: lengths[0]!,
    y: lengths[1]!,
    blur: lengths[2] ?? 0,
    spread: lengths[3] ?? 0,
    color,
  };
}

/**
 * Parse a computed `box-shadow` string.
 *
 * Returns `[]` for `none` (a real "no shadow" opinion) and `null` when the
 * value is missing or can't be parsed — callers must treat `null` as "no
 * comparison possible", never as "no shadow".
 */
export function parseCssBoxShadow(value: string | undefined): ParsedShadow[] | null {
  const v = value?.trim();
  if (!v) return null;
  if (v.toLowerCase() === "none") return [];
  const parts = splitTopLevel(v, ",");
  if (parts.length === 0) return null;
  const out: ParsedShadow[] = [];
  for (const part of parts) {
    const shadow = parseOneShadow(part);
    if (!shadow) return null;
    out.push(shadow);
  }
  return out;
}

export interface FigmaShadowResult {
  shadows: ParsedShadow[];
  /** Non-empty ⇒ the list is incomplete; the caller must emit no row. */
  excluded: string[];
}

/**
 * Convert Figma effects into the same structured form.
 *
 * `resolveColor` is supplied by the engine (it owns variable resolution and
 * the `{r,g,b,a}` → CSS conversion); returning `undefined` means the effect's
 * colour couldn't be read, which excludes the effect.
 *
 * Returns `null` when `effects` is absent entirely — Figma told us nothing
 * about this node's effects, which is not the same as "no shadow".
 */
export function figmaEffectsToShadows(
  effects: FigmaEffect[] | undefined,
  resolveColor: (effect: FigmaEffect) => string | undefined,
): FigmaShadowResult | null {
  if (!Array.isArray(effects)) return null;
  const shadows: ParsedShadow[] = [];
  const excluded: string[] = [];
  for (const effect of effects) {
    if (effect.visible === false) continue;
    const type = effect.type ?? "";
    if (!SHADOW_TYPES.has(type)) continue; // blurs etc. aren't box-shadow
    const blend = effect.blendMode;
    if (blend !== undefined && !NEUTRAL_BLEND_MODES.has(blend)) {
      excluded.push(`${type} with blend mode ${blend} (CSS box-shadow has no per-shadow blend mode)`);
      continue;
    }
    const raw = resolveColor(effect);
    const color = raw ? canonicalColor(raw) : null;
    if (color === null) {
      excluded.push(`${type} whose colour could not be read`);
      continue;
    }
    const x = effect.offset?.x ?? 0;
    const y = effect.offset?.y ?? 0;
    const blur = effect.radius ?? 0;
    const spread = effect.spread ?? 0;
    if (![x, y, blur, spread].every((n) => typeof n === "number" && Number.isFinite(n))) {
      excluded.push(`${type} with a non-numeric offset/blur/spread`);
      continue;
    }
    shadows.push({ inset: type === "INNER_SHADOW", x, y, blur, spread, color });
  }
  return { shadows, excluded };
}

/**
 * Whether two shadow lists describe the same thing. Order is significant —
 * in CSS the first shadow paints on top, and Figma's effect list is ordered
 * the same way, so a reordered list is a different rendering.
 */
export function shadowsEqual(
  a: ParsedShadow[],
  b: ParsedShadow[],
  epsilon = SHADOW_EPSILON,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((s, i) => {
    const t = b[i]!;
    return (
      s.inset === t.inset &&
      s.color === t.color &&
      Math.abs(s.x - t.x) < epsilon &&
      Math.abs(s.y - t.y) < epsilon &&
      Math.abs(s.blur - t.blur) < epsilon &&
      Math.abs(s.spread - t.spread) < epsilon
    );
  });
}

function num(n: number): string {
  return `${Number(n.toFixed(3))}px`;
}

/** Canonical CSS spelling, for the Figma cell. `none` for an empty list. */
export function formatShadows(shadows: ParsedShadow[]): string {
  if (shadows.length === 0) return "none";
  return shadows
    .map(
      (s) =>
        `${s.inset ? "inset " : ""}${num(s.x)} ${num(s.y)} ${num(s.blur)} ${num(s.spread)} ${s.color}`,
    )
    .join(", ");
}
