import { describe, expect, it } from "vitest";
import {
  isFlexDisplay,
  isGridDisplay,
  layoutRows,
  layoutRowsApplicable,
  type FigmaLayoutNode,
} from "./layout.js";

/**
 * The `structure` dimension became visible in v0.0.39. Two halves are under
 * test and they matter equally:
 *
 *  1. the enum → CSS mappings (a Card handed off with the wrong `Direction`
 *     must stop reporting clean), and
 *  2. **applicability** — the comparison must emit NOTHING when either side
 *     isn't laying out children. `getComputedStyle` reports
 *     `flex-direction: row` on a plain `<div>`, so an unguarded check would
 *     deliver a confident verdict about four properties that affect no pixel of
 *     the render. That is the failure this project keeps paying for, so the
 *     no-row cases are asserted as hard as the mappings.
 */

function flex(overrides: Record<string, string> = {}): Record<string, string> {
  return { display: "flex", "flex-direction": "row", ...overrides };
}

function rowFor(rows: ReturnType<typeof layoutRows>, property: string) {
  return rows.find((r) => r.property === property);
}

describe("layoutRowsApplicable", () => {
  it("needs a real Figma auto-layout AND a flex/grid code container", () => {
    expect(layoutRowsApplicable({ layoutMode: "HORIZONTAL", display: "flex" })).toBe(true);
    expect(layoutRowsApplicable({ layoutMode: "VERTICAL", display: "inline-flex" })).toBe(true);
    expect(layoutRowsApplicable({ layoutMode: "HORIZONTAL", display: "grid" })).toBe(true);
    expect(layoutRowsApplicable({ layoutMode: "HORIZONTAL", display: "inline-grid" })).toBe(true);
    // Figma isn't laying out children.
    expect(layoutRowsApplicable({ layoutMode: "NONE", display: "flex" })).toBe(false);
    expect(layoutRowsApplicable({ layoutMode: undefined, display: "flex" })).toBe(false);
    // Code isn't a container.
    expect(layoutRowsApplicable({ layoutMode: "HORIZONTAL", display: "block" })).toBe(false);
    expect(layoutRowsApplicable({ layoutMode: "HORIZONTAL", display: "inline-block" })).toBe(false);
    expect(layoutRowsApplicable({ layoutMode: "HORIZONTAL", display: undefined })).toBe(false);
  });

  it("refuses Figma's GRID auto-layout outright", () => {
    // `layoutMode: "GRID"` has no `flex-direction` counterpart — see the
    // module docblock. Not applicable, so not a single row.
    expect(layoutRowsApplicable({ layoutMode: "GRID", display: "grid" })).toBe(false);
    expect(layoutRows({ layoutMode: "GRID", primaryAxisAlignItems: "CENTER" }, flex())).toEqual([]);
  });

  it("reads two-value and inline display keywords", () => {
    expect(isFlexDisplay("block flex")).toBe(true);
    expect(isFlexDisplay("inline-flex")).toBe(true);
    expect(isFlexDisplay("grid")).toBe(false);
    expect(isGridDisplay("block grid")).toBe(true);
    expect(isGridDisplay("inline-grid")).toBe(true);
    expect(isGridDisplay("flex")).toBe(false);
  });
});

describe("layoutRows — no row when the comparison doesn't apply", () => {
  it("emits no row when the code element is not a flex/grid container", () => {
    const node: FigmaLayoutNode = {
      layoutMode: "VERTICAL",
      primaryAxisAlignItems: "CENTER",
      counterAxisAlignItems: "CENTER",
      layoutWrap: "WRAP",
    };
    // A plain block element still computes `flex-direction: row`,
    // `justify-content: normal` etc. — none of it applies.
    expect(
      layoutRows(node, {
        display: "block",
        "flex-direction": "row",
        "justify-content": "normal",
        "align-items": "normal",
        "flex-wrap": "nowrap",
      }),
    ).toEqual([]);
  });

  it("emits no row when Figma's layoutMode is NONE", () => {
    const node: FigmaLayoutNode = {
      layoutMode: "NONE",
      primaryAxisAlignItems: "CENTER",
      counterAxisAlignItems: "MAX",
      layoutWrap: "WRAP",
    };
    expect(layoutRows(node, flex({ "justify-content": "flex-start" }))).toEqual([]);
  });

  it("emits no row when the snapshot has no `display` (older preview bundle)", () => {
    const node: FigmaLayoutNode = { layoutMode: "HORIZONTAL", primaryAxisAlignItems: "CENTER" };
    expect(layoutRows(node, { "flex-direction": "row" })).toEqual([]);
    expect(layoutRows(node, undefined)).toEqual([]);
  });

  it("emits no row for an enum value it refuses to map", () => {
    const rows = layoutRows(
      {
        layoutMode: "HORIZONTAL",
        // Not in the mapped set — a value we don't understand is skipped, never
        // guessed at.
        primaryAxisAlignItems: "SPACE_AROUND",
        counterAxisAlignItems: "SOMETHING_NEW",
        layoutWrap: "WRAP_REVERSE",
      },
      flex({ "justify-content": "space-around", "align-items": "center", "flex-wrap": "wrap" }),
    );
    expect(rowFor(rows, "justify-content")).toBeUndefined();
    expect(rowFor(rows, "align-items")).toBeUndefined();
    expect(rowFor(rows, "flex-wrap")).toBeUndefined();
    // The direction row is unaffected by its siblings' unmapped values.
    expect(rowFor(rows, "flex-direction")?.status).toBe("match");
  });

  it("emits no flex-direction / flex-wrap row on a grid container", () => {
    const rows = layoutRows(
      { layoutMode: "HORIZONTAL", layoutWrap: "WRAP", counterAxisAlignItems: "CENTER" },
      { display: "grid", "flex-direction": "row", "flex-wrap": "nowrap", "align-items": "center" },
    );
    expect(rowFor(rows, "flex-direction")).toBeUndefined();
    expect(rowFor(rows, "flex-wrap")).toBeUndefined();
    expect(rowFor(rows, "align-items")?.status).toBe("match");
  });

  it("emits no flex-wrap row when both sides sit on their default", () => {
    const rows = layoutRows(
      { layoutMode: "HORIZONTAL", layoutWrap: "NO_WRAP" },
      flex({ "flex-wrap": "nowrap" }),
    );
    expect(rowFor(rows, "flex-wrap")).toBeUndefined();
  });
});

