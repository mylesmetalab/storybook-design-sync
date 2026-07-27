/**
 * Color folding for drift comparison.
 *
 * The code side of a comparison is `getComputedStyle().getPropertyValue()`,
 * which hands back whatever color space the author wrote when the value can't
 * be represented in legacy `rgb()`. Modern shadcn / Tailwind v4 themes ship
 * `oklch()` by default, so a *correct* themed color would be reported as drift
 * against Figma — which always arrives as `rgb()`/`rgba()` via `rgbaToCss`.
 *
 * Everything here folds into the engine's existing canonical form:
 * `rgb(R,G,B)`, or `rgba(R,G,B,A)` when alpha is below 1, whitespace-stripped
 * and lowercased. That form is unchanged by this module — only the set of
 * inputs it can recognise grew.
 *
 * ### Conversion chain
 * OKLCh → OKLab (polar → rectangular) → LMS' → LMS (cube) → linear sRGB
 * (matrix) → gamma-encoded sRGB (sRGB transfer function) → 0-255, clamped.
 *
 * The OKLab ↔ linear-sRGB matrices are verbatim from Björn Ottosson's
 * reference implementation (https://bottosson.github.io/posts/oklab/), which
 * is what CSS Color 4 normatively describes.
 *
 * Out-of-gamut inputs (common — OKLCh addresses colors sRGB can't) clamp per
 * channel rather than throwing. That is lossy: two different out-of-gamut
 * colors can fold to the same sRGB value.
 *
 * NOTE: `storybook-design-inspector` carries a parallel copy of this
 * conversion (its canonical form is hex, not `rgb()`). If a third consumer
 * appears, lift the math into `@metalab/design-sync-core`.
 */

interface Rgba {
  /** 0-255, integer. */
  r: number;
  g: number;
  b: number;
  /** 0-1. */
  a: number;
}

/** CSS Color 4: `100%` on oklab/oklch chroma and a/b axes means 0.4. */
const OK_CHROMA_PERCENT_BASE = 0.4;

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** sRGB transfer function: linear (0-1) → gamma-encoded (0-1). */
function gammaEncode(c: number): number {
  const sign = c < 0 ? -1 : 1;
  const abs = Math.abs(c);
  if (abs <= 0.0031308) return c * 12.92;
  return sign * (1.055 * Math.pow(abs, 1 / 2.4) - 0.055);
}

function to8Bit(encoded: number): number {
  return Math.round(clamp01(encoded) * 255);
}

/** OKLab → linear sRGB. Result may fall outside 0-1 (out of gamut). */
function oklabToLinearSrgb(L: number, a: number, b: number): [number, number, number] {
  const lp = L + 0.3963377774 * a + 0.2158037573 * b;
  const mp = L - 0.1055613458 * a - 0.0638541728 * b;
  const sp = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = lp * lp * lp;
  const m = mp * mp * mp;
  const s = sp * sp * sp;

  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/** OKLab (L 0-1, a/b roughly ±0.4) → sRGB 0-255, gamut-clamped. */
export function oklabToRgba(L: number, a: number, b: number, alpha = 1): Rgba {
  const [lr, lg, lb] = oklabToLinearSrgb(L, a, b);
  return {
    r: to8Bit(gammaEncode(lr)),
    g: to8Bit(gammaEncode(lg)),
    b: to8Bit(gammaEncode(lb)),
    a: alpha,
  };
}

/** OKLCh (L 0-1, C ≥ 0, H in degrees) → sRGB 0-255, gamut-clamped. */
export function oklchToRgba(L: number, C: number, H: number, alpha = 1): Rgba {
  const rad = (H * Math.PI) / 180;
  return oklabToRgba(L, C * Math.cos(rad), C * Math.sin(rad), alpha);
}

/**
 * Display P3 → sRGB. Both share the D65 white point and the sRGB transfer
 * function, so this is one linear matrix between primary sets. Grays are
 * preserved exactly (each row sums to 1); P3 colors outside sRGB clamp.
 */
function displayP3ToRgba(r: number, g: number, b: number, alpha = 1): Rgba {
  const lin = (c: number): number => {
    const sign = c < 0 ? -1 : 1;
    const abs = Math.abs(c);
    return abs <= 0.04045 ? c / 12.92 : sign * Math.pow((abs + 0.055) / 1.055, 2.4);
  };
  const pr = lin(r);
  const pg = lin(g);
  const pb = lin(b);

  const sr = 1.2249401762 * pr - 0.2249401762 * pg;
  const sg = -0.0420569547 * pr + 1.0420569547 * pg;
  const sb = -0.0196375546 * pr - 0.0786360454 * pg + 1.0982736 * pb;

  return {
    r: to8Bit(gammaEncode(sr)),
    g: to8Bit(gammaEncode(sg)),
    b: to8Bit(gammaEncode(sb)),
    a: alpha,
  };
}

/**
 * Split a functional color's body into components plus an optional
 * slash-separated alpha. Tolerates commas as component separators.
 */
function splitComponents(body: string): { parts: string[]; alpha?: string } | null {
  const slashes = (body.match(/\//g) ?? []).length;
  if (slashes > 1) return null;
  const [main, alphaRaw] = body.split("/");
  if (main === undefined) return null;
  const parts = main.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length === 0) return null;
  const alpha = alphaRaw?.trim();
  if (alpha !== undefined && alpha.length === 0) return null;
  return alpha === undefined ? { parts } : { parts, alpha };
}

/**
 * Parse one numeric component. `none` resolves to 0 (CSS Color 4: outside
 * interpolation a missing component behaves as zero). Percentages scale by
 * `percentBase`. Returns null for anything unparseable — notably `var()` and
 * `calc()`, which `getComputedStyle` would already have resolved.
 */
function parseComponent(token: string, percentBase: number): number | null {
  const t = token.trim().toLowerCase();
  if (t === "none") return 0;
  if (t.endsWith("%")) {
    const n = Number.parseFloat(t.slice(0, -1));
    return Number.isFinite(n) ? (n / 100) * percentBase : null;
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse a hue, honouring the four CSS angle units. Degrees out. */
function parseHue(token: string): number | null {
  const t = token.trim().toLowerCase();
  if (t === "none") return 0;
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+))(deg|rad|grad|turn)?$/.exec(t);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case "rad":
      return (n * 180) / Math.PI;
    case "grad":
      return n * 0.9;
    case "turn":
      return n * 360;
    default:
      return n;
  }
}

function parseAlpha(token: string | undefined): number | null {
  if (token === undefined) return 1;
  const v = parseComponent(token, 1);
  return v === null ? null : clamp01(v);
}

function parseHex(value: string): Rgba | null {
  if (!HEX_RE.test(value)) return null;
  let h = value.slice(1);
  if (h.length === 3 || h.length === 4) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const n = Number.parseInt(h.slice(0, 6), 16);
  const a = h.length === 8 ? Number.parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a };
}

