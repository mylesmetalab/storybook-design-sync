import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGlobPath, loadConfig, normalizeCodeTargets, normalizeTokenAliases } from "./config.js";
import { matchTokenNames } from "./token-aliases.js";
import { buildFixPrompt } from "./fix-prompt.js";

/**
 * `codeTargets` shipped a real bug: the documented shorthand is an array of glob
 * strings, but the config was typed and consumed as `CodeTarget[]` objects, so
 * `server.ts` computed `codeTargets.map((t) => t.path)` → `[undefined]` and every
 * generated fix prompt told its reader:
 *
 *     - The change belongs in one of these files …
 *       - `undefined`
 *
 * In audit-only mode the fix prompt IS the product, so the bad read went straight
 * into the deliverable. These tests reproduce that end-to-end (config file →
 * prompt text) and pin both accepted shapes plus the loud failure for anything
 * else.
 */

const dirs: string[] = [];

async function writeConfig(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "design-sync-config-"));
  dirs.push(dir);
  await writeFile(join(dir, "design-sync.config.json"), JSON.stringify(config), "utf8");
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const promptWith = (filePaths: string[] | undefined): string =>
  buildFixPrompt({
    storyId: "ui-button--default",
    kind: "token-value",
    property: "padding-top",
    codeValue: "6px",
    figmaValue: "12px",
    selector: ".button",
    ...(filePaths ? { filePaths } : {}),
  });

