import { describe, expect, it } from "vitest";

import {
  FORCEABLE_STATES,
  auditStateBindings,
  isForceableState,
  parseStateFlag,
  validateStateBindings,
} from "./state-bindings.js";

describe("validateStateBindings", () => {
  it("is completely silent when absent — the legacy shape must not change", () => {
    for (const raw of [undefined, null]) {
      expect(validateStateBindings(raw)).toEqual({ declarations: [], malformed: [] });
    }
  });

  it("reads a well-formed map", () => {
    const { declarations, malformed, fatal } = validateStateBindings({
      hover: "4185:3783",
    });
    expect(fatal).toBeUndefined();
    expect(malformed).toEqual([]);
    expect(declarations).toEqual([{ state: "hover", nodeId: "4185:3783" }]);
  });

  it("emits declarations in vocabulary order, not registry key order", () => {
    // The same bindings written in two different orders must produce identical
    // output, so a report's row order never depends on how the JSON was typed.
    const a = validateStateBindings({ disabled: "1:1", hover: "2:2", active: "3:3" });
    const b = validateStateBindings({ active: "3:3", disabled: "1:1", hover: "2:2" });
    expect(a.declarations).toEqual(b.declarations);
    expect(a.declarations.map((d) => d.state)).toEqual(["hover", "active", "disabled"]);
  });

  it("accepts every state it advertises as forceable", () => {
    const raw = Object.fromEntries(FORCEABLE_STATES.map((s, i) => [s, `1:${i}`]));
    const { declarations, malformed, fatal } = validateStateBindings(raw);
    expect(fatal).toBeUndefined();
    expect(malformed).toEqual([]);
    expect(declarations).toHaveLength(FORCEABLE_STATES.length);
  });

  it("is fatal when `states` is not an object", () => {
    for (const raw of ["hover", 42, true, ["hover"]]) {
      const { fatal, declarations } = validateStateBindings(raw);
      expect(fatal).toMatch(/must be an object/);
      expect(declarations).toEqual([]);
    }
  });

  /* ---- the vocabulary decision, which is the point of this module ---- */

  describe("rejects declared states, and says where they belong", () => {
    // These are all real `State=` values in the reference design file. Each is
    // a prop or a data attribute the component renders itself, so forcing is
    // the wrong mechanism and would produce a row reached the wrong way.
    it.each(["error", "open", "closed", "checked", "on", "off", "current", "selected"])(
      "%s is not forceable",
      (state) => {
        const { declarations, malformed } = validateStateBindings({ [state]: "1:1" });
        expect(declarations).toEqual([]);
        expect(malformed).toHaveLength(1);
        expect(malformed[0]!.detail).toMatch(/not a pseudo-state|not supported/);
        // The message has to route the author somewhere, not just refuse.
        expect(malformed[0]!.detail).toMatch(/bind it as its own story/i);
      },
    );

    it("points `default` at the entry's own nodeId rather than a states key", () => {
      const { malformed } = validateStateBindings({ default: "1:1" });
      expect(malformed[0]!.detail).toMatch(/the entry's own `nodeId`/);
    });
  });

  describe("rejects states that cannot be truthfully read", () => {
    it("refuses `visited` with the privacy reason, not a generic message", () => {
      const { declarations, malformed } = validateStateBindings({ visited: "1:1" });
      expect(declarations).toEqual([]);
      // The whole point: the rewriter *can* force it, so the reason has to be
      // about readability or someone will "fix" this by adding it.
      expect(malformed[0]!.detail).toMatch(/getComputedStyle/);
      expect(malformed[0]!.detail).toMatch(/false match/);
    });

    it.each(["link", "target"])("refuses %s", (state) => {
      const { declarations, malformed } = validateStateBindings({ [state]: "1:1" });
      expect(declarations).toEqual([]);
      expect(malformed[0]!.detail).toMatch(/document-navigation state/);
    });
  });

  it("lists the supported states when the key is unrecognised entirely", () => {
    const { malformed } = validateStateBindings({ wobbly: "1:1" });
    expect(malformed[0]!.detail).toContain("hover");
    expect(malformed[0]!.detail).toContain("focus-visible");
  });

  /* ---- malformed values ---- */

  it("reports a non-string node id", () => {
    const { declarations, malformed } = validateStateBindings({ hover: 4185 });
    expect(declarations).toEqual([]);
    expect(malformed[0]!.detail).toMatch(/must be a Figma node id string; got number/);
  });

  it("reports an empty or whitespace-bearing node id", () => {
    expect(validateStateBindings({ hover: "   " }).malformed[0]!.detail).toMatch(/empty/);
    expect(validateStateBindings({ hover: "418 5:3783" }).malformed[0]!.detail).toMatch(
      /contains whitespace/,
    );
  });

  it("reports an empty key", () => {
    const { malformed } = validateStateBindings({ "  ": "1:1" });
    expect(malformed[0]!.detail).toMatch(/the key is empty/);
  });

  it("trims and lowercases keys so ` Hover ` is the hover binding", () => {
    const { declarations, malformed } = validateStateBindings({ " Hover ": "4185:3783" });
    expect(malformed).toEqual([]);
    expect(declarations).toEqual([{ state: "hover", nodeId: "4185:3783" }]);
  });

  it("refuses a state declared twice with conflicting node ids", () => {
    // Reachable via case/whitespace variants. Keeping one silently would make
    // the registry's meaning depend on key order.
    const { declarations, malformed } = validateStateBindings({
      hover: "4185:3783",
      Hover: "9:9",
    });
    expect(malformed).toHaveLength(1);
    expect(malformed[0]!.detail).toMatch(/declared more than once/);
    // The first, unambiguous declaration survives; only the conflict is dropped.
    expect(declarations).toEqual([{ state: "hover", nodeId: "4185:3783" }]);
  });

  it("keeps a duplicate that agrees, since there is no ambiguity to report", () => {
    const { declarations, malformed } = validateStateBindings({
      hover: "4185:3783",
      HOVER: "4185:3783",
    });
    expect(malformed).toEqual([]);
    expect(declarations).toEqual([{ state: "hover", nodeId: "4185:3783" }]);
  });

  it("keeps good declarations alongside bad ones", () => {
    const { declarations, malformed } = validateStateBindings({
      hover: "4185:3783",
      error: "1:1",
    });
    expect(declarations).toEqual([{ state: "hover", nodeId: "4185:3783" }]);
    expect(malformed).toHaveLength(1);
  });
});

describe("isForceableState", () => {
  it("accepts the vocabulary and rejects everything else", () => {
    for (const s of FORCEABLE_STATES) expect(isForceableState(s)).toBe(true);
    for (const s of ["error", "visited", "open", "Hover", ""]) {
      expect(isForceableState(s)).toBe(false);
    }
  });
});

describe("parseStateFlag", () => {
  it("parses the documented form", () => {
    expect(parseStateFlag("hover=4185:3783")).toEqual({
      state: "hover",
      nodeId: "4185:3783",
    });
  });

  it("tolerates whitespace and case", () => {
    expect(parseStateFlag("  Hover = 4185:3783  ")).toEqual({
      state: "hover",
      nodeId: "4185:3783",
    });
  });

  it("splits on the first =, so a second one is an error not a silent node id", () => {
    // `--child` splits on the LAST "=" because selectors contain them. State
    // names never do, so a second "=" is a typo and must not be absorbed.
    expect(() => parseStateFlag("hover=4185:3783=extra")).toThrow(/more than one "="/);
  });

  it.each(["", "hover", "=4185:3783", "hover="])("rejects %o", (raw) => {
    expect(() => parseStateFlag(raw)).toThrow(/--state expects/);
  });

  it("rejects a declared state at parse time, with the routing message", () => {
    // Refusing here rather than at write time means the user sees why on the
    // command that made the mistake.
    expect(() => parseStateFlag("error=1:1")).toThrow(/bind it as its own story/i);
  });

  it("rejects visited with the readability reason", () => {
    expect(() => parseStateFlag("visited=1:1")).toThrow(/getComputedStyle/);
  });

  it("lists supported states on an unknown key", () => {
    expect(() => parseStateFlag("wobbly=1:1")).toThrow(/hover/);
  });
});

describe("auditStateBindings", () => {
  it("counts nothing for a registry with no state bindings", () => {
    expect(
      auditStateBindings({ "a--b": {}, "c--d": { states: undefined } }),
    ).toEqual({ storiesWithStates: 0, declaredBindings: 0, issues: [] });
  });

  it("counts stories and bindings separately", () => {
    const result = auditStateBindings({
      "ui-button--primary": { states: { hover: "4185:3783" } },
      "ui-button--neutral": { states: { hover: "4185:3795", disabled: "4185:3799" } },
      "ui-card--default": {},
    });
    expect(result.storiesWithStates).toBe(2);
    expect(result.declaredBindings).toBe(3);
    expect(result.issues).toEqual([]);
  });

  it("attributes each issue to its story", () => {
    const { issues } = auditStateBindings({
      "ui-input--error": { states: { error: "1:1" } },
      "ui-button--primary": { states: { hover: "" } },
    });
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.storyId).sort()).toEqual([
      "ui-button--primary",
      "ui-input--error",
    ]);
  });

  it("reports a fatal shape once, against the story, and reads no declarations", () => {
    const { issues, declaredBindings } = auditStateBindings({
      "ui-button--primary": { states: ["hover"] },
    });
    expect(declaredBindings).toBe(0);
    expect(issues).toEqual([
      { storyId: "ui-button--primary", state: "(all)", detail: expect.stringMatching(/must be an object/) },
    ]);
  });

  it("does not count a story whose every binding is malformed", () => {
    // Otherwise `storiesWithStates` would imply coverage that does not exist.
    const result = auditStateBindings({ "ui-input--error": { states: { error: "1:1" } } });
    expect(result.storiesWithStates).toBe(0);
    expect(result.declaredBindings).toBe(0);
    expect(result.issues).toHaveLength(1);
  });
});
