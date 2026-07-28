import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postcss, { type Rule, type Declaration } from "postcss";
import { glob } from "tinyglobby";
import {
  deriveSelectorChain,
  parseTailwindTheme,
  mergeTailwindThemes,
  type TailwindThemeVars,
} from "@metalab/design-sync-core";
import { expandDecl, extractBareVarToken } from "./binding-shape.js";

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
  /**
   * Tailwind v4 `@theme` custom properties found across all scanned files,
   * keyed without the leading `--`. Empty for a consumer that isn't on
   * Tailwind v4's CSS-first theme (including v3, whose scale lives in
   * `tailwind.config.js` and is not evaluated).
   *
   * Fed to `scanTsx`, which needs it to turn a utility class into a token:
   * `bg-primary` is only a binding if the consumer's theme declares
   * `--color-primary`. Parsing the theme here rather than in the TSX scanner
   * keeps CSS reading in one place — the TSX scanner never opens a `.css`
   * file.
   */
  themeVars: TailwindThemeVars;
}

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
    const token = extractBareVarToken(decl.value);
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
  const themes: TailwindThemeVars[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch (err) {
      warnings.push({ file, message: `Failed to read: ${(err as Error).message}` });
      continue;
    }
    // Theme extraction is independent of the PostCSS pass and must not be
    // skipped when a file fails to parse as CSS — `@theme` blocks are read by
    // a standalone scanner in core, so run it on the raw source first.
    themes.push(parseTailwindTheme(source));
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

  return {
    map,
    warnings,
    scannedFiles: files.map((f) => resolve(f)),
    themeVars: mergeTailwindThemes(...themes),
  };
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
  const chain = deriveSelectorChain(selector);
  const out: Record<string, string> = {};
  // Walk from most general → most specific so the specific keys overwrite.
  for (let i = chain.length - 1; i >= 0; i--) {
    const bucket = map[chain[i]!];
    if (bucket) Object.assign(out, bucket);
  }
  return out;
}

/**
 * @deprecated Use `deriveSelectorChain` from `@metalab/design-sync-core`.
 * Retained as a stable alias so existing importers of the old name keep
 * working. Note the behavior change vs the addon's original one-level
 * implementation: the core version walks up to FOUR BEM/class levels, so a
 * binding can now resolve on a deeper ancestor selector than before.
 */
export const selectorFallbackChain = deriveSelectorChain;
