import { describe, expect, it } from "vitest";

import { resolveVariablesLocal } from "./variable-resolution.js";

/**
 * Resolution exists for one consumer: `verify`'s shared-value re-check, which has
 * to answer "do these variables still resolve to the same value, mode by mode".
 * Real SDS variables are aliases into a single-mode primitives collection, so the
 * fixture mirrors that exactly — a checker tested only on direct values would pass
 * while resolving nothing real.
 */

/** Minimal `variables/local` meta in Figma's real response shape. */
function meta() {
  return {
    variableCollections: {
      "VariableCollectionId:1:1": {
        id: "VariableCollectionId:1:1",
        name: "Color",
        defaultModeId: "1:0",
        modes: [
          { modeId: "1:0", name: "SDS Light" },
          { modeId: "1:1", name: "SDS Dark" },
        ],
      },
      "VariableCollectionId:2:1": {
        id: "VariableCollectionId:2:1",
        name: "Color Primitives",
        defaultModeId: "2:0",
        modes: [{ modeId: "2:0", name: "Value" }],
      },
    },
    variables: {
      "VariableID:10": {
        id: "VariableID:10",
        name: "Brand/800",
        variableCollectionId: "VariableCollectionId:2:1",
        resolvedType: "COLOR",
        valuesByMode: { "2:0": { r: 44 / 255, g: 44 / 255, b: 44 / 255, a: 1 } },
      },
      "VariableID:11": {
        id: "VariableID:11",
        name: "White/1000",
        variableCollectionId: "VariableCollectionId:2:1",
        resolvedType: "COLOR",
        valuesByMode: { "2:0": { r: 245 / 255, g: 245 / 255, b: 245 / 255, a: 1 } },
      },
      "VariableID:20": {
        id: "VariableID:20",
        name: "Background/Brand/Default",
        variableCollectionId: "VariableCollectionId:1:1",
        resolvedType: "COLOR",
        valuesByMode: {
          "1:0": { type: "VARIABLE_ALIAS", id: "VariableID:10" },
          "1:1": { type: "VARIABLE_ALIAS", id: "VariableID:11" },
        },
      },
      "VariableID:21": {
        id: "VariableID:21",
        name: "Border/Brand/Default",
        variableCollectionId: "VariableCollectionId:1:1",
        resolvedType: "COLOR",
        valuesByMode: {
          "1:0": { type: "VARIABLE_ALIAS", id: "VariableID:10" },
          "1:1": { type: "VARIABLE_ALIAS", id: "VariableID:11" },
        },
      },
      "VariableID:30": {
        id: "VariableID:30",
        name: "spacing/slot",
        variableCollectionId: "VariableCollectionId:2:1",
        resolvedType: "FLOAT",
        valuesByMode: { "2:0": 24 },
      },
    },
  };
}

describe("resolveVariablesLocal", () => {
  it("resolves direct values per mode, colors normalized to hex", () => {
    const out = resolveVariablesLocal(meta())!;
    const prim = out.variables.find((v) => v.name === "Brand/800")!;
    expect(prim.resolvedByMode).toEqual({ Value: "#2c2c2c" });
    expect(prim.unresolved).toEqual([]);
    const spacing = out.variables.find((v) => v.name === "spacing/slot")!;
    expect(spacing.resolvedByMode).toEqual({ Value: "24" });
  });

  /**
   * The SDS shape: a two-mode semantic variable aliasing a one-mode primitives
   * collection. The alias target has no "SDS Dark" mode, so resolution must fall
   * back to the target collection's DEFAULT mode — Figma's own semantics.
   */
  it("follows alias chains across collections with default-mode fallback", () => {
    const out = resolveVariablesLocal(meta())!;
    const bg = out.variables.find((v) => v.name === "Background/Brand/Default")!;
    expect(bg.resolvedByMode).toEqual({ "SDS Light": "#2c2c2c", "SDS Dark": "#f5f5f5" });
    const border = out.variables.find((v) => v.name === "Border/Brand/Default")!;
    expect(border.resolvedByMode).toEqual({ "SDS Light": "#2c2c2c", "SDS Dark": "#f5f5f5" });
  });

  it("reports an alias cycle as unresolved for that mode, never throws or guesses", () => {
    const m = meta();
    const vars = m.variables as Record<string, { valuesByMode: Record<string, unknown> }>;
    vars["VariableID:10"]!.valuesByMode["2:0"] = { type: "VARIABLE_ALIAS", id: "VariableID:20" };
    const out = resolveVariablesLocal(m)!;
    const bg = out.variables.find((v) => v.name === "Background/Brand/Default")!;
    expect(bg.resolvedByMode["SDS Light"]).toBeUndefined();
    expect(bg.unresolved).toContain("SDS Light");
    // Dark aliases White/1000, which is untouched — it must still resolve.
    expect(bg.resolvedByMode["SDS Dark"]).toBe("#f5f5f5");
  });

  it("keeps alpha only when it carries information", () => {
    const m = meta();
    const vars = m.variables as Record<string, { valuesByMode: Record<string, unknown> }>;
    vars["VariableID:10"]!.valuesByMode["2:0"] = { r: 1, g: 1, b: 1, a: 0.7 };
    const out = resolveVariablesLocal(m)!;
    const prim = out.variables.find((v) => v.name === "Brand/800")!;
    expect(prim.resolvedByMode["Value"]).toBe("#ffffffb3");
  });

  it("lists every collection with id, name and mode names", () => {
    const out = resolveVariablesLocal(meta())!;
    expect(out.collections).toEqual([
      { id: "VariableCollectionId:1:1", name: "Color", modes: ["SDS Light", "SDS Dark"] },
      { id: "VariableCollectionId:2:1", name: "Color Primitives", modes: ["Value"] },
    ]);
  });

  it("returns null on a shape it cannot read, never an empty result", () => {
    expect(resolveVariablesLocal(undefined)).toBeNull();
    expect(resolveVariablesLocal("nope")).toBeNull();
    expect(resolveVariablesLocal({})).toBeNull();
  });
});
