# @metalab/storybook-design-sync

> **Part of the design-sync system** —
> [`addon`](https://github.com/mylesmetalab/storybook-design-sync) ·
> [`pipeline`](https://github.com/mylesmetalab/design-sync-pipeline) ·
> [`figma-plugin`](https://github.com/mylesmetalab/design-sync-figma-plugin) ·
> [architecture](https://github.com/mylesmetalab/design-sync-pipeline/blob/main/ARCHITECTURE.md)

A Storybook 10 addon that detects drift between a story and its Figma
counterpart, and surfaces it as a per-dimension diff table inside a Storybook
panel.

The addon is the *surface*. The thing that computes drift is an *engine*
behind a small adapter interface. v0 ships one engine — `figma-rest` — that
calls the Figma REST API directly. Future engines (a local daemon called
Syncything; a SQLite-backed tool called Baluarte) slot in by implementing
the same interface.

## What v0 does

- Adds a **Sync** panel to every story
- "Check drift" button runs the configured engine for the current story
- Renders a table: `dimension | property | code value | figma value | status`
- Real diffs for: `token-value` (color, padding, radius), `token-binding`,
  `variant-set`
- Reserved as `flag-only` placeholders: `copy`, `props`, `structure`,
  `motion` (engines fill in over time)
- Listens for `design-sync:proposedEdit` events from sibling addons (e.g.
  `storybook-design-inspector`) and shows them read-only in a "Staged edits
  (v1)" section. v0 never writes — anywhere.

## Install

```sh
npm i -D @metalab/storybook-design-sync
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
      // Optional: CSS selector for the element to snapshot. Defaults to
      // walking #storybook-root → first non-branching descendant.
      target: ".icon-button",
      // Optional: declare which tokens the component intends to use, so
      // the engine can compare bindings without DOM annotations.
      tokens: {
        "background-color": "color/accent/blue",
        "padding-top": "space/8",
        "padding-right": "space/8",
        "padding-bottom": "space/8",
        "padding-left": "space/8",
        "border-radius": "radius/xl",
      },
    },
  },
};
```

Both fields are optional. Without `target`, the addon walks `#storybook-root`
down through single-child wrappers. Without `tokens`, the addon reads
`data-token-*` attributes on the snapshotted element.

## How code-side values are read

The preview hook reads:

- a small set of computed CSS properties (background, padding, border
  radius, color, font-*)
- `data-token-*` attributes (e.g. `data-token-background-color="color/accent/blue"`)
- `parameters.designSync.tokens` declared in the story
- BEM-style modifier classes (anything containing `--`) for variant diffs

If the registry doesn't list the current story, the panel shows:
> Not registered. Add this story to `.design-sync/registry.json`.

## Mode-aware tokens

Color variables are resolved with both Light and Dark modes preserved
end-to-end in the `DriftReport`. v0 only displays them; v1 (writes) needs
them.

## Example: a real diff report

```
Drift report — node 37:30 — 5:31:55 PM

Dimension       Property                Code              Figma                         Status
token-value     background-color        rgb(37,99,235)    rgb(37,99,235)                match
                                                          light: rgb(37,99,235) ·
                                                          dark: rgb(96,165,250)
token-value     padding-top             8px               8px (token: space/8)          match
token-value     padding-right           8px               8px (token: space/8)          match
token-value     padding-bottom          8px               8px (token: space/8)          match
token-value     padding-left            8px               8px (token: space/8)          match
token-value     border-top-left-radius  8px               6px (token: radius/lg)        drift
token-value     border-top-right-rad…   8px               6px (token: radius/lg)        drift
token-value     border-bottom-left-…    8px               6px (token: radius/lg)        drift
token-value     border-bottom-right-…   8px               6px (token: radius/lg)        drift
variant-set     active-variant          ["accent"]        ["accent"]                    match
copy            story.copy              —                 —                             flag-only
props           story.props             —                 —                             flag-only
structure       story.structure         —                 —                             flag-only
motion          story.motion            —                 —                             flag-only
```

The four `border-*-radius` rows above are a real finding: code uses
`var(--radius-xl)` (8px) but the Figma variant binds to `radius/lg` (6px).
Either the design or the code is wrong.

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
