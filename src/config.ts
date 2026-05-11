import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface DesignSyncConfig {
  engine: string;
  registryPath: string;
  fileKey: string;
  /**
   * Glob patterns (relative to the consumer's cwd) for the CSS files the
   * scanner reads at startup to build the selector → token map. Default
   * picks up `src/**\/*.css`, which covers the common Storybook layout.
   * Set this if your CSS lives elsewhere (e.g. `styles/**\/*.css`).
   */
  cssEntries: string[];
}

const DEFAULTS = {
  engine: "figma-rest",
  registryPath: ".design-sync/registry.json",
  cssEntries: ["src/**/*.css"],
} as const;

const CANDIDATES = [
  "design-sync.config.json",
  "design-sync.config.ts",
];

export async function loadConfig(cwd: string = process.cwd()): Promise<DesignSyncConfig> {
  for (const name of CANDIDATES) {
    const full = resolve(cwd, name);
    try {
      if (name.endsWith(".json")) {
        const raw = await readFile(full, "utf8");
        return normalize(JSON.parse(raw));
      }
      const mod = await import(full);
      return normalize(mod.default ?? mod);
    } catch (err: unknown) {
      if (isNotFound(err)) continue;
      throw err;
    }
  }
  throw new Error(
    `[design-sync] No config found. Add design-sync.config.json at ${cwd}.`,
  );
}

function normalize(raw: unknown): DesignSyncConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error("[design-sync] Config must be an object.");
  }
  const r = raw as Partial<DesignSyncConfig>;
  if (!r.fileKey) throw new Error("[design-sync] Config: `fileKey` is required.");
  return {
    engine: r.engine ?? DEFAULTS.engine,
    registryPath: r.registryPath ?? DEFAULTS.registryPath,
    fileKey: r.fileKey,
    cssEntries: r.cssEntries ?? [...DEFAULTS.cssEntries],
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
