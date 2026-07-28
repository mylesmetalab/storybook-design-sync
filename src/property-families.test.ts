import { describe, expect, it } from "vitest";
import {
  driftedSiblings,
  expectedIdentity,
  propertyFamilies,
  propertyFamily,
} from "./property-families.js";
import type { DimensionDiff } from "./dimensions/types.js";

/**
 * The failure these tests exist for: four drifted paddings, one per-row fix
 * prompt handed over, and a component that came back 6px/12px/12px/12px — a
 * state nobody designed. Sibling grouping is what makes that impossible to
 * cause by accident, so it has to be right for each family the panel actually
 * reports, and silent for properties that have no siblings.
 */

/**
 * Overrides may set a field to `undefined` explicitly — that is how the engine
 * hands us a row with no `tokenName` — so this is laxer than
 * `Partial<DimensionDiff>` under `exactOptionalPropertyTypes`.
 */
type DiffOverride = { [K in keyof DimensionDiff]?: DimensionDiff[K] | undefined } &
  Pick<DimensionDiff, "property">;

const diff = (over: DiffOverride): DimensionDiff =>
  ({
    kind: "token-value",
    codeValue: "6px",
    figmaValue: "12px (token: Space/150)",
    status: "drift",
    tokenName: "Space/150",
    ...over,
  }) as DimensionDiff;

describe("propertyFamily — derived from the shared shorthand tables, not re-listed", () => {
  it("groups the four paddings under `padding`", () => {
    const family = propertyFamily("padding-top");
    expect(family?.label).toBe("padding");
    expect(family?.members).toEqual(
      expect.arrayContaining([
        "padding",
        "padding-top",
        "padding-right",
        "padding-bottom",
        "padding-left",
      ]),
    );
  });

  it("groups the four corner radii under `border-radius`", () => {
    const family = propertyFamily("border-bottom-right-radius");
    expect(family?.label).toBe("border-radius");
    expect(family?.members).toEqual(
      expect.arrayContaining([
        "border-top-left-radius",
        "border-top-right-radius",
        "border-bottom-left-radius",
        "border-bottom-right-radius",
      ]),
    );
  });

  it("groups the per-edge border colours and widths onto their engine keys", () => {
    expect(propertyFamily("border-top-color")?.label).toBe("border-color");
    expect(propertyFamily("border-left-color")?.label).toBe("border-color");
    // The engine reports the collapsed key; it must land in the same family or a
    // row would find siblings or not depending on which scanner produced it.
    expect(propertyFamily("border-color")?.label).toBe("border-color");
    expect(propertyFamily("border-bottom-width")?.label).toBe("border-width");
  });

  it("pairs font-size with line-height", () => {
    expect(propertyFamily("font-size")?.members).toEqual(["font-size", "line-height"]);
    expect(propertyFamily("line-height")?.label).toBe("type ramp");
  });

  it("leaves genuinely standalone properties without a family", () => {
    for (const property of ["gap", "box-shadow", "color", "letter-spacing", "opacity"]) {
      expect(propertyFamily(property), property).toBeUndefined();
    }
    // `background` expands to a single longhand, so it is not a family of one.
    expect(propertyFamily("background-color")).toBeUndefined();
  });

  it("never claims a family of fewer than two properties", () => {
    for (const family of propertyFamilies()) {
      expect(family.members.length, family.label).toBeGreaterThan(1);
    }
  });
});

describe("expectedIdentity — 'the same design decision' has to mean something", () => {
  it("prefers the token name, normalized across spellings", () => {
    expect(expectedIdentity({ tokenName: "Space/150", figmaValue: "12px" })).toBe(
      expectedIdentity({ tokenName: "space-150", figmaValue: "anything" }),
    );
  });

  it("falls back to the resolved value when no token backs it", () => {
    expect(expectedIdentity({ figmaValue: "12px" })).toBe("value:12px");
  });

  it("is null when Figma's side is unreadable", () => {
    expect(expectedIdentity({ figmaValue: null })).toBeNull();
    expect(expectedIdentity({ figmaValue: { light: "#fff", dark: "#000" } })).toBeNull();
  });
});

