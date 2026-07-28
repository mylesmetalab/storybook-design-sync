# @metalab/storybook-design-sync

> **Part of the design-sync system** —
> [`addon`](https://github.com/mylesmetalab/storybook-design-sync) ·
> [`pipeline`](https://github.com/mylesmetalab/design-sync-pipeline) ·
> [`figma-plugin`](https://github.com/mylesmetalab/design-sync-figma-plugin) ·
> [architecture](https://github.com/mylesmetalab/design-sync-pipeline/blob/main/ARCHITECTURE.md)

A Storybook 10 addon that detects drift between a story and its Figma
counterpart and surfaces it as a per-dimension diff table. v1 is
**audit-only by default**: the panel reports drift and hands you a
ready-to-paste fix prompt per row; one-click writes (in either
direction) are opt-in via `apply: "experimental"`.

The addon is the *surface*. Drift detection runs through an engine adapter
(today: `figma-rest`). When writes are enabled, code-scope edits are applied
in-process by the addon's Node server (PostCSS / TSX engines, no extra
binary needed); Figma-scope edits go through the
[`design-sync-pipeline`](https://github.com/mylesmetalab/design-sync-pipeline)
server ([Figma plugin](https://github.com/mylesmetalab/design-sync-figma-plugin)
for binding writes, REST for variable values).

## What it does

- Adds a **Sync** panel to every story.
- **Check drift** runs the engine for the current story.
- **Check all** runs every registered story sequentially with a summary
  table (match / drift / flag-only counts, perf stats, click to drill in).
- One row per property with a **Value** status pill — does Figma resolve
  to the same px / color as the rendered CSS? The panel reports current
  state only. (The former **Wiring** column — declared-token vs
  declared-token comparison, i.e. "will the code follow when the token's
  value changes" — was removed in v0.0.29: it answers a hypothetical
  future question and belongs to a separate static/contract checker.
  Token-binding detection still runs under the hood and powers Apply
  buttons and fix prompts.)
- Properties compared today: `background-color`, `padding-*` (×4),
  `border-*-radius` (×4), `gap`, `border-width`, `border-color`, `color`,
  `font-size`, `font-weight`, `font-family`, `font-style`, `line-height`,
  `letter-spacing`, `text-transform`, `text-decoration-line`, `text-align`,
  `box-shadow`. Diff dimensions: `token-value`, `token-binding`,
  `variant-set`, `copy`, `props`. (`structure`, `motion` reserved.)
  `opacity` is snapshotted but not yet compared.
- **No row rather than a wrong row.** Where a faithful comparison isn't
  available, the property is skipped instead of guessed. Documented cases:
  Figma small-caps (an OpenType feature, not a `text-transform`);
  percent letter-spacing with no font size to resolve it against;
  `text-align` when Figma states none (a hug-width label's placement is the
  parent auto-layout's business) or when the text hugs both axes; shadows
  with a blend mode CSS can't express or a colour that can't be read; a
  Figma text case whose rendered effect depends on how the label is literally
  typed. `font-style` reads Figma's `italic` flag, never the `fontStyle`
  variable (which holds a weight+slant style *name*).
- **Figma component properties vs story args.** BOOLEAN properties
  (`Has Icon Start` ↔ `iconStart`) are matched on a normalized name and
  compared against the arg's truthiness; TEXT properties defer to the `copy`
  dimension when they'd report the same string twice; INSTANCE_SWAP is
  surfaced as unmodelled rather than compared. An ambiguous or missing arg
  correspondence produces no row, and a disagreement with a component
  *default* (rather than an INSTANCE's actual value) is informational, never
  drift.
- **Whole-component comparison** via declared child bindings. A story can bind
  inner elements to their own Figma nodes (`"children": { "[data-slot=header]":
  "2142:11381" }`), so a composed component's header, body, label and icon are
  compared too instead of only its root element. Rows are grouped per element,
  root first. Every binding that can't be compared — selector matched nothing,
  matched several things, isn't valid CSS, or names an unreachable Figma node —
  is reported by name with zero rows, so a clean table never implies coverage it
  doesn't have. See [Child bindings](#child-bindings--checking-the-whole-component-not-just-its-root).
- **Token-name normalization.** `radius/xl` ≡ `radius-xl` ≡ `--radius-xl`.
  Token-binding comparison doesn't false-flag drift on a naming
  convention difference.
- **Copy fix prompt** on every drift row (in both apply modes): copies a
  self-contained prompt — story, file paths or selector, property, current
  vs expected value, token name and `var(--token)` form, Figma refs, and
  closing instructions — ready to paste to a coding agent or teammate.
- **Apply controls are gated** by the `apply` config field:
  - `"off"` (default) — audit-only. Full drift detail and advisories,
    no write buttons anywhere.
  - `"experimental"` — enables the write surface (labeled as such):
    - `Update code` / `Update Figma` for token-binding drift.
    - `Use token` on value drift (rewrites the literal in CSS to `var(--token)`).
    - Success shows `↶ undo` for one-click revert.
    - **Stale check.** Figma writes refuse if the binding has moved since
      the drift snapshot — re-run Check drift, try again.
    - **Auto-recheck after Apply.** A successful write triggers a fresh
      drift check so subsequent clicks operate on current data.
    - **Preview all (dry-run)** / **Apply for real** bulk actions on the
      Check-all summary.
- **Both modes** checkbox runs dual-mode comparison; rows where light
  and dark agree are still fixable.
- Listens for `storybook-design-inspector` `STYLE_UPDATE` events and
  surfaces them in the **Staged edits** panel. The section is part of the
  write surface, so it only renders with `apply: "experimental"` — in
  `apply: "off"` it is hidden entirely.

## Install

```sh
npm i -D mylesmetalab/storybook-design-sync#v0.0.28
```

In `.storybook/main.ts`:

```ts
const config = {
  addons: ["@metalab/storybook-design-sync"],
  // ...
};
```

## Configure

`design-sync.config.json` at repo root (JSON only — there is no `.ts`
config; the addon runs in Storybook's Node process, which can't import
TypeScript config files):

```json
{
  "engine": "figma-rest",
  "registryPath": ".design-sync/registry.json",
  "fileKey": "YOUR_FIGMA_FILE_KEY",
  "apply": "off"
}
```

All fields except `fileKey` are optional:

| Field | Default | What it does |
| --- | --- | --- |
| `fileKey` | *(required)* | The Figma file key drift checks run against (from the file's URL: `figma.com/design/<fileKey>/...`). |
| `apply` | `"off"` | Write gating. `"off"` = audit-only panel (drift detail, advisories, and Copy fix prompt, but no write buttons). `"experimental"` = enables the Apply / Preview-all / bulk-apply write surface, labeled experimental. |
| `engine` | `"figma-rest"` | Drift-engine adapter name. |
| `registryPath` | `".design-sync/registry.json"` | Where the story ↔ Figma-node registry lives. |
| `codeTargets` | `[]` | Files the addon may **write** when applying a code-scope edit in-process, e.g. `[{ "path": "src/components/Button.css" }, { "path": "src/components/Button.tsx" }]`. Required for `apply: "experimental"` code writes (`.css` → PostCSS token swaps, `.tsx`/`.jsx` → inline-style and JSX-text edits); with an empty list, code-scope applies are rejected with a "configure codeTargets" message. Also used by fix prompts to name the files involved. |
| `cssEntries` | `["src/**/*.css"]` | Globs (relative to the Storybook host's cwd) for the CSS files the startup scanner **reads** to derive `selector → token` bindings. |
| `tsxEntries` | `["src/**/*.tsx"]` | Globs for `.tsx` files the scanner reads to extract inline-style token bindings (`style={{ paddingTop: "var(--space-4)" }}`). Set explicitly when components live in a sibling package. |
| `storyGlobs` | `src/**/*.stories.*`, `stories/**/*.stories.*` | Where the CLI looks for stories (see [CLI](#cli)). |

`.design-sync/registry.json` maps story IDs to Figma node IDs:

```json
{
  "fileKey": "YOUR_FIGMA_FILE_KEY",
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

### Child bindings — checking the whole component, not just its root

A drift check snapshots **one** element per story: the story root. On a Button
that is nearly the whole component. On a Card, Dialog or form field it is not —
header padding, nested label typography, icon sizing and body spacing are all
unchecked, so a clean report means *"the root element matches"*, not *"the
component matches"*.

Declare the inner elements you want compared, and each one is checked against
its own Figma node:

```json
{
  "fileKey": "YOUR_FIGMA_FILE_KEY",
  "stories": {
    "ui-card--default": {
      "nodeId": "2142:11380",
      "lastSyncedHash": null,
      "children": {
        "[data-slot=header]": "2142:11381",
        "[data-slot=body]":   "2142:11382"
      }
    }
  }
}
```

- Selectors are resolved **inside the story root**, descendants only.
- Every property that works for the root works for a child (padding, per-corner
  radii, borders, gap, the full typography set, `box-shadow`, colours, plus
  `token-binding` and `copy`). `variant-set` and `props` are reported once for
  the root, where a variant identity actually exists — a child element is not a
  variant of anything.
- The panel groups rows per element, root first, each group labelled with the
  selector and the Figma node's name.
- `children` is optional. An entry without it behaves exactly as before: no
  extra requests, no extra rows.

Add bindings from the CLI:

```sh
npx design-sync register --story ui-card--default \
  --child "[data-slot=header]=2142:11381" \
  --child "[data-slot=body]=2142:11382"
```

**Why declared and not inferred.** Matching code children to Figma children by
document order or by name would be a heuristic, and a mis-paired element yields
drift numbers that are real but describe a different element — the worst failure
mode this addon has. So the pairing is authored once, per component, and
reviewed like any other committed file. (Suggesting pairings at *registration*
time, for a human to approve, is possible future work; it is not built.)

**A binding that can't be compared is never silent.** Each of these produces a
visible, named message in the panel (and in the exported markdown report) with
**zero** rows for that element, so a green table can't imply coverage it
doesn't have:

| Situation | What you see |
| --- | --- |
| Selector matched nothing | `Not compared — child binding \`…\` on story \`…\` matched no element inside the story root.` Plus a note when the story root itself matches it (child selectors only see descendants). |
| Selector matched more than one element | `Not compared — … matched N elements …` with the candidate elements listed. The addon never picks the first. |
| Selector isn't valid CSS | `Not compared — … is not a valid CSS selector (…)` |
| `children` value isn't a node-id string | `Not compared — … is malformed: …` |
| Declared Figma node id doesn't exist or isn't readable | `Not compared — Figma node \`…\` could not be read (…)`. The selector resolved; the Figma side did not. |
| The preview reported no result for a declaration | `Not compared — no snapshot arrived for …` (usually a stale preview bundle; restart Storybook.) |

**Cost.** All bound children are fetched in **one** batched
`GET /files/:key/nodes?ids=…` request — a 3-child component adds exactly one
HTTP call, and none at all when the node cache is warm.

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

Fields the addon reads from `parameters.designSync`:

- `target` *(string)* — CSS selector for the element to snapshot. The only
  field most stories need.
- `pipelineUrl` *(string, default `http://127.0.0.1:7099`)* — where the
  [`design-sync-pipeline`](https://github.com/mylesmetalab/design-sync-pipeline)
  server listens. Only used for **Figma-scope** writes (`apply:
  "experimental"`) and staged-edit applies; drift checks and in-process
  code writes never touch it. Set it globally in `.storybook/preview.ts`
  (`parameters: { designSync: { pipelineUrl: "http://127.0.0.1:7099" } }`)
  if your pipeline runs on a non-default port.
- `modeAttribute` *(string, default `data-theme`)* — attribute on `<html>`
  that carries the active theme mode name, used by mode-aware and
  dual-mode checks.
- `tokens` — deprecated, see below.

`target` is the only field most stories need. The addon's PostCSS scanner
runs once at Storybook startup and builds a map of `selector → { CSS
property → token name }` from the consumer's CSS, then looks up the
story's `target` to find its bindings (with cascade fallback — `.icon-button--accent`
falls back to `.icon-button` when a property isn't redeclared on the variant rule).

Where the CSS lives is configured by `cssEntries` in `design-sync.config.json`
(default: `["src/**/*.css"]`).

`target` is also how you point at **portalled** content and how you resolve an
ambiguous story root — see [Portalled components](#portalled-components-dialog-popover-tooltip-select).

### Tailwind / shadcn / cva consumers

If your components style themselves with utility classes rather than
`var(--token)` declarations, `target` is usually **unnecessary** — there is no
stable class to point at, because the utilities *are* the styling. The scanner
instead reads your `cva()` calls and matches them to a story by the story id's
component segment plus the story's `args`:

```
ui-button--primary   →  component "button"  →  src/components/ui/button.tsx
args { variant: "primary", size: "medium" }  →  the cva slots that applied
```

So `bg-primary` in the `variant.primary` slot becomes
`background-color → primary` for the `Primary` story and nothing at all for the
`Neutral` one. Anything the theme can't vouch for (arbitrary values, `p-3` under
the `--spacing` multiplier, Tailwind defaults like `bg-transparent`) produces no
binding rather than a guess. Full rules, including the complete "produces
nothing" table, are in
[design-sync-core's README](https://github.com/mylesmetalab/design-sync-core#tailwind-utility--token-mapping-v002).

**State modifiers are resolved, not blanket-ignored.** The bindings describe the
state the story renders in, because that is what the snapshot measures:

- `hover:`, `focus-visible:`, `active:` — provably off (nothing forces them), so
  they contribute nothing.
- `data-disabled:` / `disabled:` / `aria-disabled:` — applied when the story's
  `disabled` arg is set, and they outrank the variant slot's own classes. A
  `PrimaryDisabled` story reports `background-color → disabled` via
  `data-disabled:bg-disabled`, not `primary`.
- `dark:` — resolved from the active mode when your stories set one
  (`modeAttribute`); left unbound when they don't.
- breakpoints, `[&_svg]:`, other `data-*`/`aria-*` hooks — unknowable, so the
  property is left unbound rather than answered from the unmodified class.

Requirements:

- **Tailwind v4 CSS-first theme.** The scanner reads `@theme` blocks out of your
  `cssEntries`. A v3 `tailwind.config.js` scale is not evaluated, so a v3
  consumer gets no Tailwind bindings.
- **`tsxEntries` must cover your components** (default `["src/**/*.tsx"]`).
- **One component per name.** If two scanned `cva()` components answer to the
  same name, the addon derives nothing for that story and says so in the panel —
  rename one, or narrow `tsxEntries`.

The startup log tells you what it found:

```
[design-sync] Scanned 1 CSS + 1 TSX file(s); derived bindings for 4 selector(s)
  (css: 0, tsx: 0, tailwind-cva: 4 scope(s) across 1 component(s) [button]);
  Tailwind @theme vars: 37.
```

A `tailwind-cva` count of 0 with a non-zero `@theme vars` count means the classes
were read but none of them resolved to a consumer token — check whether your
components use arbitrary values or Tailwind's default scale.

### Portalled components (Dialog, Popover, Tooltip, Select)

Radix and Base UI render overlay content into `document.body`, outside
`#storybook-root`. The addon looks for open portalled content — an ARIA overlay
role, Base UI's `data-open`, Radix's `data-state="open"`, or a known portal
container — and snapshots it when the story root holds nothing but the trigger.

It will **not** guess. Two situations are reported as errors rather than resolved:

- more than one portalled overlay is open; or
- the story root contains an element matching the story name **and** an overlay
  is open outside it (the usual trigger-plus-popup shape).

Both are fixed by saying which element you mean:

```ts
export const Open: StoryObj<typeof Dialog> = {
  parameters: {
    // Queried against the whole document, so it reaches portalled content.
    designSync: { target: '[role="dialog"]' },
  },
};
```

or by putting `data-design-sync-target` on the element itself. (Two elements
carrying that attribute is likewise reported, not guessed.)

**State forcing is not needed for arg-driven states.** A story arg that the
component forwards to the DOM produces the real attribute — `disabled: true` on a
Base UI Button renders `data-disabled`, so `data-disabled:bg-disabled` applies
and `getComputedStyle` reads the true disabled paint. Pseudo-states (`hover`,
`focus-visible`) cannot be expressed as args and are not snapshotted; force those
in the Design Inspector instead.

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
- token bindings derived from Tailwind utility classes at startup (`cva()` calls
  and literal `className` attributes in `tsxEntries`, keyed by component +
  story args — see above)
- `data-token-*` attributes (e.g. `data-token-background-color="color/accent/blue"`)
  on the snapshotted element (overrides per-element only)
- `parameters.designSync.tokens` declared in the story *(deprecated — see above)*
- BEM-style modifier classes (anything containing `--`) for variant diffs

Where a binding came from a utility class, the row's **Copy fix prompt** names
that class (`swap `bg-primary` for the utility whose theme variable resolves to
`--color-x``) instead of telling a Tailwind codebase to write a CSS declaration
it has nowhere to put.

If the registry doesn't list the current story, the panel shows:
> Not registered. Add this story to `.design-sync/registry.json`.

### Color folding

Figma always arrives as `rgb()`/`rgba()`, but the browser returns whatever
color space the author wrote. Before comparing, both sides fold to
`rgb(R,G,B)` (or `rgba(R,G,B,A)` below full opacity): `rgb()`/`rgba()`, 3-, 4-,
6- and 8-digit hex, and the modern spaces `oklch()`, `oklab()` and
`color(display-p3 …)`.

`oklch()` matters in particular — **shadcn / Tailwind v4 themes ship `oklch()`
by default** and `getComputedStyle` returns it verbatim, so without the
conversion a *correct* themed color would be reported as drift on every check.
Conversion is OKLab → linear sRGB → sRGB transfer function → 8-bit, clamped for
out-of-gamut values; comparison is exact at 8-bit with no epsilon. Anything
still unrecognised is compared as a whitespace-stripped lowercase string, as
before.

## CLI

The package ships a `design-sync` binary with four subcommands:

```
design-sync audit                       Diff stories on disk against the registry
design-sync register [--hints <path>]   Bulk-register from hints; stub the rest
design-sync ls                          Print title → node binding tree
design-sync export-graph --format json|dot
                                        Emit the binding graph for docs / visualizations
```

All subcommands accept `--stories <glob>` (repeatable). When `--stories`
isn't passed, the CLI uses `storyGlobs` from `design-sync.config.json`,
falling back to `src/**/*.stories.*` and `stories/**/*.stories.*`. In
monorepos where stories live in sibling packages, set the config field
so the bare commands work without flags:

```json
{
  "fileKey": "...",
  "storyGlobs": [
    "../../packages/*/src/**/*.stories.@(ts|tsx)",
    "src/stories/**/*.stories.@(ts|tsx)"
  ]
}
```

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

It also validates the **shape** of every entry's `children` map and lists any
malformed ones (non-object `children`, non-string node ids, empty selectors, an
empty map), exiting non-zero when it finds one. It explicitly does **not** check
that a selector resolves or that a node id exists — audit has no DOM and makes no
Figma calls — and it says so in its output rather than letting a green run imply
otherwise. Run **Check drift** in Storybook for that; it reports both, per
binding.

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

**Declaring child bindings.** `--child "<selector>=<nodeId>"` (repeatable, and
scoped to one story with `--story`) adds or updates the entry's `children` map:

```sh
npx design-sync register --story ui-card--default \
  --child "[data-slot=header]=2142:11381" \
  --child "[data-slot=body]=2142:11382"
```

The split is on the **last** `=`, so an attribute selector needs no escaping.
The story must already be registered against a real Figma node — a child binding
needs a parent binding to hang off. `--dry-run` previews without writing.
`ls` prints declared child bindings nested under their story.

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

Property                 Code              Figma                          Value   Apply
background-color         rgb(37,99,235)    rgb(37,99,235)                 match   —
                                            light: rgb(37,99,235) ·
                                            dark:  rgb(96,165,250)
padding-top              8px               8px (token: space/8)           match   —
padding-right            8px               8px (token: space/8)           match   —
padding-bottom           8px               8px (token: space/8)           match   —
padding-left             8px               8px (token: space/8)           match   —
border-top-left-radius   8px               6px (token: radius/lg)         drift   Use token
border-top-right-radius  8px               6px (token: radius/lg)         drift   Use token
border-bottom-left-…     8px               6px (token: radius/lg)         drift   Use token
border-bottom-right-…    8px               6px (token: radius/lg)         drift   Use token
gap                      8px               4px (token: space/4)           drift   Use token
font-size                13px              13px (token: typography/ui/13) match   —
color                    rgb(31,30,30)     rgb(31,30,30)                  match   —
active-variant           ["accent"]        ["accent"]                     match   —
```

The four `border-*-radius` rows above are a real finding: code uses
`var(--radius-xl)` (8px) but the Figma variant binds to `radius/lg` (6px).
Either the design or the code is wrong. With the default `apply: "off"`,
each row's **Copy fix prompt** hands the fix to a coding agent; with
`apply: "experimental"`, **Use token** rewrites the CSS literal to
`var(--radius-lg)` in one click without leaving Storybook.

## What this addon is NOT

- Not a CLI. The addon IS the surface.
- Not coupled to a specific engine. The figma-rest engine is one of many
  future engines.
- Not coupled to a specific consumer stack. The diff is dimension-shaped,
  not framework-shaped.
- Not the inspector. A sibling addon does live token inspection. This addon
  detects and (optionally, behind `apply: "experimental"`) syncs.

## Roadmap

See [`docs/roadmap.md`](docs/roadmap.md) for the prioritized list of post-v0
work, one PR per item.

## License

MIT
