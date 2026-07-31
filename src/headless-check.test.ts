import { beforeEach, describe, expect, it, vi } from "vitest";
import { EVENTS } from "./channels.js";
import type { DriftReport } from "./dimensions/types.js";
import { installHeadlessBridge } from "./headless-bridge.js";
import {
  BRIDGE_EVENTS,
  HeadlessChannel,
  HeadlessSetupError,
  checkStoryHeadless,
  listRegisteredStories,
  preparedReader,
  previewUrl,
  readServerConfig,
  renderFailure,
  runHeadlessCheck,
  selectStories,
  warmSharedCaches,
  type HeadlessDriver,
} from "./headless-check.js";
import {
  SET_CURRENT_STORY,
  STORY_MISSING,
  STORY_PREPARED,
  STORY_RENDERED,
  STORY_THREW_EXCEPTION,
} from "./storybook-events.js";
import { requestStoryCheck } from "./check-request.js";

/**
 * A fake Storybook preview + addon server, driven through the real bridge.
 *
 * Fidelity matters here more than convenience: the bridge is genuinely installed
 * on a fake global, the emit/drain expressions are genuinely evaluated, and the
 * "server" replies on the same channel the real one broadcasts over. So these
 * tests exercise the actual wire protocol rather than a mock of it — the thing
 * they exist to protect is that `check` and the panel ask and answer identically.
 */
interface FakePreviewOptions {
  registry?: Array<{ storyId: string; nodeId: string }>;
  fileKey?: string;
  registryError?: string;
  addonVersion?: string;
  /** Per-story behaviour when `setCurrentStory` arrives. */
  render?: (storyId: string) => "ok" | "missing" | "threw";
  /** Per-story behaviour when a check request arrives. */
  respond?: (storyId: string) => { report?: DriftReport; error?: string } | "silent";
  /** Emit `storyPrepared` before `storyRendered` (the real preview's order). */
  preparedFirst?: boolean;
  storyParams?: Record<string, unknown>;
  storyArgs?: Record<string, Record<string, unknown>>;
  warmDone?: { ms: number; warmed?: boolean; error?: string } | "silent";
}

interface ChannelLike {
  on(type: string, fn: (...args: unknown[]) => void): void;
  emit(type: string, ...args: unknown[]): void;
}

function report(storyId: string, extra: Partial<DriftReport> = {}): DriftReport {
  return {
    storyId,
    nodeId: "1:2",
    generatedAt: "2026-07-31T00:00:00.000Z",
    dimensions: [],
    ...extra,
  };
}

class FakePreview implements HeadlessDriver {
  g: Record<string, unknown> = {};
  navigations: string[] = [];
  /** Everything the page emitted, in order. The request payloads live here. */
  sent: Array<{ type: string; args: unknown[] }> = [];

  constructor(private readonly opts: FakePreviewOptions = {}) {}

  async navigate(url: string): Promise<void> {
    this.navigations.push(url);
    // A page load means a fresh global and a fresh bridge, exactly as an
    // `addInitScript` gives. The Node side must forget its sequence number.
    this.g = {};
    installHeadlessBridge(this.g, {
      events: BRIDGE_EVENTS,
      storyPreparedEvent: STORY_PREPARED,
    });
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const channel: ChannelLike = {
      on: (type, fn) => {
        const list = listeners.get(type) ?? [];
        list.push(fn);
        listeners.set(type, list);
      },
      emit: (type, ...args) => {
        this.sent.push({ type, args });
        this.serve(type, args, (t, ...a) => {
          for (const fn of listeners.get(t) ?? []) fn(...a);
        });
      },
    };
    this.g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;
    // The boot of a story URL prepares and renders it, before anything asks.
    const id = new URL(url, "http://x").searchParams.get("id");
    if (id) this.renderStory(id, (t, ...a) => {
      for (const fn of listeners.get(t) ?? []) fn(...a);
    });
  }

  evaluate<T>(expression: string): Promise<T> {
    const run = new Function("globalThis", `return ${expression};`) as (
      g: Record<string, unknown>,
    ) => T;
    return Promise.resolve(run(this.g));
  }

