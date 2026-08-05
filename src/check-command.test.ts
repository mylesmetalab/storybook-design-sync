import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriftReport } from "./dimensions/types.js";
import type { BulkStoryOutcome } from "./bulk-run.js";
import {
  DEFAULT_STORYBOOK_URL,
  parseCheckArgs,
  resolveStorybookUrl,
  runCheck,
  versionNotice,
  type CheckDeps,
  type CheckOptions,
} from "./check-command.js";
import { CHECK_EXIT } from "./check-report.js";
import { HeadlessSetupError, type HeadlessRunResult } from "./headless-check.js";
import { BrowserUnavailableError } from "./headless-driver.js";

function options(over: Partial<CheckOptions> = {}): CheckOptions {
  return {
    url: "http://localhost:6006",
    stories: [],
    components: [],
    dualMode: false,
    json: false,
    includeReports: false,
    headed: false,
    quiet: true,
    ...over,
  };
}

function report(over: Partial<DriftReport> = {}): DriftReport {
  return {
    storyId: "ui-button--primary",
    nodeId: "1:2",
    generatedAt: "2026-07-31T00:00:00.000Z",
    dimensions: [],
    ...over,
  };
}

function result(
  outcomes: Array<BulkStoryOutcome<DriftReport>>,
  over: Partial<HeadlessRunResult> = {},
): HeadlessRunResult {
  return {
    outcomes,
    warm: { ms: 10 },
    fileKey: "KEY",
    nodeIds: {},
    server: { apply: "off", fileKey: "KEY", addonVersion: "0.0.45" },
    startedAt: 0,
    finishedAt: 1000,
    ...over,
  };
}

interface Harness {
  deps: CheckDeps;
  stdout: string[];
  stderr: string[];
  written: Array<{ path: string; contents: string }>;
}

function harness(run: CheckDeps["run"], version = "0.0.45"): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const written: Array<{ path: string; contents: string }> = [];
  return {
    stdout,
    stderr,
    written,
    deps: {
      run,
      version: () => Promise.resolve(version),
      write: (path, contents) => {
        written.push({ path, contents });
        return Promise.resolve();
      },
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  };
}

describe("runCheck — exit codes", () => {
  it("returns 0 for a clean run", async () => {
    const h = harness(() =>
      Promise.resolve(
        result([{ storyId: "ui-button--primary", durationMs: 5, report: report() }]),
      ),
    );
    await expect(runCheck(options(), h.deps)).resolves.toBe(CHECK_EXIT.Clean);
  });

  it("returns 1 for drift", async () => {
    const h = harness(() =>
      Promise.resolve(
        result([
          {
            storyId: "ui-button--primary",
            durationMs: 5,
            report: report({
              dimensions: [
                {
                  kind: "token-value",
                  property: "background-color",
                  codeValue: "#fff",
                  figmaValue: "#000",
                  status: "drift",
                },
              ],
            }),
          },
        ]),
      ),
    );
    await expect(runCheck(options(), h.deps)).resolves.toBe(CHECK_EXIT.Drift);
  });

  it("returns 2 when a Figma read failed — an unreadable Figma is never an exit 0", async () => {
    const h = harness(() =>
      Promise.resolve(
        result([
          {
            storyId: "ui-button--primary",
            durationMs: 5,
            report: report({
              incomplete: {
                reason: "Figma rate-limited the request",
                targets: ["file variables"],
                detail: "429; retry after 60s",
              },
            }),
          },
        ]),
      ),
    );
    await expect(runCheck(options(), h.deps)).resolves.toBe(CHECK_EXIT.IncompleteCoverage);
  });

  it("returns 3 — not 0, and not 2 — when the check could not run at all", async () => {
    // Nothing was compared. A CI job must not be able to read "Storybook was not
    // running" or "nothing is registered" as "the design matches".
    const setup = harness(() => Promise.reject(new HeadlessSetupError("nothing is registered")));
    await expect(runCheck(options(), setup.deps)).resolves.toBe(CHECK_EXIT.CouldNotRun);
    expect(setup.stderr.join("")).toContain("nothing is registered");

    const browser = harness(() => Promise.reject(new BrowserUnavailableError("no Playwright")));
    await expect(runCheck(options(), browser.deps)).resolves.toBe(CHECK_EXIT.CouldNotRun);

    const unknown = harness(() => Promise.reject(new Error("socket hang up")));
    await expect(runCheck(options(), unknown.deps)).resolves.toBe(CHECK_EXIT.CouldNotRun);
    expect(unknown.stderr.join("")).toContain("not a verdict on drift");
  });
});

