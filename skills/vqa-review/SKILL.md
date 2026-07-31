---
name: vqa-review
description: Run the definition-of-done review for a component in Storybook — drift check + inspection checklist — and route any failure to the right owner. Use when a component is claimed finished, or when asked to "VQA this component".
revised: 2026-07-31
---

# vqa-review

> **FIRST DRAFT** — the routing rule is final; the checklist items marked ⚙ DRAFT are working defaults for the design + engineering leads to adjust.

## The routing rule (do not change)

- **Drift check fails** → implementation is wrong → route to **engineering** (attach the fix prompts).
- **Drift check passes but it looks/behaves wrong** → the spec was incomplete → route to **design** as a spec gap (the fix is enriching the Figma component or the contract, then re-handoff — not hand-editing the code).

## Procedure

0. **Check the version in the panel header before you trust anything it says.** A running Storybook keeps the manager bundle it started with, so an upgraded addon can report the old version's rows for hours with `package.json` and `node_modules` both saying otherwise. The panel prints its running version and banners when it differs from the installed one — if it does, restart Storybook (and `rm -rf node_modules/.cache/storybook`) before reviewing. Bumping a git-dep pin and running `npm install` does not refetch.
1. **Use "Check all", not "Check drift" per story.** One click covers every registered story and shares a single Figma fetch across them; clicking "Check drift" story-by-story deliberately bypasses the caches on each press (that is what an explicit single check is for), so an 11-story component becomes 11 full refetches and turns a 1-minute review into 20. **Rate limiting bites after roughly two full Check all runs** — budget for one pass, not exploratory re-runs. Tick **Both modes** for light and dark in the same pass. Record per story: clean / N drift rows / advisories.

   A Check all is also what lets a fix prompt state its **blast radius** — with one, prompts name the sibling variants that expect a different value; without one they say the radius is not established. Run it before copying prompts for ENG, and copy them from the same panel session (the sibling comparison isn't persisted).

   **The two buttons must report the same story the same way** (v0.0.43 — the summary now counts in the table's unit). If a story's drift count differs between Check all and Check drift, that is a bug in the addon, not a judgement call: file it rather than picking the number you prefer. The one deliberate exception is `flagOnly` rows, which the table drops as uninformative and the summary keeps counting.

   Two results that are **not** passes:
   - `⚠ incomplete — Figma unread` — the Figma side didn't load (usually a 429). The story was never checked, it's counted apart from checked in the coverage line, and it is not cached, so re-running retries it. Never read it as clean.
   - a **Both modes** run whose report says the mode comparison was **not performed** — the theme switch moved no computed colour, so one mode's rows are all you have. Fix the mechanism (`parameters.designSync.modeSwitch`) and re-run; a single-mode result is not a two-theme sign-off. If the project's modes aren't called light and dark, `parameters.designSync.modes` must name them or the wrong two modes are measured.

   If you cannot drive the browser, say so and ask the user to run Check all and paste the report. **Never infer or fabricate results** — an unearned "DONE" is worse than no review, because this is the step everything else relies on.
   **A `copy` row routes to neither owner above** — it's a content decision. Figma can't mark text as placeholder, so a component with lorem in the design drifts on every story forever (16 of 20 rows on a live Card). Route it to whoever owns the copy, or note that the project should set `"copy": "off"` / `parameters.designSync.compareCopy: false`. It is never an engineering fix and never a DONE-blocker on its own.
2. Walk the inspection checklist below using the **Design** panel (inspect real values via the panel — don't eyeball screenshots).
3. Check every variant and both themes; force hover/focus-visible/disabled via the panel's pseudo-state controls. **This is the only coverage those states get** — drift checking never compares hover, focus or active (a story can't take a pseudo-state as an argument), so a clean drift report says nothing about them. Disabled *is* drift-checked, because it's a real prop.
4. Verdict: **DONE** (all green), **ENG** (drift rows attached, fix prompts copied), or **DESIGN** (spec gaps described concretely — "hover state undefined in Figma", not "feels off").

## Inspection checklist ⚙ DRAFT

- **Tolerances**: token-bound properties must match exactly (they resolve from the same variable — any difference is a real bug). 1px deviation acceptable only for sub-pixel text metrics (line-height rounding); nothing else.
- **States per interactive component**: default, hover, focus-visible (ring visible and from theme tokens), disabled — in **both** light and dark themes. Non-interactive: default in both themes.
- **Content stress**: longest realistic label (no truncation surprises), empty/optional content (component doesn't collapse), a 2-line wrap case for text-bearing components. RTL deferred until the product needs it — note it as unchecked, don't fake it.
- **Motion / interaction (human-only — can't be drift-checked)**: transitions fire on state change and respect `prefers-reduced-motion`; no layout jump on hover; replay via the inspector's Motion section.
- **Accessibility spot checks**: text contrast ≥ AA against its actual background in both themes (inspect the resolved values, don't assume the token pair is safe); focus ring visible against both themes; icon-only controls have accessible names.

## Output format

Per-story results table (story · drift · checklist failures), then the verdict with the routed owner and the exact artifacts attached (fix prompts for ENG; concrete spec-gap list for DESIGN).
