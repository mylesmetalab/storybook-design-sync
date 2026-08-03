import { describe, expect, it } from "vitest";
import {
  buildBulkFixPrompt,
  buildFixPrompt,
  PROMPT_SECTION_BY_KIND,
  type FixPromptInput,
} from "./fix-prompt.js";
import type { DimensionKind } from "./dimensions/types.js";

/**
 * The fix-prompt correctness batch (#63, #66, #67, #68, #71, #76).
 *
 * Every one of those issues is the same failure in a different dimension: **the
 * prompt asserted a change without having established that the change was
 * correct, complete, or still true.** So the tests here are deliberately not six
 * unrelated regressions. Each issue gets the row that reproduced it, and then the
 * bottom half of the file asserts the four properties as *invariants over every
 * dimension kind*, so a dimension added later without them fails here rather
 * than shipping a confident wrong instruction.
 *
 * The four questions a prompt must be able to answer before it proposes an edit:
 *
 *   1. Which layer owns this?          (#63 copy, #67 missing token)
 *   2. What else does it affect?       (#68 sibling variants, #71 contract pair)
 *   3. Is it complete across modes?    (#66 dark value)
 *   4. Is it still true?               (#76 provenance + re-verify)
 *
 * Where the generator cannot answer, the prompt must SAY it cannot — that is the
 * project's standing rule, and several tests below assert the "cannot" wording
 * rather than a fabricated answer.
 */

const PROVENANCE = {
  readAt: "2026-07-30T09:15:00.000Z",
  fileLastModified: "2026-07-30T09:14:12Z",
  fileVersion: "4412998877",
  addonVersion: "0.0.44",
};

/** A row that reproduces the Card colour drift from #66/#67. */
const colourRow: FixPromptInput = {
  storyId: "ui-card--icon-stroke-horizontal",
  kind: "token-value",
  property: "color",
  codeValue: "rgb(30, 30, 30)",
  figmaValue: "rgb(0, 153, 81)",
  tokenName: "Text/Positive/Secondary",
  selector: "[data-slot=card] [data-slot=title]",
  filePaths: ["src/components/ui/**/*.tsx"],
  nodeId: "280:11368",
  fileKey: "abc123",
  provenance: PROVENANCE,
};

/* ------------------------------------------------------------------------- *
 * #63 — the copy dimension must never be routed into a code edit
 * ------------------------------------------------------------------------- */

const copyRow: FixPromptInput = {
  storyId: "ui-card--horizontal",
  kind: "copy",
  property: "text",
  codeValue: "Cancel",
  figmaValue: "Button",
  selector: "[data-slot=card]",
  filePaths: ["src/components/ui/**/*.tsx"],
  nodeId: "280:11368",
  fileKey: "abc123",
  provenance: PROVENANCE,
};

