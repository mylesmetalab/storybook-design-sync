import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  deriveAutoTitle,
  discoverStories,
  globDirectory,
  loadTitleResolver,
  toStoryId,
} from "./story-discovery.js";

/**
 * CSF3 **autotitle** files were undercounted by discovery: the old regex
 * required a literal `title:` and returned null without one, so a consumer
 * using autotitle got a registry that looked complete, stories nothing ever
 * checked, and a green CI. These tests pin down that they are found with the
 * right derived title, and that anything still unreadable is *reported*, never
 * dropped.
 */

const GLOBS = ["src/**/*.stories.@(ts|tsx|js|jsx|mjs|mts)", "stories/**/*.stories.@(ts|tsx)"];

const dirs: string[] = [];

async function project(files: Record<string, string>): Promise<{ cwd: string; files: string[] }> {
  const cwd = await mkdtemp(join(tmpdir(), "design-sync-discovery-"));
  dirs.push(cwd);
  const absolute: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const full = join(cwd, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    absolute.push(full);
  }
  return { cwd, files: absolute };
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const AUTOTITLE_CSF3 = `
import type { Meta, StoryObj } from "@storybook/react";
import { Card } from "./Card";

const meta = { component: Card } satisfies Meta<typeof Card>;
export default meta;

export const Basic: StoryObj<typeof meta> = {};
export const WithHeader: StoryObj<typeof meta> = {};
`;

describe("globDirectory", () => {
  it("takes the static prefix, and never a filename", () => {
    expect(globDirectory("src/**/*.stories.tsx")).toBe("src");
    expect(globDirectory("./src/ui/*.stories.ts")).toBe("src/ui");
    expect(globDirectory("**/*.stories.tsx")).toBe("");
    expect(globDirectory("src/ui/Button.stories.tsx")).toBe("src/ui");
    expect(globDirectory("src/**/*.stories.@(ts|tsx)")).toBe("src");
  });
});

describe("deriveAutoTitle — agrees with the installed Storybook", () => {
  const paths = [
    "src/components/Button/Button.stories.tsx",
    "src/components/Card.stories.tsx",
    "src/components/Card/index.stories.tsx",
    "src/x/y/z.stories.tsx",
    "src/Deeply/Nested/Thing/Thing.stories.ts",
    "stories/Foo.stories.tsx",
  ];

  it("produces the same titles `getStoryTitle` does", async () => {
    // The fallback exists for a consumer without Storybook resolvable from the
    // CLI. If it disagreed with Storybook, it would mint story ids Storybook
    // never produces — a registry full of entries that match nothing. So the
    // two are asserted equal rather than hoped equal.
    const cwd = "/tmp/design-sync-fake-project";
    const resolver = await loadTitleResolver(cwd, GLOBS);
    expect(resolver).not.toBeNull();
    for (const path of paths) {
      expect([path, deriveAutoTitle(path, GLOBS)]).toEqual([
        path,
        resolver!(resolve(cwd, path)) ?? null,
      ]);
    }
  });

  it("drops a redundant filename and an index segment", () => {
    expect(deriveAutoTitle("src/components/Button/Button.stories.tsx", GLOBS)).toBe(
      "components/Button",
    );
    expect(deriveAutoTitle("src/components/Card/index.stories.tsx", GLOBS)).toBe("components/Card");
  });

  it("returns null when no configured glob covers the path", () => {
    expect(deriveAutoTitle("packages/ui/Thing.stories.tsx", GLOBS)).toBeNull();
  });

  it("prefers the glob with the longest matching directory prefix", () => {
    const globs = ["src/**/*.stories.tsx", "src/legacy/**/*.stories.tsx"];
    expect(deriveAutoTitle("src/legacy/Old/Old.stories.tsx", globs)).toBe("Old");
  });
});

describe("discoverStories — CSF3 autotitle files are found and counted", () => {
  it("discovers an autotitle file with the derived title", async () => {
    const { cwd, files } = await project({
      "src/components/Card/Card.stories.tsx": AUTOTITLE_CSF3,
    });

    const outcome = await discoverStories({ cwd, files, globs: GLOBS });

    expect(outcome.unreadable).toEqual([]);
    expect(outcome.stories).toEqual([
      {
        id: "components-card--basic",
        file: "src/components/Card/Card.stories.tsx",
        title: "components/Card",
        exportName: "Basic",
        titleSource: "autotitle",
      },
      {
        id: "components-card--with-header",
        file: "src/components/Card/Card.stories.tsx",
        title: "components/Card",
        exportName: "WithHeader",
        titleSource: "autotitle",
      },
    ]);
  });

  it("still reads an explicit title, and says which stories got one", async () => {
    const { cwd, files } = await project({
      "src/components/Button/Button.stories.tsx": `
        const meta = { title: "UI/Button", component: 1 };
        export default meta;
        export const Primary = {};
      `,
    });

    const outcome = await discoverStories({ cwd, files, globs: GLOBS });

    expect(outcome.stories).toEqual([
      expect.objectContaining({
        id: "ui-button--primary",
        title: "UI/Button",
        titleSource: "explicit",
      }),
    ]);
  });

  it("reads a CSF factory file", async () => {
    const { cwd, files } = await project({
      "src/components/Chip/Chip.stories.tsx": `
        import preview from "#.storybook/preview";
        const meta = preview.meta({ component: 1 });
        export default meta;
        export const Basic = meta.story({});
      `,
    });

    const outcome = await discoverStories({ cwd, files, globs: GLOBS });

    expect(outcome.exports).toBe("storybook-csf");
    expect(outcome.stories.map((s) => s.id)).toEqual(["components-chip--basic"]);
  });

  it("honours excludeStories and ignores type-only exports", async () => {
    // Two things the regex got wrong in the *other* direction — it counted
    // stories that Storybook never indexes.
    const { cwd, files } = await project({
      "src/components/Tag/Tag.stories.tsx": `
        import type { Meta } from "@storybook/react";
        export default { component: 1, excludeStories: ["Excluded"] } satisfies Meta;
        export type TagStory = 1;
        export const Kept = {};
        export const Excluded = {};
      `,
    });

    const outcome = await discoverStories({ cwd, files, globs: GLOBS });

    expect(outcome.stories.map((s) => s.exportName)).toEqual(["Kept"]);
  });
});

describe("discoverStories — unknowns are reported, never dropped", () => {
  it("reports an unparseable file as unreadable with the reason", async () => {
    const { cwd, files } = await project({
      "src/components/Broken/Broken.stories.tsx": `
        export default { component: 1 };
        export const A = { <<< not javascript };
      `,
    });

    const outcome = await discoverStories({ cwd, files, globs: GLOBS });

    expect(outcome.stories).toEqual([]);
    expect(outcome.unreadable).toEqual([
      {
        file: "src/components/Broken/Broken.stories.tsx",
        reason: expect.stringContaining("CSF parse failed"),
      },
    ]);
  });

  it("reports a file with no default export as unreadable, not as zero stories", async () => {
    const { cwd, files } = await project({
      "src/components/Helper/Helper.stories.tsx": `export const notAStory = 1;`,
    });

    const outcome = await discoverStories({ cwd, files, globs: GLOBS });

    expect(outcome.stories).toEqual([]);
    expect(outcome.unreadable[0]?.reason).toContain("missing default export");
  });

  it("reports an autotitle file no glob covers, rather than inventing a title", async () => {
    const { cwd, files } = await project({
      "packages/ui/Outside.stories.tsx": AUTOTITLE_CSF3,
    });

    // The file is passed in explicitly (as a `--stories` override would), but no
    // configured glob's directory contains it, so Storybook's derivation has no
    // answer and neither do we.
    const outcome = await discoverStories({ cwd, files, globs: GLOBS });

    expect(outcome.stories).toEqual([]);
    expect(outcome.unreadable[0]?.reason).toContain("no autotitle could be derived");
  });

  it("classifies MDX as contributing no story ids, without failing", async () => {
    const { cwd, files } = await project({
      "src/components/Docs/Intro.mdx": `# Intro`,
      "src/components/Card/Card.stories.tsx": AUTOTITLE_CSF3,
    });

    const outcome = await discoverStories({ cwd, files, globs: ["src/**/*.@(mdx|stories.tsx)"] });

    expect(outcome.unreadable).toEqual([]);
    expect(outcome.skipped).toEqual([
      { file: "src/components/Docs/Intro.mdx", reason: expect.stringContaining("docs entry") },
    ]);
    expect(outcome.stories).toHaveLength(2);
  });

  it("keeps the good files when one file in the set is unreadable", async () => {
    const { cwd, files } = await project({
      "src/components/Card/Card.stories.tsx": AUTOTITLE_CSF3,
      "src/components/Broken/Broken.stories.tsx": `export default { component: 1 }; export const A = {`,
    });

    const outcome = await discoverStories({ cwd, files, globs: GLOBS });

    expect(outcome.stories.map((s) => s.id)).toEqual([
      "components-card--basic",
      "components-card--with-header",
    ]);
    expect(outcome.unreadable).toHaveLength(1);
  });
});

describe("toStoryId", () => {
  it("derives the id from the export name, not from a `name` annotation", () => {
    // Storybook's own `toId` uses the export key; a `name:` changes only the
    // display name. Using the name would mint ids Storybook never produces.
    expect(toStoryId("components/Card", "WithHeader")).toBe("components-card--with-header");
    expect(toStoryId("UI/Button", "Primary")).toBe("ui-button--primary");
  });
});
