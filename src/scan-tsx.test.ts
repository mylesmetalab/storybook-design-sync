import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanTsx } from "./scan-tsx.js";

/**
 * Issue #60 — the same defect as #46, one scanner over.
 *
 * `scanTsx` applied `**\/dist\/**` and `**\/storybook-static\/**`
 * unconditionally to `tsxEntries`, so a consumer whose components live under an
 * ignored path got zero bindings, a panel that reported clean, and nothing said
 * why. This version bites harder than #46's: on a Tailwind / shadcn / cva stack
 * `tsxEntries` is what carries the bindings (`cssEntries` only supplies the
 * `@theme` block), so the whole declared-binding dimension empties out.
 *
 * The contract, identical to #46's by design — the two scanners must not have
 * separate answers to the same question:
 *
 *  1. An entry that **names** a default-ignored directory wins.
 *  2. A broad glob that merely reaches one still skips it, but says so, per
 *     directory, with the remedy.
 *  3. `node_modules` stays unconditional and silent.
 *  4. `*.stories.tsx` / `*.test.tsx` stay unconditional and silent — they are
 *     not build output, they are file kinds that are never a binding source.
 */

const dirs: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "design-sync-scan-tsx-"));
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

/** An inline-style binding: the simplest thing the TSX scanner derives. */
const BOUND = `
export const Chip = () => (
  <span className="chip" style={{ paddingTop: "var(--space-4)" }}>hi</span>
);
`;

const OTHER = `
export const Vendor = () => (
  <b className="vendor" style={{ color: "var(--vendor-ink)" }}>x</b>
);
`;

describe("scanTsx — explicit tsxEntries beat the default ignore list (#60)", () => {
  it("scans dist when the entry names it", async () => {
    const dir = await fixture({ "dist/components/chip.tsx": BOUND });

    const result = await scanTsx(dir, ["dist/components/**/*.tsx"]);

    expect(result.scannedFiles).toHaveLength(1);
    expect(result.map).toEqual({ ".chip": { "padding-top": "space-4" } });
    expect(result.skipped).toEqual([]);
  });

  it("scans storybook-static when the entry names it", async () => {
    const dir = await fixture({ "storybook-static/chip.tsx": BOUND });

    const result = await scanTsx(dir, ["storybook-static/**/*.tsx"]);

    expect(result.scannedFiles).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });

  it("tolerates a leading ./ on the opt-in entry", async () => {
    const dir = await fixture({ "dist/chip.tsx": BOUND });

    const result = await scanTsx(dir, ["./dist/**/*.tsx"]);

    expect(result.scannedFiles).toHaveLength(1);
  });

  it("does not let one entry's opt-in leak into another's", async () => {
    const dir = await fixture({
      "dist/chip.tsx": BOUND,
      "src/card.tsx": OTHER,
      "src/vendored/dist/oops.tsx": OTHER,
    });

    const result = await scanTsx(dir, ["dist/**/*.tsx", "src/**/*.tsx"]);

    // `dist/chip.tsx` and `src/card.tsx`, but NOT the nested vendored dist.
    expect(result.scannedFiles).toHaveLength(2);
    expect(result.skipped).toEqual([
      expect.objectContaining({ directory: "dist", count: 1, entries: ["src/**/*.tsx"] }),
    ]);
  });
});

describe("scanTsx — anything still skipped is reported, never silent (#60)", () => {
  it("reports suppressed files per directory, with examples and the remedy", async () => {
    const dir = await fixture({
      "src/card.tsx": OTHER,
      "dist/chip.tsx": BOUND,
      "storybook-static/a.tsx": BOUND,
      "storybook-static/b.tsx": BOUND,
    });

    const result = await scanTsx(dir, ["**/*.tsx"]);

    expect(result.scannedFiles).toHaveLength(1);
    expect(result.skipped).toEqual([
      expect.objectContaining({ directory: "dist", count: 1, entries: ["**/*.tsx"] }),
      expect.objectContaining({ directory: "storybook-static", count: 2, entries: ["**/*.tsx"] }),
    ]);
    for (const skipped of result.skipped) {
      expect(skipped.examples.length).toBeGreaterThan(0);
      expect(skipped.message).toContain("tsxEntries");
      expect(skipped.message).toContain("name it explicitly");
    }
  });

  it("caps examples at three but keeps the true count", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`dist/chunk-${i}.tsx`] = BOUND;
    const dir = await fixture(files);

    const result = await scanTsx(dir, ["**/*.tsx"]);

    expect(result.skipped[0]).toMatchObject({ directory: "dist", count: 12 });
    expect(result.skipped[0]!.examples).toHaveLength(3);
  });
});

describe("scanTsx — unconditional ignores stay unconditional and silent", () => {
  it("never scans node_modules, and never reports it", async () => {
    const dir = await fixture({ "node_modules/pkg/chip.tsx": BOUND });

    const named = await scanTsx(dir, ["node_modules/**/*.tsx"]);
    expect(named.scannedFiles).toEqual([]);
    expect(named.map).toEqual({});
    expect(named.skipped).toEqual([]);
  });

  it("never scans story or test files, even under an entry that names them", async () => {
    const dir = await fixture({
      "src/chip.stories.tsx": BOUND,
      "src/chip.test.tsx": BOUND,
      "src/chip.tsx": BOUND,
    });

    const result = await scanTsx(dir, ["src/**/*.tsx"]);

    expect(result.scannedFiles).toHaveLength(1);
    expect(result.scannedFiles[0]).toContain("chip.tsx");
    // Not build output — a file kind that is never a binding source. Nothing to
    // opt into, so nothing to report.
    expect(result.skipped).toEqual([]);
  });

  it("honours negative patterns inside an opted-in directory", async () => {
    const dir = await fixture({
      "dist/keep.tsx": BOUND,
      "dist/skip.tsx": OTHER,
    });

    const result = await scanTsx(dir, ["dist/**/*.tsx", "!**/skip.tsx"]);

    expect(result.scannedFiles).toHaveLength(1);
    expect(result.scannedFiles[0]).toContain("keep.tsx");
  });
});

/**
 * Source-level guard. #60 existed because the rule was written twice and one copy
 * never got #46's fix — so the regression to prevent is not a behaviour, it is a
 * second copy of the rule appearing in a scanner. `scan-ignores.ts` is the only
 * file allowed to name the default-ignored directories.
 */
describe("scanners share one answer about ignored directories (#60)", () => {
  it("neither scanner carries its own build-output ignore list", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ["scan-css.ts", "scan-tsx.ts"]) {
      const source = await readFile(join(here, file), "utf8");
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      expect(code, `${file} should delegate to scan-ignores.ts`).not.toMatch(
        /\*\*\/(dist|storybook-static)\/\*\*/,
      );
      expect(code, `${file} should delegate to scan-ignores.ts`).toContain(
        "resolveScanEntries",
      );
    }
  });
});
