import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "tinyglobby";

import { loadedVersion } from "./addon-version.js";

/**
 * `design-sync init` — one command in place of the six manual adoption steps.
 *
 * It does what the `design-sync-setup` skill does by hand, **minus the
 * judgement**. Three rules decide everything below, and they are in priority
 * order:
 *
 *  1. **Never clobber.** A file the user wrote is never overwritten. Init either
 *     merges into it in a way it can describe exactly, or prints the snippet and
 *     lists it as a step that remains. `--force` re-writes only the files init
 *     itself authors, and never a skill.
 *  2. **Detect, don't assume.** Storybook version, Tailwind, where CSS and
 *     components actually live, the project's own story globs, whether
 *     `FIGMA_PAT` is set. Anything it cannot establish it says it cannot.
 *  3. **Honest exit.** Init always ends with what it did, what it skipped, and
 *     what remains **in order**. A partial init reported as success is the
 *     failure mode this codebase spends most of its effort avoiding, so the
 *     remaining-steps block is printed even when it is long, and the last line is
 *     never "setup complete".
 *
 * Three things init deliberately refuses to do, because doing them badly is
 * worse than not doing them:
 *
 *  - **Invent a `fileKey`.** Only the user knows it. `--file-key`, or a prompt on
 *    a TTY, or a placeholder plus a loud step-one. Never a guess.
 *  - **Generate the inspector's token manifest.** It is the *other* addon's
 *    schema, and a manifest that disagrees with the CSS makes the inspector's
 *    on-token dots lie. It also has to come *after* aligning the theme with the
 *    design source, which is judgement (setup skill step 3).
 *  - **Align tokens, or decide `copy`.** Both need someone to look at the design
 *    file. Init names them as steps and leaves `copy` unset rather than writing a
 *    default that reads as a decision.
 */

/** Exit codes. Distinct so a refusal can never be read as a completed init. */
export const INIT_EXIT = {
  /** Init did everything it can. Remaining manual steps may still be listed. */
  Ok: 0,
  /** The project cannot host the suite as-is; nothing was written. */
  Refused: 1,
  /** Init started and a write failed. Partially applied — the report says how far. */
  WriteFailed: 2,
} as const;

/** Minimum Node the addon's CLI and Storybook 10 both require. */
export const MIN_NODE = { major: 20, minor: 6 } as const;

export const CONFIG_FILE = "design-sync.config.json";
export const AUDITOR_PACKAGE = "@metalab/storybook-design-sync";
export const INSPECTOR_PACKAGE = "storybook-design-inspector";
/** What a config gets when the user has not told us the file key. */
export const FILE_KEY_PLACEHOLDER = "REPLACE_WITH_YOUR_FIGMA_FILE_KEY";
/** The cache is a local derivative; the registry is committed. */
export const CACHE_IGNORE_LINE = ".design-sync/cache.json";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface InitOptions {
  cwd: string;
  /** From `--file-key`, or a prompt. Never derived from anything. */
  fileKey?: string;
  /** `--yes`: never prompt; a missing file key becomes the placeholder. */
  yes: boolean;
  /** `--no-skills`: do not copy the workflow skills into `.claude/skills/`. */
  skills: boolean;
  /** `--force`: rewrite files init authors. Never a skill, never main/preview. */
  force: boolean;
  /** `--dry-run`: print the plan, write nothing. */
  dryRun: boolean;
}

export function parseInitArgs(rest: string[], cwd = process.cwd()): InitOptions {
  const opts: InitOptions = { cwd, yes: false, skills: true, force: false, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    switch (arg) {
      case "--file-key": {
        const value = rest[++i];
        if (!value) throw new Error("--file-key requires a value");
        opts.fileKey = value.trim();
        break;
      }
      case "--yes":
      case "-y":
        opts.yes = true;
        break;
      case "--no-skills":
        opts.skills = false;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface StorybookFacts {
  /** Version string, from whichever source could answer. */
  version?: string;
  major?: number;
  /** `installed` is authoritative; `declared` is the package.json range. */
  source: "installed" | "declared" | "none";
}

export interface MainConfigFacts {
  /** Consumer-relative path. */
  path: string;
  source: string;
  /** Addon specifiers found as literal strings in the `addons` array. */
  addons: string[];
  /** Story globs from `stories`, rewritten relative to the project root. */
  storyGlobs: string[];
  /** Set when the addons array could not be read as a plain string list. */
  unreadable?: string;
}

export interface PreviewConfigFacts {
  path: string;
  source: string;
  wiresTokenManifest: boolean;
  declaresModeSwitch: boolean;
}

export interface TailwindFacts {
  present: boolean;
  /** `4` when a CSS-first `@theme` block was found, `3` when only a JS config. */
  generation: 4 | 3 | "unknown" | null;
  /** Consumer-relative CSS files holding `@theme` or the Tailwind import. */
  themeFiles: string[];
}

export interface SkillFacts {
  name: string;
  /** Absolute path inside this package. */
  packaged: string;
  /** Consumer-relative destination. */
  destination: string;
  exists: boolean;
  packagedRevised?: string;
  localRevised?: string;
}

export interface ProjectFacts {
  cwd: string;
  node: { version: string; ok: boolean };
  storybook: StorybookFacts;
  main?: MainConfigFacts;
  preview?: PreviewConfigFacts;
  tailwind: TailwindFacts;
  /** Derived entries plus the reason, so the report can defend each choice. */
  cssEntries: { globs: string[]; reason: string };
  tsxEntries: { globs: string[]; reason: string };
  codeTargets: string[];
  storyGlobs: { globs: string[]; reason: string };
  /** Present when a config already exists. `problems` is why it won't load. */
  config?: { path: string; fileKey?: string; apply?: string; problems: string[] };
  tokenManifest?: string;
  figmaPat: boolean;
  registryExists: boolean;
  packages: { auditor: boolean; inspector: boolean };
  gitignore?: { path: string; ignoresCache: boolean };
  skills: SkillFacts[];
}

const MAIN_CANDIDATES = ["main.ts", "main.js", "main.mjs", "main.cjs", "main.mts"];
const PREVIEW_CANDIDATES = ["preview.tsx", "preview.ts", "preview.jsx", "preview.js", "preview.mjs"];
const MANIFEST_CANDIDATES = [
  "tokens/manifest.json",
  "src/tokens/manifest.json",
  ".storybook/tokens.json",
  "tokens/tokens.json",
  "design-tokens/manifest.json",
];

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  return (await readIfPresent(path)) !== undefined;
}

function nodeOk(version: string): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major > MIN_NODE.major) return true;
  return major === MIN_NODE.major && minor >= MIN_NODE.minor;
}

