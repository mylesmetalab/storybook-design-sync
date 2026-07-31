---
name: fix-drift
description: Resolve a difference between a Figma design and the coded component — the single entry point for "this drifted", "fix this", "the design changed", "the brand colour changed", or a pasted Design Sync fix prompt. Triages which layer the fix belongs in (token, component, or back to design) and follows the right path.
revised: 2026-07-31
---

# fix-drift

> **FIRST DRAFT** — guardrails marked ⚙ DRAFT are working defaults; the engineering lead owns them.

**This is the front door. Nobody using it should have to know which layer a fix belongs in — that's your job, not theirs.** Accept any of: a pasted fix prompt, a story id + property, or a plain sentence like "the brand colour changed in Figma".

## Step 0 — Triage the layer (do this before anything else)

Re-check drift to get current truth, then decide which of these you're looking at. Say which one you concluded and why, in one line, before you act. **Drift checking runs only in the Storybook panel** — the CLI is `audit`, `register`, `ls`, `export-graph`, with no `check`, because comparison needs rendered DOM. If you can't drive the browser, ask for the report; never infer it.

A pasted prompt from addon v0.0.44+ has already routed the layer for you and states what it could *not* establish. Read those statements as binding: "the blast radius is not established" is an instruction to go establish it, not a caveat to skip.

| What you see | Path |
|---|---|
| **A `copy` row** (text content differs) | **Not a code edit.** Figma cannot mark text as placeholder while a story is expected to render real product copy, so rewriting a story's `args` to match a Figma placeholder destroys what the story was for. Route it to whoever owns the content. If the design's text is placeholder across the board, the fix is config — `"copy": "off"` project-wide or `parameters.designSync.compareCopy: false` per story — not an edit. |
| **The expected token isn't declared in the project** | **Not a component edit.** The prompt names the file where custom properties *are* declared. Adding the token is a design-system decision (`component-handoff`'s add-a-token rule: named in the PR title, design source cited). Never a dangling `var()`, never the raw literal. |
| **The Figma value is not bound to a variable** (a raw literal painted on the node) | **Do not touch code.** Escalate to design — the fix is re-binding it in Figma. See "when the fix is on the Figma side" below. |
| **A token's *value* changed** in Figma, and the code correctly references that token | **Token layer.** Invoke the `component-update` skill and follow its token-layer path: one PR to the theme + manifest, dual sign-off. Normally this must not touch a component — with one real exception: if the moved token turns out to be **shared by two properties that the design system names separately** (two design variables collapsed onto one theme token because their values matched at handoff), no theme-only edit can hold them apart. Split the tokens 1:1 and rewire the component to the new one, then flag the deviation explicitly for the engineering lead. Do not use this as a general licence to edit components on a token change. |
| **Variants added, removed or renamed**, or the component's structure moved | **Component restyle.** Invoke the `component-update` skill and follow its full path. |
| **The component references the wrong token, or a hardcoded value** | **Component fix.** Continue with the procedure below. |
| **Several sibling properties drifted together** (four paddings, four radii) | One change, not several — see step 3. Layer as above. |
| **A row the prompt names as a declared contract sibling** | The component's `contracts/<component>.spec.json` records one token driving several slots. Fix the pair together — nothing *compares* the other slot, so fixing only the reported row can leave a declared pair split across two values. |

If the triage is genuinely ambiguous, say so and ask **one** question. Never guess between layers: a token-layer change applied to a component leaves the token wrong everywhere else, and a component change applied to a token restyles things nobody asked about.

## Procedure (component-fix path)

1. **Verify before changing** — open the named file, confirm the current value matches what the prompt says it is. If it doesn't (someone already changed it), STOP and report the discrepancy; do not force the edit.
2. **Determine the right side.** The prompt describes code≠Figma; default assumption is code is stale (Figma is the design source). But if `git log -p` on the file shows the code value was changed *deliberately and recently* (commit message evidence), flag it as a possible intentional divergence and ask instead of overwriting.
3. **Establish the blast radius before editing.** The prompt tells you which of three cases you're in, and only one lets you edit as a minimal change:
   - *checked, siblings agree* — safe as one edit.
   - *conflicts with N sibling variants* (the prompt names them and their expected values) — a shared declaration cannot satisfy them all. Add the variant seam or escalate; do **not** apply it as written. On a live Card this case contradicted Figma on 7 of 8 siblings.
   - *not established* — only this story was compared. Find the declaration, check whether it sits behind a variant seam, and run **Check all** if you need the siblings' expected values. If you still can't establish it, say so; don't guess.

   Sibling *properties* are the same principle within one element: four paddings or four radii that moved to the same token are ONE decision the prompt already groups as one change. Fixing a subset produces a state nobody designed — say so explicitly in the PR if you do.
4. **Make the change, completely** — the named property in the named file, to the expected token reference (prefer `var(--token)` / the Tailwind theme-token form over the raw value). Nothing else, no drive-by cleanups. **If the prompt carries two mode values, cover both in the same edit** (`:root` and `.dark`, or a `dark:` utility): setting one leaves the other wrong and a check run in the mode you fixed reports green.
5. **Verify after** — typecheck + tests, then re-check drift on that story. Read it as re-verification, not confirmation: **a fix prompt is a point-in-time reading.** Every Figma value in it was read at the timestamp the prompt carries and may have moved or been reverted since — starter PR #5 applied one faithfully and would have re-introduced the drift it existed to remove, because the Figma edit it cited was reverted while the PR sat open. Confirm Figma still reads as stated before committing; on a mismatch **stop**, don't commit, and report what Figma says now. `⚠ incomplete — Figma unread` is not a pass — the read failed (usually rate limiting) and nothing was checked.
6. **Deliver as a reviewable diff** — a commit on a branch / PR per the project's flow, with the fix prompt quoted in the commit body for traceability (it carries its own provenance — keep it intact). Tell the user plainly: PR number, the one-line change made, and their options — "merge it" or hand to the engineering reviewer. Never make the user run a CLI command.

## Guardrails ⚙ DRAFT

- **Batching**: one PR per component. Multiple fix prompts for the *same* component may share a PR (one commit per prompt); prompts for different components never share one.
- **Off-limits without human sign-off**: token definition files themselves (`tokens.css`, the shadcn `:root`/`.dark` theme blocks, `tokens/manifest.json`) — changing a token's *value* affects every consumer and is a design decision, not a drift fix. If the prompt's correct fix is a token-value change, stop and escalate.
- **When the fix is on the Figma side** (code is right, design drifted — established via the git evidence in step 2 or explicit instruction): do not touch code. Open an issue on the project repo titled `design-drift: <component>.<property>`, body = the fix prompt + the git evidence, and tell the user to route it to the design lead. (Adjust to your team's channel — Slack/Notion — when decided.)
