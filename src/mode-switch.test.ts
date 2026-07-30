import { describe, expect, it, vi } from "vitest";
import {
  applyMode,
  createStyleFlusher,
  describeModeSwitch,
  fingerprint,
  parseModeSwitch,
  resolveModeSwitch,
  staleModeReason,
  switchUnavailableReason,
  type ModeSwitchElement,
  type ModeSwitchHosts,
  type ModeSwitchSpec,
} from "./mode-switch.js";

/**
 * Issue #69: "Both modes" switched theme by setting `data-theme`, so a
 * class-themed project (Tailwind's `@custom-variant dark (&:is(.dark *))`, which
 * shadcn and the reference starter use) never changed appearance. Both passes
 * measured the same rendered state and the run reported a completed two-mode
 * comparison — byte-identical totals, same runtime, no per-mode rows.
 *
 * These tests pin the two halves of the fix:
 *   - a class IS a switching mechanism, declarable and detected;
 *   - nothing is claimed without evidence, so a switch that moves nothing is
 *     reported as *not performed* rather than compared twice.
 */

/**
 * Minimal stand-in for an element. jsdom resolves neither CSS variables nor
 * Tailwind variants, so a real DOM could not express these cases.
 *
 * `classList` and the `class` attribute are backed by **one** store, as on a real
 * element — the restore path reads the attribute and writes through classList, so
 * a fake where those two disagree would pass tests the browser fails.
 */
function element(): ModeSwitchElement & { classes: Set<string>; attrs: Map<string, string> } {
  const attrs = new Map<string, string>();
  const tokens = (): string[] => (attrs.get("class") ?? "").split(/\s+/).filter(Boolean);
  const writeTokens = (list: string[]): void => {
    if (list.length === 0) attrs.delete("class");
    else attrs.set("class", list.join(" "));
  };
  return {
    get classes() {
      return new Set(tokens());
    },
    attrs,
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => void attrs.set(name, value),
    removeAttribute: (name) => void attrs.delete(name),
    classList: {
      add: (...add) => writeTokens([...tokens(), ...add.filter((t) => !tokens().includes(t))]),
      remove: (...drop) => writeTokens(tokens().filter((t) => !drop.includes(t))),
      contains: (token) => tokens().includes(token),
    },
  };
}

interface World {
  hosts: ModeSwitchHosts;
  html: ReturnType<typeof element>;
  body: ReturnType<typeof element>;
  storyRoot: { id: "story-root" };
  readStyles: (el: unknown) => Record<string, string>;
}

/**
 * A world themed by one specific mechanism. Everything else about it is inert —
 * which is exactly the situation in #69: `data-theme` was being set on a document
 * that only responds to `.dark`.
 */
function world(themedBy: "class-html" | "class-body" | "attr-html" | "nothing"): World {
  const html = element();
  const body = element();
  const storyRoot = { id: "story-root" } as const;
  const isDark = (): boolean => {
    if (themedBy === "class-html") return html.classList.contains("dark");
    if (themedBy === "class-body") return body.classList.contains("dark");
    if (themedBy === "attr-html") return html.getAttribute("data-theme") === "dark";
    return false;
  };
  return {
    hosts: { html, body },
    html,
    body,
    storyRoot,
    readStyles: () => ({
      "background-color": isDark() ? "rgb(30, 30, 30)" : "rgb(255, 255, 255)",
      color: isDark() ? "rgb(245, 245, 245)" : "rgb(10, 10, 10)",
    }),
  };
}

const flush = (): Promise<void> => Promise.resolve();

async function resolve(w: World, declared?: ModeSwitchSpec | null) {
  return resolveModeSwitch({
    hosts: w.hosts,
    evidence: [w.hosts.html, w.hosts.body, w.storyRoot],
    readStyles: w.readStyles,
    modes: ["light", "dark"],
    ...(declared !== undefined ? { declared } : {}),
    flush,
  });
}

