/**
 * Shared shape definitions for token-binding extraction. Three scanners
 * need to land bindings under the same property keys or the drift report
 * cross-section comparisons fail silently:
 *
 *   - `scan-css.ts`  — PostCSS scanner of consumer `.css` files (Node, build-time)
 *   - `scan-tsx.ts`  — ts-morph scanner of consumer `.tsx` files (Node, build-time)
 *   - `preview.ts`   — DOM scanner of the rendered story (browser, runtime)
 *
 * Anything that varies by scanner — which shorthand expands to which
 * longhands, which composite values to pull a token out of, which key
 * to file the result under — lives here as the single source of truth.
 * Previously these tables were duplicated; "drift between scanners"
 * was an actual bug class (composite border tokens captured in scan-tsx
 * but not preview, so wiring rows lied).
 */

/**
 * Bare-var-only shorthand expansion. When the *entire* declaration value
 * is a single `var(--x)`, expand the shorthand into the longhands the
 * engines compare against. Composite values (`padding: 8px 12px`) aren't
 * handled here — only fully-var shorthands.
 */
export const SHORTHAND_EXPANSIONS: Record<string, string[]> = {
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  "border-radius": [
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-left-radius",
    "border-bottom-right-radius",
  ],
  background: ["background-color"],
};

export function expandDecl(prop: string, tokenName: string): Array<[string, string]> {
  const longhands = SHORTHAND_EXPANSIONS[prop];
  if (longhands) return longhands.map((p) => [p, tokenName] as [string, string]);
  return [[prop, tokenName]];
}

/**
 * Per-edge / shorthand → engine-key map. The figma-rest engine reports
 * `border-color` (not `border-bottom-color`) and `background-color`
 * (not `background`); the inline-style + JSX scanners have to project
 * their longhand bindings onto these keys or Wiring rows show
 * "needs setup" even when the binding exists.
 */
export const INLINE_BINDING_KEY: Record<string, string> = {
  background: "background-color",
  "border-top-color": "border-color",
  "border-right-color": "border-color",
  "border-bottom-color": "border-color",
  "border-left-color": "border-color",
  "border-top-width": "border-width",
  "border-right-width": "border-width",
  "border-bottom-width": "border-width",
  "border-left-width": "border-width",
};

export function normalizeBindingKey(prop: string): string {
  return INLINE_BINDING_KEY[prop] ?? prop;
}

/**
 * Composite shorthands that may carry a single `var(--token)` reference
 * embedded in a literal `<width> <style> var(--color)` sequence. The
 * heuristic: a lone var() in any of these is the color slot.
 */
const COMPOSITE_BORDER_PREFIX: Record<string, string> = {
  border: "border",
  "border-top": "border-top",
  "border-right": "border-right",
  "border-bottom": "border-bottom",
  "border-left": "border-left",
  outline: "outline",
};

const COMPOSITE_VAR_RE = /var\(\s*--([a-zA-Z0-9_-]+)\s*(?:,[^)]*)?\)/g;

/**
 * Extract longhand → token pairs from a composite shorthand value. Returns
 * an empty array when the property isn't a border/outline shorthand, when
 * the value contains zero or 2+ var() references (ambiguous), or when
 * the property is something else entirely.
 *
 * Caller is expected to feed the result back through `normalizeBindingKey`
 * before storing if it'll be compared against the figma-rest engine's
 * output.
 */
export function compositeBorderTokens(
  prop: string,
  value: string,
): Array<[string, string]> {
  const prefix = COMPOSITE_BORDER_PREFIX[prop];
  if (!prefix) return [];
  const tokens: string[] = [];
  for (const m of value.matchAll(COMPOSITE_VAR_RE)) tokens.push(m[1]!);
  if (tokens.length !== 1) return [];
  return [[`${prefix}-color`, tokens[0]!]];
}

/**
 * Match `^var(--name)$` (whole-value bare var). Returns the token name
 * (without the leading `--`) or null if the value isn't a clean bare var.
 */
const BARE_VAR_RE = /^var\(\s*--([a-zA-Z0-9_-]+)\s*(?:,[^)]*)?\)\s*$/;

export function extractBareVarToken(value: string): string | null {
  const m = BARE_VAR_RE.exec(value.trim());
  return m ? (m[1] ?? null) : null;
}
