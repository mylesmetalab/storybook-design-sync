# Roadmap

> **Two things to know before reading, both decided after most of this was written.**
>
> **1. v1 ships detection, not mutation** (2026-07-27). "One click in either
> direction" below describes the original intent; a full source review found every
> silent failure mode in the suite living on the write path while detection came
> back clean. Writes are gated behind `apply: "off"` (the default) and the fix
> prompt *is* the write path — a complete instruction handed to a human or an
> agent, applied as a reviewable diff. The pipeline and Figma plugin are parked.
>
> **2. The suite is consumer-agnostic.** It was originally built against one
> private consumer, and that coupling was removed. Some **shipped-log rows below
> still name `mde` / `Downmark#NN`** — those are historical records of which PR
> landed which change and are kept for provenance, not because the tool knows
> anything about that project. Nothing in the codebase does. Do not add
> consumer-specific behaviour; consumer specifics belong in that consumer's
> `design-sync.config.json` or its team's skills.

## Intent

A bidirectional design-system sync layer that treats Figma as a peer
source of truth alongside code. Designers and developers stay aligned
without manual transcription.

Three sub-goals shape every choice:

1. **Catch divergence early.** Drift between Figma and code shows up on
   the next Check, not three sprints later.
2. **Make the right thing easy.** One click in either direction — no
   "open an issue, hand-edit CSS / hand-edit Figma" loop.
3. **Match the design model 1:1.** Figma's component-variant abstraction
   is the design source of truth. Code should mirror it in shape, not
   flatten it through cascade tricks that obscure the mapping.

Implicit but load-bearing: **be honest.** No false-positive drift, no
broken Update buttons, no UI that advertises features that aren't built.
Trust in the report matters as much as the report existing.

**Consumer-agnostic by mandate** (decided 2026-07-27). The suite carries no
assumptions about any single codebase. It was originally built against one
private consumer; that coupling was removed and must not return. The reference
consumer is now `design-sync-starter`, which exists to be replaceable.

See [`design-sync-pipeline/ARCHITECTURE.md`](https://github.com/mylesmetalab/design-sync-pipeline/blob/main/ARCHITECTURE.md)
for how the three repos (addon, pipeline, figma-plugin) fit together.

## Shipped

The original v0 was intentionally narrow: read-only, one engine, one click,
one story. The project has since grown into a three-repo bidirectional
system. Highlights of the work already done:

| #   | Title                                              | Where                                       |
| --- | -------------------------------------------------- | ------------------------------------------- |
| 0   | v0 walking skeleton                                | addon v0.0.1                                |
| 1   | Story-declared token bindings                      | addon v0.0.2 + Downmark#13                  |
| 1.5 | Inherit COMPONENT_SET bindings into variants       | addon v0.0.4                                |
| 5   | Structured variant comparison                      | addon v0.0.5                                |
| 2   | Dual-mode drift detection (slim — read mode)       | addon v0.0.6                                |
| 3   | Smarter default snapshot target                    | addon v0.0.7                                |
| 7a  | Real diff for the `copy` dimension                 | addon v0.0.8                                |
| 7b  | Real diff for the `props` dimension                | addon v0.0.9                                |
| 2.5 | Full dual-mode (toggle theme, dual snapshot)       | addon v0.0.10                               |
| 9a  | Apply button → POST to pipeline (code direction)   | addon v0.0.11 + pipeline v0.0.1             |
| 9b  | Pipeline queue endpoint for figma-scope edits      | pipeline v0.0.2                             |
| 9c  | `design-sync-figma-plugin` v0.0.1                  | new repo — closes the bidirectional loop    |
| 9d  | Apply scope toggle (code vs figma)                 | addon v0.0.12                               |
| 9e  | Clearer Apply labels ("Update code" / "…Figma")    | addon v0.0.13                               |
| S1  | Bulk Check drift + summary table                   | addon v0.0.14                               |
| S2  | In-memory cache for Figma fetches                  | addon v0.0.15                               |
| S3  | Visible perf stats in panel + bulk header          | addon v0.0.16                               |
| S4  | Windows build fix (spawn shell)                    | addon v0.0.17                               |
| S5  | Registry-seeding script                            | pipeline v0.0.3                             |
| S6  | Inspector edits → Staged edits bridge              | addon v0.0.18                               |
| S7  | Per-row undo                                       | addon v0.0.19                               |
| S8  | Apply on dual-mode rows when modes agree           | addon v0.0.20                               |
| S9  | `figma-rest-write` engine (variable values)        | pipeline v0.0.4                             |
| S10 | Row collapse + Value/Wiring split                  | addon v0.0.21                               |
| S11 | Token-name normalization (no false-drift on convention) | addon v0.0.21                          |
| S12 | Engine vocabulary expanded (gap, color, font-\*, borders, shadow) | addon v0.0.21               |
| S13 | TEXT-descendant binding bubble                     | addon v0.0.21                               |
| S14 | Value-drift "Use token" Apply path                 | addon v0.0.21 + pipeline                    |
| S15 | Plugin handles paint / effect / TEXT-descendant binds | figma-plugin                             |
| S16 | Stale check on Figma writes                        | figma-plugin                                |
| S17 | Auto-recheck after successful Apply                | addon                                       |
| S18 | Longhand `border-radius` corners across the consumer | consumer                                 |
| P1.1 | Auto-derive tokens from CSS (kill the third copy) | addon v0.0.23 + Downmark#21                |
| P1.2 | PostCSS AST code-write engine (replace regex swap) | pipeline v0.0.8                            |
| H1   | Bulk drift export + Apply-all (dry-run default)    | addon #27                                   |
| H2   | Bulk Check all honors "Both modes" + drift-engine honesty pass (mode default, gap normal, transparent guards, alpha-1, lineHeight AUTO, border-edge, primary-text-node heuristic) | addon #27 |
| H3   | Read-only-by-default actually enforced end-to-end (pipeline writeEnabled flipped, figma-rest-write honors dryRun, plugin checkbox is a ceiling not an override) | pipeline #10 + figma-plugin #4 |
| H4   | Inline-style binding scan — preview reads `var(--token)` refs directly from `el.style`, no PostCSS file needed | addon #27 |
| H5   | Cross-repo audit docs caught up to reality (plugin README's real property surface, pipeline ARCHITECTURE.md's correct engine roster) | figma-plugin #3 + pipeline #9 |
| H6   | Inline-scanner compound values + shorthand normalization (`borderBottom: "1px solid var(--x)"`, `border-bottom-color` → `border-color`) | addon #27 |
| H7   | `code-tsx-inline` write engine — closes the Apply-all loop on inline-styled codebases. Mirrors `code-css-postcss` semantics on JSX `style={{ … }}` expressions via ts-morph AST. | pipeline #11 |
| P1.3 | Shared types + helpers package `@metalab/design-sync-core` — one `Edit`/`EditResult` wire contract + `normalizeTokenName`/`tokenNameToCssVar`/`deriveSelectorChain`/`isSingleValue`, imported by all three repos (local copies deleted). Plugin gained the typed contract (20 sites got the required `EditResult.id`); addon's selector fallback went 1→4 levels (verified no-op on mde's 154 selectors). | core v0.0.1 + addon #37 (v0.0.24) + pipeline #12 (v0.0.9) + plugin #7 (v0.0.3) |

