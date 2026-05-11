import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postcss, { type Rule, type Declaration } from "postcss";
import { glob } from "tinyglobby";

/**
 * Map of CSS selector → { CSS property → token name }.
 *
 * Built by scanning consumer CSS for declarations whose value is a bare
 * `var(--token-name)` reference. The token name is stored without the
 * leading `--`; downstream comparison uses `normalizeTokenName` so the
 * naming convention (`space-8` vs `space/8` vs `--space-8`) doesn't matter.
 *
 * Selectors are stored exactly as authored (after pseudo-class stripping).
 * `.icon-button`, `.icon-button--accent`, and `.foo.bar` are all distinct
 * keys. Server-side lookup attempts the story's `target` selector first
 * and falls back to ancestor selectors for cascade-fallback behavior.
 */
export type AutoTokenMap = Record<string, Record<string, string>>;

interface ScanWarning {
  file: string;
  message: string;
}

export interface ScanResult {
  map: AutoTokenMap;
  warnings: ScanWarning[];
  scannedFiles: string[];
}

const VAR_RE = /^var\(\s*--([a-zA-Z0-9_-]+)\s*(?:,[^)]*)?\)\s*$/;

/**
 * Bare-var-only shorthand expansion. Keys are CSS shorthand props; values
 * are the longhand props the addon's snapshot compares against. Expansion
 * only fires when the declaration value is exactly `var(--x)` — anything
 * more complex (`background: var(--c) center/cover`) is treated as not a
 * token binding and skipped.
 */
const SHORTHAND_EXPANSIONS: Record<string, string[]> = {
  padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  "border-radius": [
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-left-radius",
    "border-bottom-right-radius",
  ],
  background: ["background-color"],
};

/**
 * Pseudo-class / pseudo-element rules don't contribute to the resting-state
 * map. The addon snapshots `getComputedStyle` on the un-hovered element, so
 * any `:hover` / `:focus` binding would falsely diverge from what's painted.
 *
 * Storybook authors hover/focus states as separate stories whose `target`
 * selector matches the forced-state class (e.g. `.pseudo-hover`); those
 * stories don't depend on this map carrying their pseudo bindings.
 */
function isPseudoSelector(sel: string): boolean {
  return /:/.test(sel);
}

function expandDecl(prop: string, tokenName: string): Array<[string, string]> {
  const longhands = SHORTHAND_EXPANSIONS[prop];
  if (longhands) return longhands.map((p) => [p, tokenName] as [string, string]);
  return [[prop, tokenName]];
}

function extractToken(value: string): string | null {
  const m = VAR_RE.exec(value.trim());
  return m ? (m[1] ?? null) : null;
}

function splitSelectors(selectorList: string): string[] {
  // PostCSS already trims; we split on top-level commas. CSS selectors
  // don't contain commas inside `()` for the cases we care about, so a
  // naive split is sufficient.
  return selectorList
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function processRule(rule: Rule, map: AutoTokenMap): void {
  const selectors = splitSelectors(rule.selector);
  const wantedSelectors = selectors.filter((s) => !isPseudoSelector(s));
  if (wantedSelectors.length === 0) return;

  for (const node of rule.nodes ?? []) {
    if (node.type !== "decl") continue;
    const decl = node as Declaration;
    const token = extractToken(decl.value);
    if (!token) continue;
    const pairs = expandDecl(decl.prop, token);
    for (const sel of wantedSelectors) {
      const bucket = map[sel] ?? (map[sel] = {});
      for (const [prop, t] of pairs) bucket[prop] = t;
    }
  }
}

export async function scanCss(
  cwd: string,
  entries: string[],
): Promise<ScanResult> {
  const warnings: ScanWarning[] = [];
  const files = await glob(entries, {
    cwd,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/storybook-static/**"],
  });

  const map: AutoTokenMap = {};
  for (const file of files) {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch (err) {
      warnings.push({ file, message: `Failed to read: ${(err as Error).message}` });
      continue;
    }
    let root;
    try {
      root = postcss.parse(source, { from: file });
    } catch (err) {
      warnings.push({ file, message: `PostCSS parse error: ${(err as Error).message}` });
      continue;
    }
    root.walkRules((rule) => {
      processRule(rule, map);
    });
  }

  return { map, warnings, scannedFiles: files.map((f) => resolve(f)) };
}

/**
 * Look up bindings for a selector with cascade fallback. Tries the exact
 * selector first; if not all properties resolve, walks back to ancestor
 * selectors by stripping trailing `--modifier` segments and adjacent
 * classes. Returns the merged bindings (more-specific keys win).
 *
 * Example fallback chain for `.icon-button--accent`:
 *   1. `.icon-button--accent`
 *   2. `.icon-button`           ← strip `--accent`
 *
 * For `.tab.active`:
 *   1. `.tab.active`
 *   2. `.tab`                   ← strip trailing `.active`
 */
export function lookupBindings(
  map: AutoTokenMap,
  selector: string,
): Record<string, string> {
  const chain = selectorFallbackChain(selector);
  const out: Record<string, string> = {};
  // Walk from most general → most specific so the specific keys overwrite.
  for (let i = chain.length - 1; i >= 0; i--) {
    const bucket = map[chain[i]!];
    if (bucket) Object.assign(out, bucket);
  }
  return out;
}

export function selectorFallbackChain(selector: string): string[] {
  const out = [selector];
  // Strip BEM `--modifier` first (the common case in mde stories).
  const dashIdx = selector.lastIndexOf("--");
  if (dashIdx > 0) {
    out.push(selector.slice(0, dashIdx));
    return out;
  }
  // Then try stripping a trailing adjacent class (.tab.active → .tab).
  const lastDot = selector.lastIndexOf(".");
  if (lastDot > 0) {
    out.push(selector.slice(0, lastDot));
  }
  return out;
}
