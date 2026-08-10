import { readFile } from "node:fs/promises";
import { glob } from "tinyglobby";
import { loadConfig } from "./config.js";
import {
  loadRegistry,
  saveRegistry,
  isPending,
  type Registry,
  type RegistryEntry,
} from "./registry.js";
import {
  auditChildBindings,
  parseChildFlag,
  validateChildBindings,
} from "./child-bindings.js";
import {
  FORCEABLE_STATES,
  auditStateBindings,
  parseStateFlag,
  validateStateBindings,
} from "./state-bindings.js";
import {
  discoverStories,
  explicitTitle,
  regexStoryExports,
  toStoryId,
  type DiscoveredStory,
  type DiscoveryOutcome,
} from "./story-discovery.js";
import { parseCheckArgs, resolveStorybookUrl, runCheck } from "./check-command.js";
import { CHECK_EXIT } from "./check-report.js";
import { INIT_EXIT, parseInitArgs, runInit } from "./init.js";
import { VERIFY_EXIT } from "./contract-verify.js";
import { parseVerifyArgs, runVerify } from "./verify-command.js";
import { applyHintPlan, planHintRegistration } from "./hint-plan.js";
import { parseScanArgs, runScan } from "./scan-command.js";

interface CommonOptions {
  cwd: string;
  /** Override globs from --stories. When undefined, the loaded config's
   *  `storyGlobs` is used. */
  storyGlobsOverride: string[] | undefined;
}

interface RegisterOptions extends CommonOptions {
  hintsPath: string;
  dryRun: boolean;
  /** `--story <id>` — scopes `--child` / `--state` to one already-registered story. */
  story: string | undefined;
  /** `--child "<selector>=<nodeId>"`, repeatable. */
  children: string[];
  /** `--state "<pseudo-state>=<nodeId>"`, repeatable. */
  states: string[];
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
    case "init":
      // Same shape as `check`: a usage error must not be reported as a
      // half-completed init, so parsing happens inside the try and maps to the
      // refusal code rather than falling through to the top-level catch.
      try {
        return await runInit(parseInitArgs(rest), { promptFileKey: promptForFileKey });
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        return INIT_EXIT.Refused;
      }
    case "audit":
      return audit(parseCommon(rest));
    case "ls":
      return ls(parseCommon(rest));
    case "register":
      return register(parseRegisterArgs(rest));
    case "export-graph":
      return exportGraph(parseExportGraphArgs(rest));
    case "verify":
      // Same shape as `check` and `init`: a usage error must not be reported as a
      // completed verification, so parsing happens inside the try and maps to the
      // refusal code rather than falling through to the top-level catch.
      try {
        return await runVerify(parseVerifyArgs(rest));
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        return VERIFY_EXIT.CouldNotRun;
      }
    case "scan":
      // Same shape as `verify`: needs no browser and no running Storybook, just
      // a filesystem scan, so a usage or config error maps to a plain refusal
      // rather than a stack trace.
      try {
        await runScan(parseScanArgs(rest));
        return 0;
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
    case "check":
      // Argument parsing happens INSIDE the try so a usage error maps to
      // `CouldNotRun` rather than falling through to the top-level catch, which
      // exits 2 — the code that means "I ran and the coverage has gaps". A wrong
      // flag must never be reported as an incomplete drift check.
      try {
        const args = parseCheckArgs(rest);
        const url = await resolveStorybookUrl(args.url, {
          warn: (message) => process.stderr.write(message),
        });
        return await runCheck({ ...args, url });
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : String(err));
        return CHECK_EXIT.CouldNotRun;
      }
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      return 1;
  }
}

/**
 * Ask for the Figma file key, but only when there is a human to ask.
 *
 * Off a TTY this returns undefined immediately, so a scripted or CI run gets the
 * placeholder plus a loud step-one instead of hanging on stdin forever. The key
 * is the one thing only the user knows, so it is prompted for or left visibly
 * blank — never derived.
 */
async function promptForFileKey(): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      "\nYour Figma file key is in the file URL: figma.com/design/<FILE_KEY>/…\n" +
        "Leave blank to write a placeholder and fill it in later.",
    );
    const answer = await rl.question("Figma file key: ");
    return answer.trim() || undefined;
  } finally {
    rl.close();
  }
}

