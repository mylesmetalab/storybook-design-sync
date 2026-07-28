import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanCss } from "./scan-css.js";

/**
 * Issue #46 — the ignore list used to override explicit `cssEntries`.
 *
 * `scanCss` applied `**\/dist\/**` and `**\/storybook-static\/**`
 * unconditionally, so a consumer who pointed `cssEntries` at built CSS got
 * `{ scannedFiles: [], map: {}, warnings: [] }`: a scanner that derived
 * nothing, a panel that reported clean, and not one word about why. Zero
 * warnings made it indistinguishable from "your CSS declares no token
 * bindings".
 *
 * The contract these tests pin down:
 *
 *  1. An entry that **names** a default-ignored directory wins — explicit
 *     configuration beats a default.
 *  2. A broad glob that merely *happens* to reach one still skips it, but says
 *     so, per directory, with the remedy — never silently.
 *  3. `node_modules` stays unconditional and silent (nobody's `cssEntries` is
 *     a request to scan their dependencies' CSS).
 */

const dirs: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "design-sync-scan-css-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const BUILT = ".button { background-color: var(--color-brand); }";
const SOURCE = ".card { gap: var(--space-8); }";
const VENDOR = ".vendor { color: var(--vendor-ink); }";

describe("scanCss — explicit cssEntries beat the default ignore list (#46)", () => {
  it("scans storybook-static when the entry names it", async () => {
    const dir = await fixture({ "storybook-static/assets/built.css": BUILT });

    const result = await scanCss(dir, ["storybook-static/**/*.css"]);

    expect(result.scannedFiles).toHaveLength(1);
    expect(result.map).toEqual({ ".button": { "background-color": "color-brand" } });
    // Nothing was suppressed, so nothing is reported as suppressed.
    expect(result.skipped).toEqual([]);
  });

  it("scans dist when the entry names it", async () => {
    const dir = await fixture({ "dist/lib.css": BUILT });

    const result = await scanCss(dir, ["dist/**/*.css"]);

    expect(result.scannedFiles).toHaveLength(1);
    expect(result.map[".button"]).toBeDefined();
    expect(result.skipped).toEqual([]);
  });

  it("keeps the default ignores for the entries that did NOT name them", async () => {
    // One entry opts into `dist`; the other is the ordinary source glob. The
    // opt-in must not leak — a `src/**` entry does not become permission to
    // scan a nested build output.
    const dir = await fixture({
      "dist/lib.css": BUILT,
      "src/app.css": SOURCE,
      "src/vendored/dist/oops.css": VENDOR,
    });

    const result = await scanCss(dir, ["dist/**/*.css", "src/**/*.css"]);

    expect(Object.keys(result.map).sort()).toEqual([".button", ".card"]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ directory: "dist", count: 1, entries: ["src/**/*.css"] }),
    ]);
  });

  it("resolves an entry that names the directory with a leading ./", async () => {
    const dir = await fixture({ "storybook-static/assets/built.css": BUILT });

    const result = await scanCss(dir, ["./storybook-static/**/*.css"]);

    expect(result.scannedFiles).toHaveLength(1);
  });
});

describe("scanCss — anything still skipped is reported, never silent (#46)", () => {
  it("reports what a broad glob reached but the defaults suppressed", async () => {
    const dir = await fixture({
      "src/app.css": SOURCE,
      "dist/lib.css": BUILT,
      "storybook-static/assets/a.css": BUILT,
      "storybook-static/assets/b.css": BUILT,
    });

    const result = await scanCss(dir, ["**/*.css"]);

    // The glob is honoured for everything not under a default-ignored dir.
    expect(Object.keys(result.map)).toEqual([".card"]);
    // …and the three files it did reach are named as skipped, per directory,
    // with the entry that reached them and the fix.
    expect(result.skipped).toEqual([
      expect.objectContaining({ directory: "dist", count: 1, entries: ["**/*.css"] }),
      expect.objectContaining({ directory: "storybook-static", count: 2, entries: ["**/*.css"] }),
    ]);
    for (const skipped of result.skipped) {
      expect(skipped.examples.length).toBeGreaterThan(0);
      expect(skipped.message).toContain("name it explicitly");
    }
  });

  it("caps the examples so a large build output can't drown the log", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`dist/chunk-${i}.css`] = BUILT;

    const result = await scanCss(await fixture(files), ["**/*.css"]);

    expect(result.skipped[0]).toMatchObject({ directory: "dist", count: 12 });
    expect(result.skipped[0]!.examples).toHaveLength(3);
  });

  it("keeps node_modules unconditional and silent", async () => {
    const dir = await fixture({
      "src/app.css": SOURCE,
      "node_modules/pkg/vendor.css": VENDOR,
    });

    // Even when the entry names it outright.
    const named = await scanCss(dir, ["node_modules/**/*.css"]);
    expect(named.scannedFiles).toEqual([]);
    expect(named.skipped).toEqual([]);

    const broad = await scanCss(dir, ["**/*.css"]);
    expect(Object.keys(broad.map)).toEqual([".card"]);
    expect(broad.skipped).toEqual([]);
  });

  it("honours negative patterns while opting a directory in", async () => {
    const dir = await fixture({
      "storybook-static/assets/keep.css": BUILT,
      "storybook-static/assets/skip.css": SOURCE,
    });

    const result = await scanCss(dir, ["storybook-static/**/*.css", "!**/skip.css"]);

    expect(result.scannedFiles).toHaveLength(1);
    expect(Object.keys(result.map)).toEqual([".button"]);
  });
});
