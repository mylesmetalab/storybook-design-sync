import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
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

/**
 * Files a `cssEntries` glob reached that a default ignore suppressed anyway,
 * grouped by the directory responsible. One entry means "you asked for these
 * and you did not get them" — the whole point of issue #46 was that this was
 * previously invisible.
 */
export interface SkippedScanPath {
  /** The default-ignored directory name: `dist` or `storybook-static`. */
  directory: string;
  /** How many files the entries reached under it. */
  count: number;
  /** Up to three consumer-relative paths, so the log names real files. */
  examples: string[];
  /** The configured entries that reached them. */
  entries: string[];
  /** Ready-to-log sentence, including how to opt in. */
  message: string;
}

export interface ScanResult {
  map: AutoTokenMap;
  warnings: ScanWarning[];
  scannedFiles: string[];
  /**
   * Non-empty when a configured entry matched files that a default ignore
   * suppressed. The caller MUST surface these: a scanner that derived nothing
   * looks exactly like a codebase that declares nothing, and that ambiguity was
   * issue #46. Empty in the ordinary case (including when an entry names a
   * default-ignored directory outright, since then nothing is suppressed).
   */
  skipped: SkippedScanPath[];
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
  /**
   * **Every** custom property declared anywhere in the scanned files, keyed
   * without the leading `--`, mapped to the consumer-relative files declaring it.
   *
   * Distinct from `themeVars`, and both are needed. `themeVars` is Tailwind's
   * `@theme` block — the subset that generates utilities, which is what turns
   * `bg-primary` into a binding. This is the whole set: `:root`, `.dark`,
   * `@theme`, a plain rule, anything. It answers a different question — "does this
   * project declare a custom property by this name at all?" — which is what a fix
   * prompt must know before it names one (issues #66/#67). A prompt that suggested
   * `var(--text-positive-secondary)` in a project whose colours are `--color-*`,
   * and which declared no such property, was the failure this collection exists to
   * prevent.
   *
   * `.dark` is included deliberately: half of a mode-varying token's answer lives
   * there, and an index that stopped at `:root` would report a dark-only override
   * as absent.
   */
  customProperties: Record<string, string[]>;
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

/**
 * Ignored no matter what any entry says. A consumer's `cssEntries` is a
 * statement about their own stylesheets; it is never a request to derive
 * bindings from their dependencies' shipped CSS, and a `**\/*.css` entry would
 * otherwise walk the whole dependency tree.
 */
const ALWAYS_IGNORED = "**/node_modules/**";

/**
 * Directories ignored **by default** — build output, which is normally a
 * duplicate of the source CSS and would double every binding. An entry that
 * names one of these opts into it, because explicit configuration must beat a
 * default (issue #46). Anything still suppressed is reported, never dropped in
 * silence.
 */
const DEFAULT_IGNORED_DIRS = ["dist", "storybook-static"] as const;

/** `**\/dist\/**` for `dist`. */
function ignorePattern(dir: string): string {
  return `**/${dir}/**`;
}

/**
 * Whether an entry names a directory outright, as a literal path segment:
 * `storybook-static/**\/*.css` and `./dist/lib.css` do; `**\/*.css` does not,
 * because it names nothing — it merely reaches everywhere.
 *
 * Deliberately literal. A glob that could *expand* to the directory (`*-static`,
 * `{dist,src}`) is not treated as naming it: guessing at intent here would
 * re-create the original bug in the other direction, silently scanning build
 * output nobody asked for. Such an entry lands in `skipped` with the exact
 * remedy instead.
 */
export function entryNamesDirectory(entry: string, dir: string): boolean {
  return entry
    .replace(/^!/, "")
    .split("/")
    .some((segment) => segment === dir);
}

/**
 * Group positive entries by the set of default ignores they opt out of, so each
 * group can be globbed with its own ignore list. Grouping (rather than one glob
 * for everything) is what keeps an opt-in from leaking: `["dist/**\/*.css",
 * "src/**\/*.css"]` scans `dist`, but `src/**\/*.css` still does not pick up a
 * nested `src/vendored/dist/`.
 *
 * Negative patterns (`!**\/skip.css`) belong to every group — they are
 * exclusions, not entries, and dropping them would scan what the consumer
 * excluded.
 */
function groupEntries(entries: string[]): Array<{ patterns: string[]; optedIn: string[] }> {
  const negatives = entries.filter((e) => e.startsWith("!"));
  const groups = new Map<string, { patterns: string[]; optedIn: string[] }>();
  for (const entry of entries) {
    if (entry.startsWith("!")) continue;
    const optedIn = DEFAULT_IGNORED_DIRS.filter((dir) => entryNamesDirectory(entry, dir));
    const key = optedIn.join("|");
    const group = groups.get(key) ?? { patterns: [], optedIn: [...optedIn] };
    group.patterns.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    patterns: [...group.patterns, ...negatives],
  }));
}

