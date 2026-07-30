import { describe, expect, it } from "vitest";
import {
  applyMode,
  describeModeSwitch,
  fingerprint,
  parseModeSwitch,
  resolveModeSwitch,
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

/** Minimal stand-in for an element. jsdom resolves neither CSS variables nor
 *  Tailwind variants, so a real DOM could not express these cases. */
function element(): ModeSwitchElement & { classes: Set<string>; attrs: Map<string, string> } {
  const classes = new Set<string>();
  const attrs = new Map<string, string>();
  return {
    classes,
    attrs,
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => void attrs.set(name, value),
    removeAttribute: (name) => void attrs.delete(name),
    classList: {
      add: (...tokens) => tokens.forEach((t) => classes.add(t)),
      remove: (...tokens) => tokens.forEach((t) => classes.delete(t)),
      contains: (token) => classes.has(token),
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
