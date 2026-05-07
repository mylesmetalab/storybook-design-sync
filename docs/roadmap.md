# Roadmap

v0 is intentionally narrow: read-only, one engine, one click, one story.
The list below is the prioritized post-v0 work, one PR per item. Priority
is by *(user value) ÷ (effort)*; items below `#5` only earn their keep
once the tool is in daily use.

| #  | Title                                              | Why                                                           |
| -- | -------------------------------------------------- | ------------------------------------------------------------- |
| 1  | ✅ `feat: story-declared token bindings`            | Flips ~6 `flag-only` rows per story to real signal. (Downmark#13, addon v0.0.2) |
| 1.5| ✅ `feat: inherit COMPONENT_SET bindings`           | When a variant is registered, padding/radius bindings live on the parent. Engine now fetches parent and merges. (addon v0.0.3) |
| 2  | `feat: dual-mode drift detection`                  | Today only the rendered theme is compared; dark-mode drift is invisible. |
| 3  | `refactor: smarter default snapshot target`        | The single-child walker fails on multi-child story roots; current escape hatch is per-story config. |
| 4  | `feat: hash-based skip path (lastSyncedHash)`      | Re-checking unchanged stories should be ~free.                |
| 5  | `fix: structured variant comparison`               | Multi-property variants (`State=Active, IsDirty=False`) lose meaning when collapsed to a string set. |
| 6  | `chore: registry-seeding script`                   | Walks Figma + Storybook `index.json`, best-effort matches names. |
| 7  | `feat: real diff for copy / props`                 | Two flag-only kinds get implementations.                      |
| 8  | `feat: syncything engine adapter`                  | Validates the multi-engine premise.                           |
| 9  | `feat: listen + apply proposedEdit`                | Today the addon lists `proposedEdit` events read-only; v1 routes them to a write-capable engine. |
| 10 | `feat: CI runner`                                  | Block PRs that introduce drift.                               |

## Done in #1 (the marker for each PR's "definition of done")

- All registered stories have ≤2 `flag-only` token-binding rows after
  declaring `parameters.designSync.tokens`.

## Done in #2

- A drift introduced *only* in dark mode is reported.

## Done in #3

- The AiPopover-style story works without `parameters.designSync.target`.

## Done in #4

- Re-clicking Check drift on an unchanged story is sub-50ms.

## Done in #5

- A `State=Active, IsDirty=False` story compared to `State=Active, IsDirty=True`
  reports drift on `IsDirty` only.

## Done in #6

- A fresh consumer with 30 components gets a registry stub in <1 minute.

## Done in #7

- IconButton's `iconName="arrowRight"` (code) vs `Type="Cross 2"` (Figma
  instance default) is reported by the `props` dimension.

## Done in #8

- Setting `"engine": "syncything"` in config produces equivalent reports
  without hitting Figma REST.

## Done in #9

- A `proposedEdit` from `storybook-design-inspector` can be applied via
  the Sync panel.

## Done in #10

- Adding `scripts/check-drift.ts` to a GitHub Actions workflow blocks
  merging PRs with token drift.

## Execution rules

- One PR per row. Don't bundle.
- Each PR ships its own doc update under `docs/`.
- Don't reorder past #5 — items 6-10 each depend on the addon's contract
  being stable.
- Stop at PR #5 if the tool isn't being used daily.