describe("codeTargets — the glob-string shorthand every doc and consumer uses", () => {
  it("reaches the fix prompt as the configured globs, never as `undefined`", async () => {
    const dir = await writeConfig({
      fileKey: "abc123",
      codeTargets: ["src/components/ui/**/*.tsx", "src/index.css"],
    });
    const config = await loadConfig(dir);

    expect(config.codeTargetPaths).toEqual(["src/components/ui/**/*.tsx", "src/index.css"]);
    // Canonical internal shape is CodeTarget[] — that's what the write engines take.
    expect(config.codeTargets).toEqual([
      { path: "src/components/ui/**/*.tsx" },
      { path: "src/index.css" },
    ]);

    const prompt = promptWith(config.codeTargetPaths);
    expect(prompt).toContain("`src/components/ui/**/*.tsx`");
    expect(prompt).toContain("`src/index.css`");
    expect(prompt).not.toContain("undefined");
  });

  it("accepts the object shape and keeps `scopeSelector`", async () => {
    const dir = await writeConfig({
      fileKey: "abc123",
      codeTargets: [{ path: "src/Button.css", scopeSelector: ".btn" }, { path: "src/Button.tsx" }],
    });
    const config = await loadConfig(dir);

    expect(config.codeTargets).toEqual([
      { path: "src/Button.css", scopeSelector: ".btn" },
      { path: "src/Button.tsx" },
    ]);
    expect(config.codeTargetPaths).toEqual(["src/Button.css", "src/Button.tsx"]);
    expect(promptWith(config.codeTargetPaths)).not.toContain("undefined");
  });

  it("defaults to an empty list, and the prompt then uses its no-paths branch", async () => {
    const dir = await writeConfig({ fileKey: "abc123" });
    const config = await loadConfig(dir);

    expect(config.codeTargets).toEqual([]);
    expect(config.codeTargetPaths).toEqual([]);
    const prompt = promptWith(config.codeTargetPaths);
    expect(prompt).toMatch(/No code file paths are configured — search the codebase/);
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toMatch(/belongs in one of these files/);
  });

  it("rejects an unusable entry loudly, naming the entry and both accepted shapes", async () => {
    const dir = await writeConfig({
      fileKey: "abc123",
      codeTargets: ["src/ok.css", { file: "src/typo.css" }],
    });
    await expect(loadConfig(dir)).rejects.toThrow(/codeTargets\[1\]` is not usable/);
    await expect(loadConfig(dir)).rejects.toThrow(/\{"file":"src\/typo\.css"\}/);
    await expect(loadConfig(dir)).rejects.toThrow(/glob\/path string/);
    await expect(loadConfig(dir)).rejects.toThrow(/object with a non-empty `path`/);
  });

  it("rejects the shapes that used to slip through as a silent undefined", () => {
    for (const bad of [[null], [42], [""], ["   "], [{}], [{ path: "" }], [{ path: 7 }], [[]]]) {
      expect(() => normalizeCodeTargets(bad), JSON.stringify(bad)).toThrow(/is not usable/);
    }
    expect(() => normalizeCodeTargets("src/**/*.tsx")).toThrow(/must be an array/);
    expect(normalizeCodeTargets(undefined)).toEqual([]);
  });

  it("trims whitespace rather than filing a path with a stray space", () => {
    expect(normalizeCodeTargets([" src/a.css "])).toEqual([{ path: "src/a.css" }]);
  });
});

describe("isGlobPath — a pattern is not a file the write engines can open", () => {
  it("recognizes glob metacharacters", () => {
    for (const p of ["src/**/*.tsx", "src/?.css", "src/{a,b}.css", "src/[ab].css"]) {
      expect(isGlobPath(p), p).toBe(true);
    }
  });

  it("leaves concrete paths alone", () => {
    for (const p of ["src/Button.css", "src/components/ui/button.tsx"]) {
      expect(isGlobPath(p), p).toBe(false);
    }
  });
});

/**
 * `tokenAliases` (v0.0.38, issue #57) gets the same treatment `codeTargets` got in
 * v0.0.37, and for a sharper reason: an alias exists to *suppress* a drift row. A
 * silently-ignored entry is the worst failure mode there is — the user believes
 * they told the addon that two names mean the same thing, the panel keeps
 * reporting the divergence, and nothing says why. Every rejection names the key.
 */
describe("tokenAliases — validated loudly, never silently ignored", () => {
  it("loads the documented shape and defaults to {}", async () => {
    const withAliases = await writeConfig({
      fileKey: "abc123",
      tokenAliases: { "color/background/brand/default": "primary" },
    });
    expect((await loadConfig(withAliases)).tokenAliases).toEqual({
      "color/background/brand/default": "primary",
    });

    const without = await writeConfig({ fileKey: "abc123" });
    expect((await loadConfig(without)).tokenAliases).toEqual({});
  });

  it("rejects a non-object map, naming the field and the shape", async () => {
    for (const bad of [[], ["color/x"], "primary", 42]) {
      const dir = await writeConfig({ fileKey: "abc123", tokenAliases: bad });
      await expect(loadConfig(dir), JSON.stringify(bad)).rejects.toThrow(
        /`tokenAliases` must be an object/,
      );
    }
  });

  it("rejects an unusable value, naming the offending key", () => {
    for (const bad of [null, 42, "", "   ", [], {}]) {
      expect(
        () => normalizeTokenAliases({ "color/background/brand/default": bad }),
        JSON.stringify(bad),
      ).toThrow(/`tokenAliases\["color\/background\/brand\/default"\]` must be a non-empty string/);
    }
  });

  it("names the shape in the error so a reader doesn't have to guess", () => {
    expect(() => normalizeTokenAliases({ "color/x": 1 })).toThrow(
      /{ "color\/background\/brand\/default": "primary" }/,
    );
  });

  it("rejects an empty key", () => {
    expect(() => normalizeTokenAliases({ "": "primary" })).toThrow(/has an empty key/);
    expect(() => normalizeTokenAliases({ "   ": "primary" })).toThrow(/has an empty key/);
  });

  it("refuses two spellings of one Figma variable that disagree, rather than picking", () => {
    // Both keys resolve to the same variable at lookup time, so whichever won
    // would be an accident.
    expect(() =>
      normalizeTokenAliases({ "color/x": "primary", "Color/X": "secondary" }),
    ).toThrow(/maps the same Figma variable twice with different token names/);
    // Same decision written twice is harmless.
    expect(normalizeTokenAliases({ "color/x": "primary", "--color-x": "primary" })).toEqual({
      "color/x": "primary",
      "--color-x": "primary",
    });
  });

  it("trims, and keeps keys exactly as written so the panel can quote them back", () => {
    expect(normalizeTokenAliases({ " color/x ": " primary " })).toEqual({ "color/x": "primary" });
    expect(normalizeTokenAliases(undefined)).toEqual({});
    expect(normalizeTokenAliases(null)).toEqual({});
  });

  it("agrees with the matcher about which keys are the same variable", () => {
    // Config's duplicate detection and the lookup canonicalization must not
    // diverge: if they did, a map config accepted could still fail to resolve.
    const aliases = normalizeTokenAliases({ "Body/Font Weight Regular": "font-weight-regular" });
    expect(matchTokenNames("font-weight-regular", "body-font-weight-regular", aliases).via).toBe(
      "alias",
    );
  });
});
