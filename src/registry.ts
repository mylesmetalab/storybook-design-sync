import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface RegistryEntry {
  /** Figma node id, or null for a stub "pending" entry. */
  nodeId: string | null;
  lastSyncedHash: string | null;
  /** Set to "pending" when the story is known but its Figma binding is
   *  intentionally absent. Server skips drift checks for these. */
  status?: "pending";
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

export async function saveRegistry(
  registryPath: string,
  registry: Registry,
  cwd: string = process.cwd(),
): Promise<void> {
  const full = resolve(cwd, registryPath);
  await mkdir(dirname(full), { recursive: true });
  const sorted: Registry = {
    fileKey: registry.fileKey,
    stories: Object.fromEntries(
      Object.keys(registry.stories)
        .sort()
        .map((k) => [k, registry.stories[k]!]),
    ),
  };
  await writeFile(full, JSON.stringify(sorted, null, 2) + "\n", "utf8");
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

export function isPending(entry: RegistryEntry | undefined): boolean {
  if (!entry) return false;
  return entry.status === "pending" || entry.nodeId === null;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