  private renderStory(storyId: string, fire: (t: string, ...a: unknown[]) => void): void {
    const outcome = this.opts.render?.(storyId) ?? "ok";
    if (outcome === "missing") {
      fire(STORY_MISSING, storyId);
      return;
    }
    if (outcome === "threw") {
      fire(STORY_THREW_EXCEPTION, { message: "boom" });
      return;
    }
    const prepared = {
      id: storyId,
      parameters: { designSync: this.opts.storyParams ?? {} },
      args: this.opts.storyArgs?.[storyId] ?? {},
    };
    if (this.opts.preparedFirst) {
      fire(STORY_PREPARED, prepared);
      fire(STORY_RENDERED, storyId);
    } else {
      fire(STORY_RENDERED, storyId);
      fire(STORY_PREPARED, prepared);
    }
  }

  private serve(type: string, args: unknown[], fire: (t: string, ...a: unknown[]) => void): void {
    if (type === EVENTS.ConfigRequest) {
      fire(EVENTS.ConfigInfo, {
        apply: "off",
        fileKey: this.opts.fileKey ?? "FILE",
        codeTargetPaths: [],
        ...(this.opts.addonVersion ? { addonVersion: this.opts.addonVersion } : {}),
      });
      return;
    }
    if (type === EVENTS.ListRegisteredRequest) {
      fire(EVENTS.RegisteredStories, {
        stories: this.opts.registry ?? [],
        fileKey: this.opts.fileKey ?? "FILE",
        ...(this.opts.registryError ? { error: this.opts.registryError } : {}),
      });
      return;
    }
    if (type === EVENTS.WarmCacheRequest) {
      if (this.opts.warmDone === "silent") return;
      fire(EVENTS.WarmCacheDone, this.opts.warmDone ?? { ms: 12, warmed: true });
      return;
    }
    if (type === SET_CURRENT_STORY) {
      const payload = args[0] as { storyId: string };
      this.renderStory(payload.storyId, fire);
      return;
    }
    if (type === EVENTS.CheckDriftRequest) {
      const payload = args[0] as { storyId: string };
      const answer = this.opts.respond?.(payload.storyId) ?? { report: report(payload.storyId) };
      if (answer === "silent") return;
      if (answer.error !== undefined) {
        fire(EVENTS.DriftError, { storyId: payload.storyId, message: answer.error });
        return;
      }
      fire(EVENTS.DriftReport, { report: answer.report });
    }
  }
}

/** A channel whose sleep is instant and whose clock we control. */
function testChannel(driver: HeadlessDriver, opts: { step?: number } = {}): HeadlessChannel {
  let clock = 0;
  const step = opts.step ?? 0;
  return new HeadlessChannel(driver, {
    pollMs: 0,
    sleep: () => Promise.resolve(),
    now: () => {
      clock += step;
      return clock;
    },
  });
}

describe("previewUrl", () => {
  it("addresses the preview iframe, and the story by id", () => {
    expect(previewUrl("http://localhost:6006")).toBe("http://localhost:6006/iframe.html");
    expect(previewUrl("http://localhost:6006/", "ui-button--primary")).toBe(
      "http://localhost:6006/iframe.html?viewMode=story&id=ui-button--primary",
    );
    // Ids are escaped: a story id is consumer-authored text, not a URL fragment.
    expect(previewUrl("http://x", "a b/c")).toContain("id=a%20b%2Fc");
  });
});

describe("HeadlessChannel", () => {
  it("keeps an event that arrived before it was awaited", async () => {
    const driver = new FakePreview({ preparedFirst: true });
    await driver.navigate(previewUrl("http://x", "s"));
    const channel = testChannel(driver);
    // `storyPrepared` was logged first; waiting for `storyRendered` must not
    // discard it, or every story would time out on its parameters.
    await channel.waitFor({
      match: (e) => e.type === STORY_RENDERED && e.args[0] === "s",
      timeoutMs: 1000,
      describe: "render",
    });
    const prepared = await channel.waitFor({
      match: (e) => e.type === STORY_PREPARED,
      timeoutMs: 1000,
      describe: "prepared",
    });
    expect((prepared.args[0] as { id: string }).id).toBe("s");
  });

  it("consumes a matched event exactly once", async () => {
    const driver = new FakePreview();
    await driver.navigate(previewUrl("http://x", "s"));
    // A clock that advances on every read, so the second wait runs out of budget
    // instead of spinning: the point is that the first event is gone, not slow.
    const channel = testChannel(driver, { step: 1 });
    await channel.waitFor({
      match: (e) => e.type === STORY_RENDERED,
      timeoutMs: 1000,
      describe: "render",
    });
    await expect(
      channel.waitFor({
        match: (e) => e.type === STORY_RENDERED,
        timeoutMs: 2,
        describe: "a second render",
      }),
    ).rejects.toThrow(/Timed out .* waiting for a second render/);
  });

  it("reports a lost bridge as a lost bridge, not as a timeout", async () => {
    const driver = new FakePreview();
    await driver.navigate(previewUrl("http://x"));
    driver.g = {};
    const channel = testChannel(driver);
    await expect(channel.poll()).rejects.toThrow(/bridge is not installed/);
  });

  it("refuses to emit when the page has no channel", async () => {
    // A page that loaded but never installed a Storybook channel: the bridge is
    // there, unattached. Saying "not available" beats a silent no-op that would
    // surface later as an unexplained timeout.
    const driver = new FakePreview();
    await driver.navigate(previewUrl("http://x"));
    driver.g = {};
    installHeadlessBridge(driver.g, { events: [], storyPreparedEvent: STORY_PREPARED });
    const channel = testChannel(driver);
    await expect(channel.emit("x")).rejects.toThrow(/preview channel is not available/);
  });
});