describe("class-based theming is switched and detected (#69)", () => {
  it("finds the class mechanism on <html> with nothing declared", async () => {
    const result = await resolve(world("class-html"));
    expect(result.changed).toBe(true);
    expect(result.spec).toEqual({ kind: "class", on: "html" });
    expect(result.mechanism).toBe("class `.dark` on <html>");
  });

  it("finds it on <body> too", async () => {
    const result = await resolve(world("class-body"));
    expect(result.changed).toBe(true);
    expect(result.spec).toEqual({ kind: "class", on: "body" });
  });

  it("switching to light removes `.dark` rather than needing a `.light` rule", () => {
    const w = world("class-html");
    w.html.classList.add("dark");
    applyMode(w.hosts, { kind: "class", on: "html" }, "light", ["light", "dark"]);
    expect(w.html.classes.has("dark")).toBe(false);
    // shadcn has no `.light` rule; adding the name is harmless and supports
    // consumers who do declare both.
    expect(w.html.classes.has("light")).toBe(true);
  });

  it("restores the classes the page started with", () => {
    const w = world("class-html");
    w.html.classList.add("dark");
    const restore = applyMode(w.hosts, { kind: "class", on: "html" }, "light", ["light", "dark"]);
    restore.apply();
    expect([...w.html.classes]).toEqual(["dark"]);
  });

  it("restores an absent attribute rather than leaving one behind", () => {
    const w = world("attr-html");
    const restore = applyMode(
      w.hosts,
      { kind: "attribute", attribute: "data-theme", on: "html" },
      "dark",
      ["light", "dark"],
    );
    expect(w.html.getAttribute("data-theme")).toBe("dark");
    restore.apply();
    expect(w.html.getAttribute("data-theme")).toBeNull();
  });

  it("leaves the DOM as it found it after detection", async () => {
    const w = world("class-html");
    w.html.classList.add("dark");
    w.html.setAttribute("data-theme", "dark");
    await resolve(w);
    expect([...w.html.classes]).toEqual(["dark"]);
    expect(w.html.getAttribute("data-theme")).toBe("dark");
  });
});

describe("attribute-based theming still works (no regression)", () => {
  it("is detected when no mechanism is declared", async () => {
    const result = await resolve(world("attr-html"));
    expect(result.changed).toBe(true);
    expect(result.spec).toEqual({ kind: "attribute", attribute: "data-theme", on: "html" });
  });

  it("is used as declared via the pre-existing `modeAttribute` param", async () => {
    const { spec } = parseModeSwitch({ modeAttribute: "data-theme" });
    expect(spec).toEqual({ kind: "attribute", attribute: "data-theme", on: "html" });
    const result = await resolve(world("attr-html"), spec);
    expect(result.changed).toBe(true);
    expect(result.declared).toBe(true);
  });

  it("honours a custom attribute name", () => {
    const { spec } = parseModeSwitch({ modeAttribute: "data-sb-theme" });
    expect(spec).toEqual({ kind: "attribute", attribute: "data-sb-theme", on: "html" });
  });
});