function printHelp(): void {
  console.log(
    [
      "design-sync — Storybook ↔ Figma drift CLI",
      "",
      "Usage:",
      "  design-sync init                        Set up the suite in this project: register the addons,",
      "                                          write design-sync.config.json from what it detects, and",
      "                                          report every step it could NOT do, in order.",
      "                                          Never overwrites a file you wrote; safe to re-run.",
      "                                          --file-key <key> (never guessed), --yes (no prompt),",
      "                                          --no-skills, --force (rewrite only files init authors),",
      "                                          --dry-run",
      "                                          Exit: 0 init did its part · 1 refused, nothing written ·",
      "                                          2 a write failed",
      "  design-sync check [--url http://localhost:6006]",
      "                                          Run the panel's drift check headlessly against a RUNNING",
      "                                          `storybook dev`, over every registered story.",
      "                                          --story <id> / --component <name> (repeatable) to narrow;",
      "                                          --both-modes, --json, --out <file>, --full-report,",
      "                                          --timeout <ms>, --headed, --quiet",
      "                                          Exit: 0 clean · 1 drift · 2 coverage incomplete · 3 could not run",
      "                                          Needs Playwright (optional peer dep) and FIGMA_PAT in the",
      "                                          STORYBOOK process's environment, not the CLI's.",
      "  design-sync verify                      Re-read `contracts/*.spec.json`'s claims against Figma — are the",
      "                                          assumptions this component was built on still true? No browser,",
      "                                          no Storybook: a Figma read plus a JSON compare, so it runs",
      "                                          anywhere `audit` runs. Needs FIGMA_PAT.",
      "                                          --full (show verified claims too), --json, --contracts <glob>",
      "                                          Exit: 0 verified · 1 falsified · 2 could not be re-read · 3 could not run",
      "  design-sync scan --out <file>           Write the CSS/TSX selector -> token scan (the same one the Storybook",
      "                                          preset runs at startup) to a file, so it can travel without a live",
      "                                          process behind it. No browser, no Storybook. --code-ref <sha> to",
      "                                          stamp a specific commit instead of reading the current git HEAD.",
      "                                          Exit: 0 written · 1 could not run",
      "  design-sync audit                       Diff stories on disk against the registry (exits non-zero on drift)",
      "                                          Also validates the SHAPE of declared child and state bindings (not that they resolve)",
      "                                          Exits non-zero on any story file it could not read — a file that yields no",
      "                                          story ids is a coverage hole, not a warning",
      "  design-sync register [--hints <path>]   Bulk-register stories from .design-sync/hints.json; stubs the rest",
      "  design-sync register --story <id> --child \"<selector>=<nodeId>\" [--child …]",
      "                                          Declare child-element bindings so composed components are checked",
      "                                          beyond their root element. Repeatable; merges into any existing map.",
      "  design-sync register --story <id> --state \"<pseudo-state>=<nodeId>\" [--state …]",
      "                                          Declare which Figma node holds a pseudo-state's design.",
      "                                          Repeatable; merges. Compared as of v0.0.52, including",
      "                                          per-mode under --both-modes; a state that cannot be forced",
      "                                          is reported as not compared, never as a pass.",
      "                                          States: " + FORCEABLE_STATES.join(", "),
      "                                          A design's Error/Open/Checked state is a prop, not a pseudo-state —",
      "                                          bind it as its own story instead.",
      "  design-sync ls                          Print the title → node binding tree (child and state bindings nested)",
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
  const common = parseCommonAllowing(rest, [
    "--hints",
    "--dry-run",
    "--story",
    "--child",
    "--state",
  ]);
  return {
    cwd: common.cwd,
    storyGlobsOverride: common.storyGlobsOverride,
    hintsPath: common.extras.get("--hints") ?? ".design-sync/hints.json",
    dryRun: common.flags.has("--dry-run"),
    story: common.extras.get("--story"),
    children: common.repeated.get("--child") ?? [],
    states: common.repeated.get("--state") ?? [],
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
/** Flags that may appear more than once; every value is kept, in order. */
const REPEATABLE_FLAGS = new Set(["--child", "--state"]);

function parseCommonAllowing(
  rest: string[],
  allowedExtras: string[],
): {
  cwd: string;
  storyGlobsOverride: string[] | undefined;
  extras: Map<string, string>;
  repeated: Map<string, string[]>;
  flags: Set<string>;
} {
  const cwd = process.cwd();
  const storyGlobs: string[] = [];
  const extras = new Map<string, string>();
  const repeated = new Map<string, string[]>();
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
        if (REPEATABLE_FLAGS.has(arg)) {
          const list = repeated.get(arg) ?? [];
          list.push(value);
          repeated.set(arg, list);
        } else {
          extras.set(arg, value);
        }
      }
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    cwd,
    storyGlobsOverride: storyGlobs.length > 0 ? storyGlobs : undefined,
    extras,
    repeated,
    flags,
  };
}

// ---- discovery ------------------------------------------------------------

/**
 * Story discovery lives in `story-discovery.ts` (a real CSF parse plus
 * Storybook's own autotitle derivation — see that file for why the old regex
 * undercounted CSF3 autotitle files, and what "unreadable" means).
 */
async function discover(
  opts: CommonOptions,
  configGlobs: string[],
): Promise<DiscoveryOutcome & { globs: string[] }> {
  const globs = opts.storyGlobsOverride ?? configGlobs;
  const files = await glob(globs, { cwd: opts.cwd, absolute: true });
  const outcome = await discoverStories({ cwd: opts.cwd, files, globs });
  return { ...outcome, globs };
}

/**
 * Print everything discovery could NOT turn into story ids. Shared by `audit`,
 * `register` and `ls` so no command can quietly omit it.
 *
 * Worded as a coverage hole, because that is what it is: the stories in these
 * files are registered by nothing and checked by nothing.
 */
function reportDiscoveryProblems(outcome: DiscoveryOutcome, globs: string[]): void {
  if (outcome.skipped.length > 0) {
    console.log(`\nNot a source of story ids (${outcome.skipped.length} file(s)):`);
    for (const s of outcome.skipped) console.log(`  - ${s.file}: ${s.reason}`);
  }
  if (outcome.unreadable.length > 0) {
    console.log(
      `\nUNREADABLE — ${outcome.unreadable.length} file(s) match storyGlobs [${globs.join(", ")}] ` +
        `but produced NO story ids. Any stories they contain are registered by nothing and checked by ` +
        `nothing; this is a coverage hole, not a formatting nit:`,
    );
    for (const u of outcome.unreadable) console.log(`  - ${u.file}: ${u.reason}`);
  }
  if (outcome.degraded) {
    console.log(`\nNote: discovery ran degraded — ${outcome.degraded}.`);
  }
}

/**
 * @deprecated Regex-based CSF read. Superseded by `discoverStories`, which uses
 * the installed Storybook's CSF parser and finds CSF3 **autotitle** files (this
 * function returns null for every one of them — the undercount that made
 * `audit` report a complete registry over stories nothing checks). Retained
 * unchanged so any direct importer keeps working.
 */
export function parseStoryFile(source: string): { title: string; exports: string[] } | null {
  const title = explicitTitle(source);
  if (title === null) return null;
  return { title, exports: regexStoryExports(source) };
}

/** Back-compat: previous CLI exposed this. Keep so any direct importer holds. */
export function extractStoryIds(source: string): string[] | null {
  const parsed = parseStoryFile(source);
  if (!parsed) return null;
  return parsed.exports.map((name) => toStoryId(parsed.title, name));
}

export { toStoryId };

// ---- audit ----------------------------------------------------------------

async function audit(opts: CommonOptions): Promise<number> {
  const config = await loadConfig(opts.cwd);
  const registry = await loadRegistry(config.registryPath, opts.cwd);
  const outcome = await discover(opts, config.storyGlobs);
  const { stories, unreadable, globs } = outcome;

  const codeIds = new Set(stories.map((s) => s.id));
  const registryIds = new Set(Object.keys(registry.stories));
  const pending = Object.entries(registry.stories)
    .filter(([, e]) => isPending(e))
    .map(([id]) => id);

  const missing = [...codeIds].filter((id) => !registryIds.has(id)).sort();
  const extra = [...registryIds].filter((id) => !codeIds.has(id)).sort();

  // Declared child bindings — shape validation only (see the note printed
  // below for what audit deliberately cannot check).
  const children = auditChildBindings(registry.stories);
  const states = auditStateBindings(registry.stories);

  const autotitled = stories.filter((s) => s.titleSource === "autotitle").length;
  const storyFiles = new Set(stories.map((s) => s.file)).size;

  console.log(`Stories on disk:     ${codeIds.size}`);
  // The counts that make an undercount visible. "Stories on disk: 0" used to be
  // the only thing an autotitle consumer saw, and it read as "you have no
  // stories" rather than "I could not read any of your files".
  console.log(
    `Story files read:    ${storyFiles} of ${storyFiles + unreadable.length + outcome.skipped.length} matched` +
      ` (${codeIds.size - autotitled} from an explicit title, ${autotitled} autotitled)`,
  );
  console.log(
    `Unreadable files:    ${unreadable.length}` +
      (unreadable.length > 0 ? "  ← stories in these are checked by NOTHING (listed below)" : ""),
  );
  console.log(`Stories registered:  ${registryIds.size} (${pending.length} pending)`);
  console.log(`Missing:             ${missing.length}`);
  console.log(`Extra:               ${extra.length}`);
  console.log(
    `Child bindings:      ${children.declaredBindings} across ${children.storiesWithChildren} story(ies)` +
      (children.issues.length > 0 ? ` — ${children.issues.length} malformed` : ""),
  );
  console.log(
    `State bindings:      ${states.declaredBindings} across ${states.storiesWithStates} story(ies)` +
      (states.issues.length > 0 ? ` — ${states.issues.length} malformed` : ""),
  );

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
  if (children.issues.length > 0) {
    console.log("\nMalformed child bindings:");
    for (const issue of children.issues) {
      console.log(`  - ${issue.storyId}: ${issue.message}`);
    }
  }
  if (states.issues.length > 0) {
    console.log("\nMalformed state bindings:");
    for (const issue of states.issues) {
      console.log(`  - ${issue.storyId}  ${issue.state}: ${issue.detail}`);
    }
  }
  if (children.storiesWithChildren > 0) {
    // Say plainly what was NOT checked. Implying that a green audit means the
    // selectors resolve would be exactly the confident-but-inapplicable signal
    // this project keeps paying for.
    console.log(
      `\nNote on child bindings: audit validates SHAPE only. It has no DOM and no Figma access, so it ` +
        `cannot tell you whether a selector matches exactly one element inside the story root, or ` +
        `whether a declared Figma node id exists. Run "Check drift" in Storybook — that reports both, ` +
        `per binding.`,
    );
  }
  if (states.storiesWithStates > 0) {
    // Same honesty note as child bindings, for the same reason: a green audit
    // here says the vocabulary and node-id shapes are valid, nothing more.
    console.log(
      `\nNote on state bindings: audit validates SHAPE only. It cannot tell you whether the state is ` +
        `forceable on the rendered element, whether forcing it actually changes anything, or whether ` +
        `the declared Figma node exists. Only a drift check reports those.`,
    );
  }
  reportDiscoveryProblems(outcome, globs);

  // An unreadable story file fails the audit. A green CI over stories nothing
  // checks is the exact failure this release is closing: the registry looks
  // complete because the files that would have added to it were never counted.
  return missing.length > 0 ||
    extra.length > 0 ||
    children.issues.length > 0 ||
    states.issues.length > 0 ||
    unreadable.length > 0
    ? 1
    : 0;
}

// ---- ls -------------------------------------------------------------------

async function ls(opts: CommonOptions): Promise<number> {
  const config = await loadConfig(opts.cwd);
  const registry = await loadRegistry(config.registryPath, opts.cwd);
  const outcome = await discover(opts, config.storyGlobs);
  const { stories } = outcome;
  if (stories.length === 0) {
    // "No stories discovered." on its own is a lie when files matched and
    // failed to parse — the reason follows immediately.
    console.log("No stories discovered.");
    reportDiscoveryProblems(outcome, outcome.globs);
    return outcome.unreadable.length > 0 ? 1 : 0;
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
      // Declared child bindings, nested under their story. Only printed when
      // present, so output for legacy entries is unchanged.
      const { declarations, malformed, fatal } = validateChildBindings(entry?.children);
      const indent = isLast ? "      " : "  │   ";
      if (fatal) console.log(`${indent}⚠ children: ${fatal}`);
      for (let d = 0; d < declarations.length; d++) {
        const decl = declarations[d]!;
        const branch = d === declarations.length - 1 && malformed.length === 0 ? "└" : "├";
        console.log(`${indent}${branch} ${decl.selector.padEnd(28)} → ${decl.nodeId}`);
      }
      for (const m of malformed) {
        console.log(`${indent}⚠ ${m.selector.padEnd(28)} → ${m.detail}`);
      }
      // Declared state bindings, same treatment: nested, present-only, and a
      // malformed one is shown rather than dropped.
      const states = validateStateBindings(entry?.states);
      if (states.fatal) console.log(`${indent}⚠ states: ${states.fatal}`);
      for (let d = 0; d < states.declarations.length; d++) {
        const decl = states.declarations[d]!;
        const isLastState =
          d === states.declarations.length - 1 && states.malformed.length === 0;
        console.log(
          `${indent}${isLastState ? "└" : "├"} :${decl.state.padEnd(27)} → ${decl.nodeId}`,
        );
      }
      for (const m of states.malformed) {
        console.log(`${indent}⚠ :${m.state.padEnd(27)} → ${m.detail}`);
      }
    }
  }
  return 0;
}

// ---- register -------------------------------------------------------------

/**
 * `register --story <id> --child "<sel>=<nodeId>" [--child …]` — add or update
 * declared child bindings on one already-registered story.
 *
 * Requires the story to be registered with a real `nodeId` first: a child
 * binding is meaningless without the component binding it hangs off, and
 * inventing a root node id here would be a guess.
 */
async function registerChildren(opts: RegisterOptions, storyId: string): Promise<number> {
  const config = await loadConfig(opts.cwd);
  const registry = await loadRegistry(config.registryPath, opts.cwd);
  const entry = registry.stories[storyId];
  if (!entry) {
    console.error(
      `"${storyId}" is not in ${config.registryPath}. Register the story (and its Figma node) first — ` +
        `a child binding needs a parent binding to hang off.`,
    );
    return 1;
  }
  if (isPending(entry)) {
    console.error(
      `"${storyId}" is a pending stub (no Figma node assigned). Set its "nodeId" before adding child bindings.`,
    );
    return 1;
  }

  const pairs = opts.children.map(parseChildFlag);
  const merged: Record<string, string> = { ...(entry.children ?? {}) };
  for (const { selector, nodeId } of pairs) {
    const previous = merged[selector];
    merged[selector] = nodeId;
    console.log(
      previous && previous !== nodeId
        ? `~ ${storyId}  ${selector} → ${nodeId}  (was ${previous})`
        : `+ ${storyId}  ${selector} → ${nodeId}`,
    );
  }
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(merged).sort()) sorted[key] = merged[key]!;

  const { malformed, fatal } = validateChildBindings(sorted);
  if (fatal || malformed.length > 0) {
    console.error(`Refusing to write a malformed "children" map: ${fatal ?? malformed[0]!.detail}`);
    return 1;
  }

  const updated: Registry = {
    fileKey: registry.fileKey || config.fileKey,
    stories: { ...registry.stories, [storyId]: { ...entry, children: sorted } },
  };
  console.log(
    `\n${pairs.length} child binding(s) set on "${storyId}" (${Object.keys(sorted).length} total)` +
      (opts.dryRun ? " (dry-run; nothing written)" : ""),
  );
  console.log(
    `Selectors are resolved inside the story root at check time. This command does NOT verify ` +
      `that they match exactly one element — only a drift check (which has a DOM) can.`,
  );
  if (!opts.dryRun) {
    await saveRegistry(config.registryPath, updated, opts.cwd);
    console.log(`Wrote ${config.registryPath}.`);
  }
  return 0;
}

