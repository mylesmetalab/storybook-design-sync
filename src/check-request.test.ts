import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { glob } from "tinyglobby";

import { EVENTS, type CheckDriftRequestPayload } from "./channels.js";
import {
  buildCheckDriftRequest,
  dualModeNames,
  readStoryArgs,
  readStoryDesignSync,
  requestStoryCheck,
  storyCheckContext,
  type StoryDataReader,
} from "./check-request.js";

const SRC = dirname(fileURLToPath(import.meta.url));

/**
 * A story index entry as Storybook's `api.getData(storyId)` returns one. `args`
 * and `parameters` are present on a *prepared* story, which every story the bulk
 * loop checks is: it waits for STORY_RENDERED before asking.
 */
function fakeApi(
  entries: Record<string, { parameters?: unknown; args?: unknown } | undefined>,
): StoryDataReader {
  return { getData: (storyId: string) => entries[storyId] };
}

/** The story that reproduced #80: a `cva()` button whose variant lives in args. */
const NEUTRAL_BUTTON = {
  parameters: {
    layout: "centered",
    designSync: {
      target: ".btn",
      tokens: { "background-color": "secondary" },
      modeAttribute: "data-theme",
      modeSwitch: { kind: "class", on: "html" },
      pipelineUrl: "http://127.0.0.1:7099",
    },
  },
  args: { variant: "neutral", size: "medium", children: "Cancel" },
};

function capture(): { emit: (event: string, ...args: unknown[]) => void; sent: unknown[][] } {
  const sent: unknown[][] = [];
  return { emit: (event, ...args) => void sent.push([event, ...args]), sent };
}

describe("check request — the two paths cannot diverge", () => {
  /**
   * Reproduces #80 directly. Before the unification the bulk path built
   * `{ storyId, dualMode?, modeSwitch?, bulk: true }` by hand and never read the
   * story's args, so the `cva()` resolver could not tell which variant was
   * rendering and reported binding rows as drift: 7 rows from Check all against
   * 4 from Check drift on `ui-button--neutral`.
   */
  it("a bulk request carries the story's args", () => {
    const api = fakeApi({ "ui-button--neutral": NEUTRAL_BUTTON });
    const payload = buildCheckDriftRequest(
      storyCheckContext(api, "ui-button--neutral", { dualMode: true, trigger: "bulk" }),
    );
    expect(payload.args).toEqual({ variant: "neutral", size: "medium", children: "Cancel" });
  });

  /**
   * `args` was not the only casualty — the bulk path also dropped `target` (which
   * keys the CSS-scanner binding lookup *and* picks the element to snapshot),
   * `tokens` and `modeAttribute`, and took `modeSwitch` from whatever story the
   * panel happened to be sitting on rather than the story being checked.
   */
  it("a bulk request carries every per-story declaration", () => {
    const api = fakeApi({ "ui-button--neutral": NEUTRAL_BUTTON });
    const payload = buildCheckDriftRequest(
      storyCheckContext(api, "ui-button--neutral", { dualMode: false, trigger: "bulk" }),
    );
    expect(payload.target).toBe(".btn");
    expect(payload.tokens).toEqual({ "background-color": "secondary" });
    expect(payload.modeAttribute).toBe("data-theme");
    expect(payload.modeSwitch).toEqual({ kind: "class", on: "html" });
  });

  /**
   * The durable assertion. One story, two triggers, one report: the requests must
   * differ only by `bulk`, which is the single field the two paths are *meant* to
   * disagree on (it selects cache-served vs revalidated).
   *
   * This holds structurally — both paths call `requestStoryCheck` — and the source
   * guards below are what keep it holding. A field added to the builder reaches
   * both triggers or neither; a second construction site fails the last test in
   * this file.
   */
  it("an explicit check and a bulk check request the same thing, bar `bulk`", () => {
    const api = fakeApi({ "ui-button--neutral": NEUTRAL_BUTTON });
    const explicit = capture();
    const bulk = capture();

    const explicitPayload = requestStoryCheck(explicit.emit, api, "ui-button--neutral", {
      dualMode: true,
      trigger: "explicit",
    });
    const bulkPayload = requestStoryCheck(bulk.emit, api, "ui-button--neutral", {
      dualMode: true,
      trigger: "bulk",
    });

    // Both went out on the same channel event.
    expect(explicit.sent).toEqual([[EVENTS.CheckDriftRequest, explicitPayload]]);
    expect(bulk.sent).toEqual([[EVENTS.CheckDriftRequest, bulkPayload]]);

    expect(explicitPayload.bulk).toBeUndefined();
    expect(bulkPayload.bulk).toBe(true);

    const { bulk: _dropped, ...bulkRest } = bulkPayload;
    expect(bulkRest).toEqual(explicitPayload);
    // Key sets, not just values: a field present-but-undefined on one side would
    // pass a value comparison and still change the wire payload's cache hash.
    expect(Object.keys(bulkRest).sort()).toEqual(Object.keys(explicitPayload).sort());
  });

  it("the same equivalence holds for a story that declares nothing", () => {
    const api = fakeApi({ "welcome--default": { parameters: {}, args: {} } });
    const explicit = buildCheckDriftRequest(
      storyCheckContext(api, "welcome--default", { dualMode: false, trigger: "explicit" }),
    );
    const bulk = buildCheckDriftRequest(
      storyCheckContext(api, "welcome--default", { dualMode: false, trigger: "bulk" }),
    );
    // Byte-identical to what the old code sent for an undeclared story, so cache
    // hashes for existing consumers don't move.
    expect(explicit).toEqual({ storyId: "welcome--default" });
    expect(bulk).toEqual({ storyId: "welcome--default", bulk: true });
  });

  it("each story in a bulk run gets its own declarations, not the panel's", () => {
    const api = fakeApi({
      "ui-button--neutral": NEUTRAL_BUTTON,
      "ui-card--default": {
        parameters: { designSync: { target: ".card", modeSwitch: "attribute" } },
        args: { elevated: true },
      },
    });
    const neutral = buildCheckDriftRequest(
      storyCheckContext(api, "ui-button--neutral", { dualMode: true, trigger: "bulk" }),
    );
    const card = buildCheckDriftRequest(
      storyCheckContext(api, "ui-card--default", { dualMode: true, trigger: "bulk" }),
    );
    expect(neutral.target).toBe(".btn");
    expect(card.target).toBe(".card");
    expect(card.modeSwitch).toBe("attribute");
    expect(card.args).toEqual({ elevated: true });
  });
});

