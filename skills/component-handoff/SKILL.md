---
name: component-handoff
description: Generate a Storybook-ready coded component from a handoff-ready Figma component — code, stories, and design-sync registry entry in one pass. Use when a designer hands off a component, or when asked to "bring this Figma component into Storybook".
revised: 2026-07-31
---

# component-handoff

> **FIRST DRAFT** — the code standards below are working defaults for a shadcn + Base UI + Tailwind stack; the engineering lead owns them and should adjust. Sections marked ⚙ DRAFT are the ones to review. Change opinions here, never in the tools.

## Preconditions

1. The component passes `handoff-ready-component` (run it first; refuse handoff on NOT READY — name what failed).
2. **You have its `Design-source facts` block (F1–F5).** These are inputs to the build, not documentation. If F1 (collections + modes) is NOT VERIFIED, stop and run it — a theme built without knowing whether the design has a second mode is how 24 values got invented, 18 of them wrong.
3. The repo has design-sync set up (`design-sync.config.json` present).

## Pipeline

1. **Read the Figma component** (variants, props, token bindings, structure, text) via the Figma MCP tools (`get_metadata`, `get_design_context`, `get_variable_defs`).
2. **Extract the spec** — record what the component *declares*: props/variants, token per property, slots, required states. Write it as a sidecar `contracts/<component>.spec.json` (variants, tokenBindings, slots keys) next to the code. It documents what the component promised at handoff, and `component-update` diffs against it later.

   **`notInFigma` — every entry cites the read that established the absence.** This key records what the design deliberately doesn't specify, so an unchecked guess in it is worse than an omission: it forecloses the lookup that would correct it. Two such claims ("SDS defines no dark mode", "SDS has no dark brand border") were both false and licensed 24 invented values, 18 of them wrong, and they survived review *because* they read as settled findings. Write the tool call and node/collection you read — `"min-width": "not bound; get_variable_defs on 2142:11380, 2026-07-31"` — or leave the entry out. Same rule for any code comment asserting the design lacks something.
   Note the spec's `tokenBindings` also drives the fix prompt's contract read: a token bound to several slots is named in the prompt as one decision, so recording the pair here is what stops a later fix splitting it.

   **`designSource` — F1–F5 from `handoff-ready-component`, copied with their citations.** A top-level key alongside `notInFigma`; the addon's contract reader only walks `tokenBindings`, so this is inert to tooling and read by agents. Shape:

   ```json
   "designSource": {
     "readAt": "2026-07-31",
     "reads": ["GET /v1/files/<key>/variables/local, 2026-07-31", "get_variable_defs 280:11380, 2026-07-31"],
     "collections": [{ "name": "Color", "modes": [{"id":"3919:21","name":"SDS Light","default":true},{"id":"3919:22","name":"SDS Dark"}], "variables": 137, "modeVarying": 118 }],
     "literals": [{ "nodeId": "…", "node": "Info", "property": "fills[0].color", "value": "#ffffff", "owner": "design" }],
     "textStyles": { "title": { "style": "Heading", "sizeToken": "typography/heading/size/base", "weight": 600, "lineHeight": "1.2", "letterSpacing": "-2", "tokensAdded": ["--leading-heading", "--tracking-heading"] } },
     "sharedValues": [{ "value": "#2c2c2c", "mode": "SDS Light", "variables": ["Background/Brand/Default", "Border/Brand/Default"], "themeTokens": ["--primary", "--primary-border"] }],
     "uncheckable": [{ "nodeId": "…", "variant": "Asset Type=Image", "property": "background-color", "reason": "fills[0] is IMAGE; the fill dimension resolves SOLID only" }]
   }
   ```

   `uncheckable` and `notInFigma` are different claims and must not be merged: `notInFigma` = *the design doesn't specify it*; `uncheckable` = *the design specifies it and the tool can't read it*. Both cite their read.
3. **Account for the facts in the build — now, not as later drift.**
   - **A second mode is theme work at handoff.** Read each token's per-mode value from F1's `valuesByMode` (follow `VARIABLE_ALIAS` to its target) and write every mode the collection has. **Never derive one mode's value from another's** — that is precisely what produced the 18 wrong values. Then set `parameters.designSync.modeSwitch` and `modes` so the check can read them, using the design's **mode names**, not `"dark"`. Two is not a given: the reference file's `Responsive` collection has `Desktop | Mobile | Tablet`.
   - **Text-style extras are token additions, identified here.** Anything F3 records past the size token — line-height, letter-spacing, weight — that the target scale doesn't carry becomes a new theme token now, while the node ids are in hand. The rule below stands: adding a token is allowed, never silent, and goes in the PR title.
   - **Variables sharing a value get distinct theme tokens** — one per design variable, each commented with the variable it came from. Never one token for two, however identical today.
   - **Literals (F2) are routed, not absorbed.** A raw value on the design side is a design ruling; it goes in the report's "needs human decision" list with its node id. Do not bind a code token to it and do not hardcode it.
   - **Uncheckable properties (F5) are stated in the report.** A clean drift check does not cover them, and presenting it as though it does is the failure this whole section exists to stop.
