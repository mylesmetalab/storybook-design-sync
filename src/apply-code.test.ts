import { describe, expect, it, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCodeEdit } from "./apply-code.js";
import type { Edit } from "@metalab/design-sync-core";

let dir: string;

async function setup(css: string): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), "addon-apply-code-"));
  await writeFile(join(dir, "style.css"), css, "utf8");
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function codeEdit(overrides: Partial<Edit> = {}): Edit {
  return {
    id: "e1",
    kind: "token-binding",
    scope: "code",
    target: { selector: ".text-button", property: "color" },
    oldValue: "label-text",
    newValue: "button-text",
    source: "test",
    timestamp: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyCodeEdit — in-process CSS write (no pipeline binary)", () => {
  it("rewrites the token var in the target CSS file", async () => {
    await setup(`.text-button { color: var(--label-text); }`);
    const result = await applyCodeEdit(codeEdit(), dir, [{ path: "style.css" }]);
    expect(result.status).toBe("applied");
    const after = await readFile(join(dir, "style.css"), "utf8");
    expect(after).toContain("var(--button-text)");
    expect(after).not.toContain("var(--label-text)");
  });

  it("dry-run reports the change without writing", async () => {
    await setup(`.text-button { color: var(--label-text); }`);
    const result = await applyCodeEdit(codeEdit({ dryRun: true }), dir, [{ path: "style.css" }]);
    expect(result.status).toBe("no_op");
    const after = await readFile(join(dir, "style.css"), "utf8");
    expect(after).toContain("var(--label-text)");
  });

  it("rejects a figma-scope edit (those route through the pipeline)", async () => {
    await setup(`.text-button { color: var(--label-text); }`);
    const result = await applyCodeEdit(codeEdit({ scope: "figma" }), dir, [{ path: "style.css" }]);
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/only handles scope/i);
  });

  it("rejects when no codeTargets are configured", async () => {
    await setup(`.text-button { color: var(--label-text); }`);
    const result = await applyCodeEdit(codeEdit(), dir, []);
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/codeTargets/i);
  });

  it("applies a copy edit to static JSX text via code-tsx-text (P2.1)", async () => {
    await setup(`.unused {}`);
    await writeFile(
      join(dir, "Button.tsx"),
      `export const B = () => <button>Save changes</button>;`,
      "utf8",
    );
    const result = await applyCodeEdit(
      codeEdit({
        kind: "copy",
        target: { property: "text" },
        oldValue: "Save changes",
        newValue: "Save",
      }),
      dir,
      [{ path: "style.css" }, { path: "Button.tsx" }],
    );
    expect(result.status).toBe("applied");
    expect(result.engine).toBe("code-tsx-text");
    const after = await readFile(join(dir, "Button.tsx"), "utf8");
    expect(after).toContain("<button>Save</button>");
  });

  it("applies a token-binding edit to an inline style via code-tsx-inline", async () => {
    await setup(`.unused {}`);
    await writeFile(
      join(dir, "Row.tsx"),
      `export const R = () => <div style={{ color: "var(--label-text)" }} />;`,
      "utf8",
    );
    const result = await applyCodeEdit(
      codeEdit({ target: { property: "color" } }),
      dir,
      [{ path: "Row.tsx" }],
    );
    expect(result.status).toBe("applied");
    expect(result.engine).toBe("code-tsx-inline");
    const after = await readFile(join(dir, "Row.tsx"), "utf8");
    expect(after).toContain('var(--button-text)');
  });
});

/**
 * `codeTargets` accepts glob strings (the documented shorthand — see config.ts),
 * but the write engines resolve `path` literally: extension filter, then read.
 * A glob sails past the extension filter and dies on an ENOENT deep inside an
 * engine. Refuse it here instead, by name.
 */
describe("applyCodeEdit — glob-shaped codeTargets can't be written to", () => {
  it("rejects with a message naming the globs when every target is a pattern", async () => {
    await setup(`.text-button { color: var(--label-text); }`);
    const result = await applyCodeEdit(codeEdit(), dir, [
      { path: "src/**/*.css" },
      { path: "src/**/*.tsx" },
    ]);
    expect(result.status).toBe("rejected");
    expect(result.message).toMatch(/glob pattern/);
    expect(result.message).toContain('"src/**/*.css"');
    expect(result.message).toMatch(/need concrete file paths/);
    // Says why the config isn't simply wrong: globs are valid, just not writable.
    expect(result.message).toMatch(/fine for fix prompts/);
  });

  it("still applies through the concrete entries of a mixed list", async () => {
    await setup(`.text-button { color: var(--label-text); }`);
    const result = await applyCodeEdit(codeEdit(), dir, [
      { path: "src/**/*.css" },
      { path: "style.css" },
    ]);
    expect(result.status).toBe("applied");
    const after = await readFile(join(dir, "style.css"), "utf8");
    expect(after).toContain("var(--button-text)");
  });
});