describe("layoutRows — layoutMode → flex-direction", () => {
  it("HORIZONTAL → row", () => {
    expect(rowFor(layoutRows({ layoutMode: "HORIZONTAL" }, flex()), "flex-direction")).toMatchObject({
      kind: "structure",
      property: "flex-direction",
      codeValue: "row",
      figmaValue: "row",
      status: "match",
    });
  });

  it("VERTICAL → column", () => {
    expect(
      rowFor(layoutRows({ layoutMode: "VERTICAL" }, flex({ "flex-direction": "column" })), "flex-direction"),
    ).toMatchObject({ figmaValue: "column", codeValue: "column", status: "match" });
  });

  it("catches the Card handed off with the wrong direction", () => {
    // The regression this dimension was unhidden for: Figma says Vertical, the
    // code lays out in a row, and the old report said clean.
    const row = rowFor(layoutRows({ layoutMode: "VERTICAL" }, flex()), "flex-direction");
    expect(row).toMatchObject({ codeValue: "row", figmaValue: "column", status: "drift" });
  });

  it("treats a reversed code direction as drift, not a match", () => {
    // Figma auto-layout cannot express reversal, so `row-reverse` really is a
    // difference — reported, not folded into `row`.
    expect(
      rowFor(layoutRows({ layoutMode: "HORIZONTAL" }, flex({ "flex-direction": "row-reverse" })), "flex-direction")
        ?.status,
    ).toBe("drift");
  });
});

describe("layoutRows — primaryAxisAlignItems → justify-content", () => {
  const cases: Array<[string, string]> = [
    ["MIN", "flex-start"],
    ["CENTER", "center"],
    ["MAX", "flex-end"],
    ["SPACE_BETWEEN", "space-between"],
  ];
  for (const [figmaEnum, css] of cases) {
    it(`${figmaEnum} → ${css}`, () => {
      const match = rowFor(
        layoutRows({ layoutMode: "HORIZONTAL", primaryAxisAlignItems: figmaEnum }, flex({ "justify-content": css })),
        "justify-content",
      );
      expect(match).toMatchObject({ kind: "structure", figmaValue: css, status: "match" });
      const drift = rowFor(
        layoutRows(
          { layoutMode: "HORIZONTAL", primaryAxisAlignItems: figmaEnum },
          flex({ "justify-content": css === "center" ? "flex-end" : "center" }),
        ),
        "justify-content",
      );
      expect(drift?.status).toBe("drift");
    });
  }

  it("accepts the logical `start` / `end` spellings", () => {
    expect(
      rowFor(
        layoutRows({ layoutMode: "HORIZONTAL", primaryAxisAlignItems: "MIN" }, flex({ "justify-content": "start" })),
        "justify-content",
      )?.status,
    ).toBe("match");
    expect(
      rowFor(
        layoutRows({ layoutMode: "HORIZONTAL", primaryAxisAlignItems: "MAX" }, flex({ "justify-content": "end" })),
        "justify-content",
      )?.status,
    ).toBe("match");
  });

  it("refuses the physical `left` / `right` spellings — unresolved, never a verdict", () => {
    const row = rowFor(
      layoutRows({ layoutMode: "HORIZONTAL", primaryAxisAlignItems: "MIN" }, flex({ "justify-content": "left" })),
      "justify-content",
    );
    expect(row?.status).toBe("unresolved");
    expect(row?.note).toContain("direction-independent");
  });

  it("is flag-only, never drift, when the code declares nothing", () => {
    const row = rowFor(
      layoutRows({ layoutMode: "HORIZONTAL", primaryAxisAlignItems: "CENTER" }, flex({ "justify-content": "normal" })),
      "justify-content",
    );
    expect(row?.status).toBe("flag-only");
    expect(row?.note).toContain("declares no justify-content");
  });

  it("emits no row when the code declares nothing and Figma matches the CSS default", () => {
    expect(
      rowFor(
        layoutRows({ layoutMode: "HORIZONTAL", primaryAxisAlignItems: "MIN" }, flex({ "justify-content": "normal" })),
        "justify-content",
      ),
    ).toBeUndefined();
  });
});

