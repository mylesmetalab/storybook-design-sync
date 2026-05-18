import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { glob } from "tinyglobby";
import { loadConfig } from "./config.js";
import {
  loadRegistry,
  saveRegistry,
  isPending,
  type Registry,
  type RegistryEntry,
} from "./registry.js";

interface CommonOptions {
  cwd: string;
  /** Override globs from --stories. When undefined, the loaded config's
   *  `storyGlobs` is used. */
  storyGlobsOverride: string[] | undefined;
}

interface RegisterOptions extends CommonOptions {
  hintsPath: string;
  dryRun: boolean;
}

interface ExportGraphOptions extends CommonOptions {
  format: "json" | "dot";
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    printHelp();
    return cmd ? 0 : 1;
  }
  switch (cmd) {
    case "audit":
      return audit(parseCommon(rest));
    case "ls":
      return ls(parseCommon(rest));
    case "register":
      return register(parseRegisterArgs(rest));
    case "export-graph":
      return exportGraph(parseExportGraphArgs(rest));
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
      "  design-sync audit                       Diff stories on disk against the registry (exits non-zero on drift)",
      "  design-sync register [--hints <path>]   Bulk-register stories from .design-sync/hints.json; stubs the rest",
      "  design-sync ls                          Print the title → node binding tree",
      "  design-sync export-graph --format json|dot",
      "                                          Emit the binding graph for docs / visualizations",
      "",
      "Common flags: --stories <glob> (repeatable). Subcommand-specific flags listed under --help on each command.",
    ].join("\n"),
  );
}

function parseCommon(rest: string[]): CommonOptions {
  return parseCommonAllowing(rest, []);
}

function parseRegisterArgs(rest: string[]): RegisterOptions {
  const common = parseCommonAllowing(rest, ["--hints", "--dry-run"]);
  return {
    cwd: common.cwd,
    storyGlobsOverride: common.storyGlobsOverride,
    hintsPath: common.extras.get("--hints") ?? ".design-sync/hints.json",
    dryRun: common.flags.has("--dry-run"),
  };
}

function parseExportGraphArgs(rest: string[]): ExportGraphOptions {
  const common = parseCommonAllowing(rest, ["--format"]);
  const format = common.extras.get("--format");
  if (format !== "json" && format !== "dot") {
    throw new Error("--format must be 'json' or 'dot'");
  }
  return { cwd: common.cwd, storyGlobsOverride: common.storyGlobsOverride, format };
}

const BOOLEAN_FLAGS = new Set(["--dry-run"]);

function parseCommonAllowing(
  rest: string[],
  allowedExtras: string[],
): {
  cwd: string;
  storyGlobsOverride: string[] | undefined;
  extras: Map<string, string>;
  flags: Set<string>;
} {
  const cwd = process.cwd();
  const storyGlobs: string[] = [];
  const extras = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--stories") {
      const value = rest[++i];
      if (!value) throw new Error("--stories requires a glob argument");
      storyGlobs.push(value);
    } else if (allowedExtras.includes(arg)) {
      if (BOOLEAN_FLAGS.has(arg)) {
        flags.add(arg);
      } else {
        const value = rest[++i];
        if (!value) throw new Error(`${arg} requires a value`);
        extras.set(arg, value);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    cwd,
    storyGlobsOverride: storyGlobs.length > 0 ? storyGlobs : undefined,
    extras,
    flags,
  };
}

// ---- discovery ------------------------------------------------------------

interface DiscoveredStory {
  id: string;
  file: string; // relative
  title: string;
  exportName: string;
}

interface DiscoveryResult {
  stories: DiscoveredStory[];
  warnings: string[];
}

async function discover(
  opts: CommonOptions,
  configGlobs: string[],
): Promise<DiscoveryResult> {
  const effective = opts.storyGlobsOverride ?? configGlobs;
  const files = await glob(effective, { cwd: opts.cwd, absolute: true });
  const stories: DiscoveredStory[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const parsed = parseStoryFile(source);
    if (!parsed) {
      warnings.push(relative(opts.cwd, file));
      continue;
    }
    for (const exportName of parsed.exports) {
      const id = toStoryId(parsed.title, exportName);
      if (seen.has(id)) continue;
      seen.add(id);
      stories.push({ id, file: relative(opts.cwd, file), title: parsed.title, exportName });
    }
  }
  return { stories, warnings };
}