/** Leading major from a semver range: `^10.1.2`, `~10`, `10.x`, `>=10 <11`. */
export function majorFromRange(range: string): number | undefined {
  const m = /(\d+)/.exec(range.replace(/^[^\d]*/, ""));
  return m ? Number(m[1]) : undefined;
}

async function detectStorybook(cwd: string, pkg: PackageJson): Promise<StorybookFacts> {
  const installed = await readIfPresent(join(cwd, "node_modules", "storybook", "package.json"));
  if (installed) {
    try {
      const version = String((JSON.parse(installed) as { version?: string }).version ?? "");
      const major = majorFromRange(version);
      if (major !== undefined) return { version, major, source: "installed" };
    } catch {
      // fall through to the declared range
    }
  }
  const declared = pkg.devDependencies?.["storybook"] ?? pkg.dependencies?.["storybook"];
  if (declared) {
    const major = majorFromRange(declared);
    return { version: declared, source: "declared", ...(major !== undefined ? { major } : {}) };
  }
  return { source: "none" };
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * Every literal string in a `key: [ … ]` array property.
 *
 * A real parse would need the TS AST; this is deliberately a *read*, never a
 * rewrite decision on its own — `addAddons` refuses to edit anything it cannot
 * account for character by character.
 */
export function readStringArrayProperty(
  source: string,
  key: string,
): { values: string[]; span: { start: number; end: number } } | undefined {
  const opener = new RegExp(`(?:^|[^\\w$])["']?${key}["']?\\s*:\\s*\\[`, "m");
  const found = opener.exec(source);
  if (!found) return undefined;
  const start = found.index + found[0].length - 1;
  const end = matchBracket(source, start);
  if (end === undefined) return undefined;
  const inner = source.slice(start + 1, end);
  const values: string[] = [];
  const literal = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = literal.exec(inner)) !== null) values.push(m[2]!);
  return { values, span: { start, end } };
}

/** Index of the `]` closing the `[` at `open`, skipping strings and comments. */
function matchBracket(source: string, open: number): number | undefined {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (c === "'" || c === '"' || c === "`") {
      i = skipString(source, i);
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) return undefined;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) return undefined;
      i = close + 1;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

function skipString(source: string, quoteAt: number): number {
  const quote = source[quoteAt];
  for (let i = quoteAt + 1; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === quote) return i;
  }
  return source.length;
}

/**
 * Story globs as the project itself declares them, rewritten from
 * `.storybook`-relative to root-relative (`../src/**` → `src/**`).
 *
 * Using the project's own globs rather than the addon's defaults is the whole
 * point: a monorepo or a `stories/` layout is then configured correctly without
 * anyone being asked. Entries that don't look like story files (`*.mdx`) are
 * dropped — the CLI discovers story ids, and an `.mdx` doc file yields none.
 */
