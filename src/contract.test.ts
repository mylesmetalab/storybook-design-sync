import { describe, expect, it } from "vitest";
import { contractReferenceFor, parseContract, slotFromSelector } from "./contract.js";

/**
 * Issue #71 — the contract knows one token drives two slots; nothing read it.
 *
 * The live case, verbatim from the SDS Card: `Space/400` is claimed twice —
 * `card.tsx:173` on `body` and `card.tsx:205` on `actions` — and
 * `contracts/card.spec.json` declares both. `[data-slot=actions]` is absent from the
 * registry (Button Group is its own component set), so the comparison never reaches
 * it. Move `Space/400` in Figma and the report shows ONE row; fix it and the two
 * slots sit at different values for a token the contract says is one decision.
 *
 * This is the first tool-time read of `contracts/*.spec.json` in the suite, so the
 * tests pin the boundaries as hard as the behaviour: it informs, it never decides,
 * and it stays quiet when it cannot establish which slot a row belongs to.
 */

const CARD_SPEC = {
  variants: ["horizontal", "vertical"],
  slots: ["card", "body", "actions", "title"],
  tokenBindings: {
    body: {
      gap: { figmaToken: "Space/400", figmaValue: "16px", utility: "gap-4" },
      "padding-top": { figmaToken: "Space/300", figmaValue: "12px", utility: "pt-3" },
    },
    actions: {
      gap: { figmaToken: "Space/400", figmaValue: "16px", utility: "gap-4" },
    },
  },
  notInFigma: ["min-width"],
};

describe("parseContract", () => {
  it("reads every tokenBindings entry, flattened to scope + property", () => {
    const c = parseContract("contracts/card.spec.json", CARD_SPEC);
    expect(c.bindings).toHaveLength(3);
    expect(c.bindings).toContainEqual({
      scope: "actions",
      property: "gap",
      declaredAs: "gap",
      figmaToken: "Space/400",
      figmaValue: "16px",
      utility: "gap-4",
    });
  });

  it("reads nothing else the contract records", () => {
    const c = parseContract("contracts/card.spec.json", CARD_SPEC);
    // `variants`, `slots`, `notInFigma`, `variantNodeIds` are deliberately ignored:
    // reading a field here would imply the tool acts on it, and the contract is
    // validated by nothing.
    expect(Object.keys(c)).toEqual(["path", "bindings"]);
  });

  it("skips malformed entries instead of failing the check", () => {
    const c = parseContract("contracts/x.spec.json", {
      tokenBindings: {
        body: { gap: "gap-4", "padding-top": { figmaToken: "Space/300" }, bad: { figmaToken: "" } },
        broken: "not an object",
      },
    });
    expect(c.bindings).toEqual([
      { scope: "body", property: "padding-top", declaredAs: "padding-top", figmaToken: "Space/300" },
    ]);
  });

  it("yields nothing for a spec with no tokenBindings at all", () => {
    expect(parseContract("p", {}).bindings).toEqual([]);
    expect(parseContract("p", null).bindings).toEqual([]);
    expect(parseContract("p", "nonsense").bindings).toEqual([]);
  });
});

describe("slotFromSelector", () => {
  it("reads the data-slot convention, including a scoped selector", () => {
    expect(slotFromSelector("[data-slot=title]")).toBe("title");
    expect(slotFromSelector('[data-slot="body"]')).toBe("body");
    expect(slotFromSelector("[data-slot=card] [data-slot=body]")).toBe("body");
  });

  it("recognises nothing else, rather than guessing", () => {
    // A class or tag selector carries no slot NAME, and a guessed mapping would
    // attribute one slot's token to another.
    expect(slotFromSelector(".card__body")).toBeUndefined();
    expect(slotFromSelector("div > span")).toBeUndefined();
    expect(slotFromSelector(undefined)).toBeUndefined();
  });
});

