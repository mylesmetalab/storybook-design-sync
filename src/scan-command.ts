import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";
import { scanCss } from "./scan-css.js";
import { scanTsx } from "./scan-tsx.js";
import { mergeMaps } from "./preset.js";
import { loadedVersion } from "./addon-version.js";
import type { AutoScan } from "./auto-tokens.js";

const execFileAsync = promisify(execFile);

/**
 * `design-sync scan` — the same startup scan the Storybook preset runs
 * (`preset.ts`'s `runInitialScan`), as a standalone command that needs no
 * live Storybook process.
 *
 * Everywhere else, `AutoScan` only ever exists as a module singleton inside a
 * running dev server (`auto-tokens.ts`'s `setAutoScan`/`getAutoScan`). This is
 * the one net-new piece the hosted-check plan needs to let it travel as a
 * file instead: it calls the exact same `scanCss` / `scanTsx` / `mergeMaps`
 * the preset calls, in the same order, so a hosted artifact and a locally
 * scanned map can never silently diverge on scan *logic* — only on which
 * commit produced them, which `codeRef` makes an explicit, checkable fact
 * instead of a hidden one (HOSTED-CHECK-SPEC.md §2c).
 */

/** `AutoScan` plus the provenance a consumer needs to trust it, not use it blindly. */
export interface ScanArtifact extends AutoScan {
  /** The exact git commit this scan was produced from. */
  codeRef: string;
  /** ISO. When this scan ran. */
  scannedAt: string;
  /** The addon version that produced this artifact, when it could be read. */
  addonVersion?: string;
}

export interface ScanOptions {
  cwd: string;
  out: string;
  /** `--code-ref`. Wins outright over the git resolver when given (CI already knows its own checked-out SHA precisely). */
  codeRef?: string;
}

export function parseScanArgs(rest: string[]): ScanOptions {
  let out: string | undefined;
  let codeRef: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = (): string => {
      const next = rest[++i];
      if (!next) throw new Error(`${arg} requires a value`);
      return next;
    };
    switch (arg) {
      case "--out":
        out = value();
        break;
      case "--code-ref":
        codeRef = value();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}. \`scan\` accepts --out, --code-ref.`);
    }
  }
  if (!out) throw new Error("--out is required — scan writes an artifact, it does not print one");
  return { cwd: process.cwd(), out, ...(codeRef !== undefined ? { codeRef } : {}) };
}

/** Injectable so the command is testable without a real git checkout or filesystem. */
export interface ScanDeps {
  resolveCodeRef: (explicit: string | undefined, cwd: string) => Promise<string>;
  version: () => Promise<string | undefined>;
  write: (path: string, contents: string) => Promise<void>;
  now: () => string;
  stderr: (text: string) => void;
}

/**
 * An explicit `--code-ref` wins outright, exactly as `resolveStorybookUrl`
 * (`check-command.ts`) resolves `--url`: CI already knows its own checked-out
 * SHA precisely, so asking git again could only introduce a mismatch, never
 * improve on it. Only absent does this shell out.
 */
