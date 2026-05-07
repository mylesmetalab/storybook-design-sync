# Roadmap

v0 is intentionally narrow: read-only, one engine, one click, one story.
The list below is the prioritized post-v0 work, one PR per item. Priority
is by *(user value) ÷ (effort)*; items below `#5` only earn their keep
once the tool is in daily use.

| #  | Title                                              | Status                                                        |
| -- | -------------------------------------------------- | ------------------------------------------------------------- |
| 1  | ✅ `feat: story-declared token bindings`            | Downmark#13, addon v0.0.2                                     |
| 1.5| ✅ `feat: inherit COMPONENT_SET bindings`           | addon v0.0.4                                                  |
| 2  | ✅ `feat: dual-mode drift detection (slim)`         | addon v0.0.6                                                  |
| 2.5| ✅ `feat: dual-mode drift detection (full)`         | addon v0.0.10 — toggles theme + dual snapshot + per-mode merge |
| 3  | ✅ `refactor: smarter default snapshot target`      | addon v0.0.7                                                  |
| 4  | `feat: hash-based skip path (lastSyncedHash)`      | open — perf at scale                                          |
| 5  | ✅ `fix: structured variant comparison`             | addon v0.0.5                                                  |
| 6  | `chore: registry-seeding script`                   | open — useful when a 2nd repo joins                           |
| 7  | ✅ `feat: real diff for copy / props`               | addon v0.0.8 (copy) + v0.0.9 (props)                          |
| 8  | `feat: sync-pipeline engine adapter`               | open — depends on the sibling repo (replaces Syncything)       |
| 9  | `feat: listen + apply proposedEdit`                | open — depends on a write-capable engine (8)                  |
| 10 | `feat: CI runner`                                  | open — depends on stable contract (likely after 4)             |

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
