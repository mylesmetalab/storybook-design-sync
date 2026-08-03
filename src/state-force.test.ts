import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";

import {
  changedStyleProperties,
  classifyStateForce,
  clearForcedStates,
  declineReason,
  forceState,
  rewriteAllStyleSheetsForStates,
  snapshotForcedStates,
  stylesStateViaDataAttribute,
} from "./state-force.js";
import type { CodeSnapshot } from "./engines/types.js";

/**
 * State forcing — the honesty half.
 *
 * The happy path fails visibly (a wrong colour shows up as drift). The dangerous
 * cases are the two silent ones: a state that forced perfectly but moved nothing
 * being reported as a *match*, and a state this addon cannot reproduce being
 * compared anyway. Those get the most coverage here.
 */

function snap(styles: Record<string, string>): CodeSnapshot {
  return { styles };
}

describe("changedStyleProperties", () => {
  it("finds properties whose value moved", () => {
    expect(
      changedStyleProperties(
        { "background-color": "rgb(44, 44, 44)", color: "rgb(245, 245, 245)" },
        { "background-color": "rgb(30, 30, 30)", color: "rgb(245, 245, 245)" },
      ),
    ).toEqual(["background-color"]);
  });

  it("returns nothing for identical snapshots", () => {
    const styles = { "background-color": "rgb(44, 44, 44)" };
    expect(changedStyleProperties(styles, { ...styles })).toEqual([]);
  });

  it("treats a property present in only one snapshot as changed", () => {
    // Skipping these would hide a border that appears only on hover — which is
    // exactly the Subtle button's hover treatment.
    expect(changedStyleProperties({}, { "border-color": "rgb(0,0,0)" })).toEqual([
      "border-color",
    ]);
    expect(changedStyleProperties({ "border-color": "rgb(0,0,0)" }, {})).toEqual([
      "border-color",
    ]);
  });

  it("sorts, so evidence lists are stable", () => {
    const changed = changedStyleProperties(
      { b: "1", a: "1", c: "1" },
      { b: "2", a: "2", c: "2" },
    );
    expect(changed).toEqual(["a", "b", "c"]);
  });
});

describe("stylesStateViaDataAttribute", () => {
  it("detects a Tailwind data-state variant for the requested state", () => {
    expect(
      stylesStateViaDataAttribute(["data-disabled:bg-disabled", "bg-primary"], "disabled"),
    ).toBe(true);
  });

  it("does not fire for a different state's data variant", () => {
    expect(stylesStateViaDataAttribute(["data-disabled:bg-disabled"], "hover")).toBe(false);
  });

  it("does not fire for a plain pseudo variant", () => {
    // `hover:bg-primary-hover` is a CSS pseudo-class rule, which we CAN force.
    expect(stylesStateViaDataAttribute(["hover:bg-primary-hover"], "hover")).toBe(false);
  });

  it("sees through group-/peer- prefixes", () => {
    expect(stylesStateViaDataAttribute(["group-data-disabled:opacity-50"], "disabled")).toBe(
      true,
    );
    expect(stylesStateViaDataAttribute(["peer-data-checked:block"], "checked")).toBe(true);
  });

  it("is not confused by an arbitrary data selector", () => {
    expect(stylesStateViaDataAttribute(["data-[state=open]:block"], "open")).toBe(false);
  });

  it("returns false for an empty class list", () => {
    expect(stylesStateViaDataAttribute([], "hover")).toBe(false);
  });
});

