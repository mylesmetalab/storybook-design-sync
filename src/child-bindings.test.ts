import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import {
  auditChildBindings,
  formatChildProblem,
  parseChildFlag,
  resolveChildElements,
  validateChildBindings,
  type ChildBindingDeclaration,
} from "./child-bindings.js";

/**
 * Declared child bindings — the honesty half of whole-component comparison.
 *
 * The feature's value is entirely in *not* lying: a binding that can't be
 * compared has to be loud, and a binding that resolves ambiguously has to be
 * refused rather than guessed. These tests pin those two properties harder than
 * they pin the happy path, because the happy path fails visibly and a silent
 * skip does not.
 */

function domOf(bodyHtml: string): Document {
  return new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`).window.document;
}

const CARD = `
  <div id="storybook-root">
    <div class="card">
      <div data-slot="header" class="card__header">Title</div>
      <div data-slot="body" class="card__body">Body copy</div>
      <button class="card__action">One</button>
      <button class="card__action">Two</button>
    </div>
  </div>
`;

function cardRoot(): Element {
  const doc = domOf(CARD);
  return doc.querySelector(".card")!;
}

const decl = (selector: string, nodeId = "2142:11381"): ChildBindingDeclaration => ({
  selector,
  nodeId,
});

/* ------------------------------------------------------------------------- */

describe("validateChildBindings — shape", () => {
  it("treats an absent `children` key as the legacy shape, silently", () => {
    expect(validateChildBindings(undefined)).toEqual({ declarations: [], malformed: [] });
    expect(validateChildBindings(null)).toEqual({ declarations: [], malformed: [] });
  });

  it("reads a well-formed map in declaration order", () => {
    const result = validateChildBindings({
      "[data-slot=header]": "2142:11381",
      "[data-slot=body]": "2142:11382",
    });

    expect(result.malformed).toEqual([]);
    expect(result.fatal).toBeUndefined();
    expect(result.declarations).toEqual([
      { selector: "[data-slot=header]", nodeId: "2142:11381" },
      { selector: "[data-slot=body]", nodeId: "2142:11382" },
    ]);
  });

  it.each([
    ["an array", ["2142:11381"]],
    ["a string", "2142:11381"],
    ["a number", 7],
  ])("reports `children` being %s as fatal, with no silent fallback", (_label, raw) => {
    const result = validateChildBindings(raw);

    expect(result.declarations).toEqual([]);
    expect(result.fatal).toContain('"children" must be an object');
  });

  it.each([
    ["a non-string node id", { "[data-slot=header]": 42 }, "must be a Figma node id string"],
    ["an empty node id", { "[data-slot=header]": "  " }, "node id is empty"],
    ["a node id with whitespace", { "[data-slot=header]": "2142 11381" }, "contains whitespace"],
    ["an empty selector", { "   ": "2142:11381" }, "the key is empty"],
  ])("reports %s as malformed rather than dropping it", (_label, raw, expected) => {
    const result = validateChildBindings(raw);

    expect(result.declarations).toEqual([]);
    expect(result.malformed).toHaveLength(1);
    expect(result.malformed[0]!.detail).toContain(expected);
  });

  it("keeps the good entries when only one is malformed", () => {
    const result = validateChildBindings({
      "[data-slot=header]": "2142:11381",
      "[data-slot=body]": null,
    });

    expect(result.declarations).toEqual([{ selector: "[data-slot=header]", nodeId: "2142:11381" }]);
    expect(result.malformed.map((m) => m.selector)).toEqual(["[data-slot=body]"]);
  });
});

describe("resolveChildElements — DOM resolution inside the story root", () => {
  it("resolves a selector that matches exactly one descendant", () => {
    const [result] = resolveChildElements(cardRoot(), [decl("[data-slot=header]")]);

    expect(result!.kind).toBe("found");
    if (result!.kind !== "found") throw new Error("unreachable");
    expect(result!.element.className).toBe("card__header");
    expect(result!.nodeId).toBe("2142:11381");
  });

  it("reports a selector that matches nothing — never silence, never a dropped entry", () => {
    const results = resolveChildElements(cardRoot(), [
      decl("[data-slot=header]"),
      decl("[data-slot=footer]", "2142:99999"),
    ]);

    // Both declarations come back: one comparable, one explained.
    expect(results).toHaveLength(2);
    expect(results[1]!.kind).toBe("not-found");
  });

  it("says so when a not-found selector would have matched the story root itself", () => {
    const [result] = resolveChildElements(cardRoot(), [decl(".card")]);

    expect(result!.kind).toBe("not-found");
    if (result!.kind !== "not-found") throw new Error("unreachable");
    expect(result!.rootMatches).toBe(true);
  });

  it("reports ambiguity and does NOT pick the first of two matches", () => {
    const [result] = resolveChildElements(cardRoot(), [decl(".card__action")]);

    expect(result!.kind).toBe("ambiguous");
    if (result!.kind !== "ambiguous") throw new Error("unreachable");
    expect(result!.candidates).toEqual(["button.card__action", "button.card__action"]);
    // No `element` field exists on the ambiguous variant at all — there is no
    // way for a caller to accidentally snapshot one of them.
    expect("element" in result!).toBe(false);
  });

  it("reports an invalid selector instead of throwing out of the check", () => {
    const [result] = resolveChildElements(cardRoot(), [decl("[data-slot=")]);

    expect(result!.kind).toBe("invalid");
    if (result!.kind !== "invalid") throw new Error("unreachable");
    expect(result!.detail.length).toBeGreaterThan(0);
  });

  it("scopes resolution to the story root — a match elsewhere in the document does not count", () => {
    const doc = domOf(`
      <div data-slot="header">Outside the story</div>
      ${CARD}
    `);
    const root = doc.querySelector(".card")!;
    // Two `[data-slot=header]` in the document, one inside the root.
    expect(doc.querySelectorAll("[data-slot=header]")).toHaveLength(2);

    const [result] = resolveChildElements(root, [decl("[data-slot=header]")]);

    expect(result!.kind).toBe("found");
  });
});

describe("formatChildProblem — every failure names the selector and the story", () => {
  const base = { selector: "[data-slot=header]", storyId: "ui-card--default" } as const;
  const registryPath = ".design-sync/registry.json";

  it.each([
    "selector-not-found",
    "selector-ambiguous",
    "selector-invalid",
    "binding-malformed",
    "snapshot-missing",
    "node-unreachable",
  ] as const)("%s names the selector, the story, and says nothing was compared", (status) => {
    const message = formatChildProblem({ ...base, status, registryPath, nodeId: "2142:11381" });

    expect(message).toContain("[data-slot=header]");
    expect(message).toContain("ui-card--default");
    expect(message.toLowerCase()).toContain("not compared");
  });

  it("points at the configured registry path, not a hardcoded one", () => {
    const message = formatChildProblem({
      ...base,
      status: "selector-not-found",
      registryPath: "config/my-registry.json",
      nodeId: "2142:11381",
    });

    expect(message).toContain("config/my-registry.json");
  });

  it("lists the candidates for an ambiguous selector so the author can narrow it", () => {
    const message = formatChildProblem({
      ...base,
      status: "selector-ambiguous",
      registryPath,
      candidates: ["button.card__action", "button.card__action"],
    });

    expect(message).toContain("matched 2 elements");
    expect(message).toContain("button.card__action");
  });

  it("explains the root-matching case rather than leaving the author guessing", () => {
    const message = formatChildProblem({
      ...base,
      selector: ".card",
      status: "selector-not-found",
      registryPath,
      rootMatches: true,
    });

    expect(message).toContain("root's descendants only");
  });
});

describe("auditChildBindings — CLI shape validation", () => {
  it("counts declarations without complaining about well-formed maps", () => {
    const result = auditChildBindings({
      "ui-card--default": {
        children: { "[data-slot=header]": "2142:11381", "[data-slot=body]": "2142:11382" },
      },
      "ui-button--primary": {},
    });

    expect(result.issues).toEqual([]);
    expect(result.storiesWithChildren).toBe(1);
    expect(result.declaredBindings).toBe(2);
  });

  it("ignores legacy entries entirely", () => {
    const result = auditChildBindings({
      "ui-button--primary": {},
      "ui-input--default": { children: undefined },
    });

    expect(result).toEqual({ issues: [], storiesWithChildren: 0, declaredBindings: 0 });
  });

  it.each([
    ["a non-object children map", { children: ["2142:11381"] }, '"children" must be an object'],
    ["a non-string node id", { children: { "[data-slot=x]": 3 } }, "must be a Figma node id"],
    ["an empty children map", { children: {} }, "present but empty"],
  ])("flags %s, naming the story", (_label, entry, expected) => {
    const result = auditChildBindings({ "ui-card--default": entry });

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.storyId).toBe("ui-card--default");
    expect(result.issues[0]!.message).toContain(expected);
  });

  it("reports issues in a stable, story-sorted order", () => {
    const result = auditChildBindings({
      "z-story--x": { children: {} },
      "a-story--x": { children: {} },
    });

    expect(result.issues.map((i) => i.storyId)).toEqual(["a-story--x", "z-story--x"]);
  });
});

describe("parseChildFlag — `--child \"<selector>=<nodeId>\"`", () => {
  it("splits on the last `=`, so an attribute selector needs no escaping", () => {
    expect(parseChildFlag("[data-slot=header]=2142:11381")).toEqual({
      selector: "[data-slot=header]",
      nodeId: "2142:11381",
    });
  });

  it("handles a plain class selector", () => {
    expect(parseChildFlag(".card__header=2142:11381")).toEqual({
      selector: ".card__header",
      nodeId: "2142:11381",
    });
  });

  it.each(["no-equals-sign", "=2142:11381", ".card__header=", ""])(
    "refuses %o with an example of the expected form",
    (raw) => {
      expect(() => parseChildFlag(raw)).toThrow(/<css selector>=<figma node id>/);
    },
  );
});
