---
name: handoff-ready-component
description: Lint a Figma component before handoff to code — library tokens only, variant naming conventions, no detached values — and establish the facts about the design file the code side will depend on (modes, literals, text styles, shared values, what can't be compared later). Use before running component-handoff, or when asked "is this component ready to hand off?"
revised: 2026-08-06
---

# handoff-ready-component

> **FIRST DRAFT** — conventions below are working defaults; the design lead owns them and should adjust. Sections marked ⚙ DRAFT are the ones to review.

Two jobs, both report-only — never "fix" the component yourself:

1. **Lint** the component against the handoff bar (below).
2. **Establish the facts about the design file** that the code side will then depend on. `component-handoff` consumes these and accounts for them in the first build; discovered later they arrive as drift, or as invented values.

Tools: Figma MCP (`get_metadata` to locate and enumerate the tree, `get_variable_defs` for bindings and text styles, `get_design_context`/`get_screenshot` for structure) **plus the Figma REST API** — `FIGMA_PAT` is in the environment; never print it. The facts below need REST. Report pass/fail per check with the exact offending node named.

## Design-source facts — establish, never infer

Five lookups. Each produces **a fact with the read that established it**, not an impression. Where the design genuinely doesn't specify something, that is a legitimate finding — and it still carries its read. An unsourced absence claim is the worst artifact this project has produced: *"SDS defines no dark mode"* and *"SDS has no dark brand border"* were both false, licensed 24 invented theme values of which 18 were wrong, and survived two days of review **because** they read as settled findings.

**F1 · Every collection, its modes, and how many variables actually vary by mode.**
`GET /v1/files/:key/variables/local` → `meta.variableCollections[].modes[]` (`modeId` + `name`), `defaultModeId`, and per variable `valuesByMode`. Count a variable as mode-varying when it has more than one distinct value across modes.
> **`get_variable_defs` cannot answer this and must not be used to.** It returns one value per variable for the **current mode only**, with no collection or mode information at all. That is exactly how "single mode" was concluded and written down.
- **Match modes by NAME.** Not by position, not by an exact `"dark"` test — the reference file's are `SDS Light` / `SDS Dark`, and an exact-`"dark"` reader silently falls back to the default (light) mode.
- **Report per collection, never per file.** Different collections have different mode counts. Reference file (`Nq23XwGfazYZZZ5vr8OezI`, read 2026-07-31): 9 collections — `Color` **2 modes**, 118 of 137 variables varying; `Color Primitives` **1 mode**, 100 variables, the raw ramp the semantic variables alias *into*; `Responsive` **3 modes** (`Desktop | Mobile | Tablet`), 3 of 5 varying. Concluding "single mode" from the primitives collection is the original error, and assuming exactly two is the next one.

**F2 · Which properties are bound, and every one that is a raw literal.**
`GET /v1/files/:key/nodes?ids=<setId>` and walk the tree. Bound = the property appears in the node's `boundVariables` (`fills`, `strokes`, `itemSpacing`, `padding*`, `rectangleCornerRadii`, `individualStrokeWeights`, `fontSize`, `fontWeight`, `fontFamily`) or in `fills[i].boundVariables.color`. Anything else styled is a literal.
- **Record the literals, don't only fail on them** — each is a design-side finding someone must own. Reference: the `Info` / `Star` / `X` icon instances each carry an unbound white `fills[0]`.
- **Only report a literal on a property that actually paints.** `strokeWeight` is `1` on virtually every node whether or not it has a stroke, and `cornerRadius` restates corners `rectangleCornerRadii` already binds. Reporting those is this project's recurring failure: stating something technically true that doesn't apply.

**F3 · What bound text styles carry beyond the size token.**
`get_variable_defs` on each text node: a bound style returns as `Font(family: …, size: …, weight: …, lineHeight: …, letterSpacing: …)`. Record style name, size token, weight, line-height, letter-spacing per text layer.
- Reference: Card's `Title` → `Heading`, **lineHeight 1.2, letterSpacing -2**; Button's label → `Single Line/Body Base`, lineHeight 1, letterSpacing 0. The Card's pair forced three theme tokens to be added mid-handoff and needed design-lead sign-off as a surprise.
- General shape, whatever the UI kit: **a stock type scale carries size; a bound text style carries more.** Anything past size is a token addition in code — flag it here, while the node ids are in hand.

**F4 · Variables that currently share a value.**
Group **the component's own** bound variables by resolved value — visible directly in the `get_variable_defs` output, no extra call. For a mode-varying collection, resolve per mode via F1's `valuesByMode` (follow `VARIABLE_ALIAS` to its target).
- Flag each group with the rule verbatim: **two design variables must never map to one theme token because their values match today.** Reference: Button binds `background/brand/default` and `border/brand/default`, both `#2c2c2c` in Light and `#f5f5f5` in Dark. Collapsed onto one theme token, a later background change dragged an unrelated border with it.
- **Scope to the component.** File-wide the reference file has 32 shared-value groups in `SDS Light` alone — a list nobody reads.

**F5 · Anything structurally uncomparable later.**
From F2's walk. An uncompared property reads as a pass, so name these up front, per node:
- **`fills[0].type` is not `SOLID`** (IMAGE, GRADIENT_*). The fill dimension reads `fills[0]` only and resolves a colour only, so the property is silently uncompared. Reference: Card's `Asset Type=Image` variant.
- **An invisible `fills[0]`** (`visible: false`) in front of the paint that matters. Visibility is not checked, so the comparison runs against a colour nothing renders.
- **`State=Hover`/`Focus` variants**, whether they exist or not. Registry bindings aren't state-keyed, so a Hover node cannot be bound and its tokens are never compared. Present it as design intent the code must implement unchecked, not as covered.

## Non-negotiable checks

1. **Every color, spacing, radius, and typography value is bound to a library variable.** Raw hex/px values fail, with the node and property named. **F2 is the read** — it is exhaustive and authoritative; `get_variable_defs` alone shows what *is* bound, never what isn't.
2. **No detached instances** anywhere in the component tree. Method: metadata + variable defs canNOT detect detachment — inspect the component's node tree via the Figma REST API (`GET /v1/files/:key/nodes?ids=<setId>` and look for frames that visually duplicate library components without an INSTANCE type) or `get_design_context`. If neither is available, report NOT VERIFIED — never pass this silently.
3. **It is a component or component set** — not a frame that looks like one.
3a. **Is the library published, and does it include THIS component?** Designers forget
   to publish, and an unpublished change is one nobody else can consume — a handoff
   built from it bakes in a decision that was never released.

   ```
   GET /v1/files/:key/component_sets   → what is published as a library
   GET /v1/files/:key                  → what the file actually contains
   ```

   Zero published entries against a file that plainly holds component sets means the
   library has **never been published**. On the reference file, read 2026-08-05:
   **78 component sets and 2,076 components in the file, 0 published. Styles too: 0.**

   State it as a finding with both numbers, and **ask the designer to confirm they have
   published** before handoff. It is not a blocker on its own — the tool reads the file's
   current state, so a comparison still works — but it changes what the handoff *means*.

   **Three things this can and cannot tell you. Do not blur them:**
   - *Never published* — **reliably detectable.** Published count 0, file count > 0.
   - *This component not among the published ones* — **reliably detectable.**
   - *Published, but the publish is older than the designer's latest edits* — **NOT
     reliably detectable.** Per-node modified times are not exposed, and the file's
     `lastModified` moves on any edit anywhere, so inferring a stale publish from it
     would be a guess. **Ask.** Never report a stale publish as established.

   **What this does NOT fix, so nobody mistakes it for a safety net:** publish state has
   no bearing on whether you can *read* a component's variants. `/component_sets` returning
   zero is a fact about publishing, not about readability — walking `GET /v1/files/:key`
   reaches every variant either way. The Dialog handoff conflated those and shipped a
   guessed hover style; publishing the library would have hidden that error rather than
   preventing it.
4. **Variant properties have explicit, complete values** — every variant axis has a value on every variant; no reliance on "default" ambiguity.
5. **Text layers use text styles / typography variables**, not per-layer overrides.

## Team conventions ⚙ DRAFT

- **Variant vocabulary**: TitleCase axis names, matching the Simple Design System conventions (verified against the live library 2026-07-27): allowed axes `Variant` (visual style: `Primary | Neutral | Subtle`), `Size` (`Small | Medium`), `State` (`Default | Hover | Disabled` — states modeled as variants), booleans as `Has*`/`Is*`. Flag any axis outside this list as a naming review item, not a hard fail. Note: separate "tones" (e.g. Button Danger) are separate component sets in SDS, not an axis — mirror that in code as documented in component-handoff.
- **Component naming**: PascalCase single name for standalone components (`Button`), `Parent/Child` slash-nesting only for true subcomponents (`Card/Header`).
- **Token tier**: components must reference **semantic** variables (e.g. `background/brand/default`), never raw palette values (e.g. `slate/900`) directly. Palette-direct binding = fail with the semantic alternative suggested if one exists.
- **Auto-layout**: required on the component root and any container with 2+ children. Absolute positioning allowed only for decorative/overlay elements — must be flagged in the report either way.
- **Required states**: interactive components (buttons, inputs, anything with a click/focus affordance) must define at minimum `default`, `hover`, and `disabled`. Missing states = fail.

## Output format

1. A pass/fail table per check (check · pass/fail · offending nodes · fix).
2. **A `Design-source facts` block, F1–F5, each line citing its read** (tool call + node/collection + date). `component-handoff` copies this verbatim into `contracts/<component>.spec.json` under `designSource`, so write it to be copied: fact, node/collection, citation. Emit it even on NOT READY — the facts are true regardless of the verdict.
3. A single verdict: **READY FOR HANDOFF** or **NOT READY** with the shortest path to ready.

Do not soften failures. If a check could not be performed, say **NOT VERIFIED** for that row — never silently pass it. **F1 NOT VERIFIED blocks handoff**: without the mode enumeration the code side has no basis for its theme work, which is the exact hole the 24 invented values went through.