describe("classifyStateForce", () => {
  it("reports `compared` with the changed properties as evidence", () => {
    const outcome = classifyStateForce({
      state: "hover",
      nodeId: "4185:3783",
      before: { "background-color": "rgb(44, 44, 44)" },
      forced: snap({ "background-color": "rgb(30, 30, 30)" }),
    });
    expect(outcome).toEqual({
      state: "hover",
      nodeId: "4185:3783",
      kind: "compared",
      snapshot: snap({ "background-color": "rgb(30, 30, 30)" }),
      changed: ["background-color"],
    });
  });

  /**
   * The rule this feature lives or dies on. Forcing that moves nothing means
   * either the state is genuinely identical or the forcing failed, and nothing
   * here can tell those apart — so it must never read as a match.
   */
  it("refuses to compare when forcing moved nothing", () => {
    const styles = { "background-color": "rgb(44, 44, 44)" };
    const outcome = classifyStateForce({
      state: "hover",
      nodeId: "4185:3783",
      before: styles,
      forced: snap({ ...styles }),
    });
    expect(outcome.kind).toBe("no-computed-change");
    // Specifically: no snapshot rides along, so no comparison can be run on it.
    expect("snapshot" in outcome).toBe(false);
  });

  it("declines without comparing when the state cannot be reproduced", () => {
    const outcome = classifyStateForce({
      state: "disabled",
      nodeId: "4185:3787",
      declined: declineReason("disabled"),
      before: { "background-color": "rgb(44, 44, 44)" },
      forced: snap({ "background-color": "rgb(44, 44, 44)" }),
    });
    expect(outcome.kind).toBe("not-forceable");
    if (outcome.kind !== "not-forceable") throw new Error("unreachable");
    // The reason has to route the author somewhere, like the registry's does.
    expect(outcome.detail).toMatch(/bind this state as its own story/i);
    expect(outcome.detail).toMatch(/data-disabled/);
  });

  it("prefers `not-forceable` over `no-computed-change`", () => {
    // Both conditions hold here. "We cannot force this" is the more specific and
    // more actionable answer; reporting "nothing changed" would send someone
    // looking for a design difference that was never measured.
    const styles = { "background-color": "rgb(44, 44, 44)" };
    const outcome = classifyStateForce({
      state: "disabled",
      nodeId: "1:1",
      declined: declineReason("disabled"),
      before: styles,
      forced: snap({ ...styles }),
    });
    expect(outcome.kind).toBe("not-forceable");
  });
});

/* ---- DOM plumbing ---- */

