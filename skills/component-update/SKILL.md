---
name: component-update
description: Update an existing coded component after its Figma design changed — a restyle, a new style guide, added or removed variants, or a token whose value moved. Usually reached via the fix-drift skill's triage rather than invoked directly; invoke directly when you already know the design has moved on beyond a single property, e.g. "apply the new style guide" or "resync this component with Figma".
revised: 2026-08-06
---

# component-update

> **FIRST DRAFT** — sections marked ⚙ DRAFT are the leads' to adjust.

For components that already exist in code. Handoff is birth; this is life. Never regenerate a component wholesale — the code contains decisions Figma cannot express, and they must survive.

## Step 1 — Triage the layer (do this before touching anything)

A restyle or new style guide usually lands in the **token layer**, not in components. Determine which you're dealing with:

1. Run a drift check on the affected component(s) — the drift rows are your changelog. **Panel only: there is no headless drift path.** The CLI is `audit`, `register`, `ls`, `export-graph` — no `check` — because comparison needs rendered DOM; `audit` gates the registry, never drift. Use **Check all** to get every story in one pass (and to establish blast radius — see below). If you can't drive the browser, ask the user to run it and paste the report; never infer the rows.
2. Read the drift:
   - **Token-layer change** — the same properties drift across many components, and the code is correctly referencing tokens whose *values* now differ from Figma. → **Do not edit components.** Produce ONE PR updating the theme/token definitions, then re-check: every correctly-bound component follows automatically. Report how many components the single change resolved.
   - **Structural change** — variants added/removed/renamed, properties that didn't exist before, layout or slot changes, a component referencing a different token than before. → per-component work, continue below.
   - **Both** — do the token PR first, re-check, then handle whatever structural drift remains. Never mix the two in one PR.

State your triage conclusion explicitly before making changes. Getting this wrong means doing 40 components of work that one file would have fixed.

**A token PR must cover every mode.** A mode-varying token has a light *and* a dark value; the prompt carries both and says the change is half-applied until both are done. Editing `:root` and leaving `.dark` produces a PR that goes green in whichever mode was checked and stays wrong in the other. Same in reverse: never write a `.dark` value you did not read from the design's dark mode — cite the read, or leave the block alone and say the dark values are unestablished.

## What the fix prompt already establishes (don't restate it)

If you were reached from a **Copy fix prompt**, the prompt has already done work this skill used to describe. Trust it and don't duplicate it:

- **Layer routing** — it says when a row is a token PR, when the token isn't declared in the project at all (and refuses both a dangling `var()` and a hardcoded literal), and when a row isn't a code edit.
- **Blast radius** — where a **Check all** has run, it names sibling stories that expect a *different* value for the same element and property. Where none has, it says the blast radius is **not established** and that you must find the declaration and check for a variant seam. Take that literally: it is not permission to guess. The check is only as wide as the last Check all in that panel session and isn't persisted, so a fresh panel always says "not established".
- **Contract siblings** — it reads `contracts/<component>.spec.json` and names the other slots the same token drives, so a declared pair isn't split. It *names* them; nothing compares them.
- **Provenance** — the ISO time of the Figma read, the file version and node id. Re-verify against Figma before committing and **stop** on a mismatch (see step 5).

## Step 2 — Enumerate the delta

**First, is the change you are chasing actually published?** The tool reads the file's
*current* state, so it sees a designer's unpublished edits and reports them as drift a
consumer cannot yet get. Cheap check, and it decides whether this update is even due:

```
GET /v1/files/:key/component_sets   → published as a library
GET /v1/files/:key                  → what the file contains now
```

Zero published against a file full of component sets means the library has never been
published (true of the reference file: 78 sets, 0 published, read 2026-08-05). Report it
and **ask the designer to confirm** rather than proceeding as if the design had settled.
*Published but stale* is **not** reliably detectable — per-node modified times are not
exposed and `lastModified` moves on any edit — so ask; never assert it. Updating code to
match an unpublished experiment is how a component ends up ahead of its own design system.

For each component in scope, compare the current Figma component against **its spec sidecar** (`contracts/<component>.spec.json`, written at handoff — it records what the component promised) and against the current code. The Figma-vs-spec diff is the cleanest statement of what design changed since handoff. Produce an explicit change list before editing:

