import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

/**
 * Story discovery for the CLI (`audit`, `ls`, `register`, `export-graph`).
 *
 * ## Why this file exists
 *
 * Discovery used to be a regex requiring a literal `title:` in the source, and
 * returning `null` when it found none. Every **CSF3 autotitle** file — no
 * `title` in the meta, the title derived from the file path, which is the shape
 * Storybook's own docs recommend — therefore produced no stories. It warned, but
 * it did not *count*: `register` created no entries for those stories, `audit`
 * reported `Missing: 0`, and CI went green over a set of stories that are never
 * checked by anything. A registry that looks complete is worse than one that is
 * visibly short.
 *
 * ## How titles are resolved
 *
 * Two tiers, and the report always says which one ran:
 *
 *  1. **`getStoryTitle` from the installed Storybook** (`storybook/internal/common`)
 *     — Storybook's own derivation, so the title is authoritative by
 *     construction. `storybook` is already a peer dependency of this addon;
 *     nothing new is installed. The addon's `storyGlobs` are passed as the
 *     `stories` specifiers with `configDir` = the consumer root, because
 *     `storyGlobs` are root-relative (Storybook's `main.ts` entries are
 *     `configDir`-relative — the difference matters and this is where it is
 *     absorbed).
 *  2. **{@link deriveAutoTitle}** — a local implementation of the same
 *     algorithm, used only when Storybook can't be imported. `story-discovery.test.ts`
 *     asserts the two agree on a table of paths, so the fallback is a fallback
 *     and not a second behaviour.
 *
 * Exports come from a real CSF parse (`loadCsf` from
 * `storybook/internal/csf-tools`) rather than a wider regex. That is what makes
 * autotitle files work at all, and it also fixes things the regex got wrong in
 * the other direction: `excludeStories` / `includeStories` are honoured, type-only
 * exports and `export const meta` are not counted as stories, and CSF factory
 * files (`preview.meta({…})`) parse. When csf-tools can't be imported, a regex
 * fallback runs and the report says so.
 *
 * ## Nothing is silently dropped
 *
 * A file that matches `storyGlobs` and cannot be turned into story ids is
 * reported as **unreadable**, with the reason, and `audit` exits non-zero on it.
 * That is the whole point: "no stories" and "stories I could not parse" must
 * never look the same.
 */

/** One story that discovery is confident about. */
export interface DiscoveredStory {
  id: string;
  /** Consumer-relative path. */
  file: string;
  title: string;
  exportName: string;
  /** Whether the meta declared `title:` or the title came from the file path. */
  titleSource: "explicit" | "autotitle";
}

/**
 * A file that matched `storyGlobs` and yielded no story ids. This is a coverage
 * hole, not a footnote: whatever stories it contains are registered by nothing
 * and checked by nothing.
 */
export interface UnreadableStoryFile {
  file: string;
  reason: string;
}

/**
 * A file that matched `storyGlobs` and legitimately contributes no story ids —
 * currently only `.mdx`, whose entries are docs, not stories. Reported so the
 * count adds up, but not a failure.
 */
export interface SkippedStoryFile {
  file: string;
  reason: string;
}

export interface DiscoveryOutcome {
  stories: DiscoveredStory[];
  unreadable: UnreadableStoryFile[];
  skipped: SkippedStoryFile[];
  /** Which export reader ran. */
  exports: "storybook-csf" | "regex";
  /** Which title resolver ran. */
  titles: "storybook" | "derived";
  /**
   * Set when either tier fell back, with the reason. Printed by the CLI: a
   * degraded read is less accurate and the user has to know which one they got.
   */
  degraded?: string;
}

/* ------------------------------------------------------------------------- *
 * story ids
 * ------------------------------------------------------------------------- */

export function storyNameFromExport(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
    .trim();
}

