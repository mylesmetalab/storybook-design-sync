import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_VERSION, PersistentCache } from "./cache.js";
import type { ChildTarget, CodeSnapshot } from "./engines/types.js";
import type { DriftReport } from "./dimensions/types.js";

/**
 * Cache invalidation for declared child bindings.
 *
 * The persistent cache keys a stored `DriftReport` on (file lastModified,
 * storyId, snapshot hash). Once the comparison covers child elements too, the
 * hash MUST cover them: otherwise editing a child's CSS leaves the root snapshot
 * untouched, the hash matches, and the next check replays a report describing a
 * component that no longer exists — a stale green.
 *
 * The v0.0.34 `rootClasses` addition was covered for free because `hashSnapshot`
 * serialises the whole snapshot object recursively. Child snapshots are NOT
 * inside that object (they arrive as a sibling list), so the mechanism did NOT
 * cover them, and these tests pin the fix.
 */

const LAST_MODIFIED = "2026-07-28T00:00:00Z";
const STORY = "ui-card--default";

const dirs: string[] = [];

async function freshCache(): Promise<PersistentCache> {
  const dir = await mkdtemp(join(tmpdir(), "design-sync-cache-"));
  dirs.push(dir);
  const cache = new PersistentCache(join(dir, "cache.json"));
  await cache.load();
  return cache;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const rootSnapshot: CodeSnapshot = { styles: { "padding-top": "16px" } };

function report(): DriftReport {
  return {
    storyId: STORY,
    nodeId: "2142:11380",
    dimensions: [],
    generatedAt: new Date().toISOString(),
  };
}

const child = (paddingTop: string, nodeId = "2142:11381"): ChildTarget => ({
  selector: "[data-slot=header]",
  nodeId,
  snapshot: { styles: { "padding-top": paddingTop } },
});

describe("PersistentCache — declared child bindings participate in the hash", () => {
  it("hits when the root snapshot and the children are both unchanged", async () => {
    const cache = await freshCache();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report(), [child("16px")]);

    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, [child("16px")])).not.toBeNull();
  });

  it("MISSES when a child's computed styles change but the root's do not", async () => {
    const cache = await freshCache();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report(), [child("16px")]);

    // The root snapshot is byte-identical; only the child moved.
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, [child("8px")])).toBeNull();
  });

  it("MISSES when a child binding is added to a previously childless story", async () => {
    const cache = await freshCache();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report());

    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, [child("16px")])).toBeNull();
  });

  it("MISSES when a child binding is removed", async () => {
    const cache = await freshCache();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report(), [child("16px")]);

    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, [])).toBeNull();
  });

  it("MISSES when a child is re-pointed at a different Figma node", async () => {
    const cache = await freshCache();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report(), [child("16px", "2142:11381")]);

    expect(
      cache.get(STORY, LAST_MODIFIED, rootSnapshot, [child("16px", "2142:99999")]),
    ).toBeNull();
  });

  it("MISSES when a selector is renamed to point at a different element", async () => {
    const cache = await freshCache();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report(), [child("16px")]);

    expect(
      cache.get(STORY, LAST_MODIFIED, rootSnapshot, [
        { ...child("16px"), selector: "[data-slot=body]" },
      ]),
    ).toBeNull();
  });

  it("MISSES when a child's resolution problem appears or clears", async () => {
    const cache = await freshCache();
    const problem: ChildTarget = {
      selector: "[data-slot=header]",
      nodeId: "2142:11381",
      problem: { status: "selector-not-found", message: "Not compared — …" },
    };
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report(), [problem]);

    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, [child("16px")])).toBeNull();
  });

  it("is insensitive to child key insertion order — no spurious misses", async () => {
    const cache = await freshCache();
    const a: ChildTarget = {
      selector: "[data-slot=header]",
      nodeId: "2142:11381",
      snapshot: { styles: { "padding-top": "16px" }, bindings: { "padding-top": "space-400" } },
    };
    const b: ChildTarget = {
      selector: "[data-slot=header]",
      nodeId: "2142:11381",
      // Same data, keys built in the other order.
      snapshot: { bindings: { "padding-top": "space-400" }, styles: { "padding-top": "16px" } },
    };
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report(), [a]);

    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, [b])).not.toBeNull();
  });

  it("keeps the legacy hash for a childless story, so no upgrade-time mass miss", async () => {
    const cache = await freshCache();
    // Written by the previous release's code path (positional call, no children).
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report());

    // Read by the new code path, both with an omitted and an empty children list.
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot)).not.toBeNull();
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, [])).not.toBeNull();
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, undefined)).not.toBeNull();
  });

  it("still invalidates on the pre-existing triggers", async () => {
    const cache = await freshCache();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report(), [child("16px")]);

    // Figma file changed.
    expect(cache.get(STORY, "2026-07-29T00:00:00Z", rootSnapshot, [child("16px")])).toBeNull();
    // Root snapshot changed.
    expect(
      cache.get(STORY, LAST_MODIFIED, { styles: { "padding-top": "4px" } }, [child("16px")]),
    ).toBeNull();
    // Different story.
    expect(cache.get("ui-card--compact", LAST_MODIFIED, rootSnapshot, [child("16px")])).toBeNull();
  });

  it("covers `rootClasses` too — the v0.0.34 field this mechanism already handled", async () => {
    const cache = await freshCache();
    const withClasses: CodeSnapshot = { ...rootSnapshot, rootClasses: ["card"] };
    cache.set(STORY, LAST_MODIFIED, withClasses, report());

    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot)).toBeNull();
    expect(cache.get(STORY, LAST_MODIFIED, withClasses)).not.toBeNull();
  });
});

