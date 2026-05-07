# Roadmap

The original v0 was intentionally narrow: read-only, one engine, one click,
one story. Since then the project has grown to a three-repo bidirectional
system. This list tracks shipped vs. remaining work.

See [`design-sync-pipeline/ARCHITECTURE.md`](https://github.com/mylesmetalab/design-sync-pipeline/blob/main/ARCHITECTURE.md)
for how the pieces fit together.

## Shipped

| #  | Title                                              | Where                                                          |
| -- | -------------------------------------------------- | -------------------------------------------------------------- |
| 0  | ✅ v0 walking skeleton                             | addon v0.0.1 (initial release)                                 |
| 0a | ✅ React 19 / esbuild bundling fix                 | addon v0.0.2                                                   |
| 1  | ✅ Story-declared token bindings                   | addon v0.0.2 + Downmark#13                                     |
| 1.5| ✅ Inherit COMPONENT_SET bindings into variants    | addon v0.0.4                                                   |
| 5  | ✅ Structured variant comparison                   | addon v0.0.5                                                   |
| 2  | ✅ Dual-mode drift detection (slim — read mode)    | addon v0.0.6                                                   |
| 3  | ✅ Smarter default snapshot target                 | addon v0.0.7                                                   |
| 7a | ✅ Real diff for the `copy` dimension              | addon v0.0.8                                                   |
| 7b | ✅ Real diff for the `props` dimension             | addon v0.0.9                                                   |
| 2.5| ✅ Full dual-mode (toggle theme, dual snapshot)    | addon v0.0.10                                                  |
| 9a | ✅ Apply button → POST to pipeline (code dir.)     | addon v0.0.11 + pipeline v0.0.1                                |
| 9b | ✅ Pipeline queue endpoint for figma-scope edits   | pipeline v0.0.2                                                |
| 9c | ✅ design-sync-figma-plugin v0.0.1                 | new repo — closes bidirectional loop via Plugin API            |
| 9d | ✅ Apply scope toggle (code vs figma)              | addon v0.0.12                                                  |
| 9e | ✅ Clearer Apply labels ("Update code"/"…Figma")   | addon v0.0.13                                                  |

## Open

| #  | Title                                              | Why                                                            |
| -- | -------------------------------------------------- | -------------------------------------------------------------- |
| 4  | `feat: hash-based skip path (lastSyncedHash)`     | Re-checking unchanged stories should be ~free at scale.        |
| 6  | `chore: registry-seeding script`                   | Walks Figma + Storybook `index.json`, best-effort matches.     |
| 8  | `feat: Apply for dual-mode rows`                   | Today only single-mode rows are auto-fixable. Need to flatten `{light, dark}` value maps into per-mode Edits. |
| 9f | `feat: figma-rest-write engine (variable values)` | Complement to the plugin's binding writes. For drift like "the value of `radius/lg` should be 8 not 6". |
| 9g | `feat: Baluarte engine adapter`                    | AST-aware code edits. Sits next to the regex CSS swapper.       |
| 10 | `feat: CI runner`                                   | Block PRs that introduce drift.                                |
| 11 | `feat: per-row undo`                                | After a successful Apply, store the inverse Edit and offer "Undo". |
| 12 | `feat: real-time push from Figma`                   | Webhook or polling so drift checks don't have to be manual.     |

## Architecture decisions worth keeping

- **Three sibling repos, one engine adapter contract.** Front doors (addon,
  plugin) talk to a pipeline. Pipeline talks to engines. Each layer is
  swappable.
- **Pipeline is localhost-only, no auth.** Single-user dev tool. Network
  exposure / multi-user is later.
- **Read-only by default.** Both the pipeline (`writeEnabled` flag) and the
  Figma plugin ("Apply for real" checkbox) ship dry-run as the first-touch
  experience. Real writes are explicit opt-in.
- **No coupling to Syncything.** The sync pipeline replaces Syncything; the
  two don't share code or config.

## Stop conditions

- Stop at item #4 if the tool isn't being used daily on Downmark.
- Items 6/9f/9g/10/11/12 are nice-to-have; daily use will tell you which.