/**
 * Regex-based CSF parse. Returns null when no `title:` literal is detected —
 * caller surfaces those as parse warnings rather than silently passing.
 */
export function parseStoryFile(source: string): { title: string; exports: string[] } | null {
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
  return { title, exports: [...exports] };
}

/** Back-compat: previous CLI exposed this. Keep so any direct importer holds. */
export function extractStoryIds(source: string): string[] | null {
  const parsed = parseStoryFile(source);
  if (!parsed) return null;
  return parsed.exports.map((name) => toStoryId(parsed.title, name));
}

export function toStoryId(title: string, exportName: string): string {
  return `${sanitize(title)}--${sanitize(storyNameFromExport(exportName))}`;
}

function storyNameFromExport(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
    .trim();
}

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ '’–—/]/g, "-")
    .replace(/[^a-z0-9_.\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---- audit ----------------------------------------------------------------

async function audit(opts: CommonOptions): Promise<number> {
  const config = await loadConfig(opts.cwd);
  const registry = await loadRegistry(config.registryPath, opts.cwd);
  const { stories, warnings } = await discover(opts, config.storyGlobs);

  const codeIds = new Set(stories.map((s) => s.id));
  const registryIds = new Set(Object.keys(registry.stories));
  const pending = Object.entries(registry.stories)
    .filter(([, e]) => isPending(e))
    .map(([id]) => id);

  const missing = [...codeIds].filter((id) => !registryIds.has(id)).sort();
  const extra = [...registryIds].filter((id) => !codeIds.has(id)).sort();

  console.log(`Stories on disk:     ${codeIds.size}`);
  console.log(`Stories registered:  ${registryIds.size} (${pending.length} pending)`);
  console.log(`Missing:             ${missing.length}`);
  console.log(`Extra:               ${extra.length}`);

  if (missing.length > 0) {
    console.log("\nMissing from registry (in code, not registered):");
    const fileById = new Map(stories.map((s) => [s.id, s.file]));
    for (const id of missing) console.log(`  - ${id}  (${fileById.get(id)})`);
  }
  if (extra.length > 0) {
    console.log("\nExtra in registry (registered, no matching story):");
    for (const id of extra) console.log(`  - ${id}`);
  }
  if (pending.length > 0) {
    console.log("\nPending (registered but no Figma binding assigned):");
    for (const id of pending.sort()) console.log(`  - ${id}`);
  }
  if (warnings.length > 0) {
    console.log(
      `\nWarning: could not parse ${warnings.length} story file(s) — title or exports not detected:`,
    );
    for (const f of warnings) console.log(`  - ${f}`);
    console.log(
      "Audit uses regex-based discovery; computed titles or unusual CSF shapes may be missed.",
    );
  }

  return missing.length > 0 || extra.length > 0 ? 1 : 0;
}

// ---- ls -------------------------------------------------------------------

async function ls(opts: CommonOptions): Promise<number> {
  const config = await loadConfig(opts.cwd);
  const registry = await loadRegistry(config.registryPath, opts.cwd);
  const { stories } = await discover(opts, config.storyGlobs);
  if (stories.length === 0) {
    console.log("No stories discovered.");
    return 0;
  }

  // Group by title for the tree view.
  const byTitle = new Map<string, DiscoveredStory[]>();
  for (const s of stories) {
    const list = byTitle.get(s.title) ?? [];
    list.push(s);
    byTitle.set(s.title, list);
  }

  const titles = [...byTitle.keys()].sort();
  for (const title of titles) {
    console.log(title);
    const group = byTitle.get(title)!;
    group.sort((a, b) => a.exportName.localeCompare(b.exportName));
    for (let i = 0; i < group.length; i++) {
      const s = group[i]!;
      const isLast = i === group.length - 1;
      const prefix = isLast ? "  └ " : "  ├ ";
      const entry = registry.stories[s.id];
      const right = entry
        ? isPending(entry)
          ? "pending"
          : entry.nodeId
        : "(unregistered)";
      console.log(`${prefix}${s.exportName.padEnd(30)} → ${right}  [${s.id}]`);
    }
  }
  return 0;
}

// ---- register -------------------------------------------------------------

async function register(opts: RegisterOptions): Promise<number> {
  const config = await loadConfig(opts.cwd);
  const registry = await loadRegistry(config.registryPath, opts.cwd);
  const { stories, warnings } = await discover(opts, config.storyGlobs);
  const hints = await loadHints(opts.cwd, opts.hintsPath);

  let added = 0;
  let stubbed = 0;
  const updated: Registry = {
    fileKey: registry.fileKey || config.fileKey,
    stories: { ...registry.stories },
  };

  for (const s of stories) {
    if (updated.stories[s.id]) continue;
    const hint = hints[s.id];
    if (typeof hint === "string" && hint.trim().length > 0) {
      const entry: RegistryEntry = { nodeId: hint, lastSyncedHash: null };
      updated.stories[s.id] = entry;
      added++;
      console.log(`+ ${s.id} → ${hint}`);
    } else {
      const entry: RegistryEntry = {
        nodeId: null,
        lastSyncedHash: null,
        status: "pending",
      };
      updated.stories[s.id] = entry;
      stubbed++;
      console.log(`· ${s.id} → pending`);
    }
  }

  console.log(
    `\n${added} registered from hints, ${stubbed} stubbed as pending` +
      (opts.dryRun ? " (dry-run; nothing written)" : ""),
  );
  if (warnings.length > 0) {
    console.log(`Skipped ${warnings.length} unparsable story file(s).`);
  }

  if (!opts.dryRun && (added > 0 || stubbed > 0)) {
    await saveRegistry(config.registryPath, updated, opts.cwd);
    console.log(`Wrote ${config.registryPath}.`);
  }
  return 0;
}

async function loadHints(cwd: string, path: string): Promise<Record<string, string>> {
  try {
    const raw = await readFile(`${cwd}/${path}`, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

// ---- export-graph ---------------------------------------------------------

async function exportGraph(opts: ExportGraphOptions): Promise<number> {
  const config = await loadConfig(opts.cwd);
  const registry = await loadRegistry(config.registryPath, opts.cwd);
  const { stories } = await discover(opts, config.storyGlobs);

  const nodes = stories.map((s) => {
    const entry = registry.stories[s.id];
    return {
      storyId: s.id,
      title: s.title,
      exportName: s.exportName,
      file: s.file,
      nodeId: entry?.nodeId ?? null,
      status: entry ? (isPending(entry) ? "pending" : "registered") : "missing",
    };
  });

  if (opts.format === "json") {
    console.log(
      JSON.stringify(
        { fileKey: registry.fileKey || config.fileKey, stories: nodes },
        null,
        2,
      ),
    );
    return 0;
  }

  // dot — minimal, one cluster per title, story→node edge labeled with status.
  const fileKey = registry.fileKey || config.fileKey;
  console.log(`digraph design_sync {`);
  console.log(`  rankdir=LR;`);
  console.log(`  node [shape=box, fontname="Helvetica"];`);
  console.log(`  "figma:${fileKey}" [label="Figma\\n${fileKey}", shape=cylinder];`);
  for (const n of nodes) {
    const label = `${n.title}\\n${n.exportName}`;
    console.log(`  "${n.storyId}" [label="${escapeDot(label)}"];`);
    if (n.nodeId) {
      console.log(
        `  "${n.storyId}" -> "figma:${fileKey}" [label="${n.nodeId} (${n.status})"];`,
      );
    } else {
      console.log(`  "${n.storyId}" -> "figma:${fileKey}" [style=dashed, label="${n.status}"];`);
    }
  }
  console.log(`}`);
  return 0;
}

function escapeDot(s: string): string {
  return s.replace(/"/g, '\\"');
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