/**
 * `tokenAliases` changes a report's *verdicts* without changing any of its inputs
 * (v0.0.38). Neither the Figma file's `lastModified` nor the DOM snapshot moves
 * when someone edits `design-sync.config.json`, so without the config signature in
 * the hash, adding the alias that turns 80 false drift rows into advisories would
 * leave a bulk run replaying the pre-alias report — and still calling them drift.
 */
describe("PersistentCache — config that changes verdicts is part of the identity", () => {
  const aliasSig = "color-background-brand-default=primary";

  it("misses when the alias signature changes", async () => {
    const cache = await freshCache();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report(), undefined, aliasSig);

    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, undefined, aliasSig)).not.toBeNull();
    // Alias removed…
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, undefined, "")).toBeNull();
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot)).toBeNull();
    // …or changed.
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, undefined, "space-150=spacing-lg")).toBeNull();
  });

  it("leaves the hash byte-identical for consumers with no aliases", async () => {
    // No signature must mean no change to existing cache behaviour: an upgraded
    // addon should not miss on every story just for having the capability.
    const cache = await freshCache();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report());
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, undefined, "")).not.toBeNull();
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, undefined, undefined)).not.toBeNull();
  });

  it("still covers children alongside the signature", async () => {
    const cache = await freshCache();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report(), [child("16px")], aliasSig);
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, [child("16px")], aliasSig)).not.toBeNull();
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot, [child("4px")], aliasSig)).toBeNull();
  });
});

