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
  let raw: string;
  try {
    raw = await readFile(full, "utf8");
  } catch (err: unknown) {
    if (isNotFound(err)) {
      // No registry yet is a legitimate starting state (every story simply
      // reports "Not registered"). fileKey falls back to the config's.
      return { fileKey: "", stories: {} };
    }
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`[design-sync] registry failed to load: ${m} at ${full}`);
  }
  // Parse/shape errors must NOT be swallowed into an empty registry — that
  // silently reports every story as unregistered. Rethrow with the path so
  // the panel can show an actionable message.
  try {
    return normalize(JSON.parse(raw));
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`[design-sync] registry.json failed to parse: ${m} at ${full}`);
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
