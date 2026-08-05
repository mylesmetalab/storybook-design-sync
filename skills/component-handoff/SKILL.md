---
name: component-handoff
description: Generate a Storybook-ready coded component from a handoff-ready Figma component — code, stories, and design-sync registry entry in one pass. Use when a designer hands off a component, or when asked to "bring this Figma component into Storybook".
revised: 2026-08-06
---

# component-handoff

> **FIRST DRAFT** — the code standards below are working defaults for a shadcn + Base UI + Tailwind stack; the engineering lead owns them and should adjust. Sections marked ⚙ DRAFT are the ones to review. Change opinions here, never in the tools.

## Preconditions

1. The component passes `handoff-ready-component` (run it first; refuse handoff on NOT READY — name what failed).
2. **You have its `Design-source facts` block (F1–F5).** These are inputs to the build, not documentation. If F1 (collections + modes) is NOT VERIFIED, stop and run it — a theme built without knowing whether the design has a second mode is how 24 values got invented, 18 of them wrong.
3. The repo has design-sync set up (`design-sync.config.json` present).
4. **For a stateful component, you have the behaviour answers** (step 4a). A dialog, menu, accordion or tooltip cannot be built correctly from the design file alone — the file does not contain its behaviour. Ask before generating, not after.

## Pipeline

1. **Read the Figma component** (variants, props, token bindings, structure, text) via the Figma MCP tools (`get_metadata`, `get_design_context`, `get_variable_defs`).

   **To enumerate a component set's sibling variants, walk the file — do NOT use `/component_sets`.**
   `GET /v1/files/<key>/component_sets` and `/components` list only what is **published as a
   library**. On an unpublished file they return **zero entries for every component**, which
   is not the same fact as "this component has no variants". An instance also carries no
   `componentSetId`, so a `GET /nodes` on the instance cannot reach its siblings either.

   What works, on any file you can read:

   ```
   GET /v1/files/<key>            -> walk for type === "COMPONENT_SET"
                                  -> componentPropertyDefinitions[axis].variantOptions
                                  -> each child COMPONENT's fills[0].boundVariables.color.id
                                  -> resolve ids against /v1/files/<key>/variables/local
   ```

   This has now cost two separate sessions the same way. In the Dialog handoff it produced
   `hover:bg-accent` as an admitted "best-effort guess" for Icon Button, while the design's
   real tokens — `Background/Default/Secondary Hover` and `Background/Disabled/Default` —
   were one file read away. **A guess in shipped code is the failure this whole skill exists
   to prevent**, and it is not redeemed by being labelled a guess.

   **A failed read does not establish an absence.** This is a sharper form of the
   `notInFigma` rule below, and the Dialog contract broke it while appearing to comply: it
   cited `GET /component_sets returned zero entries` as evidence that variants could not be
   enumerated. The citation was real and the conclusion was false, which is worse than no
   citation at all — a claim carrying a tool call reads as settled and stops the next person
   looking. Before writing any "could not be read", ask: **would this read have found the
   thing if it existed?** If the answer is no, it is evidence about the endpoint, not about
   the design.