describe("check request — payload shape", () => {
  const api = fakeApi({ "ui-button--neutral": NEUTRAL_BUTTON });

  it("omits dualMode unless asked for", () => {
    const payload = buildCheckDriftRequest(
      storyCheckContext(api, "ui-button--neutral", { dualMode: false, trigger: "explicit" }),
    );
    expect(payload.dualMode).toBeUndefined();
    expect("dualMode" in payload).toBe(false);
  });

  it("relays a falsy-but-declared modeSwitch, because declared ≠ detect", () => {
    const declaredNull = fakeApi({ s: { parameters: { designSync: { modeSwitch: null } } } });
    const payload = buildCheckDriftRequest(
      storyCheckContext(declaredNull, "s", { dualMode: false, trigger: "explicit" }),
    );
    expect("modeSwitch" in payload).toBe(true);
    expect(payload.modeSwitch).toBeNull();
  });

  it("treats empty args as no args", () => {
    const empty = fakeApi({ s: { parameters: {}, args: {} } });
    expect(readStoryArgs(empty, "s")).toBeUndefined();
  });

  it("reads live args, including control edits", () => {
    // Storybook writes STORY_ARGS_UPDATED back onto the same index entry
    // `useArgs()` reads, so a control edit is visible here too.
    const entry = { parameters: {}, args: { variant: "neutral" } as Record<string, unknown> };
    const api2 = fakeApi({ s: entry });
    entry.args = { variant: "subtle" };
    expect(readStoryArgs(api2, "s")).toEqual({ variant: "subtle" });
  });
});