describe("renderFailure", () => {
  it("names the cause instead of leaving a timeout to speak for it", () => {
    expect(renderFailure({ seq: 1, type: STORY_MISSING, args: [] }, "ui-button--gone")).toMatch(
      /no story with id "ui-button--gone".*design-sync audit/s,
    );
    expect(
      renderFailure({ seq: 1, type: STORY_THREW_EXCEPTION, args: [{ message: "bad prop" }] }, "s"),
    ).toContain("bad prop");
    expect(renderFailure({ seq: 1, type: STORY_RENDERED, args: ["s"] }, "s")).toBeUndefined();
  });
});

describe("listRegisteredStories", () => {
  it("reads the registry through the addon server, never off disk", async () => {
    const driver = new FakePreview({
      registry: [{ storyId: "ui-button--primary", nodeId: "1:1" }],
      fileKey: "KEY",
    });
    await driver.navigate(previewUrl("http://x"));
    const channel = testChannel(driver);
    const listing = await listRegisteredStories(channel, 1000);
    expect(listing).toEqual({
      stories: [{ storyId: "ui-button--primary", nodeId: "1:1" }],
      fileKey: "KEY",
    });
    expect(driver.sent.map((s) => s.type)).toContain(EVENTS.ListRegisteredRequest);
  });

  it("surfaces a registry the server could not read", async () => {
    const driver = new FakePreview({ registryError: "ENOENT registry.json" });
    await driver.navigate(previewUrl("http://x"));
    await expect(listRegisteredStories(testChannel(driver), 1000)).rejects.toThrow(
      /could not read the registry: ENOENT/,
    );
  });
});

describe("readServerConfig", () => {
  it("reports the version the Storybook process is executing", async () => {
    const driver = new FakePreview({ addonVersion: "0.0.44" });
    await driver.navigate(previewUrl("http://x"));
    const config = await readServerConfig(testChannel(driver), 1000);
    expect(config.addonVersion).toBe("0.0.44");
    expect(config.apply).toBe("off");
  });
});

describe("warmSharedCaches", () => {
  it("carries the warm-up's own cost and error, and never rejects", async () => {
    const driver = new FakePreview({ warmDone: { ms: 900, error: "no PAT" } });
    await driver.navigate(previewUrl("http://x"));
    await expect(warmSharedCaches(testChannel(driver), 1000)).resolves.toEqual({
      ms: 900,
      error: "no PAT",
    });
  });

  it("resolves with an error when the server never answers", async () => {
    // A warm-up that cannot complete makes the run slow, not wrong: each story
    // still fetches what it needs, so this must not abort the run.
    const driver = new FakePreview({ warmDone: "silent" });
    await driver.navigate(previewUrl("http://x"));
    const outcome = await warmSharedCaches(testChannel(driver, { step: 10_000 }), 1);
    expect(outcome.error).toMatch(/Timed out/);
  });
});

