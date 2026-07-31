import { describe, expect, it } from "vitest";
import {
  buildBulkFixPrompt,
  buildFixPrompt,
  componentNameFromStoryId,
  type FixPromptInput,
} from "./fix-prompt.js";

const base = {
  storyId: "atoms-iconbutton--accent",
  kind: "token-value",
  property: "border-top-left-radius",
  codeValue: "8px",
  figmaValue: "6px",
};

describe("componentNameFromStoryId", () => {
  it("takes the last title segment", () => {
    expect(componentNameFromStoryId("atoms-iconbutton--accent")).toBe("iconbutton");
    expect(componentNameFromStoryId("molecules-rowboolean--checked-true")).toBe("rowboolean");
  });

  it("falls back to the whole id without a `--` separator", () => {
    expect(componentNameFromStoryId("justonething")).toBe("justonething");
  });
});

describe("buildFixPrompt — self-contained agent prompt", () => {
  it("includes story id, component, property, and both values", () => {
    const p = buildFixPrompt(base);
    expect(p).toContain("atoms-iconbutton--accent");
    expect(p).toContain("iconbutton");
    expect(p).toContain("border-top-left-radius");
    expect(p).toContain("`8px`");
    expect(p).toContain("`6px`");
  });

  it("names token AND var(--token) form when the token is known", () => {
    const p = buildFixPrompt({ ...base, tokenName: "radius/lg" });
    expect(p).toContain("radius/lg");
    expect(p).toContain("var(--radius-lg)");
    expect(p).toMatch(/prefer wiring the token/i);
  });

  it("omits token guidance when no token name is known", () => {
    const p = buildFixPrompt(base);
    expect(p).not.toContain("var(--");
    expect(p).not.toMatch(/design token/);
  });

  it("lists configured code-target file paths when known", () => {
    const p = buildFixPrompt({
      ...base,
      filePaths: ["src/components/IconButton.css", "src/components/IconButton.tsx"],
    });
    expect(p).toContain("src/components/IconButton.css");
    expect(p).toContain("src/components/IconButton.tsx");
  });

  it("falls back to naming the selector and telling the agent to locate it", () => {
    const p = buildFixPrompt({ ...base, selector: ".icon-button--accent" });
    expect(p).toContain(".icon-button--accent");
    expect(p).toMatch(/search the codebase/i);
  });

  it("still instructs how to locate the code with neither paths nor selector", () => {
    const p = buildFixPrompt(base);
    expect(p).toMatch(/locate the styles/i);
  });

  it("carries the Figma node id and file key for reference", () => {
    const p = buildFixPrompt({ ...base, nodeId: "37:30", fileKey: "abc123" });
    expect(p).toContain("37:30");
    expect(p).toContain("abc123");
  });

  it("closes with minimal-change + typecheck/tests instructions", () => {
    const p = buildFixPrompt(base);
    expect(p).toMatch(/keep the change minimal/i);
    expect(p).toMatch(/typecheck/i);
    expect(p).toMatch(/test/i);
  });

  it("stringifies non-string (dual-mode) values instead of dropping them", () => {
    const p = buildFixPrompt({
      ...base,
      codeValue: { light: "8px", dark: "8px" },
      figmaValue: { light: "6px", dark: "4px" },
    });
    // Modes that AGREE collapse to the one value they both hold — printing
    // `{"light":"8px","dark":"8px"}` in an instruction is noise, and the live panel
    // produced exactly that for a copy row reading "Cancel" in both modes.
    expect(p).toContain("`8px`");
    expect(p).not.toContain('{"light":"8px"');
    // Modes that DISAGREE keep the full map: the difference is the information.
    expect(p).toContain('{"light":"6px","dark":"4px"}');
  });

  it("includes the engine note when present", () => {
    const p = buildFixPrompt({ ...base, note: "variable not found in file" });
    expect(p).toContain("variable not found in file");
  });
});

/**
 * Tailwind consumers: a prompt that says "set background-color to #2c2c2c" is
 * not actionable on a shadcn/cva component — there is no declaration to edit.
 * When the scanner knows which utility class produced the binding, the prompt
 * has to name it.
 */