describe("layoutRows — counterAxisAlignItems → align-items", () => {
  const cases: Array<[string, string]> = [
    ["MIN", "flex-start"],
    ["CENTER", "center"],
    ["MAX", "flex-end"],
    ["BASELINE", "baseline"],
  ];
  for (const [figmaEnum, css] of cases) {
    it(`${figmaEnum} → ${css}`, () => {
      expect(
        rowFor(
          layoutRows({ layoutMode: "HORIZONTAL", counterAxisAlignItems: figmaEnum }, flex({ "align-items": css })),
          "align-items",
        ),
      ).toMatchObject({ figmaValue: css, status: "match" });
      expect(
        rowFor(
          layoutRows(
            { layoutMode: "HORIZONTAL", counterAxisAlignItems: figmaEnum },
            flex({ "align-items": css === "center" ? "baseline" : "center" }),
          ),
          "align-items",
        )?.status,
      ).toBe("drift");
    });
  }

  it("is flag-only when the code leaves align-items at the `normal` default", () => {
    // `align-items: normal` behaves as `stretch`, which is NOT `flex-start` —
    // but the code stated no opinion, so this can never be drift.
    const row = rowFor(
      layoutRows({ layoutMode: "HORIZONTAL", counterAxisAlignItems: "MIN" }, flex({ "align-items": "normal" })),
      "align-items",
    );
    expect(row?.status).toBe("flag-only");
  });
});

describe("layoutRows — layoutWrap → flex-wrap", () => {
  it("WRAP → wrap", () => {
    expect(
      rowFor(layoutRows({ layoutMode: "HORIZONTAL", layoutWrap: "WRAP" }, flex({ "flex-wrap": "wrap" })), "flex-wrap"),
    ).toMatchObject({ figmaValue: "wrap", status: "match" });
  });

  it("NO_WRAP → nowrap, and drifts against a wrapping code element", () => {
    expect(
      rowFor(
        layoutRows({ layoutMode: "HORIZONTAL", layoutWrap: "NO_WRAP" }, flex({ "flex-wrap": "wrap" })),
        "flex-wrap",
      ),
    ).toMatchObject({ figmaValue: "nowrap", codeValue: "wrap", status: "drift" });
  });

  it("treats `wrap-reverse` as drift — Figma cannot express it", () => {
    expect(
      rowFor(
        layoutRows({ layoutMode: "HORIZONTAL", layoutWrap: "WRAP" }, flex({ "flex-wrap": "wrap-reverse" })),
        "flex-wrap",
      )?.status,
    ).toBe("drift");
  });
});

describe("layoutRows — axis disagreement makes alignment unresolved", () => {
  it("reports no alignment verdict when Figma is VERTICAL and the code is a row", () => {
    const rows = layoutRows(
      {
        layoutMode: "VERTICAL",
        primaryAxisAlignItems: "CENTER",
        counterAxisAlignItems: "CENTER",
      },
      flex({ "justify-content": "center", "align-items": "center" }),
    );
    // The direction itself is the finding, and it is drift.
    expect(rowFor(rows, "flex-direction")?.status).toBe("drift");
    // Both sides literally say `center`, but along different axes — a `match`
    // here would be a coincidence, so no verdict is given.
    for (const property of ["justify-content", "align-items"]) {
      const row = rowFor(rows, property);
      expect(row?.status).toBe("unresolved");
      expect(row?.note).toContain("different axes");
    }
  });

  it("reports no alignment verdict for Figma VERTICAL against a grid container", () => {
    const rows = layoutRows(
      { layoutMode: "VERTICAL", primaryAxisAlignItems: "CENTER", counterAxisAlignItems: "MIN" },
      { display: "grid", "justify-content": "center", "align-items": "flex-start" },
    );
    expect(rows.map((r) => r.status)).toEqual(["unresolved", "unresolved"]);
    expect(rows[0]?.note).toContain("inline axis");
  });

  it("compares alignment normally when both sides share the primary axis", () => {
    const rows = layoutRows(
      { layoutMode: "VERTICAL", primaryAxisAlignItems: "SPACE_BETWEEN", counterAxisAlignItems: "MAX" },
      flex({
        "flex-direction": "column",
        "justify-content": "space-between",
        "align-items": "flex-end",
      }),
    );
    expect(rows.map((r) => [r.property, r.status])).toEqual([
      ["flex-direction", "match"],
      ["justify-content", "match"],
      ["align-items", "match"],
    ]);
  });
});
