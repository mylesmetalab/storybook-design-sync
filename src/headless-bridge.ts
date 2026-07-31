/**
 * The script `design-sync check` evaluates inside the Storybook **preview**
 * page, and the only piece of the headless check that runs in a browser.
 *
 * ## Why a bridge at all
 *
 * A drift check is three processes talking over one channel: the manager asks,
 * the *preview* measures the rendered DOM with `getComputedStyle`, and the Node
 * server reads Figma and answers. Only the middle one needs a browser, and it is
 * already shipped and running inside the consumer's Storybook — so the headless
 * check does not re-measure anything. It stands in for the **manager**: it asks
 * the same question on the same channel and reads the same answer.
 *
 * That is the whole design, and it is what makes `check`'s green mean exactly
 * what the panel's green means: there is no second snapshotter, no second
 * engine, no second comparison. `preview.ts` and `server.ts` do the work in both
 * cases, on the same event names, with a payload built by the same
 * `check-request.ts`.
 *
 * ## Why the channel and not `page.evaluate` of our own measuring code
 *
 * Re-implementing the snapshot in an injected script would answer a *different*
 * question under the same name — the exact failure this command was specified to
 * avoid. Emitting `design-sync:checkDriftRequest` on the preview's own channel
 * runs the addon's real preview listener: real story-root resolution, real
 * property list, real mode switching, real child-binding resolution.
 *
 * ## Constraints this file is written under
 *
 * 1. **It must survive `Function.prototype.toString`.** It is shipped to the
 *    page as source text, so it may not reference a single module-scope
 *    identifier — no imports, no shared helpers, no constants from elsewhere.
 *    `headless-bridge.test.ts` enforces this by evaluating
 *    `installHeadlessBridge.toString()` in an isolated `new Function` scope,
 *    which throws on any capture.
 * 2. **It installs before the preview boots.** The channel does not exist at
 *    document-start, so instead of polling for it the bridge defines an
 *    accessor over `globalThis.__STORYBOOK_ADDONS_CHANNEL__` and attaches the
 *    instant Storybook's `setChannel` assigns it. Polling would miss the first
 *    story's `storyPrepared`, which fires during boot.
 * 3. **It never waits for a frame.** No `requestAnimationFrame` anywhere: a
 *    document the browser considers hidden runs no frame callbacks, and this
 *    project has already lost a release to a bare `await rAF` that parked
 *    forever. The bridge is a passive event log — it waits for nothing at all,
 *    and the Node side polls it.
 */

/** One logged channel event. `args` has been made structurally safe to serialize. */
export interface BridgeEvent {
  seq: number;
  type: string;
  args: unknown[];
}

/** The object the bridge parks on the page's global, read by the Node side. */
export interface BridgeState {
  /** True once the Storybook channel has been seen and listeners are attached. */
  attached: boolean;
  /** Monotonic counter; the Node side asks for everything after a known seq. */
  seq: number;
  log: BridgeEvent[];
  /** Events discarded to keep the log bounded. Non-zero means we lost history. */
  dropped: number;
  /** Emit on the preview channel. No-op before the channel exists. */
  emit(type: string, payload?: unknown): boolean;
  /** Everything logged after `afterSeq`, oldest first. */
  drain(afterSeq: number): BridgeEvent[];
}

export interface BridgeOptions {
  /** Channel events to log. Everything else is ignored. */
  events: string[];
  /**
   * The `storyPrepared` event name. Its payload is the one thing narrowed rather
   * than cloned wholesale — see `installHeadlessBridge`.
   */
  storyPreparedEvent: string;
  /** Ring-buffer size. Default 400, which is ~40 stories of traffic. */
  maxLog?: number;
}

/**
 * Install the bridge on a global object. Returns the state it parked there
 * (or the existing one, so a second evaluate is harmless).
 *
 * Self-contained by requirement — see the file header, constraint 1.
 */
