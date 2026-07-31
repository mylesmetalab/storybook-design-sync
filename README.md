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
  table (match / drift / advisory / flag-only counts, perf stats, click to
  drill in). The header says how many stories were actually **checked** —
  a story that timed out is reported as timed out, never counted as
  checked. The run's shared Figma fetch (variables + file metadata) happens
  once, before the first story, so the first story is not charged for
  warming the cache every other story reads.
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
  `box-shadow`, `opacity`, and the four layout properties (`flex-direction`,
  `justify-content`, `align-items`, `flex-wrap` — only where both sides really
  lay out children). Diff dimensions: `token-value`, `token-binding`,
  `variant-set`, `copy`, `props`, `structure`. (`motion` reserved.)
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
- **Token-name normalization.** `radius/xl` ≡ `radius-xl` ≡ `--radius-xl`
  (and `Body/Font Weight Regular` ≡ `body-font-weight-regular`).
  Token-binding comparison doesn't false-flag drift on a naming
  convention difference.
- **`advisory` — a name divergence is not drift.** When the code and the
  Figma library name the same decision differently in a way normalization
  can't collapse (`primary` vs `color/background/brand/default`) and the
  **values match**, the row is an advisory: visible, carrying both names and
  the exact `tokenAliases` entry that would settle it, but never red, never
  counted as drift, never offered a fix prompt. A divergence with no value
  comparison behind it is reported as `unverified` — not a match either.
  See [`tokenAliases`](#tokenaliases--when-figma-and-your-theme-name-the-same-token-differently).
- **Fix prompts state the layer.** A drifted row where the code already
  binds the token Figma binds and only its *value* moved is a **token-layer**
  finding: the prompt names the theme token and the design variable, says a
  token PR needs design-system sign-off, and proposes no class swap or
  literal. A prompt never names a Figma-side variable as if it were a
  code-side target.
- **Copy fix prompt** on every drift row (in both apply modes): copies a
  self-contained prompt — story, file paths or selector, property, current
  vs expected value, token name and `var(--token)` form, Figma refs, and
  closing instructions — ready to paste to a coding agent or teammate.
  A row whose **siblings drifted to the same value** says so inside the
  prompt (`padding-right`, `padding-bottom` and `padding-left` have also
  drifted to `Space/150`…), so one row handed over on its own can't produce
  the 6/12/12/12 padding nobody designed.
- **Copy fix prompt for all drift (N)** above the table: ONE prompt covering
  every drifted row in the story, with related properties grouped as single
  changes (the four paddings, the four corner radii, the per-edge border
  colours, `font-size`/`line-height`). This is the default path; the per-row
  buttons remain for when you deliberately want one thing. Rows that aren't
  code fixes are listed separately — see the next two bullets — and the
  prompt tells the agent not to act on them.
- **One table, ordered by what the finding is.** Detached Figma values first,
  then value drift, then rows needing a judgement call (`props` /
  `variant-set` advisories), then unset/unreadable, then matches. There is no
  "manual fix" collapse: it partitioned on whether a *write engine* could
  apply the row, which in the default `apply: "off"` is nothing at all — so
  its header was false and it buried real findings under trivial matches.
- **`not bound in Figma`** is a first-class row state. When a designer
  detaches a property from its variable and types a literal, the row says so
  and its prompt routes the work to Figma — it never tells you to hardcode
  the literal or to retune a theme token to match it.
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
- **Both modes** checkbox runs dual-mode comparison: the story is snapshotted
  once per mode and each snapshot is compared against that mode's Figma value.
  Rows where light and dark agree are still fixable. The theme switch is
  verified — if flipping it changes nothing on screen, the panel says the
  comparison was **not performed** instead of comparing one mode twice. See
  [`modeSwitch`](#per-story-configuration).
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
| `codeTargets` | `[]` | The files this component's code lives in. Two accepted shapes, mixable: a **glob/path string** (`"src/components/ui/**/*.tsx"`) or an **object** (`{ "path": "src/Button.css", "scopeSelector": ".btn" }`). Fix prompts name these files, so this is worth setting even in audit-only mode. For `apply: "experimental"` code writes (`.css` → PostCSS token swaps, `.tsx`/`.jsx` → inline-style and JSX-text edits) the entry must be a **concrete path** — the write engines open the file, so a glob is refused with a message saying so. An empty list rejects code-scope applies with a "configure codeTargets" message. Anything that is neither shape is a config error naming the offending entry (it used to become a silent `undefined` in every fix prompt). |
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
HTTP call, and none at all when the node cache is warm during a **Check all**
run (see below).

### `tokenAliases` — when Figma and your theme name the same token differently

A design system and a codebase often name the same decision differently: Figma
calls it `color/background/brand/default`, the theme calls it `primary`.
`normalizeTokenName` collapses separators and case, but it cannot bridge
genuinely different vocabularies — so the binding comparison reports a
divergence that is not a defect.

Declare the equivalence and the addon stops guessing:

```json
{
  "tokenAliases": {
    "color/background/brand/default": "primary",
    "color/border/brand/default": "border-brand"
  }
}
```

Keys are **Figma variable names**, values are **your project's token names**.
The map is consulted *before* the heuristic, and the panel reports which
mechanism resolved a name — `alias` (you declared it) or `heuristic` (we
guessed) — so a reader knows how much to trust the match.

Defaults to `{}`, which is the heuristic alone. An unusable entry is rejected
loudly and by name: an alias map exists to *suppress* a row, so a silently
ignored entry is the worst possible failure — you would believe you had told
the addon two names mean the same thing, the panel would keep reporting the
divergence, and nothing would explain why.

A divergence you have not aliased is reported as an **advisory**, not drift:
visible, carrying both names and the exact `tokenAliases` entry that would
settle it, but never red and never counted as drift when the two sides' values
agree.

### Caching, and why Check drift ignores it

Pressing **Check drift** is a request for the truth, so it always re-reads
Figma: this file's cached variables and nodes are dropped before the check
runs, and the on-disk report cache is not consulted. A dual-mode check
revalidates **once** per press, not once per mode.

**Check all** is the opposite case — one variables fetch serving ~90 stories is
the difference between a working bulk run and a wall of 429s — so it keeps the
in-memory caches, and additionally drops them whenever the file's
`lastModified` has moved since the last one it saw.

This matters because it used to be wrong: the variables cache carried a 5-minute
TTL justified by "variables are stable for the lifetime of a working session",
and v0.0.28's engine memoization turned that per-check cache into a cross-check
one. Change a token's value in Figma, press Check drift, and the panel could
confidently report `match` for up to five minutes. The report header's
`N cache hits / M misses` counters still describe real HTTP traffic — a dropped
entry shows up as a miss, never as a phantom hit.

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
  that carries the active theme mode name. Read on every check to resolve
  mode-aware Figma values, and treated as a declared switching mechanism for
  **Both modes** when you set it explicitly.
- `modeSwitch` — how **Both modes** flips the theme. `"class"`, `"attribute"`,
  or the object form `{ kind: "class" | "attribute", attribute?: string, on?:
  "html" | "body" }`. Set it when your project themes by class:

  ```ts
  // Tailwind v4 / shadcn: `@custom-variant dark (&:is(.dark *))`
  parameters: { designSync: { modeSwitch: { kind: "class", on: "html" } } }
  ```

  Leave it unset and the preview tries a mode-named class on `<html>` then
  `<body>`, then `data-theme` / `data-mode` / `data-color-scheme`, and uses
  whichever actually changes a computed colour. Whether declared or detected, a
  switch that changes nothing is reported as a mode comparison that did **not**
  happen (issue [#69]) — the run never compares one mode twice and calls it two.
  `setAttribute` cannot set a class, which is why `modeAttribute` alone could not
  cover this.
- `modes` *(`[string, string]`, default `["light", "dark"]`)* — the two mode names
  a **Both modes** check snapshots, for a project whose modes aren't called light
  and dark. Anything other than exactly two non-empty names is refused with a
  console warning rather than half-applied. Documented since the dual-mode
  comparison landed but sent by neither check path until v0.0.43 ([#80]), so a
  project on `["day", "night"]` was silently measured as light/dark.
- `tokens` — deprecated, see below.

`target` is the only field most stories need. The addon's PostCSS scanner
runs once at Storybook startup and builds a map of `selector → { CSS
property → token name }` from the consumer's CSS, then looks up the
story's `target` to find its bindings (with cascade fallback — `.icon-button--accent`
falls back to `.icon-button` when a property isn't redeclared on the variant rule).

Where the CSS lives is configured by `cssEntries` in `design-sync.config.json`
(default: `["src/**/*.css"]`).

`node_modules` is always ignored. `dist/` and `storybook-static/` are ignored **by
default only**: an entry that names one of them as a literal path segment
(`"storybook-static/**/*.css"`) opts in, because explicit configuration beats a
default. A broad entry that merely reaches build output (`"**/*.css"`) still skips
it — and logs `[design-sync] NOT SCANNED — …` at startup naming the directory, the
file count, example paths and the entry that would opt in. Nothing is suppressed
in silence: a scanner that derived nothing looks exactly like a codebase that
declares nothing.

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
  (`modeAttribute`, or the mode a **Both modes** pass is measuring); left unbound
  when they don't.
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

The id comes from the **export name**. A story's `name: "…"` annotation changes
only its display name, so `export const WithHeader` is `…--with-header` whether
or not it is named "With a header".

#### Discovery: autotitle, and what "unreadable" means

Stories are read with the installed Storybook's own machinery — `loadCsf` for
the exports and `getStoryTitle` for the title — so **CSF3 autotitle** files (no
`title:` in the meta; the title is derived from the file path) are discovered
with the title Storybook itself would give them. `storybook` is already a peer
dependency; nothing extra is installed. Because it is a real CSF parse rather
than a regex, `excludeStories` is honoured, type-only exports are not counted as
stories, and CSF factory files (`preview.meta({…})`) are read.

`storyGlobs` are the specifiers used for autotitle derivation, resolved
**relative to the consumer root** (Storybook's `main.ts` entries are relative to
`.storybook/`, so keep the two aligned in shape, not in spelling). A
`titlePrefix` in `main.ts` is not applied — `storyGlobs` is a list of plain
globs and cannot express one.

If Storybook can't be imported from the CLI, discovery falls back to a local
implementation of the same title algorithm plus a regex export reader, **and says
so in its output**. The fallback is unit-tested to produce the same titles as
`getStoryTitle`.

Any file that matches `storyGlobs` and yields **no story ids** is reported under
`UNREADABLE`, with the reason, and `audit` exits non-zero. That is deliberate: a
file the tool cannot read contains stories that nothing registers and nothing
checks, and a green CI over them is worse than a red one. `.mdx` files are
reported separately as contributing no story ids (Storybook indexes them as docs
entries) and do not fail the run.

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

[ Copy fix prompt for all drift (5) ]  one prompt for all 5 drifted rows —
related properties are described as one change each

Property                 Code              Figma                          Value                Fix / notes
border-color             rgb(221,221,221)  rgb(200,200,200)               not bound in Figma   Figma's value here is NOT bound to a variable…
border-top-left-radius   8px               6px (token: radius/lg)         drift                Copy fix prompt
border-top-right-radius  8px               6px (token: radius/lg)         drift                Copy fix prompt
border-bottom-left-…     8px               6px (token: radius/lg)         drift                Copy fix prompt
border-bottom-right-…    8px               6px (token: radius/lg)         drift                Copy fix prompt
gap                      8px               4px (token: space/4)           drift                Copy fix prompt
background-color         rgb(37,99,235)    rgb(37,99,235)                 match                —
                                            light: rgb(37,99,235) ·
                                            dark:  rgb(96,165,250)
padding-top              8px               8px (token: space/8)           match                —
padding-right            8px               8px (token: space/8)           match                —
padding-bottom           8px               8px (token: space/8)           match                —
padding-left             8px               8px (token: space/8)           match                —
font-size                13px              13px (token: typography/ui/13) match                —
color                    rgb(31,30,30)     rgb(31,30,30)                  match                —
active-variant           ["accent"]        ["accent"]                     match                —
```

Drift sorts to the top and matches to the bottom, in one table. The
`border-color` row is the most important line in that report — a designer
detached it from its variable — which is exactly why it is first and not
folded into a collapse.

The four `border-*-radius` rows are a real finding too: code uses
`var(--radius-xl)` (8px) but the Figma variant binds to `radius/lg` (6px).
Either the design or the code is wrong. With the default `apply: "off"`,
the bulk button hands all five rows to a coding agent as one change set (and
each row's **Copy fix prompt** hands over just that row, naming its
siblings); with
`apply: "experimental"`, **Use token** rewrites the CSS literal to
`var(--radius-lg)` in one click without leaving Storybook.

## Coverage and limits

What this addon does and does not detect, stated plainly. **If a change alters
anything in this section, the same PR updates it** — a limits list that drifts
from the code is worse than none, because it converts an honest gap into a
false promise.

**Compared today.** Background colour · all four paddings · all four corner
radii · all four border widths and colours · `gap` · text colour · font-size ·
font-weight · font-family · line-height · letter-spacing · text-align ·
text-transform · text-decoration · font-style · box-shadow (including
`INNER_SHADOW` → `inset`) · `opacity` · **layout: `flex-direction`,
`justify-content`, `align-items`, `flex-wrap`** · copy (text content) · Figma
variant axes · Figma component properties (BOOLEAN, TEXT).

**Layout (the `structure` dimension).** Figma auto-layout against computed CSS:
`layoutMode` → `flex-direction`, `primaryAxisAlignItems` → `justify-content`,
`counterAxisAlignItems` → `align-items`, `layoutWrap` → `flex-wrap`. Only the
enum values with a clean CSS equivalent are mapped (`MIN`/`CENTER`/`MAX`,
`SPACE_BETWEEN`, `BASELINE`, `NO_WRAP`/`WRAP`); anything else emits no row.

Every layout comparison is guarded, and the guard is the reason the dimension is
shown at all: **no row is emitted unless both sides are actually laying out
children** — Figma's `layoutMode` must be `HORIZONTAL` or `VERTICAL`, and the
computed `display` must be flex or grid. On a grid container `flex-direction` and
`flex-wrap` are not compared (they have no effect there). When the two sides'
primary axes don't correspond — Figma `VERTICAL` against a code `flex-direction:
row`, or any Figma `VERTICAL` against a grid — the alignment rows are reported as
`unresolved` with the reason instead of a coincidental match. A property the code
leaves at its default (`justify-content: normal`) is `flag-only`, never drift.

**Where a colour actually came from.** A fill delivered by a **shared paint
style** is compared and attributed like any other: Figma flattens the style's
paint into the node's own `fills` (variable binding included) and returns the
style's name alongside the node in the same request, so no extra call is made and
nothing is followed by hand. Three things are now said out loud:

- the row names the paint style that delivers the fill, so a fix is made in the
  style rather than on the node;
- a style whose paint carries no variable is reported as the design naming no
  token — not as a silent match;
- a style whose paint yields no readable colour at all (a gradient or image-only
  style) is `unresolved` with the reason, never `match` and never `flag-only`.

**Token tier (colour only).** When a fill binds a variable whose collection has a
single mode, **and** the same file themes colour in some other collection, the row
says so: that colour cannot follow the theme, and any multi-mode variable that
aliases it directly is named as the equivalent that can. Both halves are read from
the variables response. Nothing is inferred from a variable's *name* — a
single-mode collection is normal for Size, Radius and Typography, and normal for
colour too in a single-theme system, so in a file that themes no colour the tier
is undeterminable and nothing is said.

**Compared only where you declare it.**

- **Comparison is root-only until child bindings exist.** A drift check
  compares the story's root element against its Figma node. A Card whose
  *header* padding drifts reports clean unless that header is bound — see
  [child bindings](#child-bindings--checking-the-whole-component-not-just-its-root). This is the single easiest way to get a
  clean report that means less than it appears to.
- **Typography, `color` and copy are compared only on the element that renders
  its own text.** A wrapper `div` inherits its font size from the page while
  Figma answers from a TEXT node several levels down, so the two sides describe
  different elements and every such row was fabricated — on a live Card, twelve
  of sixteen rows. An element counts as text-bearing when it has a text node of
  its own (text alongside element children counts — `<h3>Title <Badge/></h3>` is
  compared, because its font properties cascade into the badge) or is a form
  control. **Consequence:** a component whose text lives entirely in an
  unbound child has no typography comparison at all — bind the text-bearing
  element as a child. Everything a wrapper paints itself (background, borders,
  radii, padding, gap, shadow, opacity) is compared exactly as before.
- **A TEXT node's fill is its text colour, never a background.** Figma gives a
  TEXT node no background paint, so `background-color` is not compared against
  one — the code side reads transparent on any text element and the row could
  only ever be drift. The `color` comparison is where that fill belongs.
- **Portalled components need an explicit target.** Radix and Base UI render
  Dialog, Popover, Tooltip, Select and Dropdown outside `#storybook-root`. The
  addon finds portalled content, but when both a trigger and a popup are
  plausible it reports the ambiguity rather than guessing. Set
  `parameters.designSync.target`.

**Not detected at all.**

- **Interaction states.** Hover, focus and active are never checked: a story
  cannot take a pseudo-state as an argument, so there is nothing to compare a
  Figma `State=Hover` variant against. Disabled *is* checked, because it is a
  real prop. This is a missing mechanism, not an oversight.
- **Motion.** The `motion` dimension exists in the engine but is hidden, because
  it is not yet honest enough to show. (`structure` was in this list until
  v0.0.39 and is now compared — see the layout paragraph above.)
- **Figma's grid auto-layout** (`layoutMode: "GRID"`). No `flex-direction`
  equivalent, and Figma's track definitions have no counterpart in the four
  layout properties compared; the whole layout comparison is skipped for such a
  node rather than half-run.
- **Layout properties beyond those four.** `counterAxisAlignContent` →
  `align-content` (CSS has six values to Figma's two), `itemReverseZIndex` (paint
  order only), and `clipsContent` → `overflow`.
- **Breakpoints.** Figma breakpoint variants versus CSS media queries: no
  mechanism.
- **Anything Figma does not express as a bound variable on a supported
  property.** `strokeAlign`, hug/fill sizing (`layoutSizing*`, `layoutGrow`,
  `layoutAlign`), blend modes, gradient and image fills, second and subsequent
  fills, `textAlignVertical`, paragraph spacing, `INSTANCE_SWAP` properties. Only
  `fills[0]` is read, and only when SOLID — so an image-backed variant is
  uncheckable on that property.
- **Accessibility.** Contrast is not a drift concern: both sides can agree
  perfectly on a pairing that fails WCAG. The sibling
  `storybook-design-inspector` addon grades contrast per element and across
  token pairings.

**Known fragilities.**

- **Story discovery is only as complete as `storyGlobs`.** CSF3 **autotitle**
  files are discovered since v0.0.39, using the installed Storybook's own title
  derivation ([details](#discovery-autotitle-and-what-unreadable-means)) — before
  that they were undercounted, which made a registry look complete over stories
  nothing checked. Two residual limits: a `titlePrefix` in your Storybook
  `main.ts` is not applied (`storyGlobs` cannot express one), and a story file
  living outside every configured glob's directory has no derivable title. Both
  are reported per file, and an unreadable file fails `audit`.
- **Token-name matching is heuristic** unless
  [`tokenAliases`](#tokenaliases--when-figma-and-your-theme-name-the-same-token-differently)
  is configured. A name divergence whose value matches is reported as an
  advisory rather than drift, so the heuristic's misses are visible rather
  than alarming.
- **No headless check.** Drift checking runs in the panel over the Storybook
  channel. `design-sync audit` gates the *registry* in CI; CI cannot yet gate
  on drift itself.
- **Upgrading invalidates the drift cache.** `.design-sync/cache.json` carries a
  schema version, bumped whenever a release changes what a report contains or
  what its verdicts mean (v0.0.39 added the layout and opacity comparisons;
  v0.0.41 drops the generation that could contain partial passes). The first check
  after an upgrade re-fetches rather than replaying a report that predates the new
  rows, and the panel's counters line says how many entries were discarded —
  silence there used to be indistinguishable from a clean cold run.
- **A stale preview bundle silently narrows coverage.** The layout comparison
  needs computed `display` in the snapshot, which older preview bundles don't
  send; without it the comparison emits nothing rather than guessing. Restart the
  consumer's Storybook after upgrading the addon. The text-ownership check
  fails the other way on a stale bundle: with no `ownText` in the snapshot it
  cannot tell a wrapper from a heading, so it compares everything exactly as
  v0.0.39 did rather than suppressing rows on a missing field.
- **One `cva()` class list per component name.** A file with several `cva()`
  calls has every one of them answering to the file's basename, so `card.tsx`
  holding `cardVariants`, `cardHeaderVariants` and `cardTitleVariants` offers
  three candidates for `card`. The one *named* for the component wins; if none
  is, the bindings are withheld and the advisory names the identifiers and asks
  for one to be called `<component>Variants`. Before v0.0.40 this case was
  reported as a cross-file collision and advised renaming a file — advice that
  could not be followed, while more than half the component's token attribution
  went missing.
- **Storybook 10 only.** The preset uses SB10 APIs; 8 and 9 are unsupported.
- **Tailwind bindings need Tailwind v4's CSS-first `@theme`.** A v3
  `tailwind.config.js` scale is not evaluated. Utilities resolving against
  Tailwind's built-in defaults, and numeric spacing under the `--spacing`
  multiplier (`p-3`, `gap-2`), yield no binding by design — the addon will not
  name a token it cannot verify.
- **"Both modes" needs a theme switch that visibly works, and says so when it
  doesn't** ([#69], fixed in v0.0.41; completion fixed in v0.0.42 — [#78]). The mechanism is a *class* named for the
  mode (Tailwind/shadcn `.dark`) or an *attribute*, on `<html>` or `<body>`;
  declare it with `parameters.designSync.modeSwitch`
  (`{ kind: "class", on: "html" }`, or `{ kind: "attribute", attribute:
  "data-theme" }`) or leave it unset and let the preview detect it. Either way it
  is **verified**: the story is measured in both modes and, if flipping the theme
  moves no computed colour on the story, its bound children, `<body>` or
  `<html>`, the report says the mode comparison was **not performed** and shows
  one mode's rows. Before v0.0.41 the switch was attribute-only, so a
  class-themed project produced two byte-identical passes and a completed
  two-mode comparison over one rendered state. Both sides are per-mode: the code
  snapshot is retaken in each mode and compared against that mode's Figma value.
  A declared mechanism that produces no change is reported, not silently replaced
  by one that works — a report against a mechanism you didn't declare is its own
  kind of wrong.
- **Check all honours the Both modes checkbox** ([#78], fixed in v0.0.42). It
  didn't before: Storybook's `useChannel(eventMap, deps = [])` registers a
  panel's channel handlers once on mount, so the handler that starts a bulk run
  held the callback from the first render — the one where the checkbox was still
  unticked. Ticking it and pressing **Check all** ran the whole registry in
  single mode and reported a completed run. Together with the switch being
  attribute-only, this is the second reason #69's "both modes" and "single mode"
  runs came back byte-identical. Check-all options are now read per story, at run
  time.
- **A drift check never waits on a frame callback** ([#78]). Theme switching used
  to await two nested `requestAnimationFrame`s, and a document the browser
  considers hidden — a backgrounded tab, an inactive window — never runs them. A
  **Both modes** check started and then parked indefinitely, leaving the story in
  the switched theme with transitions suspended. Frame callbacks are now raced
  against a timer, the switching phase has its own 6s ceiling *inside the
  preview*, and the document is restored (to the exact `class` attribute it had,
  not an empty one) and a snapshot always emitted — so the worst case is a stated
  refusal, never a spinner. Settled-ness is re-checked at snapshot time on
  `<html>`/`<body>`, not during an earlier probe: if the two passes read the same
  document state, the comparison is refused rather than reported. That check
  deliberately ignores the story's own values, because a component that renders
  identically in both modes while Figma holds two is a real dark-mode drift.
- **A story whose Figma side could not be read is `incomplete`, not checked**
  ([#73], [#74], fixed in v0.0.41). When a node or the file's variables 429s (two
  `Check all` runs in quick succession will do it), the story is given its own
  terminal state — never a ✓ — counted separately from `checked` in the coverage
  line, and **not written to `.design-sync/cache.json`**, so the next run retries
  instead of replaying it. Before v0.0.41 such a story returned `status: done`
  with a footnote and that partial report was persisted, so the only recovery was
  deleting the cache file by hand. A node Figma confirms is *absent* is treated
  differently: that is a stable finding about the registry, and it stays
  cacheable. Retry waits are bounded per request and surfaced ("retry in 27s")
  rather than slept through in silence, and an explicit `Check drift` now has a
  ceiling (30s, 60s for both modes) so the panel always leaves "Checking…".
- **Check all and Check drift now report the same story the same way** ([#80],
  fixed in v0.0.43). Two things made them disagree, and the counting one is what
  a reader saw: the summary's columns counted *comparisons* while the story's
  table renders *findings*, and a token property produces two comparisons (its
  value and its binding). `ui-button--neutral` showed 4 drifted rows against a
  summary saying 7 — three properties detached from their Figma variables, each
  drifting on both. The columns are now counted in the table's unit. `flagOnly`
  is the deliberate exception: the table drops rows with no value on either side
  as uninformative and the summary keeps counting them, because a comparison that
  could not be made is the thing a coverage number must not hide.
  Underneath, the bulk path built its own request and sent only the story id, so
  every story in a `Check all` was checked without its `args` (no `cva()` variant
  resolution), its `target` selector (no CSS-scanner bindings, and the story root
  found by fallback), its `tokens`, or its `modeAttribute` — and with the
  `modeSwitch` of whichever story the panel was sitting on. Both buttons now build
  their request through one function that reads the story being checked, so a
  field reaches both paths or neither.
- **A story that exceeds the per-story budget leaves the totals quietly
  smaller** ([#72]). Coverage reports `timedOut` honestly, but the drift count in
  the header simply omits that story's rows, so a total compared against a known
  baseline can differ with no visible cause. The 8s budget sits inside the
  observed duration range for image-asset stories with five child bindings.
- **Contract-declared siblings are invisible where a slot is unbound** ([#71]).
  `contracts/*.spec.json` may record one Figma token driving several slots;
  drift only compares the slots present in the registry. Fixing the reported row
  can leave a declared pair split across two values, and nothing in the report
  says the sibling exists.
- **The panel reports the version it is running, but cannot reload it** ([#62],
  reported since v0.0.41). The header shows the addon version this Storybook
  process loaded, the counters line says how many cache entries an upgrade
  discarded, and a banner appears when the installed version differs from the
  running one — the tell that a restart is needed. It remains a *notice*: the
  running bundle cannot be swapped under a live dev server, so the fix is still
  to restart Storybook (and clear `node_modules/.cache/storybook` if the manager
  bundle is cached).

[#62]: https://github.com/mylesmetalab/storybook-design-sync/issues/62
[#69]: https://github.com/mylesmetalab/storybook-design-sync/issues/69
[#71]: https://github.com/mylesmetalab/storybook-design-sync/issues/71
[#72]: https://github.com/mylesmetalab/storybook-design-sync/issues/72
[#73]: https://github.com/mylesmetalab/storybook-design-sync/issues/73
[#74]: https://github.com/mylesmetalab/storybook-design-sync/issues/74
[#78]: https://github.com/mylesmetalab/storybook-design-sync/issues/78
[#80]: https://github.com/mylesmetalab/storybook-design-sync/issues/80

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
