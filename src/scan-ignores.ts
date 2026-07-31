import { relative, resolve, sep } from "node:path";
import { glob } from "tinyglobby";

/**
 * Entry resolution shared by **every** scanner (`scan-css.ts`, `scan-tsx.ts`).
 *
 * One question — "which files does a configured entry actually get?" — must have
 * exactly one answer, because it was answered twice and the two answers
 * disagreed. Issue #46 fixed it for `cssEntries`; issue #60 was the identical
 * defect still live in `tsxEntries`, and the fix is this module rather than a
 * second copy of the logic.
 *
 * The rule, in two tiers:
 *
 *  - **`node_modules` is unconditional and silent.** A consumer's entries are a
 *    statement about their own source; they are never a request to derive
 *    bindings from their dependencies' shipped files, and a `**\/*.css` entry
 *    would otherwise walk the whole dependency tree.
 *  - **`dist` / `storybook-static` are ignored by default only.** They are
 *    normally a duplicate of the source and would double every binding — but an
 *    entry that *names* one opts into it, because explicit configuration must
 *    beat a default. Anything still suppressed is reported, never dropped in
 *    silence: a scanner that derived nothing is indistinguishable from a
 *    codebase that declares nothing, and that ambiguity is the whole bug.
 */

/** @see {@link resolveScanEntries} — tier one, unconditional. */
export const ALWAYS_IGNORED = "**/node_modules/**";

/** @see {@link resolveScanEntries} — tier two, opted into by naming. */
export const DEFAULT_IGNORED_DIRS = ["dist", "storybook-static"] as const;

/**
 * Files an entry glob reached that a default ignore suppressed anyway, grouped
 * by the directory responsible. One entry means "you asked for these and you did
 * not get them" — the whole point of #46/#60 was that this was invisible.
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

export interface ResolveScanEntriesOptions {
  /** How the scanner names its files in the report: `"CSS"` / `"TSX"`. */
  label: string;
  /** The config key the entries came from: `"cssEntries"` / `"tsxEntries"`. */
  configKey: string;
  /** File extension used in the opt-in example, without the dot. */
  extension: string;
  /**
   * Extra patterns ignored **unconditionally and silently**, on top of
   * `node_modules`. For file *kinds* that are never a binding source — the TSX
   * scanner's `*.stories.tsx` / `*.test.tsx`. There is nothing to opt into here,
   * so nothing is reported: these are not build output that duplicates the
   * source, they are files whose bindings would be wrong to derive.
   */
  alsoIgnored?: readonly string[];
}

/**
 * Resolve `entries` to the files that will actually be scanned, and to whatever
 * the default ignores suppressed on the way.
 *
 * Each group is globbed twice: once with its real ignore list, and once with
 * only the unconditional ignores. The difference is exactly "files this entry
 * asked for and did not get" — which is the thing the consumer needs told.
 */
export async function resolveScanEntries(
  cwd: string,
  entries: string[],
  options: ResolveScanEntriesOptions,
): Promise<{ files: string[]; skipped: SkippedScanPath[] }> {
  const unconditional = [ALWAYS_IGNORED, ...(options.alsoIgnored ?? [])];
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
        ignore: [...unconditional, ...enforced.map(ignorePattern)],
      }),
      enforced.length > 0
        ? glob(group.patterns, {
            cwd,
            absolute: true,
            onlyFiles: true,
            ignore: unconditional,
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
        `${files.length} ${options.label} file(s) matched by ${options.configKey} ` +
        `[${entryList.join(", ")}] were NOT scanned because they live under \`${dir}/\`, which ` +
        `design-sync ignores by default (build output normally duplicates the source). No bindings ` +
        `were derived from them: ${examples.join(", ")}` +
        `${files.length > examples.length ? `, +${files.length - examples.length} more` : ""}. ` +
        `If you meant to scan them, name it explicitly in ${options.configKey} ` +
        `(e.g. "${dir}/**/*.${options.extension}") — an entry that names the directory wins over ` +
        `this default.`,
    });
  }

  return { files: [...kept].sort(), skipped };
}