/**
 * `register --story <id> --state "<pseudo-state>=<nodeId>" [--state …]` — add or
 * update declared state bindings on one already-registered story.
 *
 * Same precondition as child bindings: the story needs a real `nodeId` first. A
 * state binding says "compare the forced state against *this other* node", which
 * is meaningless without the default-state node it is a variant of.
 */
async function registerStates(opts: RegisterOptions, storyId: string): Promise<number> {
  const config = await loadConfig(opts.cwd);
  const registry = await loadRegistry(config.registryPath, opts.cwd);
  const entry = registry.stories[storyId];
  if (!entry) {
    console.error(
      `"${storyId}" is not in ${config.registryPath}. Register the story (and its Figma node) first — ` +
        `a state binding is a variant of the default-state binding.`,
    );
    return 1;
  }
  if (isPending(entry)) {
    console.error(
      `"${storyId}" is a pending stub (no Figma node assigned). Set its "nodeId" before adding state bindings.`,
    );
    return 1;
  }

  const pairs = opts.states.map(parseStateFlag);
  const merged: Record<string, string> = { ...(entry.states ?? {}) };
  for (const { state, nodeId } of pairs) {
    const previous = merged[state];
    if (nodeId === entry.nodeId) {
      // Binding a state to the same node as the default state would compare the
      // forced rendering against the *unforced* design, reporting drift for
      // every property the state deliberately changes. Always a mistake.
      console.error(
        `Refusing to bind :${state} to ${nodeId} — that is this story's own default-state node. ` +
          `A state binding needs the Figma node for that state (e.g. the "State=Hover" variant).`,
      );
      return 1;
    }
    merged[state] = nodeId;
    console.log(
      previous && previous !== nodeId
        ? `~ ${storyId}  :${state} → ${nodeId}  (was ${previous})`
        : `+ ${storyId}  :${state} → ${nodeId}`,
    );
  }
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(merged).sort()) sorted[key] = merged[key]!;

  const { malformed, fatal } = validateStateBindings(sorted);
  if (fatal || malformed.length > 0) {
    console.error(`Refusing to write a malformed "states" map: ${fatal ?? malformed[0]!.detail}`);
    return 1;
  }

  const updated: Registry = {
    fileKey: registry.fileKey || config.fileKey,
    stories: { ...registry.stories, [storyId]: { ...entry, states: sorted } },
  };
  console.log(
    `\n${pairs.length} state binding(s) set on "${storyId}" (${Object.keys(sorted).length} total)` +
      (opts.dryRun ? " (dry-run; nothing written)" : ""),
  );
  console.log(
    `These are compared as of v0.0.52, in each mode when "Both modes" is on. A state the addon ` +
      `cannot force — one styled through a component library's own \`data-*\` attribute — is ` +
      `reported as not compared, with the reason, and never as a pass.`,
  );
  if (!opts.dryRun) {
    await saveRegistry(config.registryPath, updated, opts.cwd);
    console.log(`Wrote ${config.registryPath}.`);
  }
  return 0;
}

