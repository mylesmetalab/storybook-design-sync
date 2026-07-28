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
   *
   * **Canonical shape: `CodeTarget[]`** (objects with a `path`), because that is
   * what the pipeline's write engines take and it is the only shape that can
   * carry `scopeSelector`. JSON may use either that or the documented glob-string
   * shorthand (`"src/**\/*.tsx"`); `loadConfig` normalizes strings to
   * `{ path }`, so nothing downstream has to guess which shape it got.
   */
  codeTargets: CodeTarget[];
  /**
   * Every code-target path, in config order — what the fix prompts name as "the
   * files this change belongs in", and what the panel receives over the channel.
   *
   * Derived here rather than at the call site: `server.ts` used to compute it as
   * `config.codeTargets.map((t) => t.path)`, which produced `[undefined]` for
   * every consumer using the documented string shorthand, and every generated
   * fix prompt then told its reader to edit a file called `undefined`. In
   * audit-only mode the fix prompt IS the product, so that bug shipped straight
   * into the deliverable. Reading a plain `string[]` makes the shape impossible
   * to get wrong again.
   */
  codeTargetPaths: string[];
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

const CODE_TARGET_SHAPES =
  `Each entry must be either a glob/path string (e.g. "src/components/**/*.tsx") ` +
  `or an object with a non-empty \`path\` (e.g. { "path": "src/Button.css", "scopeSelector": ".btn" }).`;

/**
 * Accept both documented shapes for `codeTargets` and canonicalize to
 * `CodeTarget[]`:
 *
 *   "src/components/ui/**\/*.tsx"                  → { path: "src/…/*.tsx" }
 *   { "path": "src/Button.css", "scopeSelector": … } → unchanged
 *
 * Anything else throws. A silently-accepted bad entry is what caused the
 * `undefined` in fix prompts: the string shorthand every doc and every consumer
 * uses reached a `.map((t) => t.path)` and produced `[undefined]`, which read as
 * a value all the way into the prompt. Same class as the name-as-value fallback
 * removed from `figma-rest.ts` — never let a bad read masquerade as a value.
 */
export function normalizeCodeTargets(raw: unknown): CodeTarget[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `[design-sync] Config: \`codeTargets\` must be an array (got ${JSON.stringify(raw)}). ${CODE_TARGET_SHAPES}`,
    );
  }
  return raw.map((entry, i) => {
    const reject = (): never => {
      throw new Error(
        `[design-sync] Config: \`codeTargets[${i}]\` is not usable (got ${JSON.stringify(entry) ?? String(entry)}). ${CODE_TARGET_SHAPES}`,
      );
    };
    if (typeof entry === "string") {
      const path = entry.trim();
      if (path === "") reject();
      return { path };
    }
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const record = entry as { path?: unknown; scopeSelector?: unknown };
      if (typeof record.path === "string" && record.path.trim() !== "") {
        const target: CodeTarget = { path: record.path.trim() };
        if (typeof record.scopeSelector === "string" && record.scopeSelector.trim() !== "") {
          target.scopeSelector = record.scopeSelector.trim();
        }
        return target;
      }
    }
    return reject();
  });
}

function normalize(raw: unknown): DesignSyncConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("[design-sync] Config must be an object.");
  }
  const r = raw as Partial<DesignSyncConfig> & { codeTargets?: unknown };
  if (!r.fileKey) throw new Error("[design-sync] Config: `fileKey` is required.");
  if (r.apply !== undefined && r.apply !== "off" && r.apply !== "experimental") {
    throw new Error(
      `[design-sync] Config: \`apply\` must be "off" or "experimental" (got ${JSON.stringify(r.apply)}).`,
    );
  }
  const codeTargets = normalizeCodeTargets(r.codeTargets);
  return {
    engine: r.engine ?? DEFAULTS.engine,
    registryPath: r.registryPath ?? DEFAULTS.registryPath,
    fileKey: r.fileKey,
    apply: r.apply ?? DEFAULTS.apply,
    codeTargets,
    codeTargetPaths: codeTargets.map((t) => t.path),
    cssEntries: r.cssEntries ?? [...DEFAULTS.cssEntries],
    tsxEntries: r.tsxEntries ?? [...DEFAULTS.tsxEntries],
    storyGlobs: r.storyGlobs ?? [...DEFAULTS.storyGlobs],
  };
}

/**
 * Glob metacharacters. A `codeTargets` entry containing one is a *pattern*, not
 * a file: the in-process write engines resolve `path` literally (extension
 * filter, then read), so a glob can never be written to. Used by
 * `apply-code.ts` to refuse loudly instead of failing with an ENOENT from
 * inside an engine.
 */
export function isGlobPath(path: string): boolean {
  return /[*?[\]{}]/.test(path);
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