describe("CACHE_VERSION — verdicts written by older rules are discarded", () => {
  it("ignores a cache file from a previous schema version", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-sync-cache-"));
    dirs.push(dir);
    const path = join(dir, "cache.json");
    // A v3 file, as written by v0.0.39. Its rows predate the text-ownership,
    // TEXT-background and paint-style rules, so serving it would replay twelve
    // fabricated typography/colour/copy rows per Card story and a
    // guaranteed-drift `background-color` on every bound TEXT node.
    await writeFile(
      path,
      JSON.stringify({
        version: 3,
        fileLastModified: LAST_MODIFIED,
        stories: { [STORY]: { snapshotHash: "whatever", report: report() } },
      }),
      "utf8",
    );
    const cache = new PersistentCache(path);
    await cache.load();
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot)).toBeNull();
    // v0.0.44 (#76): entries written before reports carried `source` cannot tell a
    // fix prompt when their Figma values were read, so a prompt built from one can
    // only report the read time as unknown — indefinitely, since nothing but a
    // `lastModified` move would replace the entry.
    expect(CACHE_VERSION).toBe(7);
  });

  /**
   * Issue #62: `load()` dropped a mismatched cache without a word, and a silent
   * wipe is indistinguishable from a clean cold run. It cost a wrong baseline —
   * a panel reporting an older version's rows for an hour, with the only tell
   * being `"version": 3` inside a file no designer opens.
   */
  it("reports how many entries it discarded, so a wipe is not silent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-sync-cache-"));
    dirs.push(dir);
    const path = join(dir, "cache.json");
    await writeFile(
      path,
      JSON.stringify({
        version: CACHE_VERSION - 1,
        fileLastModified: LAST_MODIFIED,
        stories: {
          "ui-card--a": { snapshotHash: "x", report: report() },
          "ui-card--b": { snapshotHash: "y", report: report() },
          "ui-card--c": { snapshotHash: "z", report: report() },
        },
      }),
      "utf8",
    );
    const cache = new PersistentCache(path);
    await cache.load();
    expect(cache.status().discardedByVersion).toBe(3);
  });

  it("reports zero discards on a genuine cold start", async () => {
    const cache = await freshCache();
    expect(cache.status().discardedByVersion).toBe(0);
    expect(cache.status().notPersisted).toBeUndefined();
  });

  it("reports zero discards when the file is current", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-sync-cache-"));
    dirs.push(dir);
    const path = join(dir, "cache.json");
    await writeFile(
      path,
      JSON.stringify({
        version: CACHE_VERSION,
        fileLastModified: LAST_MODIFIED,
        stories: { [STORY]: { snapshotHash: "x", report: report() } },
      }),
      "utf8",
    );
    const cache = new PersistentCache(path);
    await cache.load();
    expect(cache.status().discardedByVersion).toBe(0);
  });
});

/**
 * Issue #73. A story whose child nodes 429'd was stored `status: done` with a
 * footnote and replayed forever: `generatedAt` frozen, byte-identical totals on
 * every re-run, and no recovery short of deleting the file by hand.
 *
 * The engine marks such a report `incomplete`; the cache's job is to refuse it.
 */
describe("PersistentCache — a result that rests on unread data is never persisted", () => {
  const incompleteReport = (): DriftReport => ({
    ...report(),
    incomplete: {
      reason: "5 child bindings could not be read from Figma (rate limited)",
      targets: ["[data-slot=header]"],
      detail: "Rate limited by Figma (HTTP 429) — retry in 12s.",
    },
  });

  it("refuses to store an incomplete report", async () => {
    const cache = await freshCache();
    expect(cache.set(STORY, LAST_MODIFIED, rootSnapshot, incompleteReport())).toBe(false);
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot)).toBeNull();
  });

  it("says why it refused, so the panel can show it", async () => {
    const cache = await freshCache();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, incompleteReport());
    expect(cache.status().notPersisted).toContain("rate limited");
    expect(cache.status().notPersisted).toContain("retry");
  });

  it("does not evict a previously good entry when it refuses", async () => {
    const cache = await freshCache();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, report());
    cache.set("ui-card--other", LAST_MODIFIED, rootSnapshot, incompleteReport());
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot)).not.toBeNull();
  });

  it("writes nothing to disk for an incomplete-only run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-sync-cache-"));
    dirs.push(dir);
    const path = join(dir, "cache.json");
    const cache = new PersistentCache(path);
    await cache.load();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, incompleteReport());
    await cache.flush();
    // Nothing was stored, so re-loading finds no entry to replay.
    const reloaded = new PersistentCache(path);
    await reloaded.load();
    expect(reloaded.get(STORY, LAST_MODIFIED, rootSnapshot)).toBeNull();
  });

  it("still stores a complete report, and clears the refusal note", async () => {
    const cache = await freshCache();
    cache.set(STORY, LAST_MODIFIED, rootSnapshot, incompleteReport());
    expect(cache.set(STORY, LAST_MODIFIED, rootSnapshot, report())).toBe(true);
    expect(cache.get(STORY, LAST_MODIFIED, rootSnapshot)).not.toBeNull();
    expect(cache.status().notPersisted).toBeUndefined();
  });
});
