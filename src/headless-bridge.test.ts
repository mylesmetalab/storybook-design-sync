import { describe, expect, it } from "vitest";
import {
  bridgeSource,
  drainSource,
  emitSource,
  installHeadlessBridge,
  type BridgeState,
} from "./headless-bridge.js";

/**
 * The bridge is the only code this package runs inside a page it did not build,
 * and it is shipped there as *source text*. Two properties matter, and neither is
 * visible by reading it:
 *
 *  1. it captures nothing from module scope, or `toString()` produces a script
 *     that throws `ReferenceError` in the page;
 *  2. it never loses an event, because the Node side polls and a reply that
 *     arrived early would otherwise become a spurious timeout.
 */

interface FakeChannel {
  on(type: string, fn: (...args: unknown[]) => void): void;
  emit(type: string, ...args: unknown[]): void;
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  emitted: Array<{ type: string; args: unknown[] }>;
  /** Deliver an event as if the channel had received it. */
  fire(type: string, ...args: unknown[]): void;
}

function fakeChannel(): FakeChannel {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const emitted: Array<{ type: string; args: unknown[] }> = [];
  return {
    listeners,
    emitted,
    on(type, fn) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    emit(type, ...args) {
      emitted.push({ type, args });
    },
    fire(type, ...args) {
      for (const fn of listeners.get(type) ?? []) fn(...args);
    },
  };
}

const OPTS = { events: ["storyPrepared", "storyRendered", "design-sync:driftReport"], storyPreparedEvent: "storyPrepared" };

function install(g: Record<string, unknown> = {}): { g: Record<string, unknown>; state: BridgeState } {
  const state = installHeadlessBridge(g, OPTS);
  return { g, state };
}

describe("headless bridge — attachment", () => {
  it("attaches when Storybook assigns the channel, not by polling for it", () => {
    const { g, state } = install();
    expect(state.attached).toBe(false);
    // Nothing to emit on yet, and it says so rather than pretending.
    expect(state.emit("x")).toBe(false);

    const channel = fakeChannel();
    g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;

    expect(state.attached).toBe(true);
    // The trap is transparent: Storybook's own `getChannel()` still reads it back.
    expect(g["__STORYBOOK_ADDONS_CHANNEL__"]).toBe(channel);
  });

  it("attaches to a channel that is already installed", () => {
    const channel = fakeChannel();
    const { state } = install({ __STORYBOOK_ADDONS_CHANNEL__: channel });
    expect(state.attached).toBe(true);
  });

  it("is idempotent — a second install returns the same state", () => {
    const g: Record<string, unknown> = {};
    const first = installHeadlessBridge(g, OPTS);
    g["__STORYBOOK_ADDONS_CHANNEL__"] = fakeChannel();
    const second = installHeadlessBridge(g, OPTS);
    expect(second).toBe(first);
  });

  it("emits on the channel once attached", () => {
    const { g, state } = install();
    const channel = fakeChannel();
    g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;
    expect(state.emit("setCurrentStory", { storyId: "a" })).toBe(true);
    expect(channel.emitted).toEqual([{ type: "setCurrentStory", args: [{ storyId: "a" }] }]);
    // No payload means no argument at all — `ListRegisteredRequest` takes none.
    state.emit("design-sync:listRegisteredRequest");
    expect(channel.emitted[1]).toEqual({ type: "design-sync:listRegisteredRequest", args: [] });
  });
});