describe("a switch that changes nothing is reported, never compared twice (#69)", () => {
  it("refuses when no mechanism moves anything", async () => {
    const result = await resolve(world("nothing"));
    expect(result.changed).toBe(false);
    expect(result.spec).toBeNull();
    expect(result.reason).toContain("Not performed");
    expect(result.reason).toContain("did not happen");
  });

  it("lists what it tried and how to declare the real one", async () => {
    const result = await resolve(world("nothing"));
    expect(result.reason).toContain("class `.dark` on <html>");
    expect(result.reason).toContain("attribute `data-theme` on <html>");
    expect(result.reason).toContain("parameters.designSync.modeSwitch");
  });

  it("refuses rather than silently substituting a working mechanism for a declared one", async () => {
    // The consumer says "attribute"; the project is actually class-themed. Going
    // hunting would produce a report against a mechanism they didn't declare.
    const result = await resolve(world("class-html"), {
      kind: "attribute",
      attribute: "data-theme",
      on: "html",
    });
    expect(result.changed).toBe(false);
    expect(result.reason).toContain("Declared mechanism");
    expect(result.reason).toContain("attribute `data-theme` on <html>");
  });

  it("is the #69 shape exactly: data-theme on a class-themed project", async () => {
    const w = world("class-html");
    const declared: ModeSwitchSpec = { kind: "attribute", attribute: "data-theme", on: "html" };
    // Both passes would have measured the same thing…
    applyMode(w.hosts, declared, "light", ["light", "dark"]);
    const light = fingerprint([w.storyRoot], w.readStyles);
    applyMode(w.hosts, declared, "dark", ["light", "dark"]);
    const dark = fingerprint([w.storyRoot], w.readStyles);
    expect(light).toBe(dark);
    // …and that is now detected instead of reported as a two-mode comparison.
    expect((await resolve(w, declared)).changed).toBe(false);
  });
});

describe("parseModeSwitch", () => {
  it("reads the shorthand string forms", () => {
    expect(parseModeSwitch({ modeSwitch: "class" }).spec).toEqual({ kind: "class", on: "html" });
    expect(parseModeSwitch({ modeSwitch: "attribute" }).spec).toEqual({
      kind: "attribute",
      attribute: "data-theme",
      on: "html",
    });
  });

  it("reads the object form, including the host", () => {
    expect(parseModeSwitch({ modeSwitch: { kind: "class", on: "body" } }).spec).toEqual({
      kind: "class",
      on: "body",
    });
    expect(
      parseModeSwitch({ modeSwitch: { kind: "attribute", attribute: "data-mode" } }).spec,
    ).toEqual({ kind: "attribute", attribute: "data-mode", on: "html" });
  });

  it("declares nothing, and says why, for a malformed value", () => {
    const bad = parseModeSwitch({ modeSwitch: "classs" });
    expect(bad.spec).toBeNull();
    expect(bad.problem).toContain("not a mechanism");
    const worse = parseModeSwitch({ modeSwitch: { on: "html" } });
    expect(worse.spec).toBeNull();
    expect(worse.problem).toContain("kind");
  });

  it("declares nothing when the story declares nothing", () => {
    expect(parseModeSwitch({}).spec).toBeNull();
    expect(parseModeSwitch({}).problem).toBeUndefined();
    expect(parseModeSwitch({ modeAttribute: "  " }).spec).toBeNull();
  });
});

describe("fingerprint", () => {
  it("differs when a colour moves and matches when nothing does", () => {
    const w = world("class-html");
    const before = fingerprint([w.storyRoot], w.readStyles);
    w.html.classList.add("dark");
    expect(fingerprint([w.storyRoot], w.readStyles)).not.toBe(before);
    w.html.classList.remove("dark");
    expect(fingerprint([w.storyRoot], w.readStyles)).toBe(before);
  });

  it("covers every evidence element, so a change anywhere counts", () => {
    const readStyles = (el: unknown): Record<string, string> =>
      el === "b" ? { color: "red" } : { color: "black" };
    expect(fingerprint(["a", "b"], readStyles)).not.toBe(fingerprint(["a", "a"], readStyles));
  });
});

describe("describeModeSwitch", () => {
  it("names the mechanism the way the panel shows it", () => {
    expect(describeModeSwitch({ kind: "class", on: "html" }, "dark")).toBe(
      "class `.dark` on <html>",
    );
    expect(describeModeSwitch({ kind: "attribute", attribute: "data-theme", on: "body" })).toBe(
      "attribute `data-theme` on <body>",
    );
  });
});