4. **Generate the component** from the spec, per the code standards below.
5. **Generate stories** — one story per meaningful variant combination, real content, no lorem. Story ids must match the registry format (`npx design-sync ls` shows examples).
6. **Register** — add the story ↔ Figma node binding (`npx design-sync register`, or edit `.design-sync/registry.json`: storyId, nodeId, fileKey). Run `npx design-sync audit` — must exit 0.

   **For any composed component, bind its inner elements too.** Drift checking compares the story's root element against the Figma node; children are only checked when declared. A Card whose header padding drifts reports clean unless you bind the header. So:
   - Put a **`data-slot="…"`** attribute on each structural element (header, body, footer, label, icon). Classes churn with Tailwind refactors; `data-slot` is stable and unambiguous, which is what a binding selector needs.
   - Declare them while you still have the Figma node ids in hand — retrofitting later means re-opening the file:
     `npx design-sync register --story ui-card--default --child "[data-slot=header]=2142:11381" --child "[data-slot=body]=2142:11382"`
   - Typically 2–4 per component, ~2 minutes. Nothing to do when the root *is* the whole component (Button, Badge, Icon).
   - Selectors resolve among the root's **descendants only** — a selector matching the root itself can never bind.
7. **Verify** — typecheck, tests, build; then run a drift check on the new story and include the result in your report. A fresh handoff must check clean; if it doesn't, fix before presenting. **Check every mode F1 found**, and state alongside the clean result which properties were *not* compared (F5) — a pass covers what was compared, nothing more.

   **Run it yourself — don't ask the user to click.** As of addon v0.0.45 `npx design-sync check --story <id>` runs the same check headlessly: it opens the project's own Storybook preview in headless Chromium, so the same code measures the same DOM against the same engine. It is verified row-for-row identical to a panel **Check all**, so its result is reportable as the check. It needs `storybook dev` running (a static build has no server channel) and Playwright installed (an optional peer dep). Exit codes: `0` clean, `1` drift, `2` **coverage incomplete**, `3` couldn't run — `2` outranks `1`, so never read a non-zero exit as merely "drift found" without checking which.

   If `check` genuinely cannot run, say the drift result is unverified and ask the user to run **Check drift** and paste it; never report a check you didn't see. Using the panel instead? Confirm its header version matches the installed addon first — a running Storybook keeps the bundle it started with, and a stale panel reports rows the installed version no longer produces.

## Code standards ⚙ DRAFT (shadcn + Base UI + Tailwind defaults)

- **Component pattern**: React function components, TypeScript strict. Build on the corresponding `@base-ui-components/react` primitive when one exists (accessibility comes from the primitive); plain elements otherwise.
- **Variants**: `class-variance-authority` (`cva`) — one `cva()` per component mapping the Figma variant axes to cva variant keys (TitleCase Figma axis → lowercase prop: `Variant=Primary` → `variant: "primary"`). Boolean Figma props → boolean component props.
- **`State` axis is NOT a prop.** Design systems (incl. SDS) model interaction states as variants (`State=Hover/Disabled`); in code these map to CSS pseudo-classes and attributes — `hover:` styles from the Hover variant's tokens, `disabled`/`aria-disabled` + disabled-variant tokens from Disabled. Never generate a `state` prop. The Default variant is the component's base styling.
- **Sibling "tone" component sets** (e.g. Button Danger as a separate set) map to a `tone`/`destructive` prop on ONE code component, not a second component — record the mapping (both node ids) in the registry/spec.
- **Styling**: Tailwind utilities referencing the theme's CSS custom properties (shadcn convention: `bg-primary`, `text-muted-foreground`). **Never a literal color/px value in a component file** — if the token doesn't exist in the theme, stop and report it as a spec gap rather than hardcoding.
- **Don't reach for the nearest-looking theme var — check what the design actually names.** shadcn's vocabulary is narrower than most design systems: it has no disabled, success, or warning semantics, and one flat tier where the design may have secondary/tertiary/hover ladders. If the design binds a disabled state to its own disabled tokens, use the theme's disabled vars — `disabled:opacity-50` or `disabled:bg-muted` is a shadcn idiom, not the design's intent, and it will read as drift forever. Same for hover fills and success/warning states.
- **When the design names a token your theme doesn't have**, you may **add** it: a new variable with the design's value, a comment stating which design token it came from, and a matching manifest entry. You may **never change an existing token's value** — that's `component-update`'s token-layer path, and it needs both leads.
  Adding a token is a design-system decision, so it cannot be silent: put it in the PR title or the first line of the PR body (e.g. "adds 3 theme tokens — needs design-lead sign-off"), list each token with its design source, and say the component was blocked without them. A reviewer must never discover a new token by reading the diff.
- **File layout**: `src/components/ui/<component>.tsx` + `src/components/ui/<component>.stories.tsx` (+ the sidecar spec in `contracts/`).
- **Structural elements carry `data-slot`.** Any element that corresponds to a named layer in the design (header, body, footer, label, icon slot) gets `data-slot="header"` etc. It costs nothing, it's the stable hook drift checking binds to, and without it the only selectors available are Tailwind classes that change on every refactor.
- **Prop naming**: camelCase; variant unions typed from the cva config (`VariantProps<typeof buttonVariants>`); forward `className` and merge with `cn()`; spread rest props onto the root element.
- **Accessibility bar (blocking)**: semantic element or Base UI primitive; keyboard operable; visible `focus-visible` ring from theme tokens; disabled states use `disabled`/`aria-disabled` correctly; icon-only variants require an accessible label prop.
- **Not generated — flagged instead**: motion beyond token-level `transition-*`, drag/typeahead/focus-trap behavior, responsive layout changes not expressed in Figma. These go in the report's "needs human decision" list.

## Rules

- Every generated style value must reference a token. A hardcoded value in generated code is a bug.
- Anything the Figma component doesn't specify (hover timing, motion, focus style beyond tokens) is surfaced as an explicit "needs human decision" list — never silently invented.
- The output is a PR for review, not a direct commit to main. After opening it, tell the user plainly: PR number, what's in it, and their two options — "merge it" (if they have rights) or hand it to the engineering reviewer. Never make the user run a CLI command; all registry/audit bookkeeping happens inside this skill and CI.
