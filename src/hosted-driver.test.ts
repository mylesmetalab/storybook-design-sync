import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVENTS, type CodeSnapshotPayload } from "./channels.js";
import { installHeadlessBridge } from "./headless-bridge.js";
import { HeadlessChannel, HOSTED_BRIDGE_EVENTS, previewUrl, type HeadlessDriver } from "./headless-check.js";
import { STORY_MISSING, STORY_PREPARED, STORY_RENDERED, SET_CURRENT_STORY } from "./storybook-events.js";
import { driveStorySnapshot } from "./hosted-driver.js";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/**
 * Phase 4, sub-PR 2 of 3 (HOSTED-CHECK-TASKS.md T8: load-artifact / drive-snapshot
 * / wire-to-engine).
 *
 * A fake **static** Storybook preview — genuinely installs the hosted bridge on
 * a fake global and evaluates real emit/drain expressions, exactly as
 * `headless-check.test.ts`'s `FakePreview` does for the local-check bridge. The
 * one behavioural difference this fake encodes is the one this module exists to
 * exploit: on `CheckDriftRequest`, it replies with `CodeSnapshot` directly —
 * `preview.ts`'s own real reply — rather than a `server.ts` turning that into a
 * `DriftReport`, because a deployed static build has no such process.
 */
interface FakeStaticPreviewOptions {
  render?: (storyId: string) => "ok" | "missing";
  storyParams?: Record<string, unknown>;
  storyArgs?: Record<string, Record<string, unknown>>;
  /** The snapshot preview.ts would have measured. Defaults to a minimal stub. */
  snapshotFor?: (storyId: string) => CodeSnapshotPayload["snapshot"];
}

interface ChannelLike {
  on(type: string, fn: (...args: unknown[]) => void): void;
  emit(type: string, ...args: unknown[]): void;
}

function defaultSnapshot(): CodeSnapshotPayload["snapshot"] {
  return { styles: { "background-color": "rgb(0, 0, 0)" } };
}

class FakeStaticPreview implements HeadlessDriver {
  g: Record<string, unknown> = {};
  sent: Array<{ type: string; args: unknown[] }> = [];

  constructor(private readonly opts: FakeStaticPreviewOptions = {}) {}

  async navigate(url: string): Promise<void> {
    this.g = {};
    installHeadlessBridge(this.g, {
      events: HOSTED_BRIDGE_EVENTS,
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
    const id = new URL(url, "http://x").searchParams.get("id");
    if (id) {
      this.renderStory(id, (t, ...a) => {
        for (const fn of listeners.get(t) ?? []) fn(...a);
      });
    }
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
    // preview.ts fires storyRendered before storyPrepared reports parameters, in
    // the shape checkStoryHeadless already tolerates (buffered, order-independent).
    fire(STORY_RENDERED, storyId);
    fire(STORY_PREPARED, {
      id: storyId,
      parameters: { designSync: this.opts.storyParams ?? {} },
      args: this.opts.storyArgs?.[storyId] ?? {},
    });
  }

  private serve(type: string, args: unknown[], fire: (t: string, ...a: unknown[]) => void): void {
    if (type === SET_CURRENT_STORY) {
      const payload = args[0] as { storyId: string };
      this.renderStory(payload.storyId, fire);
      return;
    }
    if (type === EVENTS.CheckDriftRequest) {
      const payload = args[0] as { storyId: string; target?: string };
      const snapshot = this.opts.snapshotFor?.(payload.storyId) ?? defaultSnapshot();
      const out: CodeSnapshotPayload = { storyId: payload.storyId, snapshot };
      if (payload.target) out.target = payload.target;
      fire(EVENTS.CodeSnapshot, out);
    }
  }
}

function testChannel(driver: HeadlessDriver): HeadlessChannel {
  return new HeadlessChannel(driver, { pollMs: 0, sleep: () => Promise.resolve() });
}

describe("driveStorySnapshot", () => {
  it("returns preview.ts's real CodeSnapshot reply for the requested story", async () => {
    const driver = new FakeStaticPreview({
      snapshotFor: () => ({ styles: { "background-color": "rgb(1, 2, 3)" } }),
    });
    await driver.navigate(previewUrl("http://x", "ui-button--primary"));
    const channel = testChannel(driver);

    const payload = await driveStorySnapshot({
      channel,
      storyId: "ui-button--primary",
      dualMode: false,
      trigger: "explicit",
      alreadyCurrent: true,
    });

    expect(payload.storyId).toBe("ui-button--primary");
    expect(payload.snapshot.styles["background-color"]).toBe("rgb(1, 2, 3)");
  });

  it("navigates via SET_CURRENT_STORY when the page isn't already on this story", async () => {
    const driver = new FakeStaticPreview();
    await driver.navigate(previewUrl("http://x", "ui-button--primary"));
    const channel = testChannel(driver);

    await driveStorySnapshot({
      channel,
      storyId: "ui-card--default",
      dualMode: false,
      trigger: "bulk",
      alreadyCurrent: false,
    });

    expect(driver.sent.some((e) => e.type === SET_CURRENT_STORY)).toBe(true);
  });

  it("sends the SAME request construction site the panel and local check use", async () => {
    const driver = new FakeStaticPreview({
      // An explicit override, so the wire payload actually carries `dualModes` —
      // the un-overridden default pair is never sent explicitly (dualModeNames
      // returns undefined for it); preview.ts applies ["light","dark"] itself.
      storyParams: { modes: ["day", "night"] },
    });
    await driver.navigate(previewUrl("http://x", "ui-button--primary"));
    const channel = testChannel(driver);

    await driveStorySnapshot({
      channel,
      storyId: "ui-button--primary",
      dualMode: true,
      trigger: "bulk",
      alreadyCurrent: true,
    });

    const request = driver.sent.find((e) => e.type === EVENTS.CheckDriftRequest);
    expect(request?.args[0]).toMatchObject({
      storyId: "ui-button--primary",
      dualMode: true,
      dualModes: ["day", "night"],
      bulk: true,
    });
  });

  it("reports a registry-vs-code mismatch by name, same wording as the local check", async () => {
    const driver = new FakeStaticPreview({ render: () => "missing" });
    await driver.navigate(previewUrl("http://x", "ui-ghost--story"));
    const channel = testChannel(driver);

    await expect(
      driveStorySnapshot({
        channel,
        storyId: "ui-ghost--story",
        dualMode: false,
        trigger: "explicit",
        alreadyCurrent: true,
      }),
    ).rejects.toThrow(/no story with id "ui-ghost--story"/);
  });

  it("never sends a write event — read-only, same invariant as the local check path", async () => {
    for (const file of ["hosted-driver.ts"]) {
      const text = await readFile(join(SRC, file), "utf8");
      expect(text).not.toMatch(/EVENTS\.ApplyCodeRequest|applyCodeEdit|buildEdit\(/);
    }
  });
});
