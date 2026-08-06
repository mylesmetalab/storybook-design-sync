import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseScanArgs, resolveCodeRef, runScan, type ScanDeps } from "./scan-command.js";

/**
 * Phase 3 of the hosted-check plan (HOSTED-CHECK-TASKS.md T6/T7): the
 * build-time artifact that lets `AutoScan` travel as a file instead of only
 * ever existing as a module singleton inside a running dev server —
 * replacing the dangling "Path A roadmap" reference the original spec cited
 * for this (nothing by that name exists anywhere in this project's docs).
 */

const dirs: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "design-sync-scan-command-"));
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

function testDeps(over: Partial<ScanDeps> = {}): ScanDeps {
  return {
    resolveCodeRef: async (explicit) => explicit ?? "stub-sha",
    version: async () => "0.0.99-test",
    write: async () => {},
    now: () => "2026-08-07T00:00:00.000Z",
    stderr: () => {},
    ...over,
  };
}

describe("parseScanArgs", () => {
  it("requires --out — scan writes an artifact, it does not print one", () => {
    expect(() => parseScanArgs([])).toThrow(/--out is required/);
  });

  it("captures --out and an explicit --code-ref", () => {
    const opts = parseScanArgs(["--out", "tokens.json", "--code-ref", "abc123"]);
    expect(opts.out).toBe("tokens.json");
    expect(opts.codeRef).toBe("abc123");
  });

  it("rejects an unknown flag", () => {
    expect(() => parseScanArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});

describe("resolveCodeRef", () => {
  it("an explicit value wins outright, without touching git", async () => {
    // A nonexistent cwd would make `git rev-parse` fail — proving this resolves
    // without ever invoking git, the same way `resolveStorybookUrl` proves
    // an explicit --url wins without reading the config file.
    await expect(resolveCodeRef("explicit-sha", "/nonexistent/path")).resolves.toBe(
      "explicit-sha",
    );
  });

  it("shells out to the current git HEAD when nothing explicit is given", async () => {
    const sha = await resolveCodeRef(undefined, process.cwd());
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("runScan", () => {
  it("produces the same map shape a live setAutoScan call would, plus codeRef (T6)", async () => {
    const dir = await fixture({
      "design-sync.config.json": JSON.stringify({ fileKey: "TEST_KEY" }),
      "src/button.css": ".button { background-color: var(--color-brand); }",
    });

    let written: { path: string; contents: string } | undefined;
    const artifact = await runScan(
      { cwd: dir, out: "tokens.json" },
      testDeps({
        write: async (path, contents) => {
          written = { path, contents };
        },
      }),
    );

    expect(artifact.map[".button"]).toEqual({ "background-color": "color-brand" });
    expect(artifact.themeVars).toEqual({});
    expect(artifact.components).toEqual([]);
    expect(artifact.customProperties).toEqual({});

    expect(written?.path).toBe("tokens.json");
    expect(JSON.parse(written!.contents)).toEqual(artifact);
  });

  it("stamps codeRef from the resolver, and scannedAt/addonVersion from its own deps (T7)", async () => {
    const dir = await fixture({ "design-sync.config.json": JSON.stringify({ fileKey: "TEST_KEY" }) });
    const artifact = await runScan({ cwd: dir, out: "tokens.json" }, testDeps());
    expect(artifact.codeRef).toBe("stub-sha");
    expect(artifact.scannedAt).toBe("2026-08-07T00:00:00.000Z");
    expect(artifact.addonVersion).toBe("0.0.99-test");
  });

  it("passes an explicit --code-ref through to the resolver, which is where 'explicit wins' actually lives", async () => {
    const dir = await fixture({ "design-sync.config.json": JSON.stringify({ fileKey: "TEST_KEY" }) });
    const artifact = await runScan(
      { cwd: dir, out: "tokens.json", codeRef: "explicit-sha" },
      testDeps(), // the default stub's resolver is `explicit ?? "stub-sha"`, same contract as the real one
    );
    expect(artifact.codeRef).toBe("explicit-sha");
  });

  it("writes a summary line naming the output path", async () => {
    const dir = await fixture({ "design-sync.config.json": JSON.stringify({ fileKey: "TEST_KEY" }) });
    const lines: string[] = [];
    await runScan({ cwd: dir, out: "tokens.json" }, testDeps({ stderr: (t) => lines.push(t) }));
    expect(lines.some((l) => l.includes("tokens.json"))).toBe(true);
  });

  it("propagates a missing config rather than writing an empty artifact", async () => {
    // Unlike the live preset (non-fatal, falls back to an empty AutoScan — a
    // human is watching the terminal), a hosted artifact silently empty on
    // error is indistinguishable from "this codebase truly declares nothing"
    // to whatever reads it unattended later. Fail loudly instead.
    const dir = await mkdtemp(join(tmpdir(), "design-sync-scan-command-"));
    dirs.push(dir);
    await expect(runScan({ cwd: dir, out: "tokens.json" }, testDeps())).rejects.toThrow(
      /No config found/,
    );
  });
});
