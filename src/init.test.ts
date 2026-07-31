import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CACHE_IGNORE_LINE,
  CONFIG_FILE,
  FILE_KEY_PLACEHOLDER,
  INIT_EXIT,
  addAddons,
  configContents,
  detectProject,
  majorFromRange,
  parseInitArgs,
  readStringArrayProperty,
  refusals,
  runInit,
  skillRevised,
  storyGlobsFromMain,
  type InitOptions,
} from "./init.js";
import { loadConfig } from "./config.js";

/**
 * `design-sync init`.
 *
 * The properties worth pinning are the ones that make it safe to run on somebody
 * else's repo, in the order the brief puts them:
 *
 *  1. **It never overwrites a file the user wrote.** A config, a `main.ts`, a
 *     skill: each is either merged into describably or left alone and reported.
 *  2. **A second run is a no-op that says what it skipped.** Idempotence that is
 *     silent about itself is indistinguishable from idempotence that is broken.
 *  3. **A partial init reports what remains, in order.** This is the failure mode
 *     the whole report format exists to avoid, so it is asserted directly.
 *  4. **Storybook 8/9 is refused, and nothing is written.**
 *  5. **A missing `fileKey` is never fabricated.** It is the one fact only the
 *     user has; a placeholder plus a loud step-one is the only alternative to
 *     being told.
 */

const dirs: string[] = [];

async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "design-sync-init-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

/** A Storybook 10 React project on Tailwind v4 — the common shape. */
function tailwindProject(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "app",
      devDependencies: { storybook: "^10.1.0", tailwindcss: "^4.1.0" },
    }),
    "node_modules/storybook/package.json": JSON.stringify({ name: "storybook", version: "10.1.3" }),
    ".storybook/main.ts": [
      "const config = {",
      "  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(ts|tsx)'],",
      "  addons: ['@storybook/addon-docs'],",
      "  framework: '@storybook/react-vite'",
      "};",
      "export default config;",
      "",
    ].join("\n"),
    ".storybook/preview.ts": "const preview = { parameters: {} };\nexport default preview;\n",
    "src/index.css": '@import "tailwindcss";\n@theme {\n  --color-primary: #2c2c2c;\n}\n',
    "src/components/ui/button.tsx": "export const Button = () => <button>Save</button>;\n",
    "src/components/ui/button.stories.tsx": "export default {};\nexport const Primary = {};\n",
    ".gitignore": "node_modules\ndist\n",
    ...overrides,
  };
}

function options(cwd: string, overrides: Partial<InitOptions> = {}): InitOptions {
  return { cwd, yes: true, skills: true, force: false, dryRun: false, ...overrides };
}

async function run(
  cwd: string,
  overrides: Partial<InitOptions> = {},
): Promise<{ exit: number; out: string }> {
  const lines: string[] = [];
  const exit = await runInit(options(cwd, overrides), { log: (l) => lines.push(l) });
  return { exit, out: lines.join("\n") };
}

async function read(cwd: string, rel: string): Promise<string | undefined> {
  try {
    return await readFile(join(cwd, rel), "utf8");
  } catch {
    return undefined;
  }
}