export function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ '’–—/]/g, "-")
    .replace(/[^a-z0-9_.\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `title` + export name → Storybook story id.
 *
 * Note what this deliberately does NOT use: a story's `name` annotation.
 * Storybook derives the id from the **export name** (`toId(componentId,
 * storyNameFromExport(key))`); `name: "With a header"` on
 * `export const WithHeader` changes the display name only, and both spell the
 * id `…--with-header`. Using the name here would mint ids Storybook never
 * produces.
 */
export function toStoryId(title: string, exportName: string): string {
  return `${sanitize(title)}--${sanitize(storyNameFromExport(exportName))}`;
}

/* ------------------------------------------------------------------------- *
 * autotitle derivation
 * ------------------------------------------------------------------------- */

const MAGIC = /[*?[\]{}()!+@]/;

/**
 * The static directory prefix of a glob — the leading segments before the first
 * one containing glob syntax. `src/**\/*.stories.tsx` → `src`;
 * `stories/ui/*.stories.ts` → `stories/ui`; `**\/*.stories.tsx` → `` (the root).
 *
 * This is the specifier `directory` Storybook computes for a string entry, and
 * it is the part the title is taken relative to.
 */
export function globDirectory(pattern: string): string {
  const segments = pattern.replace(/^\.\//, "").split("/");
  const staticSegments: string[] = [];
  for (const segment of segments) {
    if (MAGIC.test(segment)) break;
    staticSegments.push(segment);
  }
  // The last static segment is the filename when the pattern has no magic at
  // all (`src/ui/Button.stories.tsx`), and a filename is not a directory.
  if (staticSegments.length === segments.length) staticSegments.pop();
  return staticSegments.join("/");
}

function stripStoryExtension(segment: string): string {
  return segment.replace(/(\.(?:stories|story))?\.[^.]+$/i, "");
}

/**
 * Storybook's autotitle algorithm, reimplemented for the case where Storybook
 * itself can't be imported. The rules, exactly:
 *
 *  1. Pick the configured glob with the **longest static directory prefix**
 *     that the file's path starts with. (Storybook picks the first specifier
 *     whose matcher matches; for title purposes the discriminator is the
 *     directory, and longest-prefix is the deterministic reading of it.)
 *  2. Take the path relative to that directory and split it on `/`.
 *  3. Strip the extension and a `.stories` / `.story` suffix from the last
 *     segment.
 *  4. Drop the last segment when it is exactly equal to the one before it
 *     (`components/Button/Button` → `components/Button`) or when it is `index`
 *     (case-insensitive).
 *  5. Join the rest with `/`.
 *
 * NOT implemented, because the addon's `storyGlobs` is a list of plain glob
 * strings and cannot express them: `titlePrefix`, and object-form specifiers
 * (`{ directory, files, titlePrefix }`). A consumer whose `main.ts` uses a
 * `titlePrefix` will get titles without it — which is why the Storybook-backed
 * tier is preferred and why this one announces itself.
 *
 * Returns null when no configured glob's directory contains the file: the title
 * is then genuinely unknown, and the caller must report it as such rather than
 * inventing one.
 */
export function deriveAutoTitle(relativeFile: string, globs: readonly string[]): string | null {
  const posix = relativeFile.split(sep).join("/").replace(/^\.\//, "");
  let best: string | null = null;
  for (const glob of globs) {
    const dir = globDirectory(glob);
    const prefix = dir === "" ? "" : `${dir}/`;
    if (prefix !== "" && !posix.startsWith(prefix)) continue;
    if (best === null || dir.length > best.length) best = dir;
  }
  if (best === null) return null;

  const remainder = best === "" ? posix : posix.slice(best.length + 1);
  const segments = remainder.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  segments[segments.length - 1] = stripStoryExtension(segments[segments.length - 1]!);
  const last = segments[segments.length - 1]!;
  const previous = segments[segments.length - 2];
  if (segments.length > 1 && (last === previous || /^index$/i.test(last))) segments.pop();
  const title = segments.join("/");
  return title.length > 0 ? title : null;
}

/* ------------------------------------------------------------------------- *
 * loading Storybook's own machinery (optional)
 * ------------------------------------------------------------------------- */

type TitleResolver = (absoluteFile: string) => string | undefined;
type CsfLoader = (
  code: string,
  options: { fileName: string; makeTitle: (userTitle: string) => string },
) => { parse: () => { meta?: { title?: string }; indexInputs: Array<{ exportName: string }> } };

/**
 * Storybook's own `getStoryTitle`, bound to this consumer's root and globs.
 * Returns null when `storybook/internal/common` can't be imported — a consumer
 * running the CLI without Storybook installed, which is a slower path, not a
 * broken one.
 */
export async function loadTitleResolver(
  cwd: string,
  globs: readonly string[],
): Promise<TitleResolver | null> {
  try {
    const mod = (await import("storybook/internal/common")) as {
      getStoryTitle?: (args: {
        storyFilePath: string;
        configDir: string;
        stories: string[];
        workingDir?: string;
        userTitle?: string;
      }) => string | undefined;
    };
    const getStoryTitle = mod.getStoryTitle;
    if (typeof getStoryTitle !== "function") return null;
    return (absoluteFile: string) =>
      getStoryTitle({
        storyFilePath: absoluteFile,
        // `storyGlobs` are root-relative; Storybook resolves string specifiers
        // against `configDir`, so the consumer root IS the configDir here.
        configDir: cwd,
        stories: [...globs],
        workingDir: cwd,
      });
  } catch {
    return null;
  }
}

/** Storybook's CSF parser, or null when it can't be imported. */
export async function loadCsfLoader(): Promise<CsfLoader | null> {
  try {
    const mod = (await import("storybook/internal/csf-tools")) as { loadCsf?: unknown };
    return typeof mod.loadCsf === "function" ? (mod.loadCsf as CsfLoader) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- *
 * regex fallback
 * ------------------------------------------------------------------------- */

/** An explicit `title: "…"` in the meta, when there is one. */
export function explicitTitle(source: string): string | null {
  const match = source.match(/title\s*:\s*(['"`])([^'"`]+)\1/);
  return match ? (match[2] ?? null) : null;
}

/**
 * Named exports, by regex. Used only when the CSF parser is unavailable. Less
 * accurate than the parser on purpose-built edge cases (it cannot see
 * `excludeStories`, and it counts a type-only export as a story), which is why
 * the outcome reports which reader ran.
 */
export function regexStoryExports(source: string): string[] {
  const exports = new Set<string>();
  for (const re of [
    /export\s+const\s+([A-Za-z_$][\w$]*)/g,
    /export\s+function\s+([A-Za-z_$][\w$]*)/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      if (m[1] && m[1] !== "default") exports.add(m[1]);
    }
  }
  return [...exports];
}

/* ------------------------------------------------------------------------- *
 * discovery
 * ------------------------------------------------------------------------- */

const TITLE_UNKNOWN = "__design_sync_title_unknown__";

export interface DiscoverOptions {
  cwd: string;
  /** Absolute paths, already globbed by the caller. */
  files: readonly string[];
  /** The effective story globs (config `storyGlobs`, or the `--stories` override). */
  globs: readonly string[];
}

export async function discoverStories(opts: DiscoverOptions): Promise<DiscoveryOutcome> {
  const [csfLoader, titleResolver] = await Promise.all([
    loadCsfLoader(),
    loadTitleResolver(opts.cwd, opts.globs),
  ]);

  const degradations: string[] = [];
  if (!csfLoader) {
    degradations.push(
      "could not import `storybook/internal/csf-tools`, so exports were read by regex — " +
        "`excludeStories` is not honoured and non-story exports may be counted",
    );
  }
  if (!titleResolver) {
    degradations.push(
      "could not import `storybook/internal/common`, so autotitles were derived locally — " +
        "a `titlePrefix` in your Storybook `main.ts` is not applied",
    );
  }

  const stories: DiscoveredStory[] = [];
  const unreadable: UnreadableStoryFile[] = [];
  const skipped: SkippedStoryFile[] = [];
  const seen = new Set<string>();

  for (const absolute of [...opts.files].sort()) {
    const file = relative(opts.cwd, resolve(absolute));
    let source: string;
    try {
      source = await readFile(absolute, "utf8");
    } catch (err) {
      unreadable.push({ file, reason: `could not be read: ${(err as Error).message}` });
      continue;
    }

    if (/\.mdx$/i.test(file)) {
      skipped.push({
        file,
        reason:
          "MDX file — Storybook indexes it as a docs entry, not as stories, so it contributes no story ids",
      });
      continue;
    }

    const declared = explicitTitle(source);
    const derived = titleResolver
      ? (titleResolver(resolve(absolute)) ?? null)
      : deriveAutoTitle(file, opts.globs);

    let title: string | null = null;
    let titleSource: DiscoveredStory["titleSource"] = "explicit";
    let exportNames: string[] = [];

    if (csfLoader) {
      let sawUserTitle = false;
      try {
        const parsed = csfLoader(source, {
          fileName: file,
          makeTitle: (userTitle: string) => {
            if (userTitle) {
              sawUserTitle = true;
              return userTitle;
            }
            // No `title:` in the meta — this is the autotitle case, and if the
            // path yields nothing there is no honest answer to give.
            if (derived === null) throw new Error(TITLE_UNKNOWN);
            return derived;
          },
        }).parse();
        title = parsed.meta?.title ?? null;
        titleSource = sawUserTitle ? "explicit" : "autotitle";
        exportNames = parsed.indexInputs.map((i) => i.exportName);
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        unreadable.push({
          file,
          reason: message.includes(TITLE_UNKNOWN)
            ? `no \`title:\` in the meta and no autotitle could be derived — none of the configured storyGlobs ` +
              `has a directory prefix containing this file, so Storybook's path-derived title cannot be reproduced`
            : `CSF parse failed: ${message.split("\n")[0]}`,
        });
        continue;
      }
    } else {
      title = declared ?? derived;
      titleSource = declared ? "explicit" : "autotitle";
      if (title === null) {
        unreadable.push({
          file,
          reason:
            "no `title:` in the meta and no autotitle could be derived from the configured storyGlobs",
        });
        continue;
      }
      exportNames = regexStoryExports(source);
    }

    if (title === null || title === "") {
      unreadable.push({ file, reason: "the CSF meta produced an empty title" });
      continue;
    }
    if (exportNames.length === 0) {
      unreadable.push({
        file,
        reason: `title "${title}" resolved, but no story exports were found in the file`,
      });
      continue;
    }

    for (const exportName of exportNames) {
      const id = toStoryId(title, exportName);
      if (seen.has(id)) continue;
      seen.add(id);
      stories.push({ id, file, title, exportName, titleSource });
    }
  }

  const outcome: DiscoveryOutcome = {
    stories,
    unreadable,
    skipped,
    exports: csfLoader ? "storybook-csf" : "regex",
    titles: titleResolver ? "storybook" : "derived",
  };
  if (degradations.length > 0) outcome.degraded = degradations.join("; ");
  return outcome;
}