describe("checkStoryHeadless", () => {
  it("renders, then asks, then returns the server's report", async () => {
    const driver = new FakePreview();
    await driver.navigate(previewUrl("http://x"));
    const channel = testChannel(driver);
    const result = await checkStoryHeadless({
      channel,
      storyId: "ui-button--primary",
      dualMode: false,
    });
    expect(result.storyId).toBe("ui-button--primary");
    expect(driver.sent.map((s) => s.type)).toEqual([SET_CURRENT_STORY, EVENTS.CheckDriftRequest]);
  });

  it("does not navigate when the page was loaded on the story", async () => {
    const driver = new FakePreview();
    await driver.navigate(previewUrl("http://x", "ui-button--primary"));
    const channel = testChannel(driver);
    await checkStoryHeadless({
      channel,
      storyId: "ui-button--primary",
      dualMode: false,
      alreadyCurrent: true,
    });
    // Storybook answers `setCurrentStory` for the current story with
    // STORY_UNCHANGED and no re-render, so emitting it would hang the wait.
    expect(driver.sent.map((s) => s.type)).toEqual([EVENTS.CheckDriftRequest]);
  });

  it("turns a DriftError into a rejection carrying the server's message", async () => {
    const driver = new FakePreview({ respond: () => ({ error: "Not registered." }) });
    await driver.navigate(previewUrl("http://x"));
    await expect(
      checkStoryHeadless({ channel: testChannel(driver), storyId: "s", dualMode: false }),
    ).rejects.toThrow("Not registered.");
  });

  it("fails on a missing story with the cause, not the budget", async () => {
    const driver = new FakePreview({ render: () => "missing" });
    await expect(
      driver.navigate(previewUrl("http://x")).then(() =>
        checkStoryHeadless({
          channel: testChannel(driver),
          storyId: "ui-button--gone",
          dualMode: false,
        }),
      ),
    ).rejects.toThrow(/no story with id "ui-button--gone"/);
  });

  it("ignores a report for a different story", async () => {
    // A late report from an abandoned check must not be mistaken for this one's —
    // the manager clears its resolver for the same reason.
    const driver = new FakePreview({
      respond: () => ({ report: report("some-other-story") }),
    });
    await driver.navigate(previewUrl("http://x"));
    await expect(
      checkStoryHeadless({
        channel: testChannel(driver, { step: 10_000 }),
        storyId: "s",
        dualMode: false,
        reportTimeoutMs: 1,
      }),
    ).rejects.toThrow(/Timed out .* a drift report for "s"/);
  });
});

/**
 * The invariant the whole command rests on: the request `check` puts on the wire
 * is the request the panel puts on the wire.
 *
 * Both are built by `requestStoryCheck`; what differs is only the reader it is
 * handed — the manager's `api.getData`, or `preparedReader` over the
 * `storyPrepared` event that same index entry is built from. If those two readers
 * ever stopped agreeing, this is where it shows.
 */
describe("headless ↔ panel parity — the request on the wire", () => {
  const params = {
    target: ".btn",
    modeSwitch: "class",
    modes: ["light", "dark"],
    modeAttribute: "data-theme",
    compareCopy: false,
    tokens: { color: "fg" },
  };
  const args = { variant: "primary", size: "sm" };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  for (const dualMode of [false, true]) {
    it(`sends a byte-identical payload to the panel (dualMode: ${dualMode})`, async () => {
      const driver = new FakePreview({
        storyParams: params,
        storyArgs: { "ui-button--primary": args },
      });
      await driver.navigate(previewUrl("http://x"));
      await checkStoryHeadless({
        channel: testChannel(driver),
        storyId: "ui-button--primary",
        dualMode,
      });
      const headless = driver.sent.find((s) => s.type === EVENTS.CheckDriftRequest)!.args[0];

      // The panel's path, with the manager API shape it actually reads.
      const managerSent: unknown[] = [];
      requestStoryCheck(
        (_event, ...rest) => managerSent.push(rest[0]),
        { getData: () => ({ parameters: { designSync: params }, args }) },
        "ui-button--primary",
        { dualMode, trigger: "bulk" },
      );

      expect(headless).toEqual(managerSent[0]);
      // And it really did carry the story's context — the thing #80 dropped.
      expect(headless).toMatchObject({ target: ".btn", args, modeSwitch: "class", bulk: true });
    });
  }

  it("reads the story through preparedReader, which refuses another story's data", () => {
    const reader = preparedReader("a", { id: "a", parameters: {}, args: { x: 1 } });
    expect(reader.getData!("a")).toEqual({ id: "a", parameters: {}, args: { x: 1 } });
    expect(reader.getData!("b")).toBeUndefined();
  });
});

