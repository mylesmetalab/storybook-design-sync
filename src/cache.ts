import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { DriftReport } from "./dimensions/types.js";
import type { CodeSnapshot } from "./engines/types.js";

/**
 * Persistent drift-report cache. Sidecar JSON at `.design-sync/cache.json`
 * (gitignored). Lets the engine skip work when neither the Figma file nor
 * the rendered code snapshot has changed since the last successful check.
 *
 * This is the "what Baluarte does with SQLite, narrower" — same goal
 * (don't re-do work the upstream hasn't invalidated), simpler shape (a
 * flat key-value map keyed by storyId, no querying).
 *
 * Schema:
 *   - `fileLastModified`: from Figma's file metadata. Whole-file invalidator;
 *     when it changes, every story entry becomes stale at once (we can't
 *     know which nodes changed without re-fetching).
 *   - `stories[storyId]`: per-story snapshot hash + the cached DriftReport.
 *     Invalidated when the snapshot (rendered DOM) changes for that story.
 *
 * Both must match for a cache hit.
 */

export interface CacheFile {
  version: 1;
  fileLastModified: string;
  stories: Record<string, CacheEntry>;
}

export interface CacheEntry {
  snapshotHash: string;
  report: DriftReport;
}

const EMPTY_CACHE: CacheFile = {
  version: 1,
  fileLastModified: "",
  stories: {},
};

export class PersistentCache {
  private cache: CacheFile = { ...EMPTY_CACHE };
  private loaded = false;
  private dirty = false;
  /** Debounce concurrent writes — bulk runs hit cache.set N times in a few seconds. */
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(private readonly cachePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<CacheFile>;
      if (parsed.version === 1 && typeof parsed.fileLastModified === "string" && parsed.stories) {
        this.cache = parsed as CacheFile;
      }
    } catch {
      // File missing or unreadable — start fresh.
    }
    this.loaded = true;
  }

  /**
   * Look up a cached DriftReport. Returns null if any of:
   *   - cache file isn't loaded
   *   - file's lastModified has changed (invalidates everything)
   *   - no entry for this storyId
   *   - snapshot hash doesn't match
   */
  get(storyId: string, fileLastModified: string, snapshot: CodeSnapshot | undefined): DriftReport | null {
    if (!this.loaded) return null;
    if (!fileLastModified || this.cache.fileLastModified !== fileLastModified) return null;
    const entry = this.cache.stories[storyId];
    if (!entry) return null;
    const currentHash = hashSnapshot(snapshot);
    if (entry.snapshotHash !== currentHash) return null;
    return entry.report;
  }

  /**
   * Store a DriftReport. If `fileLastModified` differs from what's cached,
   * everything else is wiped — the file changed, every story is potentially
   * stale.
   */
  set(storyId: string, fileLastModified: string, snapshot: CodeSnapshot | undefined, report: DriftReport): void {
    if (this.cache.fileLastModified !== fileLastModified) {
      this.cache = { version: 1, fileLastModified, stories: {} };
    }
    this.cache.stories[storyId] = {
      snapshotHash: hashSnapshot(snapshot),
      report,
    };
    this.dirty = true;
    this.scheduleWrite();
  }

  /** Force a synchronous flush. Useful in tests; not normally called. */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.dirty) return;
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(this.cache, null, 2) + "\n", "utf8");
    this.dirty = false;
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, 500);
  }
}

/**
 * SHA-1 of the snapshot's stable serialization. Fast enough that we don't
 * mind hashing on every check.
 */
function hashSnapshot(snapshot: CodeSnapshot | undefined): string {
  if (!snapshot) return "no-snapshot";
  // Recursively sort keys so the serialization is stable regardless of the
  // insertion order the snapshot is built in. We previously passed
  // `Object.keys(snapshot).sort()` as the second arg, but that's an *allowlist*
  // applied at every level — nested keys (e.g. CSS prop names inside
  // `bindings`) didn't appear in the allowlist and were silently dropped from
  // the hash. Result: changing tokens didn't bust the cache, and every check
  // reused a stale "no bindings declared" report.
  const stable = JSON.stringify(snapshot, (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.keys(value)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (value as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return value;
  });
  return createHash("sha1").update(stable).digest("hex");
}