beforeEach(() => {
  // Detection reads the ambient PAT; pin it so a developer's shell cannot change
  // what the tests assert.
  vi.stubEnv("FIGMA_PAT", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("init — refuses a project it cannot set up, and writes nothing", () => {
  it("refuses Storybook 9 by name, and leaves no config behind", async () => {
    const cwd = await project(
      tailwindProject({
        "package.json": JSON.stringify({ devDependencies: { storybook: "^9.0.0" } }),
        "node_modules/storybook/package.json": JSON.stringify({ version: "9.0.4" }),
      }),
    );

    const { exit, out } = await run(cwd);

    expect(exit).toBe(INIT_EXIT.Refused);
    expect(out).toContain("REFUSED");
    expect(out).toContain("Storybook 9.0.4");
    expect(out).toContain("requires Storybook **10**");
    expect(await read(cwd, CONFIG_FILE)).toBeUndefined();
  });

  it("refuses Storybook 8 the same way", async () => {
    const cwd = await project(
      tailwindProject({
        "node_modules/storybook/package.json": JSON.stringify({ version: "8.6.14" }),
      }),
    );

    const { exit, out } = await run(cwd);

    expect(exit).toBe(INIT_EXIT.Refused);
    expect(out).toContain("Storybook 8.6.14");
    expect(await read(cwd, CONFIG_FILE)).toBeUndefined();
  });

  it("refuses a project with no Storybook at all, and says what to run first", async () => {
    const cwd = await project({ "package.json": "{}" });

    const { exit, out } = await run(cwd);

    expect(exit).toBe(INIT_EXIT.Refused);
    expect(out).toContain("No Storybook found");
    expect(out).toContain("storybook@latest init");
  });

  it("refuses when there is no .storybook/main.*", async () => {
    const files = tailwindProject();
    delete files[".storybook/main.ts"];
    const cwd = await project(files);

    const { exit, out } = await run(cwd);

    expect(exit).toBe(INIT_EXIT.Refused);
    expect(out).toContain("No `.storybook/main.*` found");
    expect(await read(cwd, CONFIG_FILE)).toBeUndefined();
  });

  it("refuses rather than guess when a declared range has no readable major", async () => {
    const facts = {
      node: { version: process.versions.node, ok: true },
      storybook: { version: "workspace:*", source: "declared" as const },
      main: { path: ".storybook/main.ts", source: "", addons: [], storyGlobs: [] },
    };
    const reasons = refusals(facts as unknown as Parameters<typeof refusals>[0]);

    expect(reasons.join("\n")).toContain("will not guess");
  });
});

describe("init — the fileKey is never fabricated", () => {
  it("writes a loud placeholder and makes filling it in step one", async () => {
    const cwd = await project(tailwindProject());

    const { out } = await run(cwd);

    const config = JSON.parse((await read(cwd, CONFIG_FILE))!) as { fileKey: string };
    expect(config.fileKey).toBe(FILE_KEY_PLACEHOLDER);
    // Nothing in the project could have suggested a key, and none was invented.
    expect(config.fileKey).not.toMatch(/^[A-Za-z0-9]{20,}$/);
    const remaining = out.slice(out.indexOf("NOT DONE"));
    expect(remaining).toMatch(/1\. Put your Figma file key/);
  });

  it("uses --file-key when given, verbatim", async () => {
    const cwd = await project(tailwindProject());

    const { out } = await run(cwd, { fileKey: "Nq23XwGfazYZZZ5vr8OezI" });

    const config = JSON.parse((await read(cwd, CONFIG_FILE))!) as { fileKey: string };
    expect(config.fileKey).toBe("Nq23XwGfazYZZZ5vr8OezI");
    expect(out).not.toContain("Put your Figma file key");
  });

  it("keeps an existing config's key on a re-run instead of re-prompting", async () => {
    const cwd = await project(
      tailwindProject({
        [CONFIG_FILE]: JSON.stringify({ fileKey: "already-set", cssEntries: [], tsxEntries: [] }),
      }),
    );
    const prompt = vi.fn(async () => "should-not-be-called");

    const lines: string[] = [];
    await runInit(options(cwd, { yes: false }), {
      log: (l) => lines.push(l),
      promptFileKey: prompt,
    });

    expect(prompt).not.toHaveBeenCalled();
    expect(await read(cwd, CONFIG_FILE)).toContain("already-set");
  });

  it("does not prompt under --yes", async () => {
    const cwd = await project(tailwindProject());
    const prompt = vi.fn(async () => "nope");

    await runInit(options(cwd, { yes: true }), { log: () => {}, promptFileKey: prompt });

    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("init — never overwrites a file the user wrote", () => {
  it("leaves an existing config untouched and says so", async () => {
    const authored = '{\n  "fileKey": "mine",\n  "apply": "experimental",\n  "cssEntries": ["a.css"],\n  "tsxEntries": ["a.tsx"]\n}\n';
    const cwd = await project(tailwindProject({ [CONFIG_FILE]: authored }));

    const { out } = await run(cwd);

    expect(await read(cwd, CONFIG_FILE)).toBe(authored);
    expect(out).toContain(`${CONFIG_FILE} already exists — left untouched`);
    // …and the one thing worth flagging about it is flagged, not fixed.
    expect(out).toContain('"apply": "experimental"');
  });

  it("merges into main.ts rather than rewriting it, preserving quote style", async () => {
    const cwd = await project(tailwindProject());

    await run(cwd);
    const main = (await read(cwd, ".storybook/main.ts"))!;

    expect(main).toContain("'@metalab/storybook-design-sync'");
    expect(main).toContain("'storybook-design-inspector'");
    // Everything the user wrote is still there, including the addon they had.
    expect(main).toContain("'@storybook/addon-docs'");
    expect(main).toContain("framework: '@storybook/react-vite'");
    expect(main).toContain("stories: ['../src/**/*.mdx'");
  });

  it("declines to edit an addons array it cannot reproduce, and prints the snippet", async () => {
    const withSpread = [
      "const extra = [];",
      "const config = {",
      "  stories: ['../src/**/*.stories.tsx'],",
      "  addons: ['@storybook/addon-docs', ...extra],",
      "};",
      "export default config;",
      "",
    ].join("\n");
    const cwd = await project(tailwindProject({ ".storybook/main.ts": withSpread }));

    const { out } = await run(cwd);

    expect(await read(cwd, ".storybook/main.ts")).toBe(withSpread);
    expect(out).toContain("Register the addons in .storybook/main.ts by hand");
    expect(out).toContain("@metalab/storybook-design-sync");
  });

  it("never overwrites a skill, not even with --force", async () => {
    const mine = "---\nname: fix-drift\nrevised: 2020-01-01\n---\n\nOur own conventions.\n";
    const cwd = await project(
      tailwindProject({ ".claude/skills/fix-drift/SKILL.md": mine }),
    );

    const { out } = await run(cwd, { force: true });

    expect(await read(cwd, ".claude/skills/fix-drift/SKILL.md")).toBe(mine);
    // Reported as older, with where to diff from — never synced silently.
    expect(out).toMatch(/fix-drift\/SKILL\.md kept \(yours: 2020-01-01/);
    expect(out).toContain("yours is OLDER");
  });

  it("--force rewrites only the config init authors", async () => {
    const cwd = await project(
      tailwindProject({ [CONFIG_FILE]: '{ "fileKey": "old" }\n' }),
    );

    await run(cwd, { force: true, fileKey: "new-key" });

    expect(await read(cwd, CONFIG_FILE)).toContain("new-key");
    // The user's main.ts is still merged into, never replaced.
    expect(await read(cwd, ".storybook/main.ts")).toContain("'@storybook/addon-docs'");
  });

  it("appends to .gitignore without disturbing what is there", async () => {
    const cwd = await project(tailwindProject({ ".gitignore": "node_modules\ndist\n" }));

    await run(cwd);
    const ignore = (await read(cwd, ".gitignore"))!;

    expect(ignore.startsWith("node_modules\ndist\n")).toBe(true);
    expect(ignore).toContain(CACHE_IGNORE_LINE);
    expect(ignore).toContain("registry.json");
  });

  it("writes nothing at all under --dry-run", async () => {
    const cwd = await project(tailwindProject());

    const { out } = await run(cwd, { dryRun: true });

    expect(out).toContain("DRY RUN, nothing written");
    expect(out).toContain("Would change");
    expect(await read(cwd, CONFIG_FILE)).toBeUndefined();
    expect(await read(cwd, ".claude/skills/fix-drift/SKILL.md")).toBeUndefined();
    expect(await read(cwd, ".storybook/main.ts")).not.toContain("design-sync");
  });
});

describe("init — a second run is a no-op that says what it skipped", () => {
  it("changes nothing and reports every step as already done", async () => {
    const cwd = await project(tailwindProject());

    await run(cwd, { fileKey: "abc" });
    const afterFirst = {
      config: await read(cwd, CONFIG_FILE),
      main: await read(cwd, ".storybook/main.ts"),
      ignore: await read(cwd, ".gitignore"),
      skill: await read(cwd, ".claude/skills/fix-drift/SKILL.md"),
    };

    const second = await run(cwd, { fileKey: "abc" });

    expect(second.exit).toBe(INIT_EXIT.Ok);
    expect(second.out).toContain("Changed (0)");
    expect(second.out).toContain("nothing — everything init writes is already there");
    expect(second.out).toMatch(/Skipped, already done \((?!0\))\d+\)/);
    expect(second.out).toContain("already registers both addons");
    expect(second.out).toContain("already ignores .design-sync/cache.json");
    expect(await read(cwd, CONFIG_FILE)).toBe(afterFirst.config);
    expect(await read(cwd, ".storybook/main.ts")).toBe(afterFirst.main);
    expect(await read(cwd, ".gitignore")).toBe(afterFirst.ignore);
    expect(await read(cwd, ".claude/skills/fix-drift/SKILL.md")).toBe(afterFirst.skill);
  });

  it("adds only the addon that is missing when one is already registered", async () => {
    const cwd = await project(
      tailwindProject({
        ".storybook/main.ts":
          "const config = {\n  stories: ['../src/**/*.stories.tsx'],\n  addons: ['@metalab/storybook-design-sync'],\n};\nexport default config;\n",
      }),
    );

    await run(cwd);
    const main = (await read(cwd, ".storybook/main.ts"))!;

    expect(main.match(/@metalab\/storybook-design-sync/g)).toHaveLength(1);
    expect(main).toContain("storybook-design-inspector");
  });
});

describe("init — an honest exit", () => {
  it("reports what remains, numbered, and never claims setup is complete", async () => {
    const cwd = await project(tailwindProject());

    const { exit, out } = await run(cwd);

    expect(exit).toBe(INIT_EXIT.Ok);
    expect(out).toMatch(/NOT DONE — \d+ step\(s\) remain, in this order/);
    expect(out).not.toMatch(/setup complete/i);
    // The steps init cannot do are all named.
    expect(out).toContain("FIGMA_PAT");
    expect(out).toContain("token VALUES with the design source");
    expect(out).toContain("token manifest");
    expect(out).toContain("register --hints");
    expect(out).toContain("PR checks");
  });

  it("puts the blocking steps before the judgement ones", async () => {
    const cwd = await project(tailwindProject());

    const { out } = await run(cwd);
    const remaining = out.slice(out.indexOf("NOT DONE"));

    const fileKeyAt = remaining.indexOf("Put your Figma file key");
    const patAt = remaining.indexOf("Set FIGMA_PAT");
    const alignAt = remaining.indexOf("Align this project's token VALUES");
    const verifyAt = remaining.indexOf("Verify end to end");
    expect(fileKeyAt).toBeGreaterThanOrEqual(0);
    expect(fileKeyAt).toBeLessThan(patAt);
    expect(patAt).toBeLessThan(alignAt);
    expect(alignAt).toBeLessThan(verifyAt);
  });

  it("does not list a step it can see is already done", async () => {
    vi.stubEnv("FIGMA_PAT", "figd_test");
    const cwd = await project(
      tailwindProject({
        "tokens/manifest.json": "{}",
        ".storybook/preview.ts":
          "const preview = { parameters: { designInspector: { tokens: {} }, designSync: { modeSwitch: { kind: 'class' } } } };\nexport default preview;\n",
      }),
    );

    const { out } = await run(cwd, { fileKey: "abc" });

    expect(out).not.toContain("Set FIGMA_PAT");
    expect(out).not.toContain("Generate the Design Inspector's token manifest");
    expect(out).not.toContain("Declare how this project switches theme");
    expect(out).toContain("already declares `modeSwitch`");
  });

  it("reports a write failure as its own exit code, not as success", async () => {
    const cwd = await project(tailwindProject());
    // A directory where the config file must go: the write fails, the report says so.
    await mkdir(join(cwd, CONFIG_FILE), { recursive: true });

    const { exit, out } = await run(cwd);

    expect(exit).toBe(INIT_EXIT.WriteFailed);
    expect(out).toContain("FAILED to write");
  });
});

describe("init — detection drives the config it writes", () => {
  it("writes a config the addon's own loader accepts", async () => {
    const cwd = await project(tailwindProject());

    await run(cwd, { fileKey: "abc" });
    const config = await loadConfig(cwd);

    expect(config.fileKey).toBe("abc");
    expect(config.apply).toBe("off");
    expect(config.cssEntries).toEqual(["src/index.css"]);
    expect(config.tsxEntries).toEqual(["src/components/ui/**/*.tsx"]);
    expect(config.codeTargetPaths).toContain("src/components/ui/**/*.tsx");
  });

  it("puts the Tailwind theme file in cssEntries — without it nothing is derived", async () => {
    const cwd = await project(
      tailwindProject({
        "src/styles/theme.css": '@theme {\n  --color-brand: #123456;\n}\n',
        "src/index.css": "body { margin: 0 }\n",
      }),
    );

    const facts = await detectProject(cwd, { skills: false });

    expect(facts.tailwind).toMatchObject({ present: true, generation: 4 });
    expect(facts.cssEntries.globs).toEqual(["src/styles/theme.css"]);
    expect(facts.cssEntries.reason).toContain("@theme");
  });

  it("warns that a Tailwind v3 project gets no utility bindings", async () => {
    const cwd = await project(
      tailwindProject({
        "package.json": JSON.stringify({ devDependencies: { storybook: "^10.1.0", tailwindcss: "^3.4.0" } }),
        "tailwind.config.js": "module.exports = {};\n",
        "src/index.css": "body { margin: 0 }\n",
      }),
    );

    const { out } = await run(cwd, { fileKey: "abc" });

    expect(out).toContain("Tailwind v3's scale");
    expect(out).toContain("NOT evaluated");
  });

  it("falls back to a plain CSS project's own directories", async () => {
    const files = tailwindProject({
      "package.json": JSON.stringify({ devDependencies: { storybook: "^10.1.0" } }),
      "styles/button.css": ".button { color: var(--ink); }\n",
    });
    delete files["src/index.css"];
    const cwd = await project(files);

    const facts = await detectProject(cwd, { skills: false });

    expect(facts.tailwind.present).toBe(false);
    expect(facts.cssEntries.globs).toEqual(["styles/**/*.css"]);
  });

  it("says so when it is falling back to a default rather than a finding", async () => {
    const cwd = await project({
      "package.json": JSON.stringify({ devDependencies: { storybook: "^10.1.0" } }),
      "node_modules/storybook/package.json": JSON.stringify({ version: "10.1.3" }),
      ".storybook/main.ts": "export default { stories: [], addons: [] };\n",
    });

    const facts = await detectProject(cwd, { skills: false });

    expect(facts.cssEntries.reason).toContain("may need changing");
    expect(facts.tsxEntries.reason).toContain("may need changing");
    expect(facts.storyGlobs.globs).toEqual([]);
  });

  it("takes storyGlobs from the project's own Storybook config", async () => {
    const cwd = await project(
      tailwindProject({
        ".storybook/main.ts":
          "export default {\n  stories: ['../packages/*/src/**/*.stories.@(ts|tsx)', '../src/**/*.mdx'],\n  addons: [],\n};\n",
      }),
    );

    const facts = await detectProject(cwd, { skills: false });

    // The `.mdx` entry is dropped: it yields no story ids.
    expect(facts.storyGlobs.globs).toEqual(["packages/*/src/**/*.stories.@(ts|tsx)"]);
  });

  it("leaves `copy` unset rather than writing a default that reads as a decision", async () => {
    const cwd = await project(tailwindProject());

    await run(cwd, { fileKey: "abc" });
    const raw = JSON.parse((await read(cwd, CONFIG_FILE))!) as Record<string, unknown>;

    expect("copy" in raw).toBe(false);
    expect(raw["apply"]).toBe("off");
  });
});

// ---------------------------------------------------------------------------
// Units behind the above
// ---------------------------------------------------------------------------

describe("addAddons", () => {
  const wanted = ["a-addon", "b-addon"];

  it("appends to a multi-line array, keeping indentation and quote style", () => {
    const source = 'export default {\n  addons: [\n    "x",\n  ],\n};\n';
    const result = addAddons(source, wanted);

    expect(result).not.toHaveProperty("refused");
    if ("refused" in result) return;
    expect(result.added).toEqual(wanted);
    expect(result.source).toBe(
      'export default {\n  addons: [\n    "x",\n    "a-addon",\n    "b-addon"\n  ],\n};\n',
    );
  });

  it("handles an empty array", () => {
    const result = addAddons("export default { addons: [] };\n", ["a"]);
    if ("refused" in result) throw new Error(result.refused);
    expect(result.source).toContain('"a"');
  });

  it("reports nothing added when both are present", () => {
    const result = addAddons('export default { addons: ["a-addon", "b-addon"] };\n', wanted);
    if ("refused" in result) throw new Error(result.refused);
    expect(result.added).toEqual([]);
  });

  it("refuses an array holding a comment", () => {
    const result = addAddons('export default {\n  addons: [\n    // keep this\n    "x",\n  ],\n};\n', wanted);
    expect(result).toHaveProperty("refused");
  });

  it("refuses an array holding an object", () => {
    const result = addAddons('export default { addons: [{ name: "x", options: {} }] };\n', wanted);
    expect(result).toHaveProperty("refused");
  });

  it("refuses a file with no addons array", () => {
    const result = addAddons("export default {};\n", wanted);
    expect(result).toHaveProperty("refused");
  });

  it("is not fooled by an `addons` string appearing inside another value", () => {
    const source = 'export default {\n  staticDirs: ["./addons"],\n  addons: ["x"],\n};\n';
    const result = addAddons(source, ["a"]);
    if ("refused" in result) throw new Error(result.refused);
    expect(result.source).toContain('staticDirs: ["./addons"]');
    expect(result.source).toContain('"x",\n    "a"');
  });
});

describe("readStringArrayProperty", () => {
  it("reads across nested brackets and ignores strings and comments", () => {
    const source = 'const c = {\n  addons: [\n    "a", // not "b"\n    "c",\n  ],\n};';
    expect(readStringArrayProperty(source, "addons")?.values).toEqual(["a", "b", "c"]);
  });

  it("returns undefined for a missing key", () => {
    expect(readStringArrayProperty("const c = {};", "addons")).toBeUndefined();
  });
});

describe("storyGlobsFromMain", () => {
  it("rewrites .storybook-relative globs and drops non-story entries", () => {
    expect(
      storyGlobsFromMain(["../src/**/*.mdx", "../src/**/*.stories.tsx", "./stories/**/*.stories.ts"]),
    ).toEqual(["src/**/*.stories.tsx", "stories/**/*.stories.ts"]);
  });

  it("deduplicates", () => {
    expect(storyGlobsFromMain(["../a/*.stories.ts", "../a/*.stories.ts"])).toEqual([
      "a/*.stories.ts",
    ]);
  });
});

describe("majorFromRange", () => {
  it("reads a major from the shapes a package.json actually holds", () => {
    expect(majorFromRange("^10.1.2")).toBe(10);
    expect(majorFromRange("~9.0.0")).toBe(9);
    expect(majorFromRange(">=10 <11")).toBe(10);
    expect(majorFromRange("10.x")).toBe(10);
    expect(majorFromRange("workspace:*")).toBeUndefined();
  });
});

describe("skillRevised", () => {
  it("reads the frontmatter stamp the staleness report turns on", () => {
    expect(skillRevised("---\nname: x\nrevised: 2026-07-31\n---\n\nbody")).toBe("2026-07-31");
    expect(skillRevised("no frontmatter")).toBeUndefined();
    expect(skillRevised("---\nname: x\n---\n")).toBeUndefined();
  });
});

describe("parseInitArgs", () => {
  it("parses every flag, and rejects anything else", () => {
    const opts = parseInitArgs(
      ["--file-key", " KEY ", "--yes", "--no-skills", "--force", "--dry-run"],
      "/tmp/x",
    );
    expect(opts).toEqual({
      cwd: "/tmp/x",
      fileKey: "KEY",
      yes: true,
      skills: false,
      force: true,
      dryRun: true,
    });
  });

  it("defaults to copying skills, and --no-skills turns it off", () => {
    expect(parseInitArgs([], "/tmp/x").skills).toBe(true);
    expect(parseInitArgs(["--no-skills"], "/tmp/x").skills).toBe(false);
  });

  it("rejects an unknown flag rather than ignoring it", () => {
    expect(() => parseInitArgs(["--nope"], "/tmp/x")).toThrow(/Unknown argument/);
  });

  it("requires a value for --file-key", () => {
    expect(() => parseInitArgs(["--file-key"], "/tmp/x")).toThrow(/requires a value/);
  });
});

describe("configContents", () => {
  it("always writes apply: off — the supported v1 posture", () => {
    const facts = {
      cssEntries: { globs: ["a.css"], reason: "" },
      tsxEntries: { globs: ["a.tsx"], reason: "" },
      codeTargets: ["a.tsx"],
      storyGlobs: { globs: [], reason: "" },
    } as unknown as Parameters<typeof configContents>[0];

    const parsed = JSON.parse(configContents(facts, "k")) as Record<string, unknown>;

    expect(parsed["apply"]).toBe("off");
    expect(parsed["fileKey"]).toBe("k");
    expect("storyGlobs" in parsed).toBe(false);
  });
});
