# Roadmap

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

Stretch goal: **portable to other codebases.** Primary mission is mde,
but the system should outlive a single project.

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
| S18 | Longhand `border-radius` corners across mde        | mde                                         |
| P1.1 | Auto-derive tokens from CSS (kill the third copy) | addon v0.0.23 + Downmark#21                |
| P1.2 | PostCSS AST code-write engine (replace regex swap) | pipeline v0.0.8                            |

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
| P1.3  | Shared types + normalizers package                      | One `Edit` definition, one `normalizeTokenName`, imported by all three repos.               | 0.5d   |
| P1.4  | Move CSS writes from pipeline into addon preset         | Update code works without the pipeline binary running. Pipeline only needed for Figma writes. | 0.5–1d |

### Phase 2 — Finish the dimensions (~7.5 days)

Make every row in the panel honest. No Apply buttons on rows the engine
can't fulfil.

| #     | Title                                       | Done when                                                                                | Effort |
| ----- | ------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| P2.1  | Finish `copy` dimension end-to-end          | A Figma copy change can be one-clicked into the JSX literal on the component, or vice versa. | 2d  |
| P2.2  | Finish `props` dimension                    | No row shows an Apply button it can't honor. Figma-side Apply for prop defaults; advisory on code side. | 1d |
| P2.3  | `variant-set` Apply                         | Either real auto-edit or honest advisory, never generic reject.                           | 0.5d   |
| P2.4  | `story.structure` engine                    | "auto-layout horizontal in Figma, code uses column" surfaces as a drift row.              | 2d     |
| P2.5  | `story.motion` engine                       | Figma prototype animations vs CSS transitions/animations compare honestly.                | 1.5d   |
| P2.6  | Wire `lastSyncedHash`                       | Field has a purpose. Panel shows "last synced X ago". CI can skip-if-unchanged.           | 0.5d   |

### Phase 3 — Codebase parity (~2.5 days)

Apply per-variant-explicit uniformly across mde so the engine never has
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
| P4.1  | CI integration                 | `design-sync check` CLI exits non-zero on drift, outputs PR-comment-shaped markdown. | 1.5d |
| P4.2  | Edit audit log                 | `.design-sync/audit.json` persists every Apply. `design-sync undo --last` works. | 1d |
| P4.3  | Multi-file CSS / glob targets  | PostCSS engine handles multiple parse units; `codeTargets` accepts globs. | 1d     |
| P4.4  | Coverage matrix view           | Panel tab showing all registered stories × last drift status.            | 1d     |

### Phase 5 — Portability (~8–10 days, scope-dependent)

Stretch goal — tackle only if Design Sync is used on non-mde projects.

| #     | Title                              | Done when                                                            | Effort |
| ----- | ---------------------------------- | -------------------------------------------------------------------- | ------ |
| P5.1  | Tailwind engine                    | Drift Apply works on a Tailwind-class project, no `.css` files needed. | 2–3d  |
| P5.2  | CSS-in-JS engine                   | JS AST rewrites styled-components / emotion / vanilla-extract calls. | 3–4d   |
| P5.3  | Documented setup for new projects  | README walkthrough — install, seed, configure, point pipeline.       | 1d     |
| P5.4  | Tokens.json roundtrip              | Watch local tokens file → push value changes back to Figma variables. | 2d    |

## Totals

| Phase                  | Days       | What you get                                                  |
| ---------------------- | ---------- | ------------------------------------------------------------- |
| 1 — Foundation         | 3.5–4.5    | Honest, robust core. Regex fragility gone. Metadata lie gone. |
| 2 — Finish dimensions  | 7.5        | Every panel row fully functional or honestly hidden.          |
| 3 — Codebase parity    | 2.5        | mde matches design model 1:1.                                 |
| 4 — New capabilities   | 4.5        | CI, audit, multi-file support, coverage view.                 |
| 5 — Portability        | 8–10 (opt) | Works on Tailwind / CSS-in-JS / any codebase.                 |
| **Total Phases 1–4**   | **~18d**   | Full system, mde-scoped.                                      |
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
- Phase 5 is opt-in. Only do it if Design Sync is actually being used
  on non-mde projects.