describe("#63 — a copy row is never a code edit", () => {
  it("the per-row prompt does not instruct a code change", () => {
    const p = buildFixPrompt(copyRow);
    expect(p).not.toMatch(/Make this change so the code matches/);
    expect(p).not.toMatch(/Keep the change minimal/);
    // It must not send an agent at the story's args, which is what destroyed the
    // story's purpose in the live run.
    expect(p).toMatch(/do not (rewrite|change) the story/i);
  });

  it("the per-row prompt says the two sides may not be comparable at all", () => {
    const p = buildFixPrompt(copyRow);
    expect(p).toMatch(/placeholder/i);
    // And how to stop asking the question, since Figma cannot express it.
    expect(p).toMatch(/compareCopy/);
  });

  it("the bulk prompt keeps copy rows out of \"What to change in code\"", () => {
    const prompt = buildBulkFixPrompt({
      storyId: "ui-card--horizontal",
      context: { selector: "[data-slot=card]", filePaths: ["src/components/ui/**/*.tsx"], provenance: PROVENANCE },
      rows: [copyRow, { ...colourRow, storyId: "ui-card--horizontal" }],
    })!;
    const codeSection = sectionOf(prompt, "## What to change in code");
    expect(codeSection).not.toContain("Cancel");
    expect(codeSection).not.toContain("`text`");
    // It still appears — suppressing it entirely would be its own dishonesty.
    expect(prompt).toContain("Cancel");
    expect(prompt).toMatch(/## Copy findings/);
  });

  it("a bulk run of nothing but copy rows offers no code edits at all", () => {
    const prompt = buildBulkFixPrompt({
      storyId: "ui-card--horizontal",
      context: { provenance: PROVENANCE },
      rows: [copyRow],
    })!;
    expect(sectionOf(prompt, "## What to change in code")).toMatch(
      /Nothing here is a mechanical code fix/,
    );
  });
});

/* ------------------------------------------------------------------------- *
 * #66 — mode completeness, and no invented namespace
 * ------------------------------------------------------------------------- */

describe("#66 — a mode-varying token carries both mode values", () => {
  const modal: FixPromptInput = {
    ...colourRow,
    modes: { light: "rgb(0, 153, 81)", dark: "rgb(133, 224, 163)" },
  };

  it("states the dark value, not only the light one", () => {
    const p = buildFixPrompt(modal);
    expect(p).toContain("rgb(0, 153, 81)");
    expect(p).toContain("rgb(133, 224, 163)");
  });

  it("says the change is incomplete until both modes are covered", () => {
    const p = buildFixPrompt(modal);
    expect(p).toMatch(/both modes/i);
    expect(p).toMatch(/light/);
    expect(p).toMatch(/dark/);
  });

  it("says nothing about modes when the token does not vary by mode", () => {
    const p = buildFixPrompt({
      ...colourRow,
      modes: { light: "rgb(0, 153, 81)", dark: "rgb(0, 153, 81)" },
    });
    expect(p).not.toMatch(/mode-varying/);
  });

  it("does not present a converted Figma name as this project's variable", () => {
    const p = buildFixPrompt({
      ...modal,
      tokenPresence: {
        kind: "absent",
        converted: "--text-positive-secondary",
        declaredCount: 93,
        themeFiles: ["src/index.css"],
        namespaceNote:
          "`--text-*` already names 24 custom properties in this project (e.g. `--text-base`, `--text-2xl`).",
      },
    });
    expect(p).not.toMatch(/set `color: var\(--text-positive-secondary\)`/);
    expect(p).not.toMatch(/If your theme names the same token differently/);
  });
});

/* ------------------------------------------------------------------------- *
 * #67 — a token the project does not declare is a token-layer change
 * ------------------------------------------------------------------------- */

describe("#67 — an absent token is not a component edit", () => {
  const absent: FixPromptInput = {
    ...colourRow,
    tokenPresence: {
      kind: "absent",
      converted: "--text-positive-secondary",
      declaredCount: 93,
      themeFiles: ["src/index.css"],
    },
  };

  it("says the token is absent, and how many were scanned", () => {
    const p = buildFixPrompt(absent);
    expect(p).toMatch(/not declared anywhere in this project/i);
    expect(p).toContain("93");
  });

  it("names the theme file, and marks the change token-layer", () => {
    const p = buildFixPrompt(absent);
    expect(p).toContain("src/index.css");
    expect(p).toMatch(/token-layer/i);
    expect(p).toMatch(/sign-off/i);
  });

  it("does not scope the change to component files alone", () => {
    const p = buildFixPrompt(absent);
    const idx = p.indexOf("src/components/ui/**/*.tsx");
    expect(idx).toBeGreaterThan(-1);
    // The component targets may be named, but not as the whole of the change.
    expect(p).toMatch(/cannot be (made|completed) in (the )?component file/i);
  });

  it("forbids hardcoding the literal", () => {
    const p = buildFixPrompt(absent);
    expect(p).toMatch(/do NOT hardcode/i);
  });

  /**
   * Found in the browser, in the first build of this batch: absence was made its own
   * prompt SHAPE, and on a Tailwind spacing row (`p-3`, Figma `Space/300`) it
   * announced "this project declares no token for it — adding one is a token-layer
   * change needing design-lead sign-off". Technically true, and inapplicable: the
   * project expresses spacing through Tailwind's `--spacing` scale, not one custom
   * property per step. Worse, replacing the whole prompt **displaced the
   * blast-radius bullet**, losing #68 on exactly the rows most likely to need it.
   */
  it("keeps the rest of the prompt — absence is a bullet, not a prompt shape", () => {
    const p = buildFixPrompt({
      ...absent,
      variantScope: {
        comparedStories: ["ui-card--horizontal"],
        conflicting: [{ storyId: "ui-card--horizontal", expected: "Text/Default/Default" }],
      },
      siblingProperties: ["background-color"],
    });
    expect(p).toMatch(/Blast radius/);
    expect(p).toContain("ui-card--horizontal");
    expect(p).toMatch(/Sibling properties drifted the same way/);
    expect(p).toContain("2026-07-30T09:15:00.000Z");
  });

  it("offers the token-layer route conditionally, not as the only reading", () => {
    const p = buildFixPrompt(absent);
    // First: use whatever this project already has. Only if nothing does is a new
    // token on the table — a spacing utility resolving through a scale needs no
    // design-lead sign-off.
    expect(p).toMatch(/Find what this project already uses/);
    expect(p).toMatch(/If nothing in this project expresses it/);
  });

  it("stays a code row in the bulk prompt — it is not automatically a token PR", () => {
    const prompt = buildBulkFixPrompt({
      storyId: "ui-card--icon-stroke-horizontal",
      context: { provenance: PROVENANCE },
      rows: [absent],
    })!;
    expect(sectionOf(prompt, "## What to change in code")).toMatch(/not declared anywhere/i);
    expect(prompt).not.toMatch(/## Token-layer findings/);
  });

  it("names the project's own variable when the token IS declared", () => {
    const p = buildFixPrompt({
      ...colourRow,
      tokenPresence: { kind: "declared", cssVar: "--color-positive-secondary", files: ["src/index.css"] },
    });
    expect(p).toContain("var(--color-positive-secondary)");
    expect(p).not.toContain("--text-positive-secondary");
    expect(p).not.toMatch(/not declared anywhere/i);
  });
});

/* ------------------------------------------------------------------------- *
 * #68 — blast radius across sibling variants
 * ------------------------------------------------------------------------- */

describe("#68 — a variant-scoped edit states its blast radius", () => {
  it("names the sibling stories that expect a different value, and drops \"minimal\"", () => {
    const p = buildFixPrompt({
      ...colourRow,
      variantScope: {
        comparedStories: [
          "ui-card--horizontal",
          "ui-card--vertical",
          "ui-card--icon-stroke-vertical",
        ],
        conflicting: [
          { storyId: "ui-card--horizontal", expected: "Text/Default/Default" },
          { storyId: "ui-card--vertical", expected: "Text/Default/Default" },
        ],
      },
    });
    expect(p).toContain("ui-card--horizontal");
    expect(p).toContain("Text/Default/Default");
    expect(p).toMatch(/2 of 3/);
    expect(p).not.toMatch(/Keep the change minimal/);
    expect(p).toMatch(/variant seam/i);
  });

  it("says the blast radius is unestablished when only this story was checked", () => {
    const p = buildFixPrompt(colourRow);
    expect(p).toMatch(/has not established/i);
    expect(p).toMatch(/Check all/);
  });

  it("says the siblings agree when they do", () => {
    const p = buildFixPrompt({
      ...colourRow,
      variantScope: {
        comparedStories: ["ui-card--horizontal", "ui-card--vertical"],
        conflicting: [],
      },
    });
    expect(p).toMatch(/2 other checked stor/);
    expect(p).toMatch(/agree/i);
  });
});

/* ------------------------------------------------------------------------- *
 * #71 — the contract knows the token drives two slots
 * ------------------------------------------------------------------------- */

describe("#71 — a declared token pair is never split", () => {
  const paired: FixPromptInput = {
    storyId: "ui-card--horizontal",
    kind: "token-value",
    property: "gap",
    codeValue: "16px",
    figmaValue: "444px",
    tokenName: "Space/400",
    selector: "[data-slot=card] [data-slot=body]",
    filePaths: ["src/components/ui/**/*.tsx"],
    provenance: PROVENANCE,
    contract: {
      path: "contracts/card.spec.json",
      figmaToken: "Space/400",
      siblings: [
        { slot: "actions", property: "gap", utility: "gap-4", compared: false },
      ],
    },
  };

  it("names the unbound sibling slot and its utility", () => {
    const p = buildFixPrompt(paired);
    expect(p).toContain("contracts/card.spec.json");
    expect(p).toContain("actions");
    expect(p).toContain("gap-4");
  });

  it("says the sibling was not compared, so the row is not the whole change", () => {
    const p = buildFixPrompt(paired);
    expect(p).toMatch(/not compared/i);
    expect(p).toMatch(/one design decision|one decision/i);
  });
});

/* ------------------------------------------------------------------------- *
 * #76 — a prompt is a point-in-time reading, and says when
 * ------------------------------------------------------------------------- */

describe("#76 — provenance and re-verification", () => {
  it("stamps the Figma read time, file version, node and addon version", () => {
    const p = buildFixPrompt(colourRow);
    expect(p).toContain("2026-07-30T09:15:00.000Z");
    expect(p).toContain("4412998877");
    // Normalised to ISO: the channel's serializer revives an ISO string into a
    // `Date`, and interpolating that yields a locale/timezone-dependent stamp,
    // which is close to useless in an artefact meant to be compared against Figma
    // later on someone else's machine.
    expect(p).toContain("2026-07-30T09:14:12.000Z");
    expect(p).toContain("280:11368");
    expect(p).toContain("0.0.44");
  });

  it("instructs the applier to re-verify and abort on mismatch", () => {
    const p = buildFixPrompt(colourRow);
    expect(p).toMatch(/re-verify|re-check/i);
    expect(p).toMatch(/stop|abort/i);
    expect(p).toMatch(/before committing/i);
  });

  it("reports the CACHE's read time for a cached row, never now", () => {
    const cachedAt = "2026-07-28T11:00:00.000Z";
    const p = buildFixPrompt({
      ...colourRow,
      provenance: { ...PROVENANCE, readAt: cachedAt, fromCache: true },
    });
    expect(p).toContain(cachedAt);
    expect(p).toMatch(/cache/i);
    // Nothing in the prompt may carry today's date when the read is older.
    const today = new Date().toISOString().slice(0, 10);
    expect(p.includes(today)).toBe(false);
  });

  it("says the read time is unknown rather than inventing one", () => {
    const p = buildFixPrompt({ ...colourRow, provenance: { addonVersion: "0.0.44" } });
    expect(p).toMatch(/read time is unknown|could not be established/i);
    const today = new Date().toISOString().slice(0, 10);
    expect(p.includes(today)).toBe(false);
  });

  it("stamps the bulk prompt too", () => {
    const p = buildBulkFixPrompt({
      storyId: "ui-card--horizontal",
      context: { provenance: PROVENANCE, nodeId: "280:11368" },
      rows: [{ ...colourRow, storyId: "ui-card--horizontal" }],
    })!;
    expect(p).toContain("2026-07-30T09:15:00.000Z");
    expect(p).toContain("4412998877");
    expect(p).toContain("0.0.44");
    expect(p).toMatch(/re-verify|re-check/i);
  });
});

/* ------------------------------------------------------------------------- *
 * Invariants over EVERY dimension kind.
 *
 * These are the tests that make a future dimension pay. Each one drives a row of
 * every `DimensionKind` through the builder and asserts a property the whole
 * batch turns on. A new kind added to the union without wiring reaches these
 * loops automatically.
 * ------------------------------------------------------------------------- */

const ALL_KINDS: DimensionKind[] = [
  "token-value",
  "token-binding",
  "variant-set",
  "copy",
  "props",
  "structure",
  "motion",
];

function rowOfKind(kind: DimensionKind, extra: Partial<FixPromptInput> = {}): FixPromptInput {
  return {
    storyId: "ui-card--horizontal",
    kind,
    property: kind === "copy" ? "text" : "color",
    codeValue: "rgb(30, 30, 30)",
    figmaValue: "rgb(0, 153, 81)",
    selector: "[data-slot=card]",
    filePaths: ["src/components/ui/**/*.tsx"],
    nodeId: "1:2",
    fileKey: "abc",
    provenance: PROVENANCE,
    ...extra,
  };
}

describe("invariants every dimension must satisfy", () => {
  it("every kind is explicitly assigned a bulk-prompt section", () => {
    for (const kind of ALL_KINDS) {
      expect(PROMPT_SECTION_BY_KIND[kind], kind).toBeDefined();
    }
    // The one assignment the batch exists to enforce.
    expect(PROMPT_SECTION_BY_KIND["copy"]).not.toBe("code");
  });

  it("no kind routed out of the code section ever appears in it", () => {
    for (const kind of ALL_KINDS) {
      if (PROMPT_SECTION_BY_KIND[kind] === "code") continue;
      const prompt = buildBulkFixPrompt({
        storyId: "ui-card--horizontal",
        context: { provenance: PROVENANCE },
        rows: [rowOfKind(kind, { codeValue: "MARKER-CODE", figmaValue: "MARKER-FIGMA" })],
      })!;
      expect(sectionOf(prompt, "## What to change in code"), kind).not.toContain("MARKER-FIGMA");
    }
  });

  it("a mode-varying token states both mode values, whatever the kind", () => {
    for (const kind of ALL_KINDS) {
      const p = buildFixPrompt(
        rowOfKind(kind, {
          tokenName: "Text/Positive/Secondary",
          modes: { light: "rgb(0, 153, 81)", dark: "rgb(133, 224, 163)" },
        }),
      );
      expect(p, kind).toContain("rgb(0, 153, 81)");
      expect(p, kind).toContain("rgb(133, 224, 163)");
    }
  });

  it("a prompt that calls its edit minimal has stated its blast radius", () => {
    for (const kind of ALL_KINDS) {
      for (const scope of [undefined, { comparedStories: ["a", "b"], conflicting: [] }]) {
        const p = buildFixPrompt(
          rowOfKind(kind, scope ? { variantScope: scope } : {}),
        );
        if (!/Keep the change minimal/.test(p)) continue;
        expect(p, `${kind} / ${scope ? "scoped" : "unscoped"}`).toMatch(
          /has not established|other checked stor|variant seam/i,
        );
      }
    }
  });

  it("every prompt of every kind carries its provenance and a re-verify step", () => {
    for (const kind of ALL_KINDS) {
      for (const finding of ["value-drift", "judgement", "unbound-figma-value"] as const) {
        const p = buildFixPrompt(rowOfKind(kind, { finding }));
        expect(p, `${kind}/${finding}`).toContain("2026-07-30T09:15:00.000Z");
        expect(p, `${kind}/${finding}`).toMatch(/re-verify|re-check/i);
      }
    }
  });

  it("no prompt of any kind ever stamps itself with the current time", () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const kind of ALL_KINDS) {
      const p = buildFixPrompt(rowOfKind(kind, { provenance: { addonVersion: "0.0.44" } }));
      expect(p.includes(today), kind).toBe(false);
    }
  });
});