export async function resolveCodeRef(explicit: string | undefined, cwd: string): Promise<string> {
  if (explicit) return explicit;
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

export const defaultScanDeps: ScanDeps = {
  resolveCodeRef,
  version: loadedVersion,
  write: (path, contents) => writeFile(path, contents, "utf8"),
  now: () => new Date().toISOString(),
  stderr: (text) => process.stderr.write(text),
};

export async function runScan(opts: ScanOptions, deps: ScanDeps = defaultScanDeps): Promise<ScanArtifact> {
  // Unlike the live preset's `runInitialScan` (non-fatal — a human is
  // watching the terminal, and the addon still works with an empty map), a
  // config or scan failure here is left to propagate: a hosted artifact
  // silently written empty on error is indistinguishable from "this codebase
  // truly declares nothing" to whatever reads it unattended later.
  const config = await loadConfig(opts.cwd);
  // CSS first: it yields the Tailwind `@theme` variables the TSX scan needs
  // to turn a utility class into a token — same order as `runInitialScan`.
  const cssResult = await scanCss(opts.cwd, config.cssEntries);
  const tsxResult = await scanTsx(opts.cwd, config.tsxEntries, cssResult.themeVars);
  const merged = mergeMaps(cssResult.map, tsxResult.map);
  const codeRef = await deps.resolveCodeRef(opts.codeRef, opts.cwd);
  const version = await deps.version();

  const artifact: ScanArtifact = {
    map: merged,
    themeVars: cssResult.themeVars,
    components: tsxResult.components,
    classHints: tsxResult.classHints,
    customProperties: cssResult.customProperties,
    codeRef,
    scannedAt: deps.now(),
    ...(version !== undefined ? { addonVersion: version } : {}),
  };

  // Same coverage-hole rule as `runInitialScan` (#46/#60): a scanner that
  // derived nothing must not look identical to a codebase that declares
  // nothing. In CI, the workflow log is the terminal a human would have read.
  for (const w of [...cssResult.warnings, ...tsxResult.warnings]) {
    deps.stderr(`[design-sync] scan warning (${w.file}): ${w.message}\n`);
  }
  for (const skipped of [...cssResult.skipped, ...tsxResult.skipped]) {
    deps.stderr(`[design-sync] NOT SCANNED — ${skipped.message}\n`);
  }

  await deps.write(opts.out, `${JSON.stringify(artifact, null, 2)}\n`);
  deps.stderr(
    `[design-sync] scan written to ${opts.out} — ${Object.keys(merged).length} selector(s), ` +
      `${tsxResult.components.length} tailwind-cva component(s), codeRef ${codeRef}.\n`,
  );
  return artifact;
}

/* ------------------------------------------------------------------------- *
 * Loading a scan artifact back — sub-PR 1 of 3 for the hosted-check plan's
 * second engine host (HOSTED-CHECK-TASKS.md T8: load-artifact / drive-snapshot
 * / wire-to-engine). Everywhere else, `AutoScan` only ever exists as a module
 * singleton (`auto-tokens.ts`'s `setAutoScan`/`getAutoScan`) populated by a
 * running Storybook process. This is the read side that lets a runner with no
 * such process load exactly what `runScan` wrote instead.
 * ------------------------------------------------------------------------- */

/** Injectable so a malformed-file test needs no real filesystem. */
export interface LoadScanArtifactDeps {
  read: (path: string) => Promise<string>;
}

const defaultLoadScanArtifactDeps: LoadScanArtifactDeps = {
  read: (path) => readFile(path, "utf8"),
};

/**
 * Validates only enough to fail loudly on a truncated or wrong-shaped file.
 * A malformed artifact silently treated as an empty scan would be
 * indistinguishable from "this codebase declares nothing" to whatever reads
 * it later — the same failure mode `runScan` itself refuses to produce on a
 * config or scan error, one layer downstream.
 */
export async function loadScanArtifact(
  path: string,
  deps: LoadScanArtifactDeps = defaultLoadScanArtifactDeps,
): Promise<ScanArtifact> {
  const raw = await deps.read(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`Scan artifact at ${path} is not valid JSON: ${m}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Scan artifact at ${path} is not a JSON object.`);
  }
  const candidate = parsed as Partial<ScanArtifact>;
  if (typeof candidate.codeRef !== "string" || !candidate.codeRef) {
    throw new Error(
      `Scan artifact at ${path} is missing "codeRef" — refusing to use an unstamped artifact.`,
    );
  }
  if (typeof candidate.map !== "object" || candidate.map === null) {
    throw new Error(`Scan artifact at ${path} is missing "map" — this is not a scan artifact.`);
  }
  return {
    map: candidate.map,
    themeVars: candidate.themeVars ?? {},
    components: candidate.components ?? [],
    classHints: candidate.classHints ?? {},
    customProperties: candidate.customProperties ?? {},
    codeRef: candidate.codeRef,
    scannedAt: candidate.scannedAt ?? "",
    ...(candidate.addonVersion !== undefined ? { addonVersion: candidate.addonVersion } : {}),
  };
}

/** Drops a `ScanArtifact`'s provenance fields down to the plain `AutoScan` shape `setAutoScan` takes. */
export function toAutoScan(artifact: ScanArtifact): AutoScan {
  const { map, themeVars, components, classHints, customProperties } = artifact;
  return { map, themeVars, components, classHints, customProperties };
}