/**
 * Issue #78, the hang. Measured in a real consumer: with **Both modes** ticked,
 * the check parked with `<html class="light">` and "Checking…" indefinitely, past
 * 65s, never reaching the dark pass. Instrumenting the live preview iframe found
 * the cause and it is not Figma:
 *
 *     document.visibilityState  →  "hidden"
 *     requestAnimationFrame     →  NEVER-FIRED-in-3000ms   (top frame and iframe)
 *     setTimeout                →  fired
 *
 * `requestAnimationFrame` does not fire in a document the browser considers
 * hidden — a backgrounded tab, an inactive window, an automated session. The
 * flush helper awaited two nested rAFs, so its promise never settled: the whole
 * check parked on the FIRST flush, before any comparison, upstream of every
 * budget (the server's budget can't start, because no snapshot is ever sent).
 *
 * v0.0.40 had the same unbounded await in its dual path with 2 calls; v0.0.41
 * added detection, taking it to ~20, and moved the first one before any snapshot.
 * So this was latent and is now certain: a designer who switches tabs during a
 * 7-second check — likely, *because* it is slow — parks it forever.
 *
 * A frame callback is a nice-to-have. Never waiting forever is not.
 */
describe("style flushing survives a hidden document (#78)", () => {
  it("resolves via the timer when rAF never fires", async () => {
    const raf = vi.fn(); // hidden document: registered, never called back
    const flush = createStyleFlusher({
      raf,
      setTimer: (cb, ms) => void setTimeout(cb, ms),
      fallbackMs: 5,
    });
    await expect(flush()).resolves.toBeUndefined();
    expect(raf).toHaveBeenCalled();
  });

  it("resolves promptly when rAF does fire, without waiting out the fallback", async () => {
    const flush = createStyleFlusher({
      raf: (cb) => cb(),
      setTimer: (cb, ms) => void setTimeout(cb, ms),
      fallbackMs: 10_000,
    });
    const startedAt = Date.now();
    await flush();
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("settles exactly once when both the frame and the timer arrive", async () => {
    let resolutions = 0;
    const timers: Array<() => void> = [];
    const flush = createStyleFlusher({
      raf: (cb) => cb(),
      setTimer: (cb) => void timers.push(cb),
      fallbackMs: 0,
    });
    await flush().then(() => resolutions++);
    for (const t of timers) t(); // the late timer must not re-resolve
    expect(resolutions).toBe(1);
  });

  it("forces a synchronous reflow before measuring", async () => {
    // getComputedStyle recalculates style on read, but the reflow is what makes
    // the *paint* keep up — the starter showed a canvas still painted dark after
    // the class was gone.
    const forceReflow = vi.fn();
    const flush = createStyleFlusher({
      raf: (cb) => cb(),
      setTimer: (cb, ms) => void setTimeout(cb, ms),
      forceReflow,
      fallbackMs: 5,
    });
    await flush();
    expect(forceReflow).toHaveBeenCalled();
  });

  it("never leaves a detection sweep unbounded: 6 candidates × 3 flushes terminate", async () => {
    // The end-to-end property: with rAF dead, a full detection sweep still ends.
    const flush = createStyleFlusher({
      raf: vi.fn(),
      setTimer: (cb, ms) => void setTimeout(cb, ms),
      fallbackMs: 1,
    });
    const w = world("nothing");
    const result = await resolveModeSwitch({
      hosts: w.hosts,
      evidence: [w.storyRoot],
      readStyles: w.readStyles,
      modes: ["light", "dark"],
      flush,
    });
    expect(result.changed).toBe(false);
    expect(result.reason).toContain("Not performed");
  });
});

/**
 * Issue #78, second half: "the mode is cleared, not restored". On the starter the
 * original root class was empty so the damage was invisible, but a consumer whose
 * `<html>` carries `class="theme-brand dark"` or a framework's `class="js"` would
 * have unrelated classes destroyed by running a drift check.
 */
describe("restoring the theme puts back exactly what was there (#78)", () => {
  const spec: ModeSwitchSpec = { kind: "class", on: "html" };

  it("preserves classes that have nothing to do with theming", () => {
    const w = world("class-html");
    w.html.setAttribute("class", "theme-brand js dark");
    const restore = applyMode(w.hosts, spec, "light", ["light", "dark"]);
    restore.apply();
    expect(w.html.getAttribute("class")).toBe("theme-brand js dark");
  });

  it("restores the original string verbatim, not a reconstruction", () => {
    const w = world("class-html");
    w.html.setAttribute("class", "dark theme-brand");
    const a = applyMode(w.hosts, spec, "light", ["light", "dark"]);
    const b = applyMode(w.hosts, spec, "dark", ["light", "dark"]);
    b.apply();
    a.apply();
    // Order and spacing included: this is what the consumer's app wrote.
    expect(w.html.getAttribute("class")).toBe("dark theme-brand");
  });

  it("leaves no class attribute behind when there was none", () => {
    const w = world("class-html");
    const restore = applyMode(w.hosts, spec, "dark", ["light", "dark"]);
    restore.apply();
    expect(w.html.getAttribute("class")).toBeNull();
  });

  it("forces a reflow on restore, so the canvas repaints in the restored theme", () => {
    const w = world("class-html");
    const forceReflow = vi.fn();
    const restore = applyMode(w.hosts, spec, "dark", ["light", "dark"], { forceReflow });
    restore.apply();
    expect(forceReflow).toHaveBeenCalled();
  });

  it("still restores an absent attribute for the attribute mechanism", () => {
    const w = world("attr-html");
    const restore = applyMode(
      w.hosts,
      { kind: "attribute", attribute: "data-theme", on: "html" },
      "dark",
      ["light", "dark"],
    );
    restore.apply();
    expect(w.html.getAttribute("data-theme")).toBeNull();
  });
});

describe("switchUnavailableReason — a refusal that names the phase (#78)", () => {
  it("says the switch could not be completed and refuses a verdict", () => {
    const reason = switchUnavailableReason("detecting the theme mechanism", "4000ms");
    expect(reason).toContain("Not performed");
    expect(reason).toContain("detecting the theme mechanism");
    expect(reason).toContain("4000ms");
    // The user gets a cause instead of the panel's generic "no reply".
    expect(reason).toContain("one mode");
  });
});

describe("staleModeReason — the evidence is re-read at snapshot time (#78)", () => {
  it("names the mechanism, the unsettled mode, and refuses the comparison", () => {
    const reason = staleModeReason({
      modeA: "light",
      modeB: "dark",
      mechanism: "class `.dark` on <html>",
    });
    expect(reason).toContain("Not performed");
    expect(reason).toContain("class `.dark` on <html>");
    expect(reason).toContain("had not settled");
    expect(reason).toContain("one rendered state");
  });

  it("is about the document, not the component — a mode-invariant story is NOT refused", () => {
    // The trap: a button whose background is a fixed brand colour renders
    // identically in both modes. If Figma holds two different values for it, that
    // IS dark-mode drift and is exactly what this feature exists to find.
    // The settled-ness check therefore reads <html>/<body>, which any real
    // theming setup moves, and never the story's own rows.
    const w = world("class-html");
    const invariantStory = { id: "story-root" };
    const readInvariant = (el: unknown): Record<string, string> =>
      el === invariantStory ? { "background-color": "rgb(44, 44, 44)" } : w.readStyles(el);

    const before = fingerprint([invariantStory], readInvariant);
    w.html.classList.add("dark");
    const after = fingerprint([invariantStory], readInvariant);
    expect(after).toBe(before); // the story did not change…

    // …while the document did, which is what the passes compare.
    w.html.classList.remove("dark");
    const docBefore = fingerprint([w.hosts.html, w.hosts.body], w.readStyles);
    w.html.classList.add("dark");
    expect(fingerprint([w.hosts.html, w.hosts.body], w.readStyles)).not.toBe(docBefore);
  });
});
