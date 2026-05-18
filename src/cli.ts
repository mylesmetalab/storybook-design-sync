import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { glob } from "tinyglobby";
import { loadConfig } from "./config.js";
import { loadRegistry } from "./registry.js";

interface AuditOptions {
  cwd: string;
  storyGlobs: string[];
}

const DEFAULT_STORY_GLOBS = [
  "src/**/*.stories.@(ts|tsx|js|jsx|mjs|mts)",
  "stories/**/*.stories.@(ts|tsx|js|jsx|mjs|mts)",
];

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    return cmd ? 0 : 1;
  }
  switch (cmd) {
    case "audit":
      return audit(parseAuditArgs(rest));
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      return 1;
  }
}

function printHelp(): void {
  console.log(
    [
      "design-sync — Storybook ↔ Figma drift CLI",
      "",
      "Usage:",
      "  design-sync audit [--stories <glob>]   Diff stories on disk against the registry",
      "",
      "Audit exits non-zero when stories are missing from, or extra in,",
      "the registry — wire it into CI to keep drift visible.",
    ].join("\n"),
  );
}

function parseAuditArgs(rest: string[]): AuditOptions {
  const cwd = process.cwd();
  const storyGlobs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--stories") {
      const value = rest[++i];
      if (!value) throw new Error("--stories requires a glob argument");
      storyGlobs.push(value);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    cwd,
    storyGlobs: storyGlobs.length > 0 ? storyGlobs : [...DEFAULT_STORY_GLOBS],
  };
}

async function audit(opts: AuditOptions): Promise<number> {
  const config = await loadConfig(opts.cwd);
  const registry = await loadRegistry(config.registryPath, opts.cwd);
  const files = await glob(opts.storyGlobs, { cwd: opts.cwd, absolute: true });

  const discovered = new Map<string, string>(); // storyId → relative file path
  const parseWarnings: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const ids = extractStoryIds(source);
    if (ids === null) {
      parseWarnings.push(relative(opts.cwd, file));
      continue;
    }
    for (const id of ids) {
      if (!discovered.has(id)) discovered.set(id, relative(opts.cwd, file));
    }
  }

  const codeIds = new Set(discovered.keys());
  const registryIds = new Set(Object.keys(registry.stories));
  const missing = [...codeIds].filter((id) => !registryIds.has(id)).sort();
  const extra = [...registryIds].filter((id) => !codeIds.has(id)).sort();

  console.log(`Stories on disk:     ${codeIds.size}`);
  console.log(`Stories registered:  ${registryIds.size}`);
  console.log(`Missing:             ${missing.length}`);
  console.log(`Extra:               ${extra.length}`);

  if (missing.length > 0) {
    console.log("\nMissing from registry (in code, not registered):");
    for (const id of missing) console.log(`  - ${id}  (${discovered.get(id)})`);
  }
  if (extra.length > 0) {
    console.log("\nExtra in registry (registered, no matching story):");
    for (const id of extra) console.log(`  - ${id}`);
  }
  if (parseWarnings.length > 0) {
    console.log(
      `\nWarning: could not parse ${parseWarnings.length} story file(s) — title or exports not detected:`,
    );
    for (const f of parseWarnings) console.log(`  - ${f}`);
    console.log(
      "Audit uses regex-based discovery; computed titles or unusual CSF shapes may be missed.",
    );
  }

  return missing.length > 0 || extra.length > 0 ? 1 : 0;
}

/**
 * Regex-based CSF discovery. Returns null when the file has no detectable
 * `title:` — caller surfaces those as a parse warning so users can fix
 * unusual shapes rather than silently passing audit.
 *
 * Story id formula matches Storybook's `@storybook/csf` toId:
 *   sanitize(title) + "--" + sanitize(storyNameFromExport(exportName))
 */
export function extractStoryIds(source: string): string[] | null {
  const titleMatch = source.match(/title\s*:\s*(['"`])([^'"`]+)\1/);
  if (!titleMatch) return null;
  const title = titleMatch[2]!;

  const exports = new Set<string>();
  const namedConst = /export\s+const\s+([A-Za-z_$][\w$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = namedConst.exec(source)) !== null) {
    if (m[1] !== "default") exports.add(m[1]!);
  }
  const namedFn = /export\s+function\s+([A-Za-z_$][\w$]*)/g;
  while ((m = namedFn.exec(source)) !== null) {
    if (m[1] !== "default") exports.add(m[1]!);
  }

  return [...exports].map((name) => toStoryId(title, name));
}

export function toStoryId(title: string, exportName: string): string {
  return `${sanitize(title)}--${sanitize(storyNameFromExport(exportName))}`;
}

/** Mirrors @storybook/csf storyNameFromExport: insert spaces at case boundaries. */
function storyNameFromExport(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
    .trim();
}

/** Mirrors @storybook/csf sanitize. */
function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ '’–—/]/g, "-")
    .replace(/[^a-z0-9_.\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
