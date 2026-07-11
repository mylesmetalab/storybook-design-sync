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
});