export function storyGlobsFromMain(globs: string[]): string[] {
  const out: string[] = [];
  for (const raw of globs) {
    if (!raw.includes(".stories.")) continue;
    let g = raw.trim();
    while (g.startsWith("../")) g = g.slice(3);
    g = g.replace(/^\.\//, "");
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

async function detectMain(cwd: string): Promise<MainConfigFacts | undefined> {
  for (const name of MAIN_CANDIDATES) {
    const full = join(cwd, ".storybook", name);
    const source = await readIfPresent(full);
    if (source === undefined) continue;
    const addons = readStringArrayProperty(source, "addons");
    const stories = readStringArrayProperty(source, "stories");
    const facts: MainConfigFacts = {
      path: join(".storybook", name),
      source,
      addons: addons?.values ?? [],
      storyGlobs: storyGlobsFromMain(stories?.values ?? []),
    };
    if (!addons) {
      facts.unreadable = "no `addons: [ … ]` array literal could be found in the file";
    }
    return facts;
  }
  return undefined;
}

async function detectPreview(cwd: string): Promise<PreviewConfigFacts | undefined> {
  for (const name of PREVIEW_CANDIDATES) {
    const full = join(cwd, ".storybook", name);
    const source = await readIfPresent(full);
    if (source === undefined) continue;
    return {
      path: join(".storybook", name),
      source,
      wiresTokenManifest: /designInspector/.test(source),
      declaresModeSwitch: /modeSwitch/.test(source),
    };
  }
  return undefined;
}

/**
 * Tailwind, and — the part that matters — **which CSS file holds the theme**.
 *
 * The utility→token mapping comes from the project's own `@theme` block, so that
 * file must be in `cssEntries` or the scanner derives nothing at all from a
 * Tailwind codebase. Detecting it is therefore not a nicety.
 */
async function detectTailwind(cwd: string, pkg: PackageJson): Promise<TailwindFacts> {
  const declared =
    pkg.devDependencies?.["tailwindcss"] ??
    pkg.dependencies?.["tailwindcss"] ??
    pkg.devDependencies?.["@tailwindcss/vite"] ??
    pkg.dependencies?.["@tailwindcss/vite"];
  const cssFiles = await glob(["**/*.css"], {
    cwd,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/storybook-static/**", "**/coverage/**"],
  });
  const themeFiles: string[] = [];
  for (const rel of cssFiles) {
    const source = await readIfPresent(join(cwd, rel));
    if (source === undefined) continue;
    if (/@theme\b/.test(source) || /@import\s+["']tailwindcss["']/.test(source)) {
      themeFiles.push(rel);
    }
  }
  const hasThemeBlock = themeFiles.length > 0;
  const jsConfig =
    (await exists(join(cwd, "tailwind.config.js"))) ||
    (await exists(join(cwd, "tailwind.config.ts"))) ||
    (await exists(join(cwd, "tailwind.config.cjs")));
  if (!declared && !hasThemeBlock && !jsConfig) {
    return { present: false, generation: null, themeFiles: [] };
  }
  const generation: TailwindFacts["generation"] = hasThemeBlock
    ? 4
    : jsConfig
      ? 3
      : declared
        ? (majorFromRange(declared) === 3 ? 3 : "unknown")
        : "unknown";
  return { present: true, generation, themeFiles };
}

/** Directories where components plausibly live, most specific first. */
const COMPONENT_DIRS = [
  "src/components/ui",
  "src/components",
  "src/ui",
  "app/components",
  "components",
  "lib/components",
  "src",
];

/** Directories a non-Tailwind project plausibly keeps component CSS in. */
const CSS_DIRS = ["src", "styles", "app", "css"];

async function hasFiles(cwd: string, pattern: string, ignore: string[] = []): Promise<boolean> {
  const hits = await glob([pattern], {
    cwd,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/storybook-static/**", ...ignore],
  });
  return hits.length > 0;
}

async function detectTsxEntries(
  cwd: string,
): Promise<{ globs: string[]; reason: string }> {
  for (const dir of COMPONENT_DIRS) {
    const pattern = `${dir}/**/*.tsx`;
    if (
      await hasFiles(cwd, pattern, ["**/*.stories.tsx", "**/*.test.tsx"])
    ) {
      return {
        globs: [pattern],
        reason: `${dir}/ holds .tsx files that are not stories or tests`,
      };
    }
  }
  return {
    globs: ["src/**/*.tsx"],
    reason: "no component directory found — this is the addon's default, and may need changing",
  };
}

async function detectCssEntries(
  cwd: string,
  tailwind: TailwindFacts,
): Promise<{ globs: string[]; reason: string }> {
  // Tailwind: the theme file is not optional. Without it the scanner cannot tell
  // `bg-primary` from an unknown utility and derives nothing at all.
  if (tailwind.present && tailwind.themeFiles.length > 0) {
    return {
      globs: [...tailwind.themeFiles],
      reason: `holds the Tailwind \`@theme\` block — required, or no utility resolves to a token`,
    };
  }
  for (const dir of CSS_DIRS) {
    const pattern = `${dir}/**/*.css`;
    if (await hasFiles(cwd, pattern)) {
      return { globs: [pattern], reason: `${dir}/ holds .css files` };
    }
  }
  return {
    globs: ["src/**/*.css"],
    reason: "no CSS found — this is the addon's default, and may need changing",
  };
}

async function detectConfig(cwd: string): Promise<ProjectFacts["config"]> {
  const source = await readIfPresent(join(cwd, CONFIG_FILE));
  if (source === undefined) return undefined;
  const facts: NonNullable<ProjectFacts["config"]> = { path: CONFIG_FILE, problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    facts.problems.push(`does not parse as JSON: ${(err as Error).message}`);
    return facts;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    facts.problems.push("is not a JSON object");
    return facts;
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw["fileKey"] === "string" && raw["fileKey"].trim() !== "") {
    facts.fileKey = raw["fileKey"];
  } else {
    facts.problems.push("`fileKey` is missing — the drift check cannot read Figma without it");
  }
  if (facts.fileKey === FILE_KEY_PLACEHOLDER) {
    facts.problems.push("`fileKey` is still the placeholder init wrote");
  }
  if (typeof raw["apply"] === "string") facts.apply = raw["apply"];
  if (raw["cssEntries"] === undefined) {
    facts.problems.push("`cssEntries` is unset, so the scanner falls back to `src/**/*.css`");
  }
  if (raw["tsxEntries"] === undefined) {
    facts.problems.push("`tsxEntries` is unset, so the scanner falls back to `src/**/*.tsx`");
  }
  return facts;
}

/** Frontmatter `revised:` date — the stamp the setup skill's rule turns on. */
export function skillRevised(source: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!m) return undefined;
  const line = /^revised:\s*(.+)$/m.exec(m[1]!);
  return line ? line[1]!.trim() : undefined;
}

/** Skills shipped inside this package. Resolved relative to the built CLI. */
export function packagedSkillsDir(): string {
  return fileURLToPath(new URL("../skills/", import.meta.url));
}

async function detectSkills(cwd: string): Promise<SkillFacts[]> {
  const root = packagedSkillsDir();
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: SkillFacts[] = [];
  for (const name of names) {
    const packaged = join(root, name, "SKILL.md");
    const packagedSource = await readIfPresent(packaged);
    if (packagedSource === undefined) continue;
    const destination = join(".claude", "skills", name, "SKILL.md");
    const localSource = await readIfPresent(join(cwd, destination));
    const facts: SkillFacts = {
      name,
      packaged,
      destination,
      exists: localSource !== undefined,
    };
    const packagedRevised = skillRevised(packagedSource);
    if (packagedRevised) facts.packagedRevised = packagedRevised;
    if (localSource !== undefined) {
      const localRevised = skillRevised(localSource);
      if (localRevised) facts.localRevised = localRevised;
    }
    out.push(facts);
  }
  return out;
}

export async function detectProject(cwd: string, opts: { skills: boolean }): Promise<ProjectFacts> {
  const pkgSource = await readIfPresent(join(cwd, "package.json"));
  let pkg: PackageJson = {};
  if (pkgSource) {
    try {
      pkg = JSON.parse(pkgSource) as PackageJson;
    } catch {
      pkg = {};
    }
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const tailwind = await detectTailwind(cwd, pkg);
  const main = await detectMain(cwd);
  const gitignoreSource = await readIfPresent(join(cwd, ".gitignore"));
  let tokenManifest: string | undefined;
  for (const candidate of MANIFEST_CANDIDATES) {
    if (await exists(join(cwd, candidate))) {
      tokenManifest = candidate;
      break;
    }
  }
  const tsxEntries = await detectTsxEntries(cwd);
  const cssEntries = await detectCssEntries(cwd, tailwind);
  const mainGlobs = main?.storyGlobs ?? [];
  const facts: ProjectFacts = {
    cwd,
    node: { version: process.versions.node, ok: nodeOk(process.versions.node) },
    storybook: await detectStorybook(cwd, pkg),
    tailwind,
    cssEntries,
    tsxEntries,
    // Fix prompts name these files as where a change belongs, so both the
    // components and the stylesheets that bind tokens belong here.
    codeTargets: [...new Set([...tsxEntries.globs, ...cssEntries.globs])],
    storyGlobs:
      mainGlobs.length > 0
        ? { globs: mainGlobs, reason: `read from ${main!.path}'s \`stories\`` }
        : {
            globs: [],
            reason: "no `.stories.*` glob found in the Storybook config — the addon's defaults apply",
          },
    figmaPat: typeof process.env["FIGMA_PAT"] === "string" && process.env["FIGMA_PAT"] !== "",
    registryExists: await exists(join(cwd, ".design-sync", "registry.json")),
    packages: {
      auditor: AUDITOR_PACKAGE in deps,
      inspector: INSPECTOR_PACKAGE in deps,
    },
    skills: opts.skills ? await detectSkills(cwd) : [],
  };
  if (main) facts.main = main;
  const preview = await detectPreview(cwd);
  if (preview) facts.preview = preview;
  const config = await detectConfig(cwd);
  if (config) facts.config = config;
  if (tokenManifest) facts.tokenManifest = tokenManifest;
  if (gitignoreSource !== undefined) {
    facts.gitignore = {
      path: ".gitignore",
      ignoresCache: gitignoreSource.split(/\r?\n/).some((l) => l.trim() === CACHE_IGNORE_LINE),
    };
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Reasons init writes nothing at all. Each one is a fact about the project that
 * no amount of config can paper over, and each says what to do instead.
 */
export function refusals(facts: ProjectFacts): string[] {
  const out: string[] = [];
  if (!facts.node.ok) {
    out.push(
      `Node ${facts.node.version} is too old. The suite needs Node ` +
        `${MIN_NODE.major}.${MIN_NODE.minor} or newer (Storybook 10's own floor). ` +
        `Upgrade Node and re-run.`,
    );
  }
  if (facts.storybook.source === "none") {
    out.push(
      `No Storybook found in this project (neither \`node_modules/storybook\` nor a ` +
        `\`storybook\` dependency). The suite is a pair of Storybook 10 addons and has ` +
        `nothing to attach to. Run \`npx storybook@latest init\` first, then re-run this.`,
    );
  } else if (facts.storybook.major !== undefined && facts.storybook.major !== 10) {
    out.push(
      `Storybook ${facts.storybook.version} detected (${facts.storybook.source}). The suite ` +
        `requires Storybook **10** — it uses the Storybook 10 addon API and the manager/preview ` +
        `entry points, so it will not load on 8 or 9. Upgrade Storybook first ` +
        `(\`npx storybook@latest upgrade\`), then re-run this. Nothing was written.`,
    );
  } else if (facts.storybook.major === undefined) {
    out.push(
      `A \`storybook\` dependency is declared as "${facts.storybook.version}", and no major ` +
        `version could be read from it. Init will not guess whether that is Storybook 10. ` +
        `Install dependencies (so the version can be read from node_modules) and re-run.`,
    );
  }
  if (!facts.main) {
    out.push(
      `No \`.storybook/main.*\` found. Init configures an existing Storybook; it does not ` +
        `create one. Run \`npx storybook@latest init\` first, then re-run this.`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type InitAction =
  | { kind: "write"; path: string; contents: string; what: string }
  | { kind: "merge"; path: string; contents: string; what: string }
  | { kind: "copy-skill"; name: string; from: string; path: string };

export interface InitPlan {
  /** Files init will create or merge into. */
  actions: InitAction[];
  /** Already-done things, named so a second run visibly skips them. */
  skipped: string[];
  /** What remains for a human, IN ORDER. Each entry is self-contained. */
  remaining: string[];
  /** Detection results worth printing before anything is written. */
  detected: string[];
  /** Non-fatal warnings — a config that exists but will not load, etc. */
  warnings: string[];
}

/** The config init writes. `apply: "off"` is the supported v1 posture. */
export function configContents(facts: ProjectFacts, fileKey: string): string {
  const body: Record<string, unknown> = {
    fileKey,
    engine: "figma-rest",
    registryPath: ".design-sync/registry.json",
    // v1 is audit-only: detection plus a fix prompt per row. The write path is
    // experimental and opting into it is a decision the user makes, not init.
    apply: "off",
    cssEntries: facts.cssEntries.globs,
    tsxEntries: facts.tsxEntries.globs,
    codeTargets: facts.codeTargets,
  };
  // `copy` is deliberately absent: whether text comparison is meaningful depends
  // on whether the design file's components carry placeholder copy, which needs
  // someone to look. Writing the default explicitly would read as a decision.
  if (facts.storyGlobs.globs.length > 0) body["storyGlobs"] = facts.storyGlobs.globs;
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Add missing addon entries to a `main.*` `addons` array, or explain why not.
 *
 * The one edit init makes to a file the user wrote, and it is a *merge*, not a
 * rewrite: it refuses unless the array holds nothing but string literals and
 * separators, so what it produces can be described character for character. A
 * comment, a spread, a conditional, an `import` — anything it cannot account for
 * — and it declines and hands back the snippet instead.
 */
export function addAddons(
  source: string,
  wanted: string[],
): { source: string; added: string[] } | { refused: string } {
  const read = readStringArrayProperty(source, "addons");
  if (!read) return { refused: "no `addons: [ … ]` array literal could be found" };
  const inner = source.slice(read.span.start + 1, read.span.end);
  // Everything that is not a string literal must be a separator or whitespace.
  const withoutStrings = inner.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, "");
  if (/[^\s,]/.test(withoutStrings)) {
    return {
      refused:
        "the `addons` array holds something other than plain strings (a comment, a spread, " +
        "an object or a conditional), and init will not rewrite what it cannot reproduce exactly",
    };
  }
  const missing = wanted.filter((w) => !read.values.includes(w));
  if (missing.length === 0) return { source, added: [] };

  const lineStart = source.lastIndexOf("\n", read.span.start) + 1;
  const outerIndent = /^[ \t]*/.exec(source.slice(lineStart))![0];
  const innerIndentMatch = /\n([ \t]+)/.exec(inner);
  const innerIndent = innerIndentMatch ? innerIndentMatch[1]! : `${outerIndent}  `;
  const quote = /(['"])/.exec(inner)?.[1] ?? '"';
  const entries = [...read.values, ...missing].map((v) => `${innerIndent}${quote}${v}${quote}`);
  const rebuilt = `[\n${entries.join(",\n")}\n${outerIndent}]`;
  return {
    source: source.slice(0, read.span.start) + rebuilt + source.slice(read.span.end + 1),
    added: missing,
  };
}

const PREVIEW_SNIPPET = `  parameters: {
    designSync: {
      // How this project switches theme. Declare it — a report measured against
      // a mechanism you did not declare is its own kind of wrong. The addon
      // verifies it: if flipping the theme moves no computed colour, the story
      // reports that the mode comparison did NOT happen.
      modeSwitch: { kind: "class", on: "html" },
      // modes: ["day", "night"],   // only if your modes aren't light/dark
    },
    designInspector: {
      tokens: tokenManifest,        // import tokenManifest from "../tokens/manifest.json"
    },
  },`;

export function buildPlan(
  facts: ProjectFacts,
  opts: InitOptions,
  fileKey: string,
  /** This package's version, for the pin line. `undefined` when it could not be
   * read — the line then omits the tag rather than printing a wrong one. */
  version?: string,
): InitPlan {
  const actions: InitAction[] = [];
  const skipped: string[] = [];
  const remaining: string[] = [];
  const detected: string[] = [];
  const warnings: string[] = [];

  // ---- what we found -----------------------------------------------------
  detected.push(
    `Storybook ${facts.storybook.version} (${facts.storybook.source === "installed" ? "installed" : "declared in package.json"})`,
  );
  detected.push(
    facts.tailwind.present
      ? `Tailwind: yes (${facts.tailwind.generation === 4 ? "v4 CSS-first `@theme`" : facts.tailwind.generation === 3 ? "v3 JS config — NOT evaluated by the scanner" : "version undetermined"})`
      : "Tailwind: no",
  );
  detected.push(`cssEntries → ${facts.cssEntries.globs.join(", ")}  (${facts.cssEntries.reason})`);
  detected.push(`tsxEntries → ${facts.tsxEntries.globs.join(", ")}  (${facts.tsxEntries.reason})`);
  detected.push(
    facts.storyGlobs.globs.length > 0
      ? `storyGlobs → ${facts.storyGlobs.globs.join(", ")}  (${facts.storyGlobs.reason})`
      : `storyGlobs → unset  (${facts.storyGlobs.reason})`,
  );
  detected.push(`FIGMA_PAT in this shell: ${facts.figmaPat ? "yes" : "NO"}`);

  if (facts.tailwind.generation === 3) {
    warnings.push(
      "Tailwind v3's scale lives in `tailwind.config.js` and is NOT evaluated, so this project " +
        "gets no Tailwind bindings at all. `tsxEntries` still yields inline-style bindings. " +
        "Moving the theme to a v4 `@theme` block is what turns the utility bindings on.",
    );
  }
  if (facts.tailwind.present && facts.tailwind.themeFiles.length === 0) {
    warnings.push(
      "Tailwind is a dependency but no CSS file holding `@theme` or `@import \"tailwindcss\"` was " +
        "found. `cssEntries` MUST include the file with the theme block, or no utility resolves " +
        "to a token and the binding dimension is empty. Set it by hand.",
    );
  }

  // ---- 1. packages -------------------------------------------------------
  if (facts.packages.auditor) {
    skipped.push(`${AUDITOR_PACKAGE} is already a dependency`);
  } else {
    // Init runs *from* this package, so it is installed one way or another —
    // but if it is not in package.json (an `npx` run against the registry, say)
    // nothing pins it for the next person.
    remaining.push(
      `Add the auditor to package.json — you ran init from it, but nothing pins it:\n` +
        `      npm install --save-dev "github:mylesmetalab/storybook-design-sync${
          version ? `#v${version}` : ""
        }"` +
        (version
          ? ""
          : `\n      (this package's version could not be read, so no tag is pinned above — ` +
            `pin one explicitly; an untagged git dep floats.)`),
    );
  }
  if (facts.packages.inspector) {
    skipped.push(`${INSPECTOR_PACKAGE} is already a dependency`);
  } else {
    remaining.push(
      `Install the Design Inspector (the designer-facing read surface; the auditor works ` +
        `without it):\n      npm install --save-dev "github:mylesmetalab/storybook-design-inspector#v0.2.5"`,
    );
  }

  // ---- 2. addons in main.* ----------------------------------------------
  const wantedAddons = [AUDITOR_PACKAGE, INSPECTOR_PACKAGE];
  const main = facts.main!;
  if (main.unreadable) {
    remaining.push(
      `Register the addons in ${main.path} by hand — ${main.unreadable}:\n` +
        `      addons: [${wantedAddons.map((a) => `"${a}"`).join(", ")}]`,
    );
  } else {
    const merged = addAddons(main.source, wantedAddons);
    if ("refused" in merged) {
      remaining.push(
        `Register the addons in ${main.path} by hand — ${merged.refused}:\n` +
          `      ${wantedAddons.map((a) => `"${a}",`).join("\n      ")}`,
      );
    } else if (merged.added.length === 0) {
      skipped.push(`${main.path} already registers both addons`);
    } else {
      actions.push({
        kind: "merge",
        path: main.path,
        contents: merged.source,
        what: `add ${merged.added.join(" + ")} to \`addons\``,
      });
    }
  }

  // ---- 3. design-sync.config.json ---------------------------------------
  const contents = configContents(facts, fileKey);
  if (!facts.config) {
    actions.push({ kind: "write", path: CONFIG_FILE, contents, what: "create" });
  } else if (opts.force) {
    actions.push({
      kind: "write",
      path: CONFIG_FILE,
      contents,
      what: "OVERWRITE (--force)",
    });
  } else {
    skipped.push(
      `${CONFIG_FILE} already exists — left untouched` +
        (facts.config.problems.length > 0 ? "" : " (it looks complete)"),
    );
    for (const problem of facts.config.problems) {
      warnings.push(`${CONFIG_FILE} ${problem}`);
    }
    if (facts.config.apply !== undefined && facts.config.apply !== "off") {
      warnings.push(
        `${CONFIG_FILE} sets \`"apply": "${facts.config.apply}"\`. v1 ships detection only; ` +
          `\`"off"\` is the supported posture. Init left it alone.`,
      );
    }
    if (facts.config.problems.length > 0) {
      remaining.push(
        `Fix ${CONFIG_FILE} — init did not touch your existing config. Problems listed above. ` +
          `\`--force\` rewrites it from detection if you would rather start over.`,
      );
    }
  }

  // ---- 4. .gitignore -----------------------------------------------------
  if (!facts.gitignore) {
    remaining.push(
      `Gitignore the drift cache (this project has no .gitignore):\n      ${CACHE_IGNORE_LINE}\n` +
        `      .design-sync/registry.json is committed on purpose — it holds the story ↔ Figma bindings.`,
    );
  } else if (facts.gitignore.ignoresCache) {
    skipped.push(".gitignore already ignores .design-sync/cache.json");
  } else {
    actions.push({
      kind: "merge",
      path: facts.gitignore.path,
      contents: "",
      what: `append ${CACHE_IGNORE_LINE} (the cache is a local derivative; the registry is committed)`,
    });
  }

  // ---- 5. skills ---------------------------------------------------------
  if (!opts.skills) {
    skipped.push("workflow skills (--no-skills)");
  } else if (facts.skills.length === 0) {
    warnings.push(
      "No packaged skills were found next to the CLI, so none were copied. Nothing else is affected.",
    );
  } else {
    for (const skill of facts.skills) {
      if (!skill.exists) {
        actions.push({
          kind: "copy-skill",
          name: skill.name,
          from: skill.packaged,
          path: skill.destination,
        });
        continue;
      }
      // Never overwritten, not even with --force. A project's copy is meant to
      // diverge — a client's codegen standards are not universal — and
      // "deliberately diverged" is indistinguishable from "silently stale" from
      // inside the repo. So report the `revised:` stamps and let the human
      // decide per skill.
      const local = skill.localRevised ?? "no `revised:` stamp";
      const packagedStamp = skill.packagedRevised ?? "no `revised:` stamp";
      if (skill.localRevised && skill.packagedRevised && skill.localRevised < skill.packagedRevised) {
        skipped.push(
          `${skill.destination} kept (yours: ${local}, packaged: ${packagedStamp} — ` +
            `yours is OLDER; diff against ${skill.packaged} if you want the update)`,
        );
      } else {
        skipped.push(`${skill.destination} kept (yours: ${local}, packaged: ${packagedStamp})`);
      }
    }
  }

  // ---- 6. what a human still has to do, in order ------------------------
  if (fileKey === FILE_KEY_PLACEHOLDER && !facts.config?.fileKey) {
    remaining.unshift(
      `Put your Figma file key in ${CONFIG_FILE}. It is the one thing only you know — take it ` +
        `from the file URL: figma.com/design/<FILE_KEY>/…  Until you do, every drift check fails ` +
        `to read Figma. (\`--file-key <key>\` next time, or answer the prompt.)`,
    );
  }
  if (!facts.figmaPat) {
    remaining.push(
      `Set FIGMA_PAT in the environment that runs Storybook (not the CLI's): Figma → Settings → ` +
        `Security → Personal access tokens, scopes "file content: read" and "variables: read". ` +
        `The drift check cannot read the design file without it; \`design-sync audit\` does not need it.`,
    );
  }
  remaining.push(
    `Align this project's token VALUES with the design source before trusting the first report. ` +
      `If the theme holds a UI kit's defaults (shadcn / MUI / Tailwind) while Figma holds the ` +
      `client's, every component reports real-but-uninformative colour and font drift on day one. ` +
      `Enumerate the design file's collection modes first — do not write a dark-mode value you ` +
      `have not read. Map design variables 1:1; never merge two onto one token because their ` +
      `values match today.`,
  );
  remaining.push(
    `Decide \`"copy"\` in ${CONFIG_FILE} by looking at the design file. Lorem throughout → ` +
      `\`"copy": "off"\` (otherwise every story drifts on text forever); real strings → leave it ` +
      `on (the default). Init left it unset rather than write a default that reads as a decision.`,
  );
  if (facts.tokenManifest && facts.preview?.wiresTokenManifest) {
    skipped.push(
      `token manifest ${facts.tokenManifest} exists and ${facts.preview.path} wires \`designInspector\``,
    );
  } else if (facts.tokenManifest) {
    remaining.push(
      `Wire the token manifest ${facts.tokenManifest} into ${facts.preview?.path ?? ".storybook/preview.ts"} ` +
        `under \`parameters.designInspector.tokens\` — it exists but nothing reads it.`,
    );
  } else {
    remaining.push(
      `Generate the Design Inspector's token manifest (\`tokens/manifest.json\`) from this ` +
        `project's CSS custom properties, and wire it into ` +
        `${facts.preview?.path ?? ".storybook/preview.ts"} under \`parameters.designInspector.tokens\`. ` +
        `Init does NOT generate it: it is the inspector's schema, it must agree with the CSS or the ` +
        `on-token dots lie, and it has to come after the token alignment above. The schema and a ` +
        `full example are in the storybook-design-inspector README.`,
    );
  }
  if (facts.preview?.declaresModeSwitch) {
    skipped.push(`${facts.preview.path} already declares \`modeSwitch\``);
  } else {
    remaining.push(
      `Declare how this project switches theme, in ${facts.preview?.path ?? ".storybook/preview.ts"}:\n` +
        PREVIEW_SNIPPET.split("\n")
          .map((l) => `      ${l}`)
          .join("\n"),
    );
  }
  remaining.push(
    facts.registryExists
      ? `Re-run \`npx design-sync register --hints\` and \`npx design-sync audit\` — a registry ` +
        `exists; audit tells you which stories are missing from it.`
      : `Bind stories to Figma nodes:\n      npx design-sync register --hints\n      npx design-sync audit\n` +
        `      Stories with no Figma counterpart yet are registered as pending stubs so audit ` +
        `exits 0 honestly.`,
  );
  remaining.push(
    `Add \`npx design-sync audit\` to this project's PR checks. Be clear with your team about ` +
      `what it gates: the REGISTRY, not drift. Drift comparison needs rendered DOM, so it runs in ` +
      `the panel or via \`design-sync check\` against a running \`storybook dev\` — CI cannot gate ` +
      `on drift with \`audit\` alone.`,
  );
  remaining.push(
    `Verify end to end. Start Storybook and read the addon's startup line: ` +
      `\`derived bindings for 0 selector(s)\` means the scan found nothing and every report will be ` +
      `empty on the binding dimension — fix cssEntries/tsxEntries before going further. Then open a ` +
      `registered story, run Check drift, tick "Both modes" and confirm the report says the mode ` +
      `comparison happened.`,
  );

  return { actions, skipped, remaining, detected, warnings };
}


// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ApplyResult {
  done: string[];
  failed: Array<{ path: string; message: string }>;
}

export async function applyPlan(
  cwd: string,
  plan: InitPlan,
  opts: { dryRun: boolean },
): Promise<ApplyResult> {
  const done: string[] = [];
  const failed: Array<{ path: string; message: string }> = [];
  for (const action of plan.actions) {
    const label =
      action.kind === "copy-skill"
        ? `${action.path} (skill: ${action.name})`
        : `${action.path} — ${action.what}`;
    if (opts.dryRun) {
      done.push(label);
      continue;
    }
    try {
      const full = join(cwd, action.path);
      await mkdir(dirname(full), { recursive: true });
      if (action.kind === "copy-skill") {
        await writeFile(full, await readFile(action.from, "utf8"), "utf8");
      } else if (action.kind === "merge" && action.contents === "") {
        // The .gitignore append — the only action whose content depends on the
        // file as it is at write time.
        const existing = await readFile(full, "utf8");
        const sep = existing.endsWith("\n") || existing === "" ? "" : "\n";
        await writeFile(
          full,
          `${existing}${sep}\n# Design Sync — the drift-report cache is a local derivative.\n` +
            `# .design-sync/registry.json (story ↔ Figma bindings) IS committed.\n` +
            `${CACHE_IGNORE_LINE}\n`,
          "utf8",
        );
      } else {
        await writeFile(full, action.contents, "utf8");
      }
      done.push(label);
    } catch (err) {
      failed.push({ path: action.path, message: (err as Error).message });
    }
  }
  return { done, failed };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface InitReport {
  lines: string[];
  exitCode: number;
}

export function renderRefusal(reasons: string[]): InitReport {
  const lines = [
    "design-sync init — REFUSED. Nothing was written.",
    "",
    ...reasons.map((r, i) => `  ${i + 1}. ${r}`),
    "",
  ];
  return { lines, exitCode: INIT_EXIT.Refused };
}

export function renderReport(
  plan: InitPlan,
  applied: ApplyResult,
  opts: { dryRun: boolean },
): InitReport {
  const lines: string[] = [];
  lines.push(opts.dryRun ? "design-sync init — DRY RUN, nothing written" : "design-sync init");
  lines.push("");
  lines.push("Detected:");
  for (const d of plan.detected) lines.push(`  · ${d}`);
  if (plan.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of plan.warnings) lines.push(`  ! ${w}`);
  }
  lines.push("");
  lines.push(opts.dryRun ? `Would change (${applied.done.length}):` : `Changed (${applied.done.length}):`);
  if (applied.done.length === 0) lines.push("  (nothing — everything init writes is already there)");
  for (const d of applied.done) lines.push(`  + ${d}`);
  if (plan.skipped.length > 0) {
    lines.push("");
    lines.push(`Skipped, already done (${plan.skipped.length}):`);
    for (const s of plan.skipped) lines.push(`  = ${s}`);
  }
  if (applied.failed.length > 0) {
    lines.push("");
    lines.push(`FAILED to write (${applied.failed.length}):`);
    for (const f of applied.failed) lines.push(`  x ${f.path}: ${f.message}`);
  }
  lines.push("");
  if (plan.remaining.length === 0) {
    lines.push("Nothing remains. Start Storybook and run Check drift.");
  } else {
    // Deliberately loud, and deliberately last. Init is not finished setup: it is
    // the mechanical part of setup, and saying otherwise is the failure this
    // whole report exists to prevent.
    lines.push(
      `NOT DONE — ${plan.remaining.length} step(s) remain, in this order. Init cannot do these ` +
        `(they need your Figma file, your judgement, or your CI):`,
    );
    plan.remaining.forEach((r, i) => lines.push(`  ${i + 1}. ${r}`));
  }
  lines.push("");
  return {
    lines,
    exitCode: applied.failed.length > 0 ? INIT_EXIT.WriteFailed : INIT_EXIT.Ok,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface InitDeps {
  /** Asks for the Figma file key. Only called on a TTY, never in tests. */
  promptFileKey?: () => Promise<string | undefined>;
  log?: (line: string) => void;
}

export async function runInit(opts: InitOptions, deps: InitDeps = {}): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const facts = await detectProject(opts.cwd, { skills: opts.skills });
  const blockers = refusals(facts);
  if (blockers.length > 0) {
    const report = renderRefusal(blockers);
    for (const line of report.lines) log(line);
    return report.exitCode;
  }

  // The file key, in strict order of trust: the flag, then an existing config's
  // value (so a re-run does not undo it), then a prompt, then the placeholder.
  // Never anything derived.
  let fileKey = opts.fileKey?.trim() || facts.config?.fileKey;
  if (!fileKey && !opts.yes && deps.promptFileKey) {
    fileKey = (await deps.promptFileKey())?.trim() || undefined;
  }
  if (!fileKey) fileKey = FILE_KEY_PLACEHOLDER;

  const plan = buildPlan(facts, opts, fileKey, await loadedVersion());
  const applied = await applyPlan(opts.cwd, plan, { dryRun: opts.dryRun });
  const report = renderReport(plan, applied, { dryRun: opts.dryRun });
  for (const line of report.lines) log(line);
  return report.exitCode;
}

/** Unused re-export kept so `relative`/`resolve`/`sep` stay available to tests. */
export const __pathHelpers = { relative, resolve, sep };
