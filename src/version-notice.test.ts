import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  cacheNoticeText,
  staleVersionMessage,
  versionIsStale,
  versionLabel,
} from "./version-notice.js";
import { installedVersion, loadedVersion, versionInfo } from "./addon-version.js";

/**
 * Issue #62: a running Storybook keeps serving the bundle it started with, so the
 * panel reported v0.0.39's rows against a v0.0.40 checkout for an hour —
 * `package.json` 40, `node_modules` 40, panel 39, and nothing in the UI to say so.
 * The only tell was `"version": 3` in `.design-sync/cache.json`. It cost a wrong
 * baseline and nearly a duplicate fix for three already-fixed bugs.
 */

describe("the running version reaches the panel", () => {
  it("reads the addon's own package.json", async () => {
    const version = await loadedVersion();
    const raw = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(version).toBe(raw.version);
  });

  it("reports the loaded and installed versions together", async () => {
    const info = await versionInfo();
    expect(info.loaded).toBeDefined();
    expect(info.installed).toBe(await installedVersion());
    // Nothing changed on disk during this test, so they agree.
    expect(info.stale).toBe(false);
  });

  it("renders as a `v`-prefixed label, and as nothing when unknown", () => {
    expect(versionLabel("0.0.41")).toBe("v0.0.41");
    expect(versionLabel(undefined)).toBe("");
  });
});

describe("a version mismatch banners", () => {
  it("is stale only when both versions are known and differ", () => {
    expect(versionIsStale("0.0.39", "0.0.40")).toBe(true);
    expect(versionIsStale("0.0.40", "0.0.40")).toBe(false);
  });

  it("treats unknown as not stale", () => {
    // A missing version is a gap in what we can report, not evidence of a
    // mismatch. Banner-ing on it would train users to ignore the banner.
    expect(versionIsStale(undefined, "0.0.40")).toBe(false);
    expect(versionIsStale("0.0.40", undefined)).toBe(false);
    expect(versionIsStale(undefined, undefined)).toBe(false);
  });

  it("says what is running, what it means, and the one action that fixes it", () => {
    const message = staleVersionMessage("0.0.39", "0.0.40");
    expect(message).toContain("v0.0.39");
    expect(message).toContain("v0.0.40");
    expect(message).toContain("Restart Storybook");
    // The consequence, not just the fact — this is the sentence that would have
    // saved the wrong baseline.
    expect(message).toContain("on screen");
    expect(message).toContain("node_modules/.cache/storybook");
  });
});

describe("the cache stops being silent about what it threw away", () => {
  it("reports a version-mismatch discard with its count", () => {
    expect(cacheNoticeText({ discardedByVersion: 21 })).toBe(
      "discarded 21 entries written by an older version",
    );
  });

  it("gets the singular right", () => {
    expect(cacheNoticeText({ discardedByVersion: 1 })).toContain("1 entry");
  });

  it("reports a refusal to persist", () => {
    expect(cacheNoticeText({ notPersisted: "Not cached — rate limited by Figma." })).toContain(
      "Not cached",
    );
  });

  it("reports both at once", () => {
    const text = cacheNoticeText({ discardedByVersion: 3, notPersisted: "Not cached — x." });
    expect(text).toContain("discarded 3");
    expect(text).toContain("Not cached");
  });

  it("says nothing when there is nothing to say", () => {
    // A warm, valid cache and a complete report must read exactly as before.
    expect(cacheNoticeText(undefined)).toBeNull();
    expect(cacheNoticeText({})).toBeNull();
    expect(cacheNoticeText({ discardedByVersion: 0 })).toBeNull();
  });
});