describe("runCheck — output", () => {
  const clean = () =>
    Promise.resolve(result([{ storyId: "ui-button--primary", durationMs: 5, report: report() }]));

  it("prints nothing to stdout unless --json is passed", async () => {
    const h = harness(clean);
    await runCheck(options(), h.deps);
    expect(h.stdout).toEqual([]);
  });

  it("puts the JSON document on stdout and the summary on stderr, so it pipes", async () => {
    const h = harness(clean);
    await runCheck(options({ json: true, quiet: false }), h.deps);
    const parsed = JSON.parse(h.stdout.join(""));
    expect(parsed.tool).toBe("@metalab/storybook-design-sync");
    expect(parsed.exitCode).toBe(0);
    // Anything human belongs on stderr; `design-sync check --json | jq` must work.
    expect(h.stderr.join("")).toContain("PASS");
    expect(h.stdout.join("")).not.toContain("PASS");
  });

  it("writes the document to --out", async () => {
    const h = harness(clean);
    await runCheck(options({ out: "drift.json" }), h.deps);
    expect(h.written).toHaveLength(1);
    expect(h.written[0]!.path).toBe("drift.json");
    expect(JSON.parse(h.written[0]!.contents).schema).toBe(1);
  });

  it("reports the version the Storybook process is running, not the CLI's", async () => {
    // #62 one process out: a running dev server keeps serving the bundle it
    // started with, so the report is that version's answer.
    const h = harness(
      () =>
        Promise.resolve(
          result([{ storyId: "s", durationMs: 1, report: report({ storyId: "s" }) }], {
            server: { apply: "off", fileKey: "KEY", addonVersion: "0.0.43" },
          }),
        ),
      "0.0.45",
    );
    await runCheck(options({ quiet: false }), h.deps);
    const text = h.stderr.join("");
    expect(text).toContain("VERSION SKEW");
    expect(text).toContain("this CLI is 0.0.45");
    expect(text).toContain("Storybook process is running 0.0.43");
  });

  it("says nothing about versions when they agree", async () => {
    const h = harness(clean, "0.0.45");
    await runCheck(options({ quiet: false }), h.deps);
    expect(h.stderr.join("")).not.toContain("VERSION SKEW");
  });
});

describe("parseCheckArgs", () => {
  it("leaves url unset when --url isn't passed, and defaults everything else to a single-mode run", () => {
    // `url` is resolved separately, by `resolveStorybookUrl` — flag → config →
    // default (2.2, NEXT-WORK.md / addon#109) — so parsing alone must not
    // decide it. If it did, the config layer could never see "the flag wasn't
    // passed" versus "the flag was passed as the default's own value".
    expect(parseCheckArgs([])).toEqual({
      stories: [],
      components: [],
      dualMode: false,
      json: false,
      includeReports: false,
      headed: false,
      quiet: false,
    });
  });

  it("still captures an explicit --url", () => {
    expect(parseCheckArgs(["--url", "http://localhost:6007"]).url).toBe("http://localhost:6007");
  });

  it("accumulates repeatable filters", () => {
    const parsed = parseCheckArgs([
      "--story",
      "a--b",
      "--story",
      "c--d",
      "--component",
      "button",
      "--both-modes",
      "--json",
      "--out",
      "r.json",
      "--timeout",
      "12000",
    ]);
    expect(parsed.stories).toEqual(["a--b", "c--d"]);
    expect(parsed.components).toEqual(["button"]);
    expect(parsed.dualMode).toBe(true);
    expect(parsed.json).toBe(true);
    expect(parsed.out).toBe("r.json");
    expect(parsed.budgetMs).toBe(12000);
  });

  it("rejects an unknown flag by naming the ones it accepts", () => {
    // Thrown, and mapped to exit 3 by `cli.ts` — a mistyped flag must never be
    // reported as a drift verdict.
    expect(() => parseCheckArgs(["--stories", "src/**"])).toThrow(/Unknown argument: --stories/);
    expect(() => parseCheckArgs(["--url"])).toThrow(/--url requires a value/);
    expect(() => parseCheckArgs(["--timeout", "nope"])).toThrow(/positive number/);
  });
});