/** Text between `heading` and the next `## ` heading (or the end). */
function sectionOf(prompt: string, heading: string): string {
  const start = prompt.indexOf(heading);
  if (start === -1) return "";
  const rest = prompt.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

/* ------------------------------------------------------------------------- *
 * #95 — the BULK prompt must follow the same rule as the per-row one
 * ------------------------------------------------------------------------- */

describe("#95 — a grouped prompt never names a custom property the project lacks", () => {
  /**
   * The per-row path already refused to name an absent variable (#66/#67). The
   * grouped path — the one behind "Copy fix prompt for all drift" — checked only
   * `tokenName` and never `tokenPresence`, so on a fresh project it instructed
   * an applier to `set each of them to var(--space-300)` where no spacing token
   * is declared at all. That resolves to nothing: applying the prompt faithfully
   * leaves the component worse than the drift did.
   *
   * Four paddings is the exact shape that produced it, so it is the fixture.
   */
  const PRESENCE = {
    kind: "absent" as const,
    converted: "--space-300",
    declaredCount: 8,
    themeFiles: ["src/index.css"],
  };

  const padding = (property: string): FixPromptInput => ({
    storyId: "ui-button--primary",
    kind: "token-value" as DimensionKind,
    property,
    codeValue: "8px",
    figmaValue: "12px",
    tokenName: "Space/300",
    selector: "button",
    filePaths: ["src/components/**/*.tsx"],
    nodeId: "4185:3779",
    fileKey: "abc",
    provenance: PROVENANCE,
    tokenPresence: PRESENCE,
  });

  const FAMILY = ["padding-top", "padding-right", "padding-bottom", "padding-left"];

  function bulk(rows: FixPromptInput[]): string {
    const out = buildBulkFixPrompt({
      storyId: "ui-button--primary",
      context: {
        selector: "button",
        filePaths: ["src/components/**/*.tsx"],
        nodeId: "4185:3779",
        fileKey: "abc",
        provenance: PROVENANCE,
      },
      rows,
    });
    if (out === null) throw new Error("expected a bulk prompt");
    return out;
  }

  it("does not instruct the applier to write var(--space-300)", () => {
    const p = bulk(FAMILY.map(padding));
    // The wiring instruction is what was wrong — "set each of them to
    // var(--space-300)" in a project with no spacing tokens.
    expect(p).not.toMatch(/Prefer wiring the token/);
    expect(p).not.toMatch(/set each of them to/);
  });

  it("names the variable only to forbid it", () => {
    // Naming it is not the bug; *instructing* it was. "Do NOT write
    // var(--space-300)" is far more actionable than a vague warning, so the
    // mention has to survive — bounded by the prohibition around it.
    const p = bulk(FAMILY.map(padding));
    expect(p).toMatch(/do NOT write `var\(--space-300\)`/);
    expect(p).toMatch(/would resolve to nothing/);
  });

  it("says the property is not declared, and how many were scanned", () => {
    const p = bulk(FAMILY.map(padding));
    expect(p).toMatch(/not declared anywhere in this project/i);
    expect(p).toMatch(/8 custom properties were scanned/);
  });

  it("still names the Figma token and the expected value", () => {
    // Refusing to name a CSS variable is not the same as withholding the design
    // decision — the applier still needs to know what Figma asks for.
    const p = bulk(FAMILY.map(padding));
    expect(p).toContain("Space/300");
    expect(p).toContain("12px");
  });

  it("routes it to the token layer rather than the component files", () => {
    const p = bulk(FAMILY.map(padding));
    expect(p).toMatch(/\*\*token-layer\*\* change/);
    expect(p).toMatch(/design-lead sign-off/);
  });

  it("covers the whole family in the refusal, not one of four", () => {
    const p = bulk(FAMILY.map(padding));
    for (const property of FAMILY) expect(p).toContain(property);
  });

  it("keeps the move-together instruction, so the group is not half-applied", () => {
    const p = bulk(FAMILY.map(padding));
    expect(p).toMatch(/All 4 move together/);
  });

  it("still wires the token when the project DOES declare it", () => {
    // The refusal must be driven by evidence, not by grouping.
    const declared = FAMILY.map((property) => ({
      ...padding(property),
      tokenPresence: {
        kind: "declared" as const,
        cssVar: "--space-300",
        files: ["src/index.css"],
      },
    }));
    const p = bulk(declared);
    expect(p).toMatch(/Prefer wiring the token/);
    expect(p).toContain("var(--space-300)");
  });

  it("says nothing about presence when the scan never ran", () => {
    // `tokenPresence` undefined is "not established", which must behave as it did
    // before this change rather than being read as absent.
    const unknown = FAMILY.map((property) => {
      const row = padding(property);
      delete (row as { tokenPresence?: unknown }).tokenPresence;
      return row;
    });
    const p = bulk(unknown);
    expect(p).not.toMatch(/not declared anywhere in this project/i);
  });
});