## Active roadmap

The product is roughly 75% built, 60% honest. The 25% gap is the
unfinished dimensions and architectural shortcuts. The honesty gap is
the source of most friction — features that get advertised in the UI
but reject on Apply.

Phases are sequential. Each phase makes the next cheaper; running them
in parallel re-creates the incremental-fix problem.

### Phase 1 — Foundation (3.5–4.5 days)

Architectural moves everything else depends on. Removes whole categories
of bug; finishing unfinished features afterwards becomes much cheaper.

| #     | Title                                                   | Done when                                                                                   | Effort |
| ----- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| ~~P1.1~~ | ~~Auto-derive tokens from CSS (kill the third copy)~~ | ✅ Shipped — addon v0.0.23, mde stories codemodded (Downmark#21).                          | 1d   |
| ~~P1.2~~ | ~~PostCSS-based code-write engine (replace regex swap)~~ | ✅ Shipped — pipeline v0.0.8. Regex engine deleted, AST engine has 21 unit tests, stale-check tightened. | 2d   |
| ~~P1.3~~ | ~~Shared types + normalizers package~~                  | ✅ Shipped — `@metalab/design-sync-core` v0.0.1; addon v0.0.24 / pipeline v0.0.9 / plugin v0.0.3 import it, local copies deleted. | 0.5d   |
| ~~P1.4~~ | ~~Move code writes from pipeline into addon preset~~    | ✅ Shipped — addon v0.0.25 (#38) + v0.0.26 (#39). The preset applies code-scope edits in-process via the pipeline's full engine roster (css + tsx-inline + tsx-text); pipeline binary only needed for Figma writes. Consumer sets `codeTargets` in design-sync.config.json (Downmark#27). | 0.5–1d |
| ~~P1.5~~ | ~~Drift-engine honesty pass~~ | ✅ Shipped — addon #27. Bulk Check all now honors "Both modes", `findFirstTextNode` prefers alphanumeric labels over single-glyph children, border read from drawn edge (not always `border-top-*`), mode-detection no longer guesses "light" on missing attribute, `gap: normal` / transparent / `rgba(R,G,B,1)` / Figma `lineHeight: AUTO` all stop producing false-positive drift. | 1d |
| ~~P1.6~~ | ~~Inline-style binding scan (read side of P5.2)~~ | ✅ Shipped — addon #27. Preview's `snapshotElement` now reads `var(--token)` references directly from `el.style` and synthesizes bindings. Token-binding rows populate on codebases that style inline without any consumer config. | 0.5d |

### Phase 2 — Finish the dimensions (~7.5 days)

Make every row in the panel honest. No Apply buttons on rows the engine
can't fulfil.

| #     | Title                                       | Done when                                                                                | Effort |
| ----- | ------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| ~~P2.1~~ | ~~Finish `copy` dimension end-to-end~~      | ✅ Shipped — addon v0.0.26 (#39) + pipeline v0.0.10 (#13, `code-tsx-text` w/ 10 tests) + plugin v0.0.4 (#8, `applyCopyEdit`) + Downmark#27 (codeTargets). Code side E2E-verified on a real mde component (apply/stale/undo); Figma side verified to the queue-drain protocol — the in-Figma `characters` write itself still needs a manual pass with the plugin open in Figma desktop. TSX codeTargets are explicit paths until P4.3 (globs). | 2d  |
| ~~P2.2~~ | ~~Finish `props` dimension~~                | ✅ Shipped (scoped) — "no Apply button it can't honor" is now a tested invariant (`row-triage.test.ts`: props/variant-set drift always partitions to info). Advisory names the exact prop/value and both fixes. **Prop-default auto-writes deliberately deferred:** the props diff (story args vs bound variant's props) has no unambiguous write target — arg? registry binding? Figma default? — so auto-applying would guess. Revisit if/when the diff reads `componentPropertyDefinitions` defaults on SET-bound stories. | 1d |
| ~~P2.3~~ | ~~`variant-set` Apply~~                     | ✅ Shipped as honest advisory — the generic "no auto-apply engine yet" line replaced with per-shape, data-driven guidance (active-variant: names the missing Figma variants + BEM fix; variant-options: names the unknown code modifiers + both fixes). Real auto-edit rejected on honesty grounds: which side is wrong isn't inferable from the diff (empty CSS rule / deleting a Figma variant = a guess; see P3.1). | 0.5d   |
| P2.4  | `story.structure` engine                    | "auto-layout horizontal in Figma, code uses column" surfaces as a drift row.              | 2d     |
| P2.5  | `story.motion` engine                       | Figma prototype animations vs CSS transitions/animations compare honestly.                | 1.5d   |
| P2.6  | Wire `lastSyncedHash`                       | Field has a purpose. Panel shows "last synced X ago". CI can skip-if-unchanged.           | 0.5d   |
| ~~P2.7~~ | ~~Compare forced pseudo-states~~ | ✅ Shipped — v0.0.47 (#91). A registry `states` map binds a pseudo-state to the design's node for it, and the rendered element is measured **in that state**. Page JS cannot fire a real `:hover`, so the stylesheet is rewritten (`.btn:hover` gains `.btn.pseudo-hover`) and the class toggled — measured identical to a real pointer and to CDP `CSS.forcePseudoState`, and being pure DOM/CSS it behaves the same in the panel and in `check`, so the two agree by construction. Transitions are **suspended**, not waited out, because a mid-transition read returns the interpolated value and makes a correctly-forced state look unchanged. Vocabulary is forced pseudo-states only: a design's `State=Error`/`Open`/`Checked` is a prop and binds as its own story. Four things are refused rather than approximated — forcing that moved nothing, a state the component library owns via `data-*`, a run that also asked for two modes, and a story with no `states` map. Rows carry the state, not a fake element (`{"element": null, "state": "hover"}`). **Modes × states is not combined** and `focus` has no design source in the reference file. | 2d |

### Phase 3 — Codebase parity (~2.5 days)

Apply per-variant-explicit uniformly across the consumer so the engine never has
to special-case cascade.

| #     | Title                                                    | Done when                                                              | Effort |
| ----- | -------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| P3.1  | Per-variant-explicit codemod for remaining ~9 components | Each variant rule redeclares all design-token-bound properties.        | 1.5d   |
| P3.2  | Cascade fallback decision                                | Keep + document as adoption-friendly graceful mode. Not removed.       | 0.5d   |
| P3.3  | Auto-recheck timing polish                               | Debounce rapid Apply clicks so we don't re-check N times in a row.     | 0.5d   |

### Phase 4 — New capabilities (~4.5 days)

Things the intent calls for that aren't here yet.

| #     | Title                          | Done when                                                                | Effort |
| ----- | ------------------------------ | ------------------------------------------------------------------------ | ------ |
| ~~P4.1~~ | ~~CI integration~~          | ✅ Shipped — v0.0.45. `design-sync check` drives the consumer's own Storybook preview in headless Chromium and reuses the panel's request builder, engine, triage and budgets; verified row-for-row identical to a panel `Check all` over the reference consumer. Four exit codes (`0` clean / `1` drift / `2` coverage incomplete / `3` could not run), `--json` + `--out`, `--story`/`--component`/`--both-modes`. PR-comment-shaped **markdown** is still panel-only (`Export markdown`); the CLI emits JSON. | 1.5d |
| P4.2  | Edit audit log                 | `.design-sync/audit.json` persists every Apply. `design-sync undo --last` works. | 1d |
| P4.3  | Multi-file CSS / glob targets  | PostCSS engine handles multiple parse units; `codeTargets` accepts globs. | 1d     |
| P4.4  | Coverage matrix view           | Panel tab showing all registered stories × last drift status.            | 1d     |

### Phase 5 — Portability (~8–10 days, scope-dependent)

Largely overtaken by events: Tailwind/`cva()` scanning shipped in v0.0.32 and
the reference consumer is a Tailwind + shadcn project, so "works on any
codebase" is no longer a stretch goal but the baseline. What remains here is
CSS-in-JS runtime themes.

| #     | Title                              | Done when                                                            | Effort |
| ----- | ---------------------------------- | -------------------------------------------------------------------- | ------ |
| P5.1  | Tailwind engine                    | Drift Apply works on a Tailwind-class project, no `.css` files needed. | 2–3d  |
| P5.2  | CSS-in-JS engine                   | JS AST rewrites styled-components / emotion / vanilla-extract calls. | 3–4d   |
| ~~P5.3~~ | ~~Documented setup for new projects~~ | ✅ Shipped — v0.0.46, and as a command rather than a walkthrough. `design-sync init` detects the project (Storybook version, Tailwind generation, the `@theme` file, the component directory, the project's own story globs), registers both addons by **merging** into `main.*`, writes a config with `apply: "off"`, gitignores the cache, and copies the six workflow skills where absent. It refuses to invent a `fileKey`, to overwrite anything the user wrote, to generate the inspector's manifest, or to make the token-alignment and `copy` judgements — and it always ends with the steps that remain, numbered and in order, because a partial init reported as success is the failure mode. | 1d |
| P5.4  | Tokens.json roundtrip              | Watch local tokens file → push value changes back to Figma variables. | 2d    |

## Totals

| Phase                  | Days       | What you get                                                  |
| ---------------------- | ---------- | ------------------------------------------------------------- |
| 1 — Foundation         | 3.5–4.5    | Honest, robust core. Regex fragility gone. Metadata lie gone. |
| 2 — Finish dimensions  | 7.5        | Every panel row fully functional or honestly hidden.          |
| 3 — Codebase parity    | 2.5        | The consumer matches the design model 1:1.                    |
| 4 — New capabilities   | 4.5        | CI, audit, multi-file support, coverage view.                 |
| 5 — Portability        | 8–10 (opt) | Works on Tailwind / CSS-in-JS / any codebase.                 |
| **Total Phases 1–4**   | **~18d**   | Full system, single-consumer scope.                           |
| **Total all phases**   | **~26–28d**| Plus portable.                                                |

## Execution principles

1. **One phase at a time.** Don't start Phase 2 work until Phase 1 is
   shipped. Parallel work re-creates incremental-patch problem.
2. **Each item has an acceptance test before it's done.**
3. **Hide before deleting.** If a feature isn't ready, flag-gate it
   (`parameters.designSync.experimental: true`) so the default UI is
   honest while the code stays in the tree.
4. **No new dimensions or features until existing ones are honest.**
   Resist the urge to add the sixth kind while the fifth's Apply rejects.
5. **Refactor the engine before adding more cases to it.** If P1.2
   (PostCSS) isn't done, don't add new code-write features.

## Architecture decisions worth keeping

- **Three sibling repos, one engine adapter contract.** Front doors
  (addon, plugin) talk to a pipeline. Pipeline talks to engines. Each
  layer swappable.
- **Pipeline is localhost-only, no auth.** Single-user dev tool. Network
  exposure / multi-user is later.
- **Read-only by default.** Both the pipeline (`writeEnabled` flag) and
  the Figma plugin ("Apply for real" checkbox) ship dry-run as the
  first-touch experience. Real writes are explicit opt-in.
- **Cascade fallback stays.** Keeps the addon usable on day 1 against
  any CSS shape, not just per-variant-explicit ones. Adoption-friendly.

## Stop conditions

- Stop after Phase 1 if the system feels complete enough as-is — the
  detection half is the real value, write-back is the bonus.
- Phase 5 is opt-in, and partly delivered early: Tailwind support shipped in
  v0.0.32 because the reference consumer needed it.