async function register(opts: RegisterOptions): Promise<number> {
  if (opts.children.length > 0 && opts.states.length > 0) {
    // Both would work, but each prints its own summary and writes the registry
    // once; interleaving them makes the output ambiguous about what was written.
    console.error(
      `Pass --child and --state in separate commands so each reports what it wrote.`,
    );
    return 1;
  }
  if (opts.children.length > 0) {
    if (!opts.story) {
      console.error(
        `--child requires --story <storyId> so the binding lands on a specific story. ` +
          `Example: design-sync register --story ui-card--default --child "[data-slot=header]=2142:11381"`,
      );
      return 1;
    }
    return registerChildren(opts, opts.story);
  }
  if (opts.states.length > 0) {
    if (!opts.story) {
      console.error(
        `--state requires --story <storyId> so the binding lands on a specific story. ` +
          `Example: design-sync register --story ui-button--primary --state "hover=4185:3783"`,
      );
      return 1;
    }
    return registerStates(opts, opts.story);
  }
  if (opts.story) {
    console.error(`--story is only meaningful together with --child or --state.`);
    return 1;
  }

  const config = await loadConfig(opts.cwd);
  const registry = await loadRegistry(config.registryPath, opts.cwd);
  const outcome = await discover(opts, config.storyGlobs);
  const { stories } = outcome;
  const hints = await loadHints(opts.cwd, opts.hintsPath);

  const updated: Registry = {
    fileKey: registry.fileKey || config.fileKey,
    stories: { ...registry.stories },
  };

  const plan = planHintRegistration(stories, hints, updated.stories);
  updated.stories = applyHintPlan(plan, updated.stories);

  for (const action of plan.actions) {
    if (action.kind === "add") console.log(`+ ${action.storyId} → ${action.nodeId}`);
    else if (action.kind === "stub") console.log(`· ${action.storyId} → pending`);
    else if (action.kind === "upgrade") {
      console.log(`↑ ${action.storyId} → ${action.nodeId}  (was a pending stub)`);
    }
  }

  const { add, stub, upgrade, conflict } = plan.counts;
  console.log(
    `\n${add} registered from hints, ${upgrade} pending stub(s) upgraded, ` +
      `${stub} stubbed as pending` +
      (opts.dryRun ? " (dry-run; nothing written)" : ""),
  );
  if (conflict > 0) {
    // A hint the user wrote and the tool discarded must never be silent — that
    // silence, plus exit 0, is the whole of #97.
    console.log(
      `\n${conflict} hint(s) NOT applied — already bound to a different node. ` +
        `\`register\` never overwrites a real binding; edit ${config.registryPath} ` +
        `directly if the hint is the correct one:`,
    );
    for (const a of plan.actions) {
      if (a.kind === "conflict") {
        console.log(`  - ${a.storyId}: hint says ${a.nodeId}, registry says ${a.boundTo}`);
      }
    }
  }

  // Same report as `audit`: a file that produced no story ids means stories
  // this registry will never contain, so `register` must not finish quietly.
  reportDiscoveryProblems(outcome, outcome.globs);

  if (!opts.dryRun && (add > 0 || stub > 0 || upgrade > 0)) {
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