/**
 * 2.2 (NEXT-WORK.md, addon#109) — `--url` → `storybookUrl` in
 * design-sync.config.json → the conventional dev default, in that order.
 * `check` has never required a config file, so a missing one must stay
 * silent; a config file that exists but fails to parse is different — the
 * user tried to configure something, so `warn` fires (non-fatal: the run
 * still proceeds against the default).
 */
describe("resolveStorybookUrl — flag → config → default", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });
  async function configDir(config: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "design-sync-check-url-"));
    dirs.push(dir);
    if (config !== undefined) {
      await writeFile(join(dir, "design-sync.config.json"), JSON.stringify(config), "utf8");
    }
    return dir;
  }

  it("an explicit --url wins outright, without even reading the config", async () => {
    const dir = await configDir({ fileKey: "abc", storybookUrl: "http://localhost:9999" });
    expect(await resolveStorybookUrl("http://localhost:7000", { cwd: dir })).toBe(
      "http://localhost:7000",
    );
  });

  it("falls back to storybookUrl in config when no flag was passed", async () => {
    const dir = await configDir({ fileKey: "abc", storybookUrl: "http://localhost:7000" });
    expect(await resolveStorybookUrl(undefined, { cwd: dir })).toBe("http://localhost:7000");
  });

  it("falls back to the conventional default when config has no storybookUrl", async () => {
    const dir = await configDir({ fileKey: "abc" });
    expect(await resolveStorybookUrl(undefined, { cwd: dir })).toBe(DEFAULT_STORYBOOK_URL);
  });

  it("falls back to the default silently when there is no config file at all", async () => {
    const dir = await configDir(undefined);
    const warnings: string[] = [];
    expect(await resolveStorybookUrl(undefined, { cwd: dir, warn: (m) => warnings.push(m) })).toBe(
      DEFAULT_STORYBOOK_URL,
    );
    expect(warnings).toEqual([]);
  });

  it("warns (but still falls back) when a config file exists but fails to parse", async () => {
    const dir = await configDir(undefined);
    await writeFile(join(dir, "design-sync.config.json"), "{ not json", "utf8");
    const warnings: string[] = [];
    expect(await resolveStorybookUrl(undefined, { cwd: dir, warn: (m) => warnings.push(m) })).toBe(
      DEFAULT_STORYBOOK_URL,
    );
    expect(warnings.join("")).toContain("storybookUrl");
  });
});

describe("versionNotice", () => {
  it("mentions a package upgraded under a running server", () => {
    const notice = versionNotice(
      result([], { server: { apply: "off", fileKey: "K", addonVersion: "0.0.43", installedVersion: "0.0.45" } }),
      "0.0.45",
    );
    expect(notice).toContain("with 0.0.45 on disk — it was upgraded while running");
  });

  it("is silent when the server did not report a version", () => {
    expect(versionNotice(result([], { server: { apply: "off", fileKey: "K" } }), "0.0.45")).toBe("");
  });
});
