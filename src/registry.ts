import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface RegistryEntry {
  nodeId: string;
  lastSyncedHash: string | null;
}

export interface Registry {
  fileKey: string;
  stories: Record<string, RegistryEntry>;
}

export async function loadRegistry(
  registryPath: string,
  cwd: string = process.cwd(),
): Promise<Registry> {
  const full = resolve(cwd, registryPath);
  try {
    const raw = await readFile(full, "utf8");
    const parsed = JSON.parse(raw);
    return normalize(parsed);
  } catch (err: unknown) {
    if (isNotFound(err)) {
      return { fileKey: "", stories: {} };
    }
    throw err;
  }
}

function normalize(raw: unknown): Registry {
  if (!raw || typeof raw !== "object") {
    throw new Error("[design-sync] Registry must be an object.");
  }
  const r = raw as Partial<Registry>;
  return {
    fileKey: r.fileKey ?? "",
    stories: r.stories ?? {},
  };
}

export function lookup(registry: Registry, storyId: string): RegistryEntry | undefined {
  return registry.stories[storyId];
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
