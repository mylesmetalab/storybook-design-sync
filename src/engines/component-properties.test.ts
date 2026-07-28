import { describe, expect, it } from "vitest";
import {
  componentPropertyRows,
  effectiveComponentProperties,
  matchArgForProperty,
  normalizePropName,
  stripBooleanPrefix,
  stripPropertyIdSuffix,
} from "./component-properties.js";

/**
 * Figma component properties (BOOLEAN / TEXT / INSTANCE_SWAP) vs story args.
 *
 * Every refusal below is load-bearing. The whole reason this comparison didn't
 * exist is that a wrong answer ("your `Has Icon Start` doesn't match") is worse
 * than no answer, so the name matcher refuses on absence *and* on ambiguity,
 * INSTANCE_SWAP is never adjudicated, and a component *default* never produces
 * drift.
 */

describe("key parsing", () => {
  it("strips Figma's `#id` suffix from non-variant property keys", () => {
    expect(stripPropertyIdSuffix("Has Icon Start#4611:0")).toBe("Has Icon Start");
    // Variant keys carry no suffix.
    expect(stripPropertyIdSuffix("Size")).toBe("Size");
  });

  it("normalizes to alphanumerics and drops a leading has/is", () => {
    expect(normalizePropName("Has Icon Start")).toBe("hasiconstart");
    expect(normalizePropName("icon_start")).toBe("iconstart");
    expect(stripBooleanPrefix("hasiconstart")).toBe("iconstart");
    expect(stripBooleanPrefix("isdirty")).toBe("dirty");
    expect(stripBooleanPrefix("iconstart")).toBe("iconstart");
  });
});

describe("matchArgForProperty", () => {
  const cases: Array<[string, string, Record<string, unknown>, string]> = [
    [
      "Figma's `Has Icon Start` finds code's `iconStart`",
      "Has Icon Start",
      { iconStart: true, children: "x" },
      "one:iconStart",
    ],
    ["exact name wins outright", "Has Icon", { hasIcon: true }, "one:hasIcon"],
    [
      "an exact match settles a near-collision instead of reading as ambiguous",
      "Has Icon",
      { hasIcon: true, icon: true },
      "one:hasIcon",
    ],
    ["case and separators are irrelevant", "has-icon-end", { HasIconEnd: true }, "one:HasIconEnd"],
    ["no candidate → refuse", "Has Icon Start", { size: "lg" }, "none"],
    [
      "two equally plausible candidates → refuse",
      "Has Icon Start",
      { iconStart: true, isIconStart: true },
      "ambiguous",
    ],
    ["a name that normalizes to nothing → refuse", "  ", { icon: true }, "none"],
  ];
  for (const [name, figmaName, args, expected] of cases) {
    it(name, () => {
      const got = matchArgForProperty(figmaName, args);
      expect(got.kind === "one" ? `one:${got.key}` : got.kind).toBe(expected);
    });
  }
});

describe("effectiveComponentProperties", () => {
  it("prefers an INSTANCE's actual value over the component default", () => {
    const map = effectiveComponentProperties({
      componentProperties: { "Has Icon#1:0": { type: "BOOLEAN", value: true } },
      componentPropertyDefinitions: { "Has Icon#1:0": { type: "BOOLEAN", defaultValue: false } },
    });
    expect(map.get("Has Icon")).toEqual({ type: "BOOLEAN", value: true, authoritative: true });
  });

  it("falls back to the definition's default, marked non-authoritative", () => {
    const map = effectiveComponentProperties({
      componentPropertyDefinitions: { "Label#1:0": { type: "TEXT", defaultValue: "Submit" } },
    });
    expect(map.get("Label")).toEqual({ type: "TEXT", value: "Submit", authoritative: false });
  });
});

/** An INSTANCE: its property values are what it actually renders. */
function instance(props: Record<string, { type: string; value?: unknown }>) {
  return { componentProperties: props };
}

/** A COMPONENT/COMPONENT_SET: only defaults are available. */
function definitions(defs: Record<string, { type: string; defaultValue?: unknown }>) {
  return { componentPropertyDefinitions: defs };
}

