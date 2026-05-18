# @metalab/storybook-design-sync

> **Part of the design-sync system** —
> [`addon`](https://github.com/mylesmetalab/storybook-design-sync) ·
> [`pipeline`](https://github.com/mylesmetalab/design-sync-pipeline) ·
> [`figma-plugin`](https://github.com/mylesmetalab/design-sync-figma-plugin) ·
> [architecture](https://github.com/mylesmetalab/design-sync-pipeline/blob/main/ARCHITECTURE.md)

A Storybook 10 addon that detects drift between a story and its Figma
counterpart, surfaces it as a per-dimension diff table, and lets you fix
drift in either direction with one click.

The addon is the *surface*. Drift detection runs through an engine adapter
(today: `figma-rest`); writes go through the [`design-sync-pipeline`](https://github.com/mylesmetalab/design-sync-pipeline)
orchestrator + engines (CSS token swap for code, [Figma plugin](https://github.com/mylesmetalab/design-sync-figma-plugin)
for binding writes, REST for variable values).

## What it does

- Adds a **Sync** panel to every story.
- **Check drift** runs the engine for the current story.
- **Check all** runs every registered story sequentially with a summary
  table (match / drift / flag-only counts, perf stats, click to drill in).
- One row per property with two status pills:
  - **Value** — does Figma resolve to the same px / color as the rendered CSS?
  - **Wiring** — does the code declare the same design token as Figma, so
    the code follows automatically when the token's value changes?
- Properties compared today: `background-color`, `padding-*` (×4),
  `border-*-radius` (×4), `gap`, `border-width`, `border-color`, `color`,
  `font-size`, `font-weight`, `font-family`, `font-style`, `line-height`,
  `letter-spacing`, `text-transform`, `text-decoration`, `text-align`,
  `box-shadow`. Diff dimensions: `token-value`, `token-binding`,
  `variant-set`, `copy`, `props`. (`structure`, `motion` reserved.)
- **Token-name normalization.** `radius/xl` ≡ `radius-xl` ≡ `--radius-xl`.
  Wiring doesn't false-flag drift on a naming convention difference.
- **Apply** column on every fixable row:
  - `Update code` / `Update Figma` for wiring drift.
  - `Use token` on value drift (rewrites the literal in CSS to `var(--token)`).
  - Success shows `↶ undo` for one-click revert.
- **Stale check.** Figma writes refuse if the binding has moved since the
  drift snapshot — re-run Check drift, try again. Avoids stomping on
  changes you made manually.
- **Auto-recheck after Apply.** A successful write triggers a fresh
  drift check so subsequent clicks operate on current data.
- **Both modes** checkbox runs dual-mode comparison; rows where light
  and dark agree are still fixable.
- Listens for `storybook-design-inspector` `STYLE_UPDATE` events and
  surfaces them in the **Staged edits** panel.

## Install

```sh
npm i -D mylesmetalab/storybook-design-sync#v0.0.21
```

In `.storybook/main.ts`:

```ts
const config = {
  addons: ["@metalab/storybook-design-sync"],
  // ...
};
```

## Configure

`design-sync.config.json` at repo root:

```json
{
  "engine": "figma-rest",
  "registryPath": ".design-sync/registry.json",
  "fileKey": "XgZr68XNB9lc3Lh6yUZZjU"
}
```

`.design-sync/registry.json` maps story IDs to Figma node IDs:

```json
{
  "fileKey": "XgZr68XNB9lc3Lh6yUZZjU",
  "stories": {
    "atoms-iconbutton--accent": {
      "nodeId": "37:30",
      "lastSyncedHash": null
    }
  }
}
```

To find the right `nodeId`, open the variant in Figma and copy its node-id
from the URL (`?node-id=37-30` → `"37:30"`). Map to the **specific variant**,
not the `COMPONENT_SET` parent — variant-level fills/bindings differ.

Set the Figma Personal Access Token in your environment:

```sh
export FIGMA_PAT=figd_xxx
```

The PAT is read from `process.env.FIGMA_PAT` in the Storybook Node process.
It is never logged, never persisted.

> **Variables endpoint requires Figma Enterprise.** Without it, the engine
> falls back to raw fill colors — fine for `token-value` color diffs, but
> `token-binding` rows degrade to `flag-only`.

## Per-story configuration

The addon reads `parameters.designSync` on each story:

```ts
export const Accent: StoryObj<typeof IconButton> = {
  args: { iconName: "arrowRight", variant: "accent" },
  parameters: {
    designSync: {
      // CSS selector for the element to snapshot. The scanner uses this
      // same selector to look up the component's token bindings.
      target: ".icon-button--accent",
    },
  },
};
```

`target` is the only field most stories need. The addon's PostCSS scanner
runs once at Storybook startup and builds a map of `selector → { CSS
property → token name }` from the consumer's CSS, then looks up the
story's `target` to find its bindings (with cascade fallback — `.icon-button--accent`
falls back to `.icon-button` when a property isn't redeclared on the variant rule).

Where the CSS lives is configured by `cssEntries` in `design-sync.config.json`
(default: `["src/**/*.css"]`).

> **Deprecated:** `parameters.designSync.tokens` (a hand-maintained map from
> CSS property → token name) is still accepted for one release for backwards
> compat, but logs a deprecation warning in the manager console. CSS-derived
> bindings take precedence where they exist. The field will be removed in v0.1.

## How code-side values are read

The preview hook reads:

- a small set of computed CSS properties (background, padding, border
  radius, color, font-*)
- token bindings derived from the consumer's CSS at startup (PostCSS scan
  of `cssEntries`, keyed by the story's `target` selector)
- `data-token-*` attributes (e.g. `data-token-background-color="color/accent/blue"`)
  on the snapshotted element (overrides per-element only)
- `parameters.designSync.tokens` declared in the story *(deprecated — see above)*
- BEM-style modifier classes (anything containing `--`) for variant diffs

If the registry doesn't list the current story, the panel shows:
> Not registered. Add this story to `.design-sync/registry.json`.

## CLI

The package ships a `design-sync` binary with four subcommands:

```
design-sync audit                       Diff stories on disk against the registry
design-sync register [--hints <path>]   Bulk-register from hints; stub the rest
design-sync ls                          Print title → node binding tree
design-sync export-graph --format json|dot
                                        Emit the binding graph for docs / visualizations
```

All subcommands accept `--stories <glob>` (repeatable; defaults cover
`src/**/*.stories.*` and `stories/**/*.stories.*`).

### `audit` — surface drift, fail CI

In-panel "Not registered" only fires when a designer happens to open
the story. `audit` walks every story file, derives the canonical id,
and diffs against `.design-sync/registry.json`:

```sh
npx design-sync audit
```

Reports Missing (in code, unregistered), Extra (registered, no matching
story), and Pending (registered but no Figma binding assigned). Exits
non-zero when Missing or Extra is non-empty so it composes with CI:

```yaml
- name: design-sync audit
  run: npx design-sync audit
```

**Story id formula** (matches `@storybook/csf` `toId`):

```
sanitize(title) + "--" + sanitize(storyNameFromExport(exportName))
```

So `title: "Molecules/RowBoolean"` + `export const CheckedTrueStateDefault`
→ `molecules-rowboolean--checked-true-state-default`.

> **Discovery is regex-based.** Files with no detectable `title:` are
> surfaced as parse warnings rather than silently skipped.

### `register` — bulk-register from a hints file

Going from 0 → N registry entries by hand is tedious. Provide a hints
file (`.design-sync/hints.json` by default) mapping story id → Figma
node id; `register` reads it, adds real entries for matched stories,
and writes `pending` stubs for everything else:

```json
{
  "molecules-rowboolean--checked-true-state-default": "72:588",
  "molecules-rowboolean--checked-true-state-hover":   "72:595"
}
```

```sh
npx design-sync register --dry-run    # preview
npx design-sync register              # write
```

Existing registry entries are never overwritten — `register` only adds.

### Pending stubs

Stories that don't yet have a Figma counterpart can be expressed
honestly in the registry:

```json
"molecules-rowfoo--default": {
  "nodeId": null,
  "lastSyncedHash": null,
  "status": "pending"
}
```

The panel surfaces these as "Pending — Figma binding not assigned" instead
of attempting a drift check. `audit` counts them separately from Missing
so the registry can reflect "I know about this story, the binding is
intentionally absent" without being treated as drift.

### Component-set coverage warnings

When the registered node is a `COMPONENT_SET` (rather than a specific
variant), the drift report's variant-set row includes a warning naming
the first variant Figma would otherwise use, so it's clear that
value/binding diffs are running against the set root and not a pinned
variant.

## Mode-aware tokens

Color variables are resolved with both Light and Dark modes preserved
end-to-end in the `DriftReport`. v0 only displays them; v1 (writes) needs
them.

## Example: a real diff report

```
Drift report — node 37:30 — 5:31:55 PM

Property                 Code              Figma                          Value   Wiring   Apply
background-color         rgb(37,99,235)    rgb(37,99,235)                 match   match    —
                                            light: rgb(37,99,235) ·
                                            dark:  rgb(96,165,250)
padding-top              8px               8px (token: space/8)           match   match    —
padding-right            8px               8px (token: space/8)           match   match    —
padding-bottom           8px               8px (token: space/8)           match   match    —
padding-left             8px               8px (token: space/8)           match   match    —
border-top-left-radius   8px               6px (token: radius/lg)         drift   match    Use token
border-top-right-radius  8px               6px (token: radius/lg)         drift   match    Use token
border-bottom-left-…     8px               6px (token: radius/lg)         drift   match    Use token
border-bottom-right-…    8px               6px (token: radius/lg)         drift   match    Use token
gap                      8px               4px (token: space/4)           drift   match    Use token
font-size                13px              13px (token: typography/ui/13) match   match    —
color                    rgb(31,30,30)     rgb(31,30,30)                  match   match    —
active-variant           ["accent"]        ["accent"]                     match            —
```

The four `border-*-radius` rows above are a real finding: code uses
`var(--radius-xl)` (8px) but the Figma variant binds to `radius/lg` (6px).
**Use token** rewrites the CSS literal to `var(--radius-lg)` in one click.
Either the design or the code is wrong — the Apply column resolves it
without leaving Storybook.

## What this addon is NOT

- Not a CLI. The addon IS the surface.
- Not coupled to a specific engine. The figma-rest engine is one of many
  future engines.
- Not coupled to a specific consumer stack. The diff is dimension-shaped,
  not framework-shaped.
- Not the inspector. A sibling addon does live token inspection. This addon
  only commits/syncs; v0 doesn't even commit yet.

## Roadmap

See [`docs/roadmap.md`](docs/roadmap.md) for the prioritized list of post-v0
work, one PR per item.

## License

MIT