2. **Extract the spec** — record what the component *declares*: props/variants, token per property, slots, required states. Write it as a sidecar `contracts/<component>.spec.json` (variants, tokenBindings, slots keys) next to the code. It documents what the component promised at handoff, and `component-update` diffs against it later.

   **`notInFigma` — every entry cites a read that WOULD have found the thing if it existed.**
   Not merely "a read". A read that failed for an unrelated reason — wrong endpoint,
   unpublished library, missing scope — establishes nothing about the design, and citing it
   dresses a gap up as a finding. See step 1.

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
4. **Resolve every nested instance BEFORE generating — compose what exists, rebuild nothing.**

   A composed component is a tree of `INSTANCE` nodes, and most of them are components the repo may already have. SDS's `Dialog` is five levels deep — `Dialog → Dialog Body → Slot → Button Group → Button` — and its two buttons are instances of the same Button component set a starter is typically already registered against.

   Rebuilding one of those is not a cosmetic mistake. It forks a component that already has a contract, stories, and registry bindings, so a later design change to Button drifts in one place and is reported clean in the other.

   For each `INSTANCE` in the tree, in this order:

   1. **Read its `componentId`** (`get_metadata`, or the REST node's `componentId`) — not its layer name. Layer names repeat and get renamed; the component id is the identity.
   2. **Look for that id in the registry.** `npx design-sync ls` prints every registered story with its node id. A hit means the repo already implements it: **import and compose it.** Pass content through props/children; never copy its markup or its `cva()` config.
   3. **A miss is a decision, not a licence to build.** Say so in the report: *"`Button Group` (2072:9433) is not registered; I built it inline / it needs its own handoff first."* Prefer handing off the child component separately when it is genuinely reusable — one `Dialog` handoff that quietly births three new components is not reviewable.
   4. **Ignore the utility instances.** `_Component Annotation` and `_Component Note` are documentation the designer writes for humans (see step 4a). They are never code.
   5. **Register the nested ids as children** (step 7), so the composition is actually checked rather than assumed.

   `SLOT` nodes are Figma's slot feature and map to `children` or a named render prop — not to a wrapper element of their own unless the slot itself carries tokens.

4a. **Behaviour: read the file first, then ASK. Never infer it.**

   Figma can encode interaction as prototype reactions, and it is worth reading — but do not assume that is where behaviour lives. Read `interactions` on the nodes (**the REST field is `interactions`; a scan for `reactions` silently returns nothing**, which will read as "no behaviour" when you simply looked in the wrong place).

   On the reference SDS file, every interaction in the entire file — **504 of them** — is `ON_HOVER → NODE:CHANGE_TO`, i.e. hover-variant swapping. There is not one click, open, close, or key trigger. The designer notes on the Dialog page are layout rules (max-width 600, bottom-sheet anchoring, min-height 160) and say nothing about behaviour either.

   So for anything stateful — a dialog, a menu, an accordion, a tooltip — **the design file does not specify the behaviour, and you cannot derive it.** A `Dismissible` boolean prop says an X button exists; it does not say what clicking it does.

   Therefore: **ask the user, before generating.** Ask specifically, not "how should this behave?" — a designer answers a specific question quickly and a vague one badly:

   - What opens it, and what closes it? (trigger click · Cancel · X · Escape · click outside · programmatic only)
   - Is it modal — does it block interaction with the page behind, and trap focus?
   - Where does focus go on open, and on close?
   - Can it be dismissed by clicking the overlay, or is that deliberately disabled for destructive actions?
   - Any motion beyond the theme's `transition-*`?

   Then record the answers in the contract under `designSource.behaviour`, **each with its source** — `"asked"` plus the date, or the read that established it:

   ```json
   "behaviour": {
     "askedAt": "2026-08-05",
     "figmaInteractions": "504 interactions on this file, all ON_HOVER → CHANGE_TO; none is a click/open/close (GET /v1/files/<key>, 2026-08-05)",
     "opensOn": { "value": "trigger click", "source": "asked 2026-08-05" },
     "closesOn": { "value": ["Cancel", "X", "Escape"], "source": "asked 2026-08-05" },
     "overlayClickDismisses": { "value": false, "source": "asked 2026-08-05" },
     "modal": { "value": true, "source": "asked 2026-08-05" }
   }
   ```

   An unanswered question stays unanswered in the contract and goes in the "needs human decision" list. **Do not fill it from the primitive's defaults and call it the design's intent** — Base UI closing on outside-click is Base UI's opinion, not the designer's, and writing it down as though it were the design source is the same failure as the invented `.dark` values.

5. **Generate the component** from the spec, per the code standards below.
6. **Generate stories** — one story per meaningful variant combination, real content, no lorem. Story ids must match the registry format (`npx design-sync ls` shows examples).
7. **Register** — add the story ↔ Figma node binding (`npx design-sync register`, or edit `.design-sync/registry.json`: storyId, nodeId, fileKey). Run `npx design-sync audit` — must exit 0.

   **Bind the nested instances you resolved in step 4**, using their component ids, so composition is checked and not assumed. A composed component whose children are unbound reports clean while a child drifts.

   **For any composed component, bind its inner elements too.** Drift checking compares the story's root element against the Figma node; children are only checked when declared. A Card whose header padding drifts reports clean unless you bind the header. So:
   - Put a **`data-slot="…"`** attribute on each structural element (header, body, footer, label, icon). Classes churn with Tailwind refactors; `data-slot` is stable and unambiguous, which is what a binding selector needs.
   - Declare them while you still have the Figma node ids in hand — retrofitting later means re-opening the file:
     `npx design-sync register --story ui-card--default --child "[data-slot=header]=2142:11381" --child "[data-slot=body]=2142:11382"`
   - Typically 2–4 per component, ~2 minutes. Nothing to do when the root *is* the whole component (Button, Badge, Icon).
   - Selectors resolve among the root's **descendants only** — a selector matching the root itself can never bind.
8. **Verify** — typecheck, tests, build; then run a drift check on the new story and include the result in your report. A fresh handoff must check clean; if it doesn't, fix before presenting. **Check every mode F1 found**, and state alongside the clean result which properties were *not* compared (F5) — a pass covers what was compared, nothing more.

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
- **Never rebuild a component the repo already has.** Import it and compose. See pipeline step 4 — the check is `componentId` against the registry, not the layer name.
- **Not generated — asked about, then flagged**: open/close and dismissal behaviour, focus management and focus trapping, drag/typeahead, motion beyond token-level `transition-*`, and responsive layout not expressed in Figma. Ask the specific questions in step 4a first; whatever is still unanswered goes in the report's "needs human decision" list. Silently taking the primitive's default and presenting it as the design's intent is the failure this rule exists to stop.

## Rules

- Every generated style value must reference a token. A hardcoded value in generated code is a bug.
- Anything the Figma component doesn't specify (hover timing, motion, focus style beyond tokens) is surfaced as an explicit "needs human decision" list — never silently invented.
- The output is a PR for review, not a direct commit to main. After opening it, tell the user plainly: PR number, what's in it, and their two options — "merge it" (if they have rights) or hand it to the engineering reviewer. Never make the user run a CLI command; all registry/audit bookkeeping happens inside this skill and CI.