describe("headless bridge — the log", () => {
  it("hands over only what the reader has not seen, in order", () => {
    const { g, state } = install();
    const channel = fakeChannel();
    g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;

    channel.fire("storyRendered", "a");
    channel.fire("storyRendered", "b");
    expect(state.drain(0).map((e) => e.args[0])).toEqual(["a", "b"]);
    expect(state.drain(1).map((e) => e.args[0])).toEqual(["b"]);
    expect(state.drain(2)).toEqual([]);

    channel.fire("storyRendered", "c");
    expect(state.drain(2).map((e) => e.args[0])).toEqual(["c"]);
  });

  it("keeps the log bounded and records what it dropped", () => {
    const g: Record<string, unknown> = {};
    const state = installHeadlessBridge(g, { ...OPTS, maxLog: 3 });
    const channel = fakeChannel();
    g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;
    for (let i = 0; i < 6; i++) channel.fire("storyRendered", `s${i}`);
    expect(state.log).toHaveLength(3);
    expect(state.dropped).toBe(3);
    // Sequence numbers keep counting, so a reader can tell it missed history.
    expect(state.seq).toBe(6);
  });

  it("ignores events it was not asked to log", () => {
    const { g, state } = install();
    const channel = fakeChannel();
    g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;
    channel.fire("storyArgsUpdated", { id: "a" });
    expect(state.log).toEqual([]);
  });
});

describe("headless bridge — payload safety", () => {
  it("narrows storyPrepared to the slice check-request.ts reads", () => {
    const { g, state } = install();
    const channel = fakeChannel();
    g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;

    // A realistic payload: `parameters` also carries docs internals and a
    // component reference, which must not cross to Node.
    const component = function Button(): null {
      return null;
    };
    channel.fire("storyPrepared", {
      id: "ui-button--primary",
      parameters: {
        designSync: { target: ".btn", modeSwitch: "class" },
        docs: { container: component, page: component },
        component,
      },
      initialArgs: { variant: "primary" },
      args: { variant: "primary" },
      argTypes: { variant: { name: "variant" } },
    });

    const [entry] = state.drain(0);
    expect(entry!.args[0]).toEqual({
      id: "ui-button--primary",
      parameters: { designSync: { target: ".btn", modeSwitch: "class" } },
      args: { variant: "primary" },
    });
  });

  it("renders a function-valued arg as an object, the way telejson does", () => {
    // Load-bearing: `engines/component-properties.ts` describes any NON-primitive
    // arg as "<provided>". A function flattened to a string would be compared as
    // that string, producing a `props` row the panel does not have.
    const { g, state } = install();
    const channel = fakeChannel();
    g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;
    channel.fire("storyPrepared", {
      id: "s",
      parameters: {},
      args: { onClick: function handleClick(): void {}, label: "Go" },
    });
    const args = (state.drain(0)[0]!.args[0] as { args: Record<string, unknown> }).args;
    expect(typeof args["onClick"]).toBe("object");
    expect(args["onClick"]).toEqual({ __function__: "handleClick" });
    expect(args["label"]).toBe("Go");
  });

  it("survives a cycle instead of throwing where the report would be lost", () => {
    const { g, state } = install();
    const channel = fakeChannel();
    g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;
    const cyclic: Record<string, unknown> = { name: "self" };
    cyclic["me"] = cyclic;
    channel.fire("storyPrepared", { id: "s", parameters: {}, args: { node: cyclic } });
    const args = (state.drain(0)[0]!.args[0] as { args: Record<string, unknown> }).args;
    expect(args["node"]).toEqual({ name: "self", me: "[Circular]" });
  });

  it("clones a repeated (but not circular) reference twice, not as circular", () => {
    const { g, state } = install();
    const channel = fakeChannel();
    g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;
    const shared = { a: 1 };
    channel.fire("storyPrepared", { id: "s", parameters: {}, args: { x: shared, y: shared } });
    const args = (state.drain(0)[0]!.args[0] as { args: Record<string, unknown> }).args;
    expect(args).toEqual({ x: { a: 1 }, y: { a: 1 } });
  });

  it("turns a Date into its ISO string, not into an empty object", () => {
    /**
     * The engine writes `source.readAt` as an ISO string; telejson revives
     * anything ISO-shaped as a `Date` on its way across the websocket, and a Date
     * has no enumerable keys — so the generic object path emitted `{}`, a value
     * that reads as present and carries nothing. Caught by diffing a headless run
     * against a panel run against the reference consumer.
     */
    const { g, state } = install();
    const channel = fakeChannel();
    g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;
    channel.fire("design-sync:driftReport", {
      report: {
        storyId: "s",
        source: {
          readAt: new Date("2026-07-30T12:34:56.000Z"),
          fileLastModified: new Date("2026-07-29T00:00:00.000Z"),
          fileVersion: "2381959055834843157",
          fromCache: true,
        },
      },
    });
    const payload = state.drain(0)[0]!.args[0] as { report: { source: Record<string, unknown> } };
    expect(payload.report.source).toEqual({
      readAt: "2026-07-30T12:34:56.000Z",
      fileLastModified: "2026-07-29T00:00:00.000Z",
      fileVersion: "2381959055834843157",
      fromCache: true,
    });
  });

  it("refuses to invent a timestamp for an invalid Date", () => {
    const { g, state } = install();
    const channel = fakeChannel();
    g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;
    channel.fire("design-sync:driftReport", { at: new Date("not a date") });
    expect(state.drain(0)[0]!.args[0]).toEqual({ at: "[InvalidDate]" });
  });

  it("passes a drift report through unchanged", () => {
    const { g, state } = install();
    const channel = fakeChannel();
    g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;
    const report = {
      report: {
        storyId: "s",
        nodeId: "1:2",
        generatedAt: "2026-07-31T00:00:00.000Z",
        dimensions: [
          { kind: "token-value", property: "background-color", codeValue: "#fff", figmaValue: "#000", status: "drift" },
        ],
      },
    };
    channel.fire("design-sync:driftReport", report);
    expect(state.drain(0)[0]!.args[0]).toEqual(report);
  });
});