describe("check request — unreadable context is reported, never guessed", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("warns when the manager API has no getData at all", () => {
    // `sbApi?.getStoryData?.(...)` — the name this addon used in two places — is
    // not on the Storybook 10 API, so it silently evaluated to undefined every
    // time. A context that can't be read must say so rather than look like a
    // story with nothing declared.
    const ctx = storyCheckContext({} as StoryDataReader, "ui-button--getdata-missing", {
      dualMode: false,
      trigger: "bulk",
    });
    expect(ctx.designSync).toEqual({});
    expect(ctx.args).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("could not read the story's parameters");
  });

  it("warns when the story is not in the index", () => {
    storyCheckContext(fakeApi({}), "ui-button--absent", { dualMode: false, trigger: "explicit" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns once per story, not once per check", () => {
    const api = fakeApi({});
    storyCheckContext(api, "ui-button--repeat", { dualMode: false, trigger: "explicit" });
    storyCheckContext(api, "ui-button--repeat", { dualMode: false, trigger: "bulk" });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("survives a non-object designSync or args", () => {
    const junk = fakeApi({ s: { parameters: { designSync: "nope" }, args: 7 } });
    expect(readStoryDesignSync(junk, "s")).toEqual({});
    expect(readStoryArgs(junk, "s")).toBeUndefined();
  });

  it("warns once about a malformed `modes` and falls back to the documented default", () => {
    expect(dualModeNames("s", ["dark"])).toBeUndefined();
    expect(dualModeNames("s", ["day", "night"])).toEqual(["day", "night"]);
    expect(dualModeNames("s", undefined)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("sends a story's declared mode names on both paths", () => {
    const api = fakeApi({ s: { parameters: { designSync: { modes: ["day", "night"] } } } });
    const explicit = buildCheckDriftRequest(
      storyCheckContext(api, "s", { dualMode: true, trigger: "explicit" }),
    );
    const bulk = buildCheckDriftRequest(
      storyCheckContext(api, "s", { dualMode: true, trigger: "bulk" }),
    );
    expect(explicit.dualModes).toEqual(["day", "night"]);
    expect(bulk.dualModes).toEqual(["day", "night"]);
    // Only meaningful for a two-mode check, so not sent for a single-mode one.
    const single = buildCheckDriftRequest(
      storyCheckContext(api, "s", { dualMode: false, trigger: "explicit" }),
    );
    expect("dualModes" in single).toBe(false);
  });

  it("warns once about deprecated story tokens on either path", () => {
    const api = fakeApi({
      "ui-tokens--legacy": { parameters: { designSync: { tokens: { color: "fg" } } } },
    });
    const sink = capture();
    requestStoryCheck(sink.emit, api, "ui-tokens--legacy", { dualMode: false, trigger: "bulk" });
    requestStoryCheck(sink.emit, api, "ui-tokens--legacy", {
      dualMode: false,
      trigger: "explicit",
    });
    const deprecations = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("designSync.tokens is deprecated"),
    );
    // The bulk path never warned before, because it never read the param.
    expect(deprecations).toHaveLength(1);
    expect(sink.sent).toHaveLength(2);
  });
});

/**
 * The structural half of the invariant. The value assertions above only bind the
 * two paths together while both actually go through `requestStoryCheck`; these
 * assert that at source level, so re-introducing a hand-built payload fails here
 * instead of in a consumer's panel.
 */
describe("check request — one construction site", () => {
  it("only check-request.ts builds or emits a CheckDriftRequest", async () => {
    const files = await glob(["**/*.ts", "**/*.tsx"], { cwd: SRC, absolute: true, onlyFiles: true });
    const offenders: string[] = [];
    for (const file of files) {
      const name = relative(SRC, file);
      if (name === "check-request.ts" || name.includes(".test.")) continue;
      const text = await readFile(file, "utf8");
      if (/emit\(\s*EVENTS\.CheckDriftRequest/.test(text)) {
        offenders.push(`${name}: emits EVENTS.CheckDriftRequest directly`);
      }
      if (/:\s*CheckDriftRequestPayload\s*=/.test(text)) {
        offenders.push(`${name}: constructs a CheckDriftRequestPayload`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The other half of "one story, one verdict" (#80): the Check-all row's columns
   * must be counted in the same unit the per-story table renders — findings, not
   * comparisons. `countRowStatuses` is that unit; a return to `countStatuses` over
   * raw dimensions would re-inflate the summary's drift column against the table
   * it summarises. The arithmetic itself is asserted in `row-triage.test.ts`.
   */
  it("the bulk summary counts rows, not dimensions", async () => {
    const manager = await readFile(join(SRC, "manager.tsx"), "utf8");
    expect(manager).toMatch(/countRowStatuses\(groupDimensions\(visibleDimensions\(report\)\)\)/);
    expect(manager).not.toMatch(/countStatuses\(/);
  });

  it("the manager reaches the channel through requestStoryCheck", async () => {
    const manager = await readFile(join(SRC, "manager.tsx"), "utf8");
    const calls = manager.match(/requestStoryCheck\(/g) ?? [];
    // Exactly two: Check drift, and one story of a Check all run.
    expect(calls).toHaveLength(2);
    expect(manager).toContain('trigger: "explicit"');
    expect(manager).toContain('trigger: "bulk"');
  });

  /**
   * v0.0.45 added a **third caller** — `design-sync check`, the headless bulk run
   * — and a third caller is fine. A third *construction site* is not: the payload
   * is what the two paths silently disagreed about twice in one release cycle
   * (#78, #80), and a CLI that assembled its own would reintroduce the same class
   * of bug with a second consumer (CI) that has no panel to contradict it.
   *
   * The generic guard above already forbids emitting or typing the payload
   * anywhere else. This pins the positive obligation: the headless path reaches
   * the channel through `requestStoryCheck`, once.
   */
  it("the headless check reaches the channel through requestStoryCheck", async () => {
    const headless = await readFile(join(SRC, "headless-check.ts"), "utf8");
    // Call sites only — a `requestStoryCheck(...)` inside a doc comment is prose.
    expect(headless.match(/^\s*requestStoryCheck\(/gm) ?? []).toHaveLength(1);
    expect(headless).toContain('trigger: "bulk"');
    // And it reuses the panel's sequencing and budget rather than its own, so a
    // story that times out headlessly times out in the panel too.
    expect(headless).toContain("runBulkCheck");
    expect(headless).toContain("bulkBudgetMs");
  });
});

/**
 * The other half of "one story, one verdict" for the CLI: the panel and
 * `design-sync check` must partition, group and count a report identically, or
 * their numbers disagree over the same story with nothing to say which is right.
 *
 * Asserted at source level because the arithmetic itself is already covered
 * (`row-triage.test.ts`, `check-report.test.ts`); what these protect is that
 * neither consumer grows a private copy of the filter or the tally.
 */
describe("one triage, two consumers", () => {
  it("only row-triage.ts decides which dimensions are visible", async () => {
    const files = await glob(["**/*.ts", "**/*.tsx"], { cwd: SRC, absolute: true, onlyFiles: true });
    const offenders: string[] = [];
    for (const file of files) {
      const name = relative(SRC, file);
      if (name === "row-triage.ts" || name.includes(".test.")) continue;
      const text = await readFile(file, "utf8");
      if (/HIDDEN_DIMENSION_KINDS\s*[:=]/.test(text)) {
        offenders.push(`${name}: declares its own HIDDEN_DIMENSION_KINDS`);
      }
      if (/function visibleDimensions\s*\(/.test(text)) {
        offenders.push(`${name}: declares its own visibleDimensions`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the CLI counts rows in the same unit the panel's table renders", async () => {
    const reportSource = await readFile(join(SRC, "check-report.ts"), "utf8");
    expect(reportSource).toMatch(/countRowStatuses\(groupDimensions\(visibleDimensions\(/);
    // `countStatuses` counts comparisons, not findings — the inflation #80 fixed.
    expect(reportSource).not.toMatch(/\bcountStatuses\(/);
  });

  /**
   * Both bulk loops must agree on which stories need navigating to. They did not:
   * neither skipped the story already on screen, and the panel therefore timed out
   * on it (`planBulkNavigation`). Sharing one plan is the fix; this pins it.
   */
  it("both bulk loops decide navigation with planBulkNavigation", async () => {
    for (const file of ["manager.tsx", "headless-check.ts"]) {
      const text = await readFile(join(SRC, file), "utf8");
      expect(text).toContain("planBulkNavigation(");
      expect(text).toContain("alreadyRendered");
    }
  });

  it("the CLI never writes, in any apply mode", async () => {
    // `check` reads and reports. There is no code path from it to an Edit, so
    // `apply: "experimental"` changes nothing about it.
    for (const file of ["check-command.ts", "check-report.ts", "headless-check.ts", "headless-driver.ts"]) {
      const text = await readFile(join(SRC, file), "utf8");
      expect(text).not.toMatch(/EVENTS\.ApplyCodeRequest|applyCodeEdit|buildEdit\(/);
    }
  });
});

describe("check request — contract coverage", () => {
  /**
   * Every optional field on `CheckDriftRequestPayload` other than `bulk` is
   * per-story context, and a check path that omits one reports on a story it
   * hasn't fully described. Listed explicitly so adding a field to the wire
   * contract without teaching the builder to send it fails here.
   */
  it("populates every per-story field the wire contract declares", () => {
    const api = fakeApi({
      s: {
        parameters: {
          designSync: {
            target: ".btn",
            tokens: { color: "fg" },
            modeAttribute: "data-theme",
            modeSwitch: "class",
            modes: ["light", "dark"],
          },
        },
        args: { variant: "neutral" },
      },
    });
    const payload = buildCheckDriftRequest(
      storyCheckContext(api, "s", { dualMode: true, trigger: "bulk" }),
    );
    const declared: Array<keyof CheckDriftRequestPayload> = [
      "storyId",
      "target",
      "tokens",
      "modeAttribute",
      "modeSwitch",
      "args",
      "dualMode",
      "dualModes",
      "bulk",
    ];
    expect(Object.keys(payload).sort()).toEqual([...declared].sort());
  });
});