- **Additive**: new variant value, new optional prop, new token binding on an existing property. Safe.
- **Modified**: an existing property now references a different token; a variant's styling changed. Safe, but verify no call site relied on the old look.
- **Breaking**: a variant value removed or renamed, a required prop added, a prop's type narrowed. → find every call site (`grep`/`rg` for the component and the affected prop across the repo) and list them. Breaking changes need the user's explicit go-ahead plus either a codemod or a documented migration in the PR body.
- **Unrepresented**: something in the design that code can't express, or something in code the design doesn't mention (see step 3).

## Step 3 — Preserve what Figma can't express

Before editing, inventory what exists in the code that has no Figma counterpart, and carry it through unchanged:

- Motion beyond token-level transitions; animation timing and easing
- Interaction behavior: keyboard handlers, focus management, drag, typeahead
- Accessibility work: ARIA wiring, live regions, label plumbing
- Props that exist for code reasons (`asChild`, `ref` forwarding, `className` merge, analytics hooks)
- Comments explaining a non-obvious decision — especially any that document a *deliberate* divergence from the design

If a design change would remove or contradict one of these, STOP and surface the conflict rather than resolving it yourself. That's a human decision.

## Step 4 — Edit in place

- Modify the existing component file; do not regenerate it. The diff should be readable as "what the design changed", nothing more.
- Follow the code standards in `component-handoff` (same stack rules: tokens only, no hardcoded values, `State`-as-variants map to pseudo-classes not props, cva keys mirror Figma axes).
- Update stories: add stories for new variants, remove stories for removed ones, keep existing realistic content.
- Registry: usually unchanged (same story ↔ node binding). Update it if node ids changed or stories were added/removed, and verify.
- **Update the spec sidecar** (`contracts/<component>.spec.json`) to match what the component now declares — otherwise the next update diffs against a stale promise. Every `notInFigma` entry you add or keep must cite the read that established the absence (see `component-handoff` step 2); an uncited absence claim reads as a settled finding and licenses invented values.

## Step 5 — Verify and report

1. Typecheck, tests, build.
2. **Re-check drift on every affected story, and read it as re-verification, not just confirmation.** Every value you applied was read at some past moment and may have moved or been reverted since — that has happened, and a faithfully-applied prompt would have re-introduced the drift it existed to remove. Confirm the Figma side still reads as the prompt said; on a mismatch **stop**, don't commit, and report what Figma says now. Otherwise expect clean, or rows you can explain. `⚠ incomplete — Figma unread` is **not** a pass — the Figma side didn't load (usually rate limiting) and the story was never checked; re-run it. With **Both modes** ticked, confirm the report doesn't say the mode comparison was not performed.
3. Deliver as a PR — one PR per component (or one PR for the token change). Tell the user the PR number, the change list from step 2 classified additive/modified/breaking, every call site a breaking change touches, and anything from step 3 you preserved or flagged as conflicting. Never make the user run a CLI command.

## When to refuse

If the delta is large enough that the component's identity changed — different structure, different purpose, most variants replaced — say so and recommend a fresh `component-handoff` with the old file archived. Patching a component into a different component produces worse code than regenerating it honestly.

## Working rules ⚙ DRAFT (defaults — leads may change)

- **Breaking changes**: report every call site; write the codemod only when the change is a pure rename with no semantic shift (e.g. `variant="subtle"` → `variant="ghost"`). Anything that changes meaning gets a migration note in the PR body and a human decides per call site.
- **Token-layer PRs**: this skill is the sanctioned path for editing theme/token files (`fix-drift` deliberately escalates instead). A token PR needs review from the **design lead** (the values are theirs) and the **engineering lead** (the blast radius is theirs). Never merge one on a single approval.
- **Removed variants**: deprecate rather than delete — keep the variant working, add a deprecation comment naming the replacement, and list the call sites to migrate. Delete in a follow-up once call sites are clear. Exception: if the variant has zero call sites, remove it immediately and say so.
- **Batch size**: one PR per component. A whole-library restyle is one token PR plus, at most, one PR per component that still drifts after it. Never one giant PR — it's unreviewable and unrevertable.
- **Renames**: when the design renames a component, keep the code file name and add a note; renaming files breaks imports for no design benefit. Flag it for the leads instead.