/**
 * Resolve `entries` to the files that will actually be scanned, and to whatever
 * the default ignores suppressed on the way.
 *
 * Each group is globbed twice: once with its real ignore list, and once with
 * only `node_modules` ignored. The difference is exactly "files this entry
 * asked for and did not get" — which is the thing the consumer needs told.
 */
async function resolveEntries(
  cwd: string,
  entries: string[],
): Promise<{ files: string[]; skipped: SkippedScanPath[] }> {
  const kept = new Set<string>();
  /** directory → { files, entries } */
  const suppressed = new Map<string, { files: Set<string>; entries: Set<string> }>();

  for (const group of groupEntries(entries)) {
    const enforced = DEFAULT_IGNORED_DIRS.filter((dir) => !group.optedIn.includes(dir));
    const [scanned, reachable] = await Promise.all([
      glob(group.patterns, {
        cwd,
        absolute: true,
        onlyFiles: true,
        ignore: [ALWAYS_IGNORED, ...enforced.map(ignorePattern)],
      }),
      enforced.length > 0
        ? glob(group.patterns, {
            cwd,
            absolute: true,
            onlyFiles: true,
            ignore: [ALWAYS_IGNORED],
          })
        : Promise.resolve([]),
    ]);
    for (const file of scanned) kept.add(resolve(file));
    const scannedSet = new Set(scanned.map((f) => resolve(f)));
    for (const raw of reachable) {
      const file = resolve(raw);
      if (scannedSet.has(file)) continue;
      const rel = relative(cwd, file);
      const dir = enforced.find((d) => rel.split(sep).includes(d));
      if (!dir) continue;
      const bucket = suppressed.get(dir) ?? { files: new Set(), entries: new Set() };
      bucket.files.add(rel);
      for (const pattern of group.patterns) {
        if (!pattern.startsWith("!")) bucket.entries.add(pattern);
      }
      suppressed.set(dir, bucket);
    }
  }

  const skipped: SkippedScanPath[] = [];
  for (const dir of DEFAULT_IGNORED_DIRS) {
    const bucket = suppressed.get(dir);
    if (!bucket || bucket.files.size === 0) continue;
    const files = [...bucket.files].sort();
    const examples = files.slice(0, 3);
    const entryList = [...bucket.entries].sort();
    skipped.push({
      directory: dir,
      count: files.length,
      examples,
      entries: entryList,
      message:
        `${files.length} CSS file(s) matched by cssEntries [${entryList.join(", ")}] were NOT scanned ` +
        `because they live under \`${dir}/\`, which design-sync ignores by default (build output normally ` +
        `duplicates the source CSS). No bindings were derived from them: ${examples.join(", ")}` +
        `${files.length > examples.length ? `, +${files.length - examples.length} more` : ""}. ` +
        `If you meant to scan them, name it explicitly in cssEntries (e.g. "${dir}/**/*.css") — ` +
        `an entry that names the directory wins over this default.`,
    });
  }

  return { files: [...kept].sort(), skipped };
}

export async function scanCss(
  cwd: string,
  entries: string[],
): Promise<ScanResult> {
  const warnings: ScanWarning[] = [];
  const { files, skipped } = await resolveEntries(cwd, entries);

  const map: AutoTokenMap = {};
  const themes: TailwindThemeVars[] = [];
  const customProperties: Record<string, string[]> = {};
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
    // Declarations, not rules: `@theme { --color-primary: … }` is an at-rule, so
    // `walkRules` never reaches its children. `walkDecls` reaches every
    // declaration wherever it sits, which is the point — the index must not depend
    // on which block a consumer keeps its tokens in.
    const rel = relative(cwd, file);
    root.walkDecls((decl) => {
      if (!decl.prop.startsWith("--")) return;
      const name = decl.prop.slice(2).trim();
      if (name === "") return;
      const bucket = customProperties[name] ?? (customProperties[name] = []);
      if (!bucket.includes(rel)) bucket.push(rel);
    });
  }

  return {
    map,
    warnings,
    scannedFiles: files,
    skipped,
    themeVars: mergeTailwindThemes(...themes),
    customProperties,
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