/**
 * Table-driven over every family the panel reports, in both directions: the
 * siblings ARE named when they drifted to the same value, and are NOT named
 * when they didn't.
 */
const FAMILY_CASES: Array<{ family: string; properties: [string, string, string, string] }> = [
  {
    family: "padding",
    properties: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
  },
  {
    family: "border-radius",
    properties: [
      "border-top-left-radius",
      "border-top-right-radius",
      "border-bottom-left-radius",
      "border-bottom-right-radius",
    ],
  },
  {
    family: "border-color",
    properties: [
      "border-top-color",
      "border-right-color",
      "border-bottom-color",
      "border-left-color",
    ],
  },
];

describe("driftedSiblings — same family, same element, both drifted, same expected value", () => {
  for (const { family, properties } of FAMILY_CASES) {
    it(`names the other three ${family} properties when all four drifted alike`, () => {
      const all = properties.map((property) => diff({ property }));
      expect(driftedSiblings(all[0]!, all).map((d) => d.property)).toEqual(properties.slice(1));
    });

    it(`names nobody when the other ${family} properties did NOT drift`, () => {
      const all = [
        diff({ property: properties[0]! }),
        ...properties.slice(1).map((property) => diff({ property, status: "match" })),
      ];
      expect(driftedSiblings(all[0]!, all)).toEqual([]);
    });

    it(`names nobody when the other ${family} properties drifted to a DIFFERENT value`, () => {
      const all = [
        diff({ property: properties[0]! }),
        ...properties.slice(1).map((property) =>
          diff({ property, figmaValue: "4px (token: Space/50)", tokenName: "Space/50" }),
        ),
      ];
      expect(driftedSiblings(all[0]!, all)).toEqual([]);
    });
  }

  it("pairs font-size and line-height when both drifted to the same token", () => {
    const all = [
      diff({ property: "font-size", figmaValue: "13px (token: type/13)", tokenName: "type/13" }),
      diff({ property: "line-height", figmaValue: "13px (token: type/13)", tokenName: "type/13" }),
    ];
    expect(driftedSiblings(all[0]!, all).map((d) => d.property)).toEqual(["line-height"]);
  });

  it("never crosses elements — a child's padding says nothing about the root's", () => {
    const root = diff({ property: "padding-top" });
    const child = diff({ property: "padding-right", childSelector: "[data-slot=header]" });
    expect(driftedSiblings(root, [root, child])).toEqual([]);
    expect(driftedSiblings(child, [root, child])).toEqual([]);
  });

  it("groups within one child element", () => {
    const a = diff({ property: "padding-top", childSelector: "[data-slot=header]" });
    const b = diff({ property: "padding-left", childSelector: "[data-slot=header]" });
    expect(driftedSiblings(a, [a, b]).map((d) => d.property)).toEqual(["padding-left"]);
  });

  it("never crosses families", () => {
    const padding = diff({ property: "padding-top" });
    const radius = diff({ property: "border-top-left-radius" });
    const gap = diff({ property: "gap" });
    expect(driftedSiblings(padding, [padding, radius, gap])).toEqual([]);
  });

  it("is empty for a property with no family, and for non-drifted rows", () => {
    const gap = diff({ property: "gap" });
    expect(driftedSiblings(gap, [gap])).toEqual([]);
    const matched = diff({ property: "padding-top", status: "match" });
    expect(driftedSiblings(matched, [matched, diff({ property: "padding-left" })])).toEqual([]);
  });

  it("groups unbound (token-less) siblings on their shared literal", () => {
    // Detached in Figma: no token name on either side, same literal.
    const all = ["padding-top", "padding-bottom"].map((property) =>
      diff({ property, figmaValue: "12px", tokenName: undefined }),
    );
    expect(driftedSiblings(all[0]!, all).map((d) => d.property)).toEqual(["padding-bottom"]);
  });
});