export function installHeadlessBridge(
  g: Record<string, unknown>,
  opts: BridgeOptions,
): BridgeState {
  const KEY = "__designSyncHeadless__";
  const CHANNEL_KEY = "__STORYBOOK_ADDONS_CHANNEL__";
  const existing = g[KEY] as BridgeState | undefined;
  if (existing && typeof existing.drain === "function") return existing;

  const maxLog = typeof opts.maxLog === "number" ? opts.maxLog : 400;
  const preparedEvent = opts.storyPreparedEvent;

  /**
   * Structure-safe clone. `parameters` and story `args` routinely carry React
   * elements, class instances and cycles, and `page.evaluate`'s own serializer
   * throws on a cycle rather than degrading — so the payload is made safe here,
   * inside the page, where the original objects still exist.
   *
   * A function becomes `{ __function__: name }`, an **object**, not a string.
   * That is deliberate: `engines/component-properties.ts` renders any
   * non-primitive arg as `"<provided>"`, and a function flattened to a string
   * would instead be compared as that string — a `props` row that disagreed with
   * the panel's. The panel receives functions telejson-encoded as objects, so an
   * object is the faithful shape.
   */
  const clone = (value: unknown, stack: unknown[], depth: number): unknown => {
    if (typeof value === "function") {
      const named = value as { name?: string };
      return { __function__: typeof named.name === "string" ? named.name : "" };
    }
    if (typeof value === "bigint" || typeof value === "symbol") return String(value);
    if (value === null || typeof value !== "object") return value;
    if (stack.indexOf(value) !== -1) return "[Circular]";
    if (depth > 12) return "[MaxDepth]";
    stack.push(value);
    let out: unknown;
    if (Array.isArray(value)) {
      const arr: unknown[] = [];
      for (let i = 0; i < value.length; i++) arr.push(clone(value[i], stack, depth + 1));
      out = arr;
    } else if (value instanceof Error) {
      out = { name: value.name, message: value.message };
    } else {
      const obj: Record<string, unknown> = {};
      const src = value as Record<string, unknown>;
      const keys = Object.keys(src);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i] as string;
        try {
          obj[k] = clone(src[k], stack, depth + 1);
        } catch {
          obj[k] = "[Unreadable]";
        }
      }
      out = obj;
    }
    stack.pop();
    return out;
  };

  /**
   * `storyPrepared` carries the story's whole `parameters` object, which on a
   * docs-enabled project reaches megabytes of React internals. Narrowed to the
   * exact slice `check-request.ts` reads — `parameters.designSync` and `args` —
   * so what crosses to Node is the reader's surface and nothing else. A field
   * added to `StoryDesignSyncParams` needs no change here, because
   * `parameters.designSync` is cloned whole.
   */
  const narrowPrepared = (payload: unknown): unknown => {
    if (payload === null || typeof payload !== "object") return payload;
    const p = payload as Record<string, unknown>;
    const parameters = p["parameters"];
    const designSync =
      parameters !== null && typeof parameters === "object"
        ? (parameters as Record<string, unknown>)["designSync"]
        : undefined;
    return {
      id: p["id"],
      parameters: { designSync: clone(designSync, [], 0) },
      args: clone(p["args"], [], 0),
    };
  };

  const state: BridgeState = {
    attached: false,
    seq: 0,
    log: [],
    dropped: 0,
    emit(): boolean {
      return false;
    },
    drain(afterSeq: number): BridgeEvent[] {
      const out: BridgeEvent[] = [];
      for (let i = 0; i < state.log.length; i++) {
        const entry = state.log[i] as BridgeEvent;
        if (entry.seq > afterSeq) out.push(entry);
      }
      return out;
    },
  };

  const push = (type: string, args: unknown[]): void => {
    state.seq += 1;
    state.log.push({ seq: state.seq, type, args });
    if (state.log.length > maxLog) {
      state.dropped += state.log.length - maxLog;
      state.log.splice(0, state.log.length - maxLog);
    }
  };

  const attach = (channel: unknown): void => {
    if (state.attached) return;
    const ch = channel as
      | { on?: (t: string, fn: (...a: unknown[]) => void) => void; emit?: (t: string, ...a: unknown[]) => void }
      | null
      | undefined;
    if (!ch || typeof ch.on !== "function" || typeof ch.emit !== "function") return;
    state.attached = true;
    for (let i = 0; i < opts.events.length; i++) {
      const type = opts.events[i] as string;
      ch.on(type, (...args: unknown[]) => {
        try {
          push(
            type,
            type === preparedEvent
              ? [narrowPrepared(args[0])]
              : args.map((a) => clone(a, [], 0)),
          );
        } catch (err: unknown) {
          push(type, [{ __bridgeError__: String(err) }]);
        }
      });
    }
    state.emit = (type: string, payload?: unknown): boolean => {
      if (payload === undefined) ch.emit!(type);
      else ch.emit!(type, payload);
      return true;
    };
  };

  // Attach on assignment rather than by polling, so the first story's
  // `storyPrepared` — emitted while the preview boots — is not missed.
  let current = g[CHANNEL_KEY];
  try {
    Object.defineProperty(g, CHANNEL_KEY, {
      configurable: true,
      get(): unknown {
        return current;
      },
      set(next: unknown): void {
        current = next;
        attach(next);
      },
    });
  } catch {
    // A non-configurable global means the channel is already installed and
    // cannot be trapped; attaching to what is there is still correct, we just
    // may have missed events emitted before now.
  }
  attach(current);

  g[KEY] = state;
  return state;
}

/**
 * The bridge as source text, ready to be evaluated in a page.
 *
 * `Function.prototype.toString` on a function that captures nothing is the whole
 * trick. The build does not minify (`build.mjs` sets no `minify`), and the
 * isolated-scope test would fail loudly if a helper were ever hoisted out of the
 * function body — so this stays honest without a bundler plugin.
 */
export function bridgeSource(opts: BridgeOptions): string {
  return `(${installHeadlessBridge.toString()})(globalThis, ${JSON.stringify(opts)})`;
}

/** The expression a driver evaluates to drain the log. */
export function drainSource(afterSeq: number): string {
  return `(globalThis.__designSyncHeadless__ ? globalThis.__designSyncHeadless__.drain(${afterSeq}) : null)`;
}

/** The expression a driver evaluates to emit on the preview channel. */
export function emitSource(type: string, payload: unknown): string {
  const args = payload === undefined ? JSON.stringify(type) : `${JSON.stringify(type)}, ${JSON.stringify(payload)}`;
  return `(globalThis.__designSyncHeadless__ ? globalThis.__designSyncHeadless__.emit(${args}) : false)`;
}

/** The expression a driver evaluates to check the bridge saw the channel. */
export const ATTACHED_SOURCE =
  "!!(globalThis.__designSyncHeadless__ && globalThis.__designSyncHeadless__.attached)";