describe("buildFixPrompt — Tailwind class attribution", () => {
  it("names the class to change and where it may live", () => {
    const p = buildFixPrompt({ ...base, codeClassName: "bg-primary" });
    expect(p).toContain("`bg-primary`");
    expect(p).toMatch(/Tailwind utility class/i);
    expect(p).toMatch(/cva\(\)` base array or variant slot/i);
  });

  it("scopes the minimal-change instruction to that class", () => {
    const p = buildFixPrompt({ ...base, codeClassName: "rounded-md" });
    expect(p).toMatch(/change only the `rounded-md` class/i);
    expect(p).toMatch(/leave every other utility class alone/i);
  });

  it("advises a utility swap, not a CSS declaration, when a token is known", () => {
    const p = buildFixPrompt({
      ...base,
      tokenName: "size/radius/200",
      codeClassName: "rounded-md",
    });
    expect(p).toMatch(/swap `rounded-md` for the utility class/i);
    expect(p).toContain("--size-radius-200");
    // The CSS-declaration advice must NOT appear — it is uncorrectable advice
    // for this codebase.
    expect(p).not.toMatch(/set `border-top-left-radius: var\(/);
  });

  it("keeps the CSS-declaration advice when there is no class attribution", () => {
    const p = buildFixPrompt({ ...base, tokenName: "size/radius/200" });
    expect(p).toMatch(/set `border-top-left-radius: var\(--size-radius-200\)`/);
    expect(p).not.toMatch(/utility class/i);
  });
});

/* ------------------------------------------------------------------------- *
 * item 2 — a lone per-row prompt must carry its siblings
 * ------------------------------------------------------------------------- */

const padding = (property: string, over: Partial<FixPromptInput> = {}): FixPromptInput => ({
  storyId: "ui-card--default",
  kind: "token-value",
  property,
  codeValue: property === "padding-top" ? "6px" : "12px",
  figmaValue: "12px (token: Space/150)",
  tokenName: "Space/150",
  selector: ".card",
  ...over,
});

/**
 * The live failure: four drifted paddings, one prompt handed over, and a
 * component that came back 6px/12px/12px/12px. The sibling information has to
 * travel INSIDE the prompt — it must survive being pasted into a session with no
 * other context, so nothing may depend on a skill re-checking.
 */
describe("buildFixPrompt — sibling context (item 2)", () => {
  const withSiblings = padding("padding-top", {
    siblingProperties: ["padding-right", "padding-bottom", "padding-left"],
  });

  it("names the siblings, the shared expected value, and the 'one design change' framing", () => {
    const p = buildFixPrompt(withSiblings);
    expect(p).toContain(
      "`padding-right`, `padding-bottom` and `padding-left` have also drifted to `Space/150`.",
    );
    expect(p).toMatch(/These are one design change — fix them together, or state why you are fixing only this one\./);
  });

  it("instructs the agent to change them in the same edit", () => {
    const p = buildFixPrompt(withSiblings);
    expect(p).toMatch(/Apply the same value to the sibling properties named above/);
    expect(p).toContain("`padding-right`, `padding-bottom` and `padding-left`");
    expect(p).toMatch(/leaves the component in a state nobody designed/);
  });

  it("says nothing about sibling PROPERTIES when none drifted the same way", () => {
    const p = buildFixPrompt(padding("padding-top"));
    expect(p).not.toMatch(/Sibling properties/);
    expect(p).not.toMatch(/one design change/);
    // "sibling" alone is no longer a safe probe: every prompt now carries a
    // blast-radius bullet about sibling *variants* (#68), which is a different
    // axis from sibling properties in a family.
    expect(p).toMatch(/sibling variant/i);
  });

  it("reads correctly for a single sibling (verb agreement, not '1 sibling(s)')", () => {
    const p = buildFixPrompt(padding("font-size", { siblingProperties: ["line-height"] }));
    expect(p).toContain("`line-height` has also drifted to `Space/150`.");
  });

  it("falls back to the raw Figma value when no token backs the change", () => {
    const p = buildFixPrompt(
      padding("padding-top", {
        tokenName: undefined,
        figmaValue: "12px",
        siblingProperties: ["padding-left"],
      }),
    );
    expect(p).toContain("`padding-left` has also drifted to `12px`.");
  });
});

/* ------------------------------------------------------------------------- *
 * item 4 — an unbound Figma value routes to design, never to a hardcoded value
 * ------------------------------------------------------------------------- */

describe("buildFixPrompt — unbound Figma value (item 4)", () => {
  const unbound: FixPromptInput = {
    ...base,
    figmaValue: "12px",
    tokenName: undefined,
    finding: "unbound-figma-value",
    nodeId: "37:30",
    fileKey: "abc123",
    filePaths: ["src/components/IconButton.css"],
  };

  it("says what happened: Figma's value is not bound to a variable", () => {
    const p = buildFixPrompt(unbound);
    expect(p).toMatch(/NOT bound to a variable/);
    expect(p).toMatch(/a literal typed into the design/);
    expect(p).toMatch(/no design token naming the expected value/);
  });

  it("routes the work to Figma, naming the node and file", () => {
    const p = buildFixPrompt(unbound);
    expect(p).toMatch(/This is a Figma fix, not a code fix\./);
    expect(p).toMatch(/bind `border-top-left-radius` on node `37:30` \(file `abc123`\)/);
    expect(p).toMatch(/re-run "Check drift"/);
  });

  it("forbids the two wrong fixes: hardcoding the literal and retuning a theme token", () => {
    const p = buildFixPrompt(unbound);
    expect(p).toMatch(/Do NOT hardcode Figma's literal `12px` in code/);
    expect(p).toMatch(/do NOT add or change a theme token/);
    expect(p).toMatch(/Change no code for this row/);
  });

  it("does NOT reuse the ordinary value-drift instructions", () => {
    const p = buildFixPrompt(unbound);
    expect(p).not.toMatch(/Prefer wiring the token/);
    expect(p).not.toMatch(/so the code matches the Figma value above/);
    // Code-target file guidance would contradict "change no code".
    expect(p).not.toContain("src/components/IconButton.css");
  });

  it("is distinguishable from ordinary value drift, which still targets code", () => {
    const ordinary = buildFixPrompt({ ...unbound, finding: "value-drift", tokenName: "radius/lg" });
    expect(ordinary).toMatch(/Fix a design-system drift/);
    expect(ordinary).toMatch(/Prefer wiring the token/);
    expect(ordinary).not.toMatch(/NOT bound to a variable/);
  });
});

/* ------------------------------------------------------------------------- *
 * item 1 — one prompt for every drifted row, related properties grouped
 * ------------------------------------------------------------------------- */

const FOUR_PADDINGS: FixPromptInput[] = [
  padding("padding-top", { siblingProperties: ["padding-right", "padding-bottom", "padding-left"] }),
  padding("padding-right", { siblingProperties: ["padding-top", "padding-bottom", "padding-left"] }),
  padding("padding-bottom", { siblingProperties: ["padding-top", "padding-right", "padding-left"] }),
  padding("padding-left", { siblingProperties: ["padding-top", "padding-right", "padding-bottom"] }),
];

const bulkContext = {
  selector: ".card",
  filePaths: ["src/components/Card.css"],
  fileKey: "abc123",
  nodeId: "37:30",
};

describe("buildBulkFixPrompt — one coherent instruction for the whole story (item 1)", () => {
  it("returns null when nothing drifted, so the button can't render", () => {
    expect(
      buildBulkFixPrompt({ storyId: "ui-card--default", context: bulkContext, rows: [] }),
    ).toBeNull();
  });

  it("covers every drifted row", () => {
    const p = buildBulkFixPrompt({
      storyId: "ui-card--default",
      context: bulkContext,
      rows: [...FOUR_PADDINGS, padding("gap", { figmaValue: "8px (token: Space/100)", tokenName: "Space/100" })],
    })!;
    for (const property of [
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "gap",
    ]) {
      expect(p, property).toContain(`\`${property}\``);
    }
    expect(p).toContain("5 drifted rows");
  });

  it("presents the four paddings as ONE change, not four prompts", () => {
    const p = buildBulkFixPrompt({
      storyId: "ui-card--default",
      context: bulkContext,
      rows: FOUR_PADDINGS,
    })!;
    expect(p).toContain("### padding — 4 properties, ONE design change");
    expect(p).toMatch(
      /- Properties: `padding-top`, `padding-right`, `padding-bottom` and `padding-left`/,
    );
    expect(p).toMatch(/Expected value from Figma for all 4/);
    expect(p).toMatch(/All 4 move together/);
    // Every property's current value is named, so the agent can see the 6/12/12/12.
    expect(p).toContain("`padding-top` = `6px`");
    expect(p).toContain("`padding-left` = `12px`");
    // One heading for the family, not one per property.
    expect(p.match(/^### /gm)).toHaveLength(1);
    // And the header states the framing.
    expect(p).toMatch(/Treat this as ONE change set/);
    expect(p).toMatch(/6px\/12px\/12px\/12px/);
  });

  it("groups the four corner radii and the type pair the same way", () => {
    const p = buildBulkFixPrompt({
      storyId: "ui-card--default",
      context: bulkContext,
      rows: [
        ...["border-top-left-radius", "border-top-right-radius"].map((property) =>
          padding(property, { figmaValue: "6px (token: radius/lg)", tokenName: "radius/lg" }),
        ),
        ...["font-size", "line-height"].map((property) =>
          padding(property, { figmaValue: "13px (token: type/13)", tokenName: "type/13" }),
        ),
      ],
    })!;
    expect(p).toContain("### border-radius — 2 properties, ONE design change");
    expect(p).toContain("### type ramp — 2 properties, ONE design change");
  });

  it("does NOT merge same-family properties that drifted to different values", () => {
    const p = buildBulkFixPrompt({
      storyId: "ui-card--default",
      context: bulkContext,
      rows: [
        padding("padding-top"),
        padding("padding-left", {
          figmaValue: "4px (token: Space/50)",
          tokenName: "Space/50",
        }),
      ],
    })!;
    expect(p.match(/^### /gm)).toHaveLength(2);
    expect(p).not.toMatch(/ONE design change/);
  });

  it("keeps unbound Figma values out of the code-fix section and routes them to design", () => {
    const p = buildBulkFixPrompt({
      storyId: "ui-card--default",
      context: bulkContext,
      rows: [
        padding("padding-top"),
        padding("border-color", {
          figmaValue: "#ddd",
          tokenName: undefined,
          finding: "unbound-figma-value",
        }),
      ],
    })!;
    expect(p).toContain("## Figma-side findings — value not bound to a variable (do NOT fix in code)");
    expect(p).toMatch(/`border-color`: Figma's value is `#ddd`, a literal with NO variable behind it/);
    expect(p).toMatch(/Do NOT hardcode Figma's literal in code and do NOT add or change a theme token/);
    // The mechanical section still exists, and doesn't contain the unbound row.
    const mechanical = p.slice(
      p.indexOf("## What to change in code"),
      p.indexOf("## Figma-side findings"),
    );
    expect(mechanical).toContain("padding-top");
    expect(mechanical).not.toContain("border-color");
  });

  it("lists judgement-call rows separately, with their advisory, and tells the agent not to guess", () => {
    const p = buildBulkFixPrompt({
      storyId: "ui-card--default",
      context: bulkContext,
      rows: [
        padding("padding-top"),
        {
          storyId: "ui-card--default",
          kind: "props",
          property: "Size",
          codeValue: null,
          figmaValue: "Large",
          finding: "judgement",
          advisory: "Figma variant sets Size=Large, but the story args carry no matching value.",
        },
      ],
    })!;
    expect(p).toContain("## Needs a judgement call — not a mechanical fix");
    expect(p).toContain("`Size` (props): Figma variant sets Size=Large");
    expect(p).toMatch(/those are not code edits/);
  });

  it("shares the per-row prompt's context and closing discipline", () => {
    const p = buildBulkFixPrompt({
      storyId: "ui-card--default",
      context: bulkContext,
      rows: FOUR_PADDINGS,
    })!;
    expect(p).toContain("ui-card--default");
    expect(p).toContain("src/components/Card.css");
    expect(p).toContain("abc123");
    expect(p).toMatch(/Keep the change minimal/);
    expect(p).toMatch(/typecheck/);
    expect(p).toMatch(/Do not reformat unrelated code/);
  });

  it("names the element for a child-binding row so the fix lands on the right node", () => {
    const p = buildBulkFixPrompt({
      storyId: "ui-card--default",
      context: bulkContext,
      rows: [padding("padding-top", { selector: ".card [data-slot=header]" })],
    })!;
    expect(p).toContain("on `.card [data-slot=header]`");
  });

  it("says so plainly when nothing in the report is a mechanical code fix", () => {
    const p = buildBulkFixPrompt({
      storyId: "ui-card--default",
      context: bulkContext,
      rows: [
        padding("border-color", {
          figmaValue: "#ddd",
          tokenName: undefined,
          finding: "unbound-figma-value",
        }),
      ],
    })!;
    expect(p).toMatch(/Nothing here is a mechanical code fix/);
  });
});

/* ------------------------------------------------------------------------- *
 * v0.0.38 — the prompt states the LAYER instead of inventing an edit
 * ------------------------------------------------------------------------- */

/**
 * Found live: a prompt asked an agent to swap `bg-primary` for "the utility class
 * whose theme variable resolves to `--background-brand-default`". That is the
 * FIGMA variable's name, converted to a CSS custom property — no such utility or
 * theme variable exists in the consumer, and none should. The prompt invented an
 * impossible code-side target for something that was not a code-side change at
 * all: the component bound the right token and the token's value had moved.
 *
 * The panel already holds everything needed to classify this (whether Figma's
 * value is bound, whether the code binds a token, whether the names reconciled),
 * so the prompt's job is to name the layer, not to guess at an edit.
 */
describe("buildFixPrompt — token-layer drift (the code is already right)", () => {
  const tokenLayer: FixPromptInput = {
    storyId: "ui-button--primary",
    kind: "token-value",
    property: "background-color",
    codeValue: "rgb(44, 44, 44)",
    figmaValue: "rgb(255, 0, 0)",
    tokenName: "color/background/brand/default",
    codeTokenName: "primary",
    codeClassName: "bg-primary",
    layer: "token",
    selector: ".button",
    nodeId: "37:30",
    fileKey: "abc123",
    filePaths: ["src/components/ui/button.tsx"],
  };

  it("states the layer, in those words", () => {
    const p = buildFixPrompt(tokenLayer);
    expect(p).toMatch(/token-layer change, not a component change/i);
    expect(p).toMatch(/it is the TOKEN'S VALUE that no longer matches Figma/);
  });

  it("names both sides: the theme token and the design variable", () => {
    const p = buildFixPrompt(tokenLayer);
    expect(p).toContain("`primary`");
    expect(p).toContain("var(--primary)");
    expect(p).toContain("`color/background/brand/default`");
  });

  it("says a token change needs design-system sign-off", () => {
    const p = buildFixPrompt(tokenLayer);
    expect(p).toMatch(/design-token PR/);
    expect(p).toMatch(/design-system sign-off/);
    expect(p).toMatch(/affects every consumer/);
  });

  it("proposes NO class swap, no arbitrary value, no literal", () => {
    const p = buildFixPrompt(tokenLayer);
    expect(p).not.toMatch(/swap `bg-primary`/);
    expect(p).not.toMatch(/utility class whose theme variable resolves to/);
    expect(p).not.toMatch(/\[rgb\(255, 0, 0\)\]/);
    expect(p).toMatch(/Change no code on the "button" component/);
  });

  it("NEVER presents Figma's variable name as a code-side target", () => {
    const p = buildFixPrompt(tokenLayer);
    // The Figma-derived custom property is the impossible target. It may not
    // appear at all: the code-side name is `--primary`.
    expect(p).not.toContain("--color-background-brand-default");
  });

  it("leaves room for the opposite conclusion (Figma moved by mistake)", () => {
    const p = buildFixPrompt(tokenLayer);
    expect(p).toMatch(/If you believe the CODE token is right/);
  });

  it("falls back to the ordinary prompt when there is no code-side token name", () => {
    // `layer: "token"` can only be trusted with a code-side name to talk about.
    const { codeTokenName: _drop, ...noCodeToken } = tokenLayer;
    const p = buildFixPrompt(noCodeToken);
    expect(p).toMatch(/Fix a design-system drift/);
  });
});

describe("buildFixPrompt — component-layer drift with an unreconciled token name", () => {
  const unreconciled: FixPromptInput = {
    storyId: "ui-button--primary",
    kind: "token-value",
    property: "background-color",
    codeValue: "rgb(44, 44, 44)",
    figmaValue: "rgb(255, 0, 0)",
    tokenName: "color/background/brand/default",
    codeTokenName: "primary",
    codeClassName: "bg-primary",
    layer: "component",
  };

  it("refuses to name a code-side target it cannot know", () => {
    const p = buildFixPrompt(unreconciled);
    expect(p).toMatch(/could NOT reconcile it with Figma's variable|could NOT reconcile with Figma's variable/);
    expect(p).toMatch(/treat `--color-background-brand-default` as Figma's spelling only/);
    expect(p).toMatch(/do NOT assume a utility class, theme variable or CSS custom property of that name exists/);
    // The impossible instruction, gone.
    expect(p).not.toMatch(/swap `bg-primary` for the utility class whose theme variable resolves to/);
  });

  it("offers the two real possibilities, including the alias fix", () => {
    const p = buildFixPrompt(unreconciled);
    expect(p).toContain(`"color/background/brand/default": "primary"`);
    expect(p).toContain("tokenAliases");
    expect(p).toMatch(/find the token in THIS codebase whose value is `rgb\(255, 0, 0\)`/);
    expect(p).toMatch(/If you cannot tell which, say so and stop rather than guessing/);
  });

  it("still names Figma's spelling as a caveat when the code binds no token", () => {
    const { codeTokenName: _drop, ...literal } = unreconciled;
    const p = buildFixPrompt(literal);
    // Pre-existing guidance survives for the literal case…
    expect(p).toMatch(/swap `bg-primary` for the utility class whose theme variable resolves to/);
    // …with the confidence it was missing.
    expect(p).toMatch(/is Figma's token name converted by convention/);
    expect(p).toMatch(/cannot confirm this project spells it that way/);
  });
});

describe("buildBulkFixPrompt — token-layer rows are not code edits", () => {
  const rows: FixPromptInput[] = [
    {
      storyId: "ui-button--primary",
      kind: "token-value",
      property: "padding-top",
      codeValue: "6px",
      figmaValue: "12px",
      tokenName: "space/150",
      selector: ".button",
    },
    {
      storyId: "ui-button--primary",
      kind: "token-value",
      property: "background-color",
      codeValue: "rgb(44, 44, 44)",
      figmaValue: "rgb(255, 0, 0)",
      tokenName: "color/background/brand/default",
      codeTokenName: "primary",
      codeClassName: "bg-primary",
      layer: "token",
      selector: ".button",
    },
  ];

  const bulk = buildBulkFixPrompt({
    storyId: "ui-button--primary",
    context: { selector: ".button", filePaths: ["src/components/ui/button.tsx"], fileKey: "abc123", nodeId: "37:30" },
    rows,
  })!;

  it("puts the token-layer row in its own section, out of the code section", () => {
    expect(bulk).toContain(
      "## Token-layer findings — the token, not this component (do NOT edit this component)",
    );
    const code = bulk.slice(
      bulk.indexOf("## What to change in code"),
      bulk.indexOf("## Token-layer findings"),
    );
    expect(code).toContain("padding-top");
    expect(code).not.toContain("background-color");
  });

  it("describes it as a token PR, with no class swap anywhere in the prompt", () => {
    expect(bulk).toMatch(/design-token PR needing design-system sign-off/);
    expect(bulk).not.toMatch(/swap `bg-primary`/);
    expect(bulk).not.toContain("--color-background-brand-default");
    expect(bulk).toMatch(/Do not act on the "Token-layer findings" section by editing this component/);
  });
});
