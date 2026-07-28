import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { DriftReport } from "./dimensions/types.js";
import type { ChildTarget, CodeSnapshot } from "./engines/types.js";

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

/**
 * Schema version. Bump whenever an upgrade changes what a report *contains* or
 * what its verdicts *mean*, because a cache hit serves the old report verbatim
 * until the Figma file's `lastModified` happens to move.
 *
 *  - **2** (v0.0.38): a name-only binding divergence became an `advisory` rather
 *    than `drift` (issue #57). Entries written under the old rules kept reporting
 *    89 drift on a clean component.
 *  - **3** (v0.0.39): reports gained `structure` (auto-layout) and `opacity`
 *    comparisons. A v0.0.38 entry has neither, so a Card whose Figma direction
 *    is Vertical while the code lays out in a row would keep reporting clean off
 *    the cache — exactly the silent false-clean this release exists to remove.
 */
export const CACHE_VERSION = 3;

export interface CacheFile {
  version: typeof CACHE_VERSION;
  fileLastModified: string;
  stories: Record<string, CacheEntry>;
}

export interface CacheEntry {
  snapshotHash: string;
  report: DriftReport;
}

const EMPTY_CACHE: CacheFile = {
  version: CACHE_VERSION,
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
      if (parsed.version === CACHE_VERSION && typeof parsed.fileLastModified === "string" && parsed.stories) {
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
  get(
    storyId: string,
    fileLastModified: string,
    snapshot: CodeSnapshot | undefined,
    children?: readonly ChildTarget[] | undefined,
    configSignature?: string | undefined,
  ): DriftReport | null {
    if (!this.loaded) return null;
    if (!fileLastModified || this.cache.fileLastModified !== fileLastModified) return null;
    const entry = this.cache.stories[storyId];
    if (!entry) return null;
    const currentHash = hashSnapshot(snapshot, children, configSignature);
    if (entry.snapshotHash !== currentHash) return null;
    return entry.report;
  }

  /**
   * Store a DriftReport. If `fileLastModified` differs from what's cached,
   * everything else is wiped — the file changed, every story is potentially
   * stale.
   */
  set(
    storyId: string,
    fileLastModified: string,
    snapshot: CodeSnapshot | undefined,
    report: DriftReport,
    children?: readonly ChildTarget[] | undefined,
    configSignature?: string | undefined,
  ): void {
    if (this.cache.fileLastModified !== fileLastModified) {
      this.cache = { version: CACHE_VERSION, fileLastModified, stories: {} };
    }
    this.cache.stories[storyId] = {
      snapshotHash: hashSnapshot(snapshot, children, configSignature),
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
 *
 * Declared child bindings participate in the hash: the comparison now covers
 * child elements too, so a change to a child's computed styles (or to which
 * selectors are declared, or to which Figma node one points at) MUST invalidate
 * the cached report — otherwise a re-check would replay a report that describes
 * a component that no longer exists.
 *
 * `configSignature` covers config that changes a report's *verdicts* rather than
 * its inputs — today only `tokenAliases` (v0.0.38). Neither the Figma file's
 * `lastModified` nor the DOM snapshot moves when someone edits
 * `design-sync.config.json`, so without it a bulk run would keep replaying the
 * pre-alias report and calling a reconciled name divergence drift.
 *
 * When there are no children and no config signature the hash is computed over
 * the bare snapshot exactly as before, so legacy entries keep hitting their
 * existing cache instead of all missing once on upgrade.
 */
function hashSnapshot(
  snapshot: CodeSnapshot | undefined,
  children?: readonly ChildTarget[] | undefined,
  configSignature?: string | undefined,
): string {
  const config = configSignature ?? "";
  if (config !== "") {
    return sha1(
      stableStringify({ snapshot: snapshot ?? null, children: children ?? null, config }),
    );
  }
  if (children && children.length > 0) {
    return sha1(stableStringify({ snapshot: snapshot ?? null, children }));
  }
  if (!snapshot) return "no-snapshot";
  return sha1(stableStringify(snapshot));
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function stableStringify(input: unknown): string {
  // Recursively sort keys so the serialization is stable regardless of the
  // insertion order the snapshot is built in. We previously passed
  // `Object.keys(snapshot).sort()` as the second arg, but that's an *allowlist*
  // applied at every level — nested keys (e.g. CSS prop names inside
  // `bindings`) didn't appear in the allowlist and were silently dropped from
  // the hash. Result: changing tokens didn't bust the cache, and every check
  // reused a stale "no bindings declared" report.
  return JSON.stringify(input, (_key, value) => {
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
}