function domWith(css: string, html: string): { doc: Document; el: HTMLElement } {
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${css}</style></head><body>${html}</body></html>`,
  );
  const doc = dom.window.document;
  const el = doc.querySelector("button") as HTMLElement;
  return { doc, el };
}

describe("rewriteAllStyleSheetsForStates", () => {
  it("rewrites a :hover rule so a class can trigger it", () => {
    const { doc } = domWith(".btn:hover{color:red}", `<button class="btn"></button>`);
    rewriteAllStyleSheetsForStates(doc);
    const rule = (doc.styleSheets[0]!.cssRules[0] as CSSStyleRule).selectorText;
    expect(rule).toContain(".btn.pseudo-hover");
    expect(rule).toContain(".btn:hover");
  });

  it("recurses into @media, which is where Tailwind hover utilities live", () => {
    // Tailwind emits `@layer utilities { @media ((hover:hover)) { .hover\:x:hover }}`.
    // Without recursion the whole dimension is unreachable.
    const { doc } = domWith(
      "@media (hover: hover){.btn:hover{color:red}}",
      `<button class="btn"></button>`,
    );
    rewriteAllStyleSheetsForStates(doc);
    const media = doc.styleSheets[0]!.cssRules[0] as CSSMediaRule;
    expect((media.cssRules[0] as CSSStyleRule).selectorText).toContain(".btn.pseudo-hover");
  });

  it("is idempotent — a second pass adds nothing", () => {
    const { doc } = domWith(".btn:hover{color:red}", `<button class="btn"></button>`);
    rewriteAllStyleSheetsForStates(doc);
    const once = (doc.styleSheets[0]!.cssRules[0] as CSSStyleRule).selectorText;
    rewriteAllStyleSheetsForStates(doc);
    const twice = (doc.styleSheets[0]!.cssRules[0] as CSSStyleRule).selectorText;
    expect(twice).toBe(once);
  });

  it("leaves a stateless rule untouched", () => {
    const { doc } = domWith(".btn{color:red}", `<button class="btn"></button>`);
    rewriteAllStyleSheetsForStates(doc);
    expect((doc.styleSheets[0]!.cssRules[0] as CSSStyleRule).selectorText).toBe(".btn");
  });
});

describe("forceState / clearForcedStates", () => {
  it("adds and removes the state class", () => {
    const { el } = domWith("", `<button class="btn"></button>`);
    const undo = forceState(el, "hover");
    expect(el.classList.contains("pseudo-hover")).toBe(true);
    undo();
    expect(el.classList.contains("pseudo-hover")).toBe(false);
  });

  it("leaves a class it did not add, so it cannot clobber another addon's forcing", () => {
    const { el } = domWith("", `<button class="btn pseudo-hover"></button>`);
    const undo = forceState(el, "hover");
    undo();
    expect(el.classList.contains("pseudo-hover")).toBe(true);
  });

  it("clears every named state", () => {
    const { el } = domWith("", `<button class="btn"></button>`);
    el.classList.add("pseudo-hover", "pseudo-active");
    clearForcedStates(el, ["hover", "active", "focus"]);
    expect(el.className).toBe("btn");
  });
});

describe("snapshotForcedStates", () => {
  const base = snap({ "background-color": "rgb(44, 44, 44)" });

  it("produces one outcome per declaration, in order", () => {
    const { el } = domWith("", `<button class="btn"></button>`);
    const outcomes = snapshotForcedStates({
      element: el,
      declarations: [
        { state: "hover", nodeId: "1:1" },
        { state: "active", nodeId: "2:2" },
      ],
      base,
      snapshot: () => snap({ "background-color": "rgb(30, 30, 30)" }),
    });
    expect(outcomes.map((o) => [o.state, o.kind])).toEqual([
      ["hover", "compared"],
      ["active", "compared"],
    ]);
  });

  it("un-forces between states, so outcomes never compound", () => {
    const { el } = domWith("", `<button class="btn"></button>`);
    const seen: string[][] = [];
    snapshotForcedStates({
      element: el,
      declarations: [
        { state: "hover", nodeId: "1:1" },
        { state: "active", nodeId: "2:2" },
      ],
      base,
      snapshot: () => {
        seen.push(Array.from(el.classList));
        return snap({ "background-color": "rgb(30, 30, 30)" });
      },
    });
    expect(seen[0]).toContain("pseudo-hover");
    expect(seen[1]).toContain("pseudo-active");
    expect(seen[1]).not.toContain("pseudo-hover");
    // And the element is left exactly as found.
    expect(el.className).toBe("btn");
  });

  it("restores the element even if the snapshot throws", () => {
    const { el } = domWith("", `<button class="btn"></button>`);
    expect(() =>
      snapshotForcedStates({
        element: el,
        declarations: [{ state: "hover", nodeId: "1:1" }],
        base,
        snapshot: () => {
          throw new Error("boom");
        },
      }),
    ).toThrow("boom");
    // A forced class surviving a throw would leave the story stuck in hover for
    // every later read, including the next story's.
    expect(el.className).toBe("btn");
  });

  it("declines a data-attribute state without forcing anything", () => {
    const { el } = domWith("", `<button class="btn data-disabled:bg-disabled"></button>`);
    let snapshotted = false;
    const outcomes = snapshotForcedStates({
      element: el,
      declarations: [{ state: "disabled", nodeId: "1:1" }],
      base,
      snapshot: () => {
        snapshotted = true;
        return base;
      },
    });
    expect(outcomes[0]!.kind).toBe("not-forceable");
    // It must not even attempt the snapshot — a comparison that was never
    // measured should have no snapshot behind it.
    expect(snapshotted).toBe(false);
    expect(el.classList.contains("pseudo-disabled")).toBe(false);
  });

  it("reports no-computed-change when the forced snapshot matches the base", () => {
    const { el } = domWith("", `<button class="btn"></button>`);
    const outcomes = snapshotForcedStates({
      element: el,
      declarations: [{ state: "hover", nodeId: "1:1" }],
      base,
      snapshot: () => snap({ ...base.styles }),
    });
    expect(outcomes[0]!.kind).toBe("no-computed-change");
  });

  it("flushes before snapshotting and after un-forcing", () => {
    // Ordering matters: without a flush before the read, the computed value can
    // still be mid-transition. Without one after, the next state's base is dirty.
    const { el } = domWith("", `<button class="btn"></button>`);
    const order: string[] = [];
    snapshotForcedStates({
      element: el,
      declarations: [{ state: "hover", nodeId: "1:1" }],
      base,
      flush: () => order.push("flush"),
      snapshot: () => {
        order.push("snapshot");
        return snap({ "background-color": "rgb(30, 30, 30)" });
      },
    });
    expect(order).toEqual(["flush", "snapshot", "flush"]);
  });
});