describe("headless bridge — shipped as source", () => {
  /**
   * The property that makes `bridgeSource()` viable at all: evaluated in a scope
   * with no bindings whatsoever, it still works. A helper hoisted out of the
   * function body — or an import sneaking into it — fails here with a
   * `ReferenceError`, in this repo, rather than in a consumer's browser.
   */
  it("evaluates and works in an isolated scope with nothing in it", () => {
    const g: Record<string, unknown> = {};
    // `new Function` bodies see only globals and their own parameters: no module
    // scope, no closure over this test file.
    const run = new Function("globalThis", `return ${bridgeSource(OPTS)};`) as (
      g: Record<string, unknown>,
    ) => BridgeState;
    const state = run(g);

    const channel = fakeChannel();
    g["__STORYBOOK_ADDONS_CHANNEL__"] = channel;
    channel.fire("storyRendered", "ui-button--primary");
    expect(state.drain(0)).toEqual([
      { seq: 1, type: "storyRendered", args: ["ui-button--primary"] },
    ]);
    expect(g["__designSyncHeadless__"]).toBe(state);
  });

  it("builds drain and emit expressions that survive a missing bridge", () => {
    // Both must evaluate to a falsy/absent answer rather than throwing: the Node
    // side turns `null` into "the bridge is gone", which names the real cause.
    const drain = new Function("globalThis", `return ${drainSource(0)};`) as (
      g: Record<string, unknown>,
    ) => unknown;
    expect(drain({})).toBe(null);
    const emit = new Function("globalThis", `return ${emitSource("x", { a: 1 })};`) as (
      g: Record<string, unknown>,
    ) => unknown;
    expect(emit({})).toBe(false);
  });

  it("serializes the payload into the emit expression", () => {
    expect(emitSource("setCurrentStory", { storyId: "a--b", viewMode: "story" })).toContain(
      '"setCurrentStory", {"storyId":"a--b","viewMode":"story"}',
    );
    // No payload → no second argument, so `Channel.emit` sees zero args.
    expect(emitSource("ping", undefined)).toContain('emit("ping")');
  });
});