/**
 * Parse `oklch()`, `oklab()` or `color(display-p3 …)` into sRGB 0-255.
 * Returns null for anything else — including `color()` in a space we don't
 * handle — so callers can fall back to their previous behaviour.
 */
export function parseModernColor(input: string): Rgba | null {
  const v = input.trim().toLowerCase();
  const m = /^(oklch|oklab|color)\(([^()]*)\)$/.exec(v);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const split = splitComponents(m[2]);
  if (!split) return null;
  const { parts, alpha: alphaToken } = split;

  const alpha = parseAlpha(alphaToken);
  if (alpha === null) return null;

  if (m[1] === "oklch") {
    if (parts.length !== 3) return null;
    const L = parseComponent(parts[0]!, 1);
    const C = parseComponent(parts[1]!, OK_CHROMA_PERCENT_BASE);
    const H = parseHue(parts[2]!);
    if (L === null || C === null || H === null) return null;
    // Negative chroma is invalid CSS; fold to achromatic rather than flipping
    // the hue.
    return oklchToRgba(L, Math.max(0, C), H, alpha);
  }

  if (m[1] === "oklab") {
    if (parts.length !== 3) return null;
    const L = parseComponent(parts[0]!, 1);
    const a = parseComponent(parts[1]!, OK_CHROMA_PERCENT_BASE);
    const b = parseComponent(parts[2]!, OK_CHROMA_PERCENT_BASE);
    if (L === null || a === null || b === null) return null;
    return oklabToRgba(L, a, b, alpha);
  }

  // color(<colorspace> c1 c2 c3)
  if (parts.length !== 4) return null;
  if (parts[0]!.toLowerCase() !== "display-p3") return null;
  const r = parseComponent(parts[1]!, 1);
  const g = parseComponent(parts[2]!, 1);
  const b = parseComponent(parts[3]!, 1);
  if (r === null || g === null || b === null) return null;
  return displayP3ToRgba(r, g, b, alpha);
}

/** Render into the engine's canonical `rgb()`/`rgba()` form (no whitespace). */
function toCanonical(c: Rgba): string {
  if (c.a >= 1) return `rgb(${c.r},${c.g},${c.b})`;
  // Alpha is rounded to 3 decimals so float noise from a percentage or an
  // oklch conversion can't split two otherwise-identical colors.
  return `rgba(${c.r},${c.g},${c.b},${Number(c.a.toFixed(3))})`;
}

/** Treat browser's "no opinion" color sentinels as equivalent. */
export function isTransparentColor(value: string | undefined): boolean {
  if (!value) return true;
  const v = value.replace(/\s+/g, "").toLowerCase();
  return v === "rgba(0,0,0,0)" || v === "transparent" || v === "rgba(0,0,0,0.0)";
}

/**
 * Fold colors into a canonical form so semantically-equivalent expressions
 * compare equal. `rgba(R,G,B,1)` ≡ `rgb(R,G,B)`; whitespace and case are
 * ignored. Hex and the modern color spaces (`oklch()`, `oklab()`,
 * `color(display-p3 …)`) convert into the same `rgb()` form. Returns
 * "transparent" for any fully-transparent value so the engine can treat those
 * as "no opinion." Anything unrecognised falls through whitespace-stripped and
 * lowercased, exactly as before.
 */
export function normalizeColor(value: string): string {
  if (isTransparentColor(value)) return "transparent";
  const trimmed = value.trim().toLowerCase();

  // Convert before stripping whitespace — spaces are significant inside
  // oklch()/oklab()/color().
  const converted = parseHex(trimmed) ?? parseModernColor(trimmed);
  const stripped = converted ? toCanonical(converted) : trimmed.replace(/\s+/g, "");

  // A conversion can land on a fully-transparent color too.
  if (isTransparentColor(stripped)) return "transparent";

  // rgba(R, G, B, 1) → rgb(R, G, B). The same channel triple should match
  // regardless of whether the producer wrote it with an alpha=1 suffix.
  const m = /^rgba\((\d+),(\d+),(\d+),1(?:\.0+)?\)$/.exec(stripped);
  if (m) return `rgb(${m[1]},${m[2]},${m[3]})`;
  return stripped;
}