describe("selectStories", () => {
  const registered = [
    { storyId: "ui-button--primary", nodeId: "1" },
    { storyId: "ui-button--neutral", nodeId: "2" },
    { storyId: "ui-card--default", nodeId: "3" },
  ];

  it("selects everything when no filter is given", () => {
    const result = selectStories(registered, { stories: [], components: [] });
    expect(result.selected).toHaveLength(3);
  });

  it("filters by story id and by component", () => {
    expect(
      selectStories(registered, { stories: ["ui-card--default"], components: [] }).selected.map(
        (s) => s.storyId,
      ),
    ).toEqual(["ui-card--default"]);
    expect(
      selectStories(registered, { stories: [], components: ["Button"] }).selected.map(
        (s) => s.storyId,
      ),
    ).toEqual(["ui-button--primary", "ui-button--neutral"]);
  });

  it("reports a filter that matched nothing instead of selecting nothing", () => {
    // The purest form of a meaningless green: `check --story typo` exiting 0 over
    // zero stories. Named here, refused in `runHeadlessCheck`.
    expect(selectStories(registered, { stories: ["nope"], components: [] }).unknownStories).toEqual([
      "nope",
    ]);
    expect(
      selectStories(registered, { stories: [], components: ["dialog"] }).unknownComponents,
    ).toEqual(["dialog"]);
  });
});

describe("runHeadlessCheck", () => {
  const registry = [
    { storyId: "ui-button--primary", nodeId: "1:1" },
    { storyId: "ui-button--neutral", nodeId: "1:2" },
  ];

  it("warms once before the first story, then checks each in order", async () => {
    const driver = new FakePreview({ registry });
    const started: string[] = [];
    const result = await runHeadlessCheck({
      driver,
      baseUrl: "http://x",
      selection: { stories: [], components: [] },
      dualMode: false,
      channel: testChannel(driver),
      onStoryStart: (_i, storyId) => started.push(storyId),
    });

    expect(started).toEqual(["ui-button--primary", "ui-button--neutral"]);
    expect(result.outcomes.map((o) => o.report?.storyId)).toEqual([
      "ui-button--primary",
      "ui-button--neutral",
    ]);
    expect(result.nodeIds).toEqual({ "ui-button--primary": "1:1", "ui-button--neutral": "1:2" });
    expect(result.fileKey).toBe("FILE");

    // #56's ordering, asserted on the wire: the shared fetch is requested before
    // the first check request, so no story is charged for warming the run.
    const types = driver.sent.map((s) => s.type);
    expect(types.indexOf(EVENTS.WarmCacheRequest)).toBeLessThan(
      types.indexOf(EVENTS.CheckDriftRequest),
    );
    // Two page loads: one to reach the channel, one to land on the first story.
    expect(driver.navigations).toEqual([
      "http://x/iframe.html",
      "http://x/iframe.html?viewMode=story&id=ui-button--primary",
    ]);
    // …and therefore exactly one `setCurrentStory`, for the second story.
    expect(driver.sent.filter((s) => s.type === SET_CURRENT_STORY)).toHaveLength(1);
  });

  it("records a failing story as an outcome and keeps going", async () => {
    const driver = new FakePreview({
      registry,
      respond: (storyId) =>
        storyId === "ui-button--primary" ? { error: "Pending" } : { report: report(storyId) },
    });
    const result = await runHeadlessCheck({
      driver,
      baseUrl: "http://x",
      selection: { stories: [], components: [] },
      dualMode: false,
      channel: testChannel(driver),
    });
    expect(result.outcomes[0]!.error).toBe("Pending");
    expect(result.outcomes[1]!.report).toBeDefined();
  });

  it("refuses to run over an empty registry", async () => {
    const driver = new FakePreview({ registry: [] });
    await expect(
      runHeadlessCheck({
        driver,
        baseUrl: "http://x",
        selection: { stories: [], components: [] },
        dualMode: false,
        channel: testChannel(driver),
      }),
    ).rejects.toBeInstanceOf(HeadlessSetupError);
  });

  it("refuses a filter that matches nothing", async () => {
    const driver = new FakePreview({ registry });
    await expect(
      runHeadlessCheck({
        driver,
        baseUrl: "http://x",
        selection: { stories: ["ui-button--typo"], components: [] },
        dualMode: false,
        channel: testChannel(driver),
      }),
    ).rejects.toThrow(/Not registered with a Figma node: ui-button--typo/);
  });

  it("passes dual mode through to every story's request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const driver = new FakePreview({ registry });
    await runHeadlessCheck({
      driver,
      baseUrl: "http://x",
      selection: { stories: [], components: [] },
      dualMode: true,
      channel: testChannel(driver),
    });
    const requests = driver.sent.filter((s) => s.type === EVENTS.CheckDriftRequest);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.args[0]).toMatchObject({ dualMode: true });
    }
  });
});
