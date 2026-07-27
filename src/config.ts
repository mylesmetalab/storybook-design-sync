import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CodeTarget } from "@metalab/design-sync-pipeline";

/**
 * Write gating for the panel's apply controls (v1 "audit-only" release).
 *
 *   - `"off"` (default): the panel is read-only. Drift detail, advisories,
 *     and "Copy fix prompt" all render, but no Apply / Preview-all /
 *     bulk-apply buttons are shown.
 *   - `"experimental"`: the pre-v1 write surface (Apply buttons, dry-run
 *     preview, bulk apply) is enabled, labeled as experimental.
 */
export type ApplyMode = "off" | "experimental";

export interface DesignSyncConfig {
  engine: string;
  registryPath: string;
  fileKey: string;
  /** Write gating — see {@link ApplyMode}. Defaults to `"off"`. */
  apply: ApplyMode;
  /**
   * Files the addon is allowed to write when applying a **code-scope** edit
   * in-process (P1.4 — "Update code" without the pipeline binary running).
   * Mirrors the pipeline's `codeTargets`. Defaults to `[]`, in which case a
   * code-scope Apply is rejected with a "configure codeTargets" message.
   */
  codeTargets: CodeTarget[];
  /**
   * Glob patterns (relative to the consumer's cwd) for the CSS files the
   * scanner reads at startup to build the selector → token map. Default
   * picks up `src/**\/*.css`, which covers the common Storybook layout.
   * Set this if your CSS lives elsewhere (e.g. `styles/**\/*.css`).
   */
  cssEntries: string[];
  /**
   * Glob patterns (relative to the consumer's cwd) for `.tsx` files the
   * scanner reads at startup to extract inline-style token bindings
   * (`style={{ paddingTop: "var(--space-4)" }}`). Default matches the
   * common `src/**\/*.tsx` layout. Set explicitly when stories live in
   * a sibling package (e.g. `["../../packages/*\/src/**\/*.tsx"]`).
   */
  tsxEntries: string[];
  /**
   * Glob patterns (relative to the consumer's cwd) where stories live.
   * Used by the CLI for discovery. Set this in monorepos where stories
   * are siblings of the Storybook host (e.g.
   * `["../../packages/*\/src/**\/*.stories.@(ts|tsx)"]`). The CLI's
   * `--stories` flag still overrides this when set.
   */
  storyGlobs: string[];
}

const DEFAULTS = {
  engine: "figma-rest",
  registryPath: ".design-sync/registry.json",
  apply: "off" as ApplyMode,
  codeTargets: [] as CodeTarget[],
  cssEntries: ["src/**/*.css"],
  tsxEntries: ["src/**/*.tsx"],
  storyGlobs: [
    "src/**/*.stories.@(ts|tsx|js|jsx|mjs|mts)",
    "stories/**/*.stories.@(ts|tsx|js|jsx|mjs|mts)",
  ],
} as const;

// JSON only. A `.ts` config would need `await import()` of a TypeScript
// file, which stock Node rejects (ERR_UNKNOWN_FILE_EXTENSION) — advertising
// it was a lie. If typed config is ever wanted, it needs a real loader.
const CONFIG_NAME = "design-sync.config.json";

export async function loadConfig(cwd: string = process.cwd()): Promise<DesignSyncConfig> {
  const full = resolve(cwd, CONFIG_NAME);
  let raw: string;
  try {
    raw = await readFile(full, "utf8");
  } catch (err: unknown) {
    if (isNotFound(err)) {
      throw new Error(
        `[design-sync] No config found. Add ${CONFIG_NAME} at ${cwd}.`,
      );
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`[design-sync] ${CONFIG_NAME} failed to parse: ${m} at ${full}`);
  }
  return normalize(parsed);
}

function normalize(raw: unknown): DesignSyncConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("[design-sync] Config must be an object.");
  }
  const r = raw as Partial<DesignSyncConfig>;
  if (!r.fileKey) throw new Error("[design-sync] Config: `fileKey` is required.");
  if (r.apply !== undefined && r.apply !== "off" && r.apply !== "experimental") {
    throw new Error(
      `[design-sync] Config: \`apply\` must be "off" or "experimental" (got ${JSON.stringify(r.apply)}).`,
    );
  }
  return {
    engine: r.engine ?? DEFAULTS.engine,
    registryPath: r.registryPath ?? DEFAULTS.registryPath,
    fileKey: r.fileKey,
    apply: r.apply ?? DEFAULTS.apply,
    codeTargets: r.codeTargets ?? [...DEFAULTS.codeTargets],
    cssEntries: r.cssEntries ?? [...DEFAULTS.cssEntries],
    tsxEntries: r.tsxEntries ?? [...DEFAULTS.tsxEntries],
    storyGlobs: r.storyGlobs ?? [...DEFAULTS.storyGlobs],
  };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