describe("contractReferenceFor", () => {
  const contract = parseContract("contracts/card.spec.json", CARD_SPEC);

  it("names the sibling slot the comparison never reached", () => {
    const ref = contractReferenceFor(contract, {
      figmaToken: "Space/400",
      property: "gap",
      selector: "[data-slot=card] [data-slot=body]",
      comparedSelectors: ["[data-slot=card]", "[data-slot=body]"],
    });
    expect(ref).toEqual({
      path: "contracts/card.spec.json",
      figmaToken: "Space/400",
      siblings: [{ slot: "actions", property: "gap", utility: "gap-4", compared: false }],
    });
  });

  it("marks a sibling as compared when the report did reach it", () => {
    const ref = contractReferenceFor(contract, {
      figmaToken: "Space/400",
      property: "gap",
      selector: "[data-slot=body]",
      comparedSelectors: ["[data-slot=body]", "[data-slot=actions]"],
    });
    expect(ref?.siblings[0]?.compared).toBe(true);
  });

  it("matches token names the way the rest of the addon does", () => {
    // `normalizeTokenName`: separator and case differences are the same token.
    const ref = contractReferenceFor(contract, {
      figmaToken: "space-400",
      property: "gap",
      selector: "[data-slot=body]",
      comparedSelectors: [],
    });
    expect(ref?.siblings).toHaveLength(1);
  });

  it("says nothing when the token drives only this slot", () => {
    expect(
      contractReferenceFor(contract, {
        figmaToken: "Space/300",
        property: "padding-top",
        selector: "[data-slot=body]",
        comparedSelectors: [],
      }),
    ).toBeNull();
  });

  /**
   * Correct or absent. Without the row's own slot, every entry for the token looks
   * like a sibling — including the row's own — and the prompt would tell an agent to
   * also change the thing it is already changing.
   */
  it("says nothing when the row's own slot cannot be identified", () => {
    expect(
      contractReferenceFor(contract, {
        figmaToken: "Space/400",
        property: "gap",
        selector: ".card-body",
        comparedSelectors: [],
      }),
    ).toBeNull();
    expect(
      contractReferenceFor(contract, {
        figmaToken: "Space/400",
        property: "gap",
        selector: undefined,
        comparedSelectors: [],
      }),
    ).toBeNull();
  });

  it("says nothing without a contract, or without a token", () => {
    expect(
      contractReferenceFor(undefined, {
        figmaToken: "Space/400",
        property: "gap",
        selector: "[data-slot=body]",
        comparedSelectors: [],
      }),
    ).toBeNull();
    expect(
      contractReferenceFor(contract, {
        figmaToken: undefined,
        property: "gap",
        selector: "[data-slot=body]",
        comparedSelectors: [],
      }),
    ).toBeNull();
  });
});

/**
 * The starter's `contracts/button.spec.json` groups `tokenBindings` by axis rather
 * than by slot, and spells properties in camelCase. The Card's is flat. Both are
 * written by the same skill and validated by nothing, so a reader that assumed one
 * shape would see nothing at all on the other — the same failure as reading nothing,
 * minus the honesty.
 */
