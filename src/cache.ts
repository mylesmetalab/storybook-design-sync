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
 *  - **5** (v0.0.41): entries written before issue #73 was fixed can be *partial
 *    passes* — a story whose child nodes 429'd was stored with `status: done` and
 *    a footnote, and replayed on every subsequent run, so the only recovery was
 *    deleting this file by hand. Those entries are indistinguishable from real
 *    ones by inspection (the missing children left no trace in the report's
 *    dimensions), so the whole generation is dropped. `set` now refuses a report
 *    marked `incomplete`, which is what stops new ones being written.
 *  - **4** (v0.0.40): three changes to which rows exist at all. Typography,
 *    `color` and `copy` are no longer compared on an element that owns no text; a
 *    TEXT node no longer gets a `background-color` row; and a fill delivered by a
 *    shared paint style carries a `sourceAdvisory` (and, when its paint is
 *    unreadable, `unresolved`). A v0.0.39 entry replays twelve fabricated rows per
 *    Card story and a guaranteed-drift `background-color` on every bound TEXT
 *    node, which is the report this release exists to stop producing.
 *  - **6** (v0.0.43): every entry a **Check all** wrote before issue #80 was
 *    fixed rests on a request that carried none of the story's context — no
 *    `args`, so no `cva()` variant resolution; no `target`, so no CSS-scanner
 *    bindings and a story root found by fallback. Those reports are real reports
 *    of the wrong thing (three fewer matches and an extra unresolved binding per
 *    button variant in the consumer we measured), and only a `Check drift` on the
 *    same story would ever have overwritten one. Explicit entries are unaffected,
 *    but nothing in a stored entry says which trigger wrote it, so the generation
 *    goes as a whole.
 */
export const CACHE_VERSION = 6;

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
  /**
   * Entries found on disk and thrown away because an older addon wrote them.
   * Counted rather than discarded silently: a version-mismatch wipe and a genuine
   * cold start produce identical panels, and telling them apart is the whole of
   * issue #62's second half. Read once by the first report after a load, so the
   * number appears where a user is looking.
   */
  private discardedByVersion = 0;
  /** Reports `set` refused to persist, with the reason (issue #73). */
  private lastRefusal: string | undefined;

  constructor(private readonly cachePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.cachePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<CacheFile>;
      if (parsed.version === CACHE_VERSION && typeof parsed.fileLastModified === "string" && parsed.stories) {
        this.cache = parsed as CacheFile;
      } else if (parsed.stories && typeof parsed.stories === "object") {
        // A readable cache from a different schema generation. Dropping it is
        // correct — its verdicts were produced under other rules — but doing it
        // without a word is how a stale baseline survives an upgrade.
        this.discardedByVersion = Object.keys(parsed.stories).length;
      }
    } catch {
      // File missing or unreadable — start fresh.
    }
    this.loaded = true;
  }

  /**
   * How many entries the last `load` discarded on a version mismatch, and
   * whether the most recent `set` was refused. Reported on the DriftReport so it
   * reaches the panel; see `CacheStatus`.
   */
  status(): { discardedByVersion: number; notPersisted?: string } {
    return this.lastRefusal === undefined
      ? { discardedByVersion: this.discardedByVersion }
      : { discardedByVersion: this.discardedByVersion, notPersisted: this.lastRefusal };
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
   *
   * **Refuses any report marked `incomplete`** (issue #73). A story whose child
   * nodes 429'd used to be written here with `status: done` and a footnote, which
   * made a transient rate limit permanent: every later run hit the cache, replayed
   * the partial result, never retried the failed fetches, and only deleting
   * `.design-sync/cache.json` by hand recovered. A result that rests on data we
   * could not read is not a result to remember — the next run must go and look
   * again. Returns whether it stored anything, so callers can say what happened.
   */
  set(
    storyId: string,
    fileLastModified: string,
    snapshot: CodeSnapshot | undefined,
    report: DriftReport,
    children?: readonly ChildTarget[] | undefined,
    configSignature?: string | undefined,
  ): boolean {
    if (report.incomplete) {
      this.lastRefusal =
        `Not cached — ${report.incomplete.reason}. The next run will retry ` +
        `instead of replaying this result.`;
      return false;
    }
    this.lastRefusal = undefined;
    if (this.cache.fileLastModified !== fileLastModified) {
      this.cache = { version: CACHE_VERSION, fileLastModified, stories: {} };
    }
    this.cache.stories[storyId] = {
      snapshotHash: hashSnapshot(snapshot, children, configSignature),
      report,
    };
    this.dirty = true;
    this.scheduleWrite();
    return true;
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