describe("componentPropertyRows: BOOLEAN", () => {
  it("matches a truthy ReactNode arg against Figma's `true`", () => {
    const rows = componentPropertyRows({
      node: instance({ "Has Icon Start#1:0": { type: "BOOLEAN", value: true } }),
      args: { iconStart: { $$typeof: "react.element" } },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "props",
      property: "Has Icon Start",
      figmaValue: true,
      status: "match",
    });
    // The cell stays JSON-safe — args can carry ReactNodes and functions.
    expect(rows[0]?.codeValue).toEqual({ iconStart: "<provided>" });
  });

  it("drifts when the instance says true and the arg is falsy", () => {
    const rows = componentPropertyRows({
      node: instance({ "Has Icon Start#1:0": { type: "BOOLEAN", value: true } }),
      args: { iconStart: null },
    });
    expect(rows[0]?.status).toBe("drift");
  });

  it("drifts when the instance says false and the arg is set", () => {
    const rows = componentPropertyRows({
      node: instance({ "Has Icon End#1:0": { type: "BOOLEAN", value: false } }),
      args: { iconEnd: "→" },
    });
    expect(rows[0]?.status).toBe("drift");
  });

  it("emits no row when no arg corresponds", () => {
    const rows = componentPropertyRows({
      node: instance({ "Has Icon Start#1:0": { type: "BOOLEAN", value: true } }),
      args: { size: "lg" },
    });
    expect(rows).toEqual([]);
  });

  it("emits no row when the correspondence is ambiguous", () => {
    const rows = componentPropertyRows({
      node: instance({ "Has Icon Start#1:0": { type: "BOOLEAN", value: true } }),
      args: { iconStart: true, isIconStart: true },
    });
    expect(rows).toEqual([]);
  });

  it("emits no row when Figma's value isn't a boolean", () => {
    const rows = componentPropertyRows({
      node: instance({ "Has Icon Start#1:0": { type: "BOOLEAN", value: "yes" } }),
      args: { iconStart: true },
    });
    expect(rows).toEqual([]);
  });

  it("never calls a disagreement with a component *default* drift", () => {
    const rows = componentPropertyRows({
      node: definitions({ "Has Icon Start#1:0": { type: "BOOLEAN", defaultValue: false } }),
      args: { iconStart: "★" },
    });
    // A `WithIcon` story is entitled to differ from the component default.
    expect(rows[0]?.status).toBe("flag-only");
    expect(rows[0]?.note).toContain("default");
  });

  it("still confirms agreement with a default", () => {
    const rows = componentPropertyRows({
      node: definitions({ "Has Icon Start#1:0": { type: "BOOLEAN", defaultValue: false } }),
      args: { iconStart: undefined },
    });
    expect(rows[0]?.status).toBe("match");
    expect(rows[0]?.note).toBeUndefined();
  });
});

describe("componentPropertyRows: TEXT", () => {
  it("compares a string arg against the Figma property value", () => {
    const rows = componentPropertyRows({
      node: instance({ "Badge Text#1:0": { type: "TEXT", value: "New" } }),
      args: { badgeText: "New" },
      figmaTexts: ["Submit"],
    });
    expect(rows[0]).toMatchObject({ property: "Badge Text", status: "match", figmaValue: "New" });
  });

  it("drifts on a different string", () => {
    const rows = componentPropertyRows({
      node: instance({ "Badge Text#1:0": { type: "TEXT", value: "New" } }),
      args: { badgeText: "Old" },
    });
    expect(rows[0]?.status).toBe("drift");
  });

  it("defers to the `copy` dimension when the same string is already reported", () => {
    const rows = componentPropertyRows({
      node: instance({ "Label#1:0": { type: "TEXT", value: "Submit" } }),
      args: { label: "Submit" },
      // `collectFigmaText` found this exact string on a TEXT node, so `copy`
      // owns it — reporting it here too would double-count one string.
      figmaTexts: ["Submit"],
    });
    expect(rows).toEqual([]);
  });

  it("emits no row when the arg isn't a string", () => {
    const rows = componentPropertyRows({
      node: instance({ "Badge Text#1:0": { type: "TEXT", value: "New" } }),
      args: { badgeText: { $$typeof: "react.element" } },
    });
    expect(rows).toEqual([]);
  });
});

describe("componentPropertyRows: INSTANCE_SWAP and VARIANT", () => {
  it("never compares an INSTANCE_SWAP, and names it as unmodelled instead", () => {
    const rows = componentPropertyRows({
      node: definitions({
        "Icon Start#1:0": { type: "INSTANCE_SWAP", defaultValue: "1:23" },
        "Icon End#1:1": { type: "INSTANCE_SWAP", defaultValue: "1:24" },
      }),
      args: { iconStart: "★", iconEnd: "→" },
    });
    // One informational row for both, and no per-property verdicts.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "props", property: "instance-swap", status: "flag-only" });
    expect(rows[0]?.figmaValue).toEqual(["Icon Start", "Icon End"]);
    expect(rows[0]?.note).toContain("unmodelled");
  });

  it("leaves VARIANT axes to the variant comparison", () => {
    const rows = componentPropertyRows({
      node: definitions({ Size: { type: "VARIANT", defaultValue: "Medium" } }),
      args: { size: "Medium" },
    });
    expect(rows).toEqual([]);
  });

  it("emits nothing at all for a node with no component properties", () => {
    expect(componentPropertyRows({ node: {}, args: { size: "lg" } })).toEqual([]);
  });
});