describe("the nested, axis-grouped spec shape (the starter's Button)", () => {
  const BUTTON_SPEC = {
    component: "Button",
    tokenBindings: {
      shared: {
        borderRadius: { figmaToken: "size/radius/200", figmaValue: "8px", utility: "rounded-md" },
        gap: { figmaToken: "size/space/200", figmaValue: "8px", utility: "gap-2" },
      },
      bySize: {
        medium: { padding: { figmaToken: "size/space/300", figmaValue: "12px", utility: "p-3" } },
        small: { padding: { figmaToken: "size/space/200", figmaValue: "8px", utility: "p-2" } },
      },
      byVariantAndState: {
        "subtle.default": {
          $comment: "prose, not a property",
          backgroundColor: { figmaToken: null, figmaValue: "none", utility: "bg-transparent" },
          color: { figmaToken: "color/text/default/default", utility: "text-foreground" },
        },
      },
    },
  };

  const contract = parseContract("contracts/button.spec.json", BUTTON_SPEC);

  it("walks to any depth, recording the path as the scope", () => {
    expect(contract.bindings.map((b) => `${b.scope}.${b.declaredAs}`).sort()).toEqual([
      "bySize.medium.padding",
      "bySize.small.padding",
      "byVariantAndState.subtle.default.color",
      "shared.borderRadius",
      "shared.gap",
    ]);
  });

  it("normalises camelCase to the CSS spelling the report uses", () => {
    const radius = contract.bindings.find((b) => b.declaredAs === "borderRadius");
    expect(radius?.property).toBe("border-radius");
  });

  it("treats `figmaToken: null` as the contract saying there is no design source", () => {
    // A deliberate statement, not a token, and not a node to recurse into either.
    expect(contract.bindings.some((b) => b.declaredAs === "backgroundColor")).toBe(false);
  });

  it("names the OTHER consumer of a token the comparison did not cover", () => {
    // `size/space/200` drives the shared `gap-2` and the small size's `p-2`. Moving
    // the token and changing only the gap leaves `p-2` behind — the #71 failure on a
    // component with no `data-slot` selectors at all.
    const ref = contractReferenceFor(contract, {
      figmaToken: "size/space/200",
      property: "gap",
      selector: ".button",
      comparedSelectors: [".button"],
    });
    expect(ref?.siblings).toEqual([
      { slot: "bySize.small", property: "padding", utility: "p-2", compared: false },
    ]);
  });

  it("still refuses to name a same-property entry it cannot tell apart from the row's own", () => {
    // Two `padding` entries, one per size, and nothing in a root selector says which
    // size this story renders. Under-reporting is the safe direction; naming the
    // row's own binding as its sibling is not.
    const ref = contractReferenceFor(contract, {
      figmaToken: "size/space/300",
      property: "padding",
      selector: ".button",
      comparedSelectors: [".button"],
    });
    expect(ref).toBeNull();
  });
});

/**
 * The spelling gap that made this feature a no-op on the only real consumer:
 * `component-handoff` records a variable collection-qualified (`size/space/200`),
 * while the drift report carries the variable's own name (`Space/200`).
 */
describe("token matching across the contract's longer path", () => {
  const contract = parseContract("contracts/button.spec.json", {
    tokenBindings: {
      shared: { gap: { figmaToken: "size/space/200", utility: "gap-2" } },
      bySize: {
        small: { padding: { figmaToken: "size/space/200", utility: "p-2" } },
        medium: { padding: { figmaToken: "size/space/300", utility: "p-3" } },
      },
    },
  });

  it("matches a report's short name against the contract's qualified one", () => {
    const ref = contractReferenceFor(contract, {
      figmaToken: "Space/200",
      property: "gap",
      selector: ".button",
      comparedSelectors: [".button"],
    });
    expect(ref?.siblings).toEqual([
      { slot: "bySize.small", property: "padding", utility: "p-2", compared: false },
    ]);
  });

  it("refuses an AMBIGUOUS suffix match rather than picking one", () => {
    // Two different tokens both end in `-default`. A wrong pairing would point an
    // agent at a slot bound to a different design decision.
    const ambiguous = parseContract("contracts/x.spec.json", {
      tokenBindings: {
        a: { color: { figmaToken: "color/border/default" } },
        b: { "background-color": { figmaToken: "size/border/default" } },
      },
    });
    expect(
      contractReferenceFor(ambiguous, {
        figmaToken: "border/default",
        property: "color",
        selector: "[data-slot=a]",
        comparedSelectors: [],
      }),
    ).toBeNull();
  });

  it("does not suffix-match across a segment boundary that is not one", () => {
    // `space/200` must not match `space/2000`.
    const other = parseContract("contracts/y.spec.json", {
      tokenBindings: {
        a: { gap: { figmaToken: "size/space/2000" } },
        b: { padding: { figmaToken: "size/space/2000" } },
      },
    });
    expect(
      contractReferenceFor(other, {
        figmaToken: "space/200",
        property: "gap",
        selector: "[data-slot=a]",
        comparedSelectors: [],
      }),
    ).toBeNull();
  });
});
