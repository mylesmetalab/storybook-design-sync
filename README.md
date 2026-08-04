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
- **[`design-sync check`](#check--the-panels-drift-check-headlessly)** runs that
  same check with no panel — for CI, for a schedule, for an agent. It drives your
  own Storybook preview in a headless browser and reuses the panel's request
  builder, engine and triage, so its verdict is the panel's verdict; a clear
  exit-code contract keeps "no drift" and "I could not find out" apart.
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
npm i -D "github:mylesmetalab/storybook-design-sync#v0.0.49"
npx design-sync init
```

In `.storybook/main.ts` (`init` does this for you when it can):

```ts
const config = {
  addons: ["@metalab/storybook-design-sync"],
  // ...
};
```

## `design-sync init`

One command in place of the manual adoption sequence. It does the mechanical
part of setup and **reports every step it could not do, in order**. It is not a
substitute for reading the rest of this section — it is the thing that stops you
having to type it.

```sh
npx design-sync init                      # prompts for the Figma file key on a TTY
npx design-sync init --file-key ABC123    # or pass it
npx design-sync init --dry-run            # print the plan, write nothing
```

| Flag | Effect |
| --- | --- |
| `--file-key <key>` | The Figma file key. Never derived from anything — see below. |
| `--yes` / `-y` | Never prompt. A missing key becomes a placeholder plus a loud step one. |
| `--no-skills` | Do not copy the workflow skills into `.claude/skills/`. |
| `--force` | Rewrite the files **init itself authors** (`design-sync.config.json`). Never a skill, never your `main.ts` or `preview.ts`. |
| `--dry-run` | Print the plan and write nothing. |

Exit codes: **0** init did its part (remaining steps may still be listed) ·
**1** refused, nothing written · **2** a write failed.

### What it does

1. **Checks the project can host the suite, and refuses if not** — Node ≥ 20.6,
   Storybook **10** (8/9 is refused by name, with the upgrade command; so is a
   project with no Storybook, or no `.storybook/main.*`). A refusal writes
   nothing at all.
2. **Detects, and shows its reasoning.** Storybook version (installed beats
   declared), whether the project is on Tailwind and which generation, which CSS
   file holds the `@theme` block, which directory holds components, and the
   project's **own** story globs read out of `.storybook/main.*` — so a monorepo
   or a `stories/` layout is configured correctly without being asked. Every
   derived entry prints with the reason it was chosen, and a fallback says it is
   a fallback.
3. **Registers both addons in `.storybook/main.*`** — a *merge*, not a rewrite.
   It refuses to touch the `addons` array unless it holds nothing but string
   literals, so what it produces can be described character for character; a
   comment, a spread or an object and it prints the snippet and lists it as a
   step that remains. Quote style and indentation are preserved.
4. **Writes `design-sync.config.json`** from what it detected, with
   `"apply": "off"`. If a config already exists it is **left untouched** and
   anything missing from it is reported.
5. **Appends `.design-sync/cache.json` to `.gitignore`** (the cache is a local
   derivative; `registry.json` is committed on purpose).
6. **Copies the workflow skills into `.claude/skills/`** — only ones that are not
   already there. See below.
7. **Prints what remains, numbered and ordered**: the file key if it is still a
   placeholder, `FIGMA_PAT`, token alignment, the `copy` decision, the token
   manifest, the `modeSwitch` declaration, `register` + `audit`, CI, and the
   end-to-end verification. The last line is never "setup complete", because it
   isn't.

Running it twice is safe and says what it skipped. On an already-configured
project it changes nothing and reports twelve things as already done.

### What it refuses to do

- **Invent a `fileKey`.** It is the one fact only you have. Flag, prompt, or a
  placeholder plus a step one that says every drift check fails until you fill it
  in. Never anything derived.
- **Overwrite a file you wrote.** Ever, including under `--force`, for anything
  except the config it authored itself.
- **Generate the inspector's token manifest.** That is the *other* addon's
  schema, and a manifest that disagrees with your CSS makes the inspector's
  on-token dots lie. It also has to come *after* aligning your theme with the
  design source, which is judgement. Init detects whether a manifest exists and
  whether `preview.*` wires it, and names the step otherwise.
- **Align your tokens, or decide `copy`.** Both need someone to look at the
  design file. `copy` is left **unset** rather than written as a default, because
  a written default reads as a decision.
- **Run `npm install`, or `register`.** The first is your package manager's job;
  the second needs Figma node ids. Both are printed as exact commands.

### The workflow skills

The package ships the six suite skills (`design-sync-setup`,
`handoff-ready-component`, `component-handoff`, `component-update`, `fix-drift`,
`vqa-review`) under `skills/`, and `init` copies them into `.claude/skills/`.

They are **created only when absent, and never overwritten** — not even with
`--force`. A project's copy is *meant* to diverge: a client's codegen standards
are not universal, and overwriting a lead's edited conventions is worse than
being out of date. But "deliberately diverged" and "silently stale" look
identical from inside a repo, which is what the `revised:` stamp in each skill's
frontmatter is for. So on a re-run init reports both dates per skill, flags yours
when it is older, and names the packaged path to diff against — then leaves the
decision to you. `--no-skills` skips the whole step.

Shipping them inside the package is what makes the offer possible at all: a
consumer installs the addon and has no other access to the suite's skills, so
printing a path would have pointed at nothing.

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
| `copy` | `"on"` | Whether the `copy` dimension compares text at all. `"off"` emits **no** copy rows anywhere. Figma has no way to mark a string as placeholder text while stories are expected to carry realistic product copy, so a component whose design holds lorem drifts on every story forever — only you know which you have. Per-story override: `parameters.designSync.compareCopy: false`. See [Coverage and limits](#coverage-and-limits). |
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

Since v0.0.50 the addon also reads each variable's **`codeSyntax.WEB`** in Figma
(*Variable → Code syntax → Web*), which gives four tiers, most to least trusted:

| | how the name was decided | trusted? |
|---|---|---|
| 1 | Figma's `codeSyntax` names a custom property **your CSS declares** | authoritative |
| 2 | your `tokenAliases` entry | authoritative |
| 3 | Figma's `codeSyntax` names a property you **don't** declare | inferred, but Figma's own name is quoted |
| 4 | no `codeSyntax` at all → `normalizeTokenName` | inferred |

Tier 3 is the common case when you adopt a design system's Figma file but not its
CSS — in the reference file **356 of 361** variables carry a `codeSyntax`, and
every one names that design system's own `--sds-*` property rather than the
consumer's. That is a legitimate re-mapping, **not a finding**: the addon quotes
the design system's name (so only your half is still inferred) and tells the
reader not to write it, because it would resolve to nothing.

A tier-1 name that contradicts a `tokenAliases` entry is **reported, not
silently resolved** — two explicit declarations disagreeing means one is stale.

The panel and every fix prompt say which tier resolved a name, so an inferred
name never reads like an asserted one.

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
- `compareCopy` *(boolean, default `true`)* — set `false` to stop comparing this
  story's text against Figma's TEXT nodes. For the common case where a component's
  structural text is placeholder in the design but its labels are real, so the
  project-wide `"copy": "off"` would be too blunt. `false` emits **no** copy rows
  for the story — see [Coverage and limits](#coverage-and-limits) ([#63]).
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

**The same rules apply to `tsxEntries`, identically** — one shared implementation,
so the two scanners cannot answer this question differently ([#60], fixed in
v0.0.46; before that the ignore list overrode `tsxEntries` unconditionally, which
emptied the binding dimension outright on a Tailwind stack, where `tsxEntries` is
what carries the bindings). Two extra patterns are unconditional and silent for the
TSX scanner: `*.stories.tsx` and `*.test.tsx`. Those are not build output that
duplicates the source — a story's inline styles are arguments to a component, not
the component's declared tokens — so there is nothing to opt into.

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

- `hover:`, `focus-visible:`, `active:` — provably off **unless the story
  declares a state binding and the addon forced that state** for the pass being
  measured. Resting snapshots are unchanged; a forced `:hover` pass attributes
  `hover:bg-primary-hover` rather than crediting the value to the base utility.
  See [Interaction states](#interaction-states).
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

The package ships a `design-sync` binary with six subcommands:

```
design-sync init                        Set up the suite in this project (see `design-sync init`)
design-sync check [--url http://localhost:6006]
                                        Run the drift check headlessly against a RUNNING Storybook
design-sync audit                       Diff stories on disk against the registry
design-sync register [--hints <path>]   Bulk-register from hints; stub the rest
design-sync ls                          Print title → node binding tree
design-sync export-graph --format json|dot
                                        Emit the binding graph for docs / visualizations
```

`audit`, `register`, `ls` and `export-graph` accept `--stories <glob>`
(repeatable). When `--stories` isn't passed, the CLI uses `storyGlobs` from
`design-sync.config.json`,
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

### `check` — the panel's drift check, headlessly

```sh
# 1. a Storybook dev server, with FIGMA_PAT in ITS environment
FIGMA_PAT=figd_… npx storybook dev -p 6006 --ci &

# 2. the check
npx design-sync check
```

`check` runs **the same check the panel runs**, over every registered story, with
no browser for a human to click in. It is what makes drift gateable in CI,
runnable on a schedule, and answerable by an agent.

**What its green means: exactly what the panel's green means.** This is a
property of how it is built, not a claim about it. A drift check is three
processes talking over one channel — the manager asks, the *preview* measures the
rendered story with `getComputedStyle`, the Node server reads Figma and answers —
and only the middle one needs a browser. `check` does not re-implement any of
them. It stands in for the **manager**: it opens the consumer's own Storybook
preview in a headless Chromium, emits the same `checkDriftRequest` (built by the
same single request builder the panel uses), and reads the same `driftReport`
back. Same snapshot code, same engine, same triage, same row grouping, same
counts, same per-story budget.

Measured against the reference consumer (ten registered Button stories), `check`
and a panel **Check all** produced identical reports for all ten stories —
comparing every dimension's kind, property, element, status, both values, token
name, divergence kind, note, class attribution, source advisory and token
presence:

```
Panel   Check all  — 10/10 stories checked · 138 match · 13 drift · 85 name-only · 10 flag-only
CLI     check      — 10/10 stories checked · 138 match · 13 drift · 85 name-only · 10 flag-only
                     10/10 stories row-for-row identical
```

**Flags.**

| Flag | Meaning |
|---|---|
| `--url <url>` | Storybook's dev-server URL. Default `http://localhost:6006`. |
| `--story <id>` | Check only this story. Repeatable. An id the registry does not bind is an error, never a silent skip. |
| `--component <name>` | Check every registered story of this component (matched against the story id's component segment). Repeatable. |
| `--both-modes` | The **Both modes** checkbox. Snapshots each story in both themes and merges, and says so when the theme switch could not be verified. |
| `--json` | Write the machine-readable report to **stdout**. The human summary always goes to stderr, so `design-sync check --json \| jq` works. |
| `--out <file>` | Write the same JSON to a file. Combines with or replaces `--json`. |
| `--full-report` | Embed each story's complete `DriftReport` in the JSON, alongside the triaged rows. |
| `--timeout <ms>` | Per-story budget. Defaults to the panel's: 8000 single-mode, 16000 with `--both-modes`. |
| `--headed` | Show the browser. For debugging a check that behaves differently headless. |
| `--quiet` | Suppress the progress lines and the summary. Exit code and `--json` only. |

**Exit codes.** The contract, in the order that matters — `2` outranks `1`,
because "I found drift and checked everything" is a stronger claim than a run
with a hole in it is entitled to make:

| Code | Meaning |
|---|---|
| `0` | Every targeted story produced a complete report, and **no row drifted**. |
| `1` | Every targeted story was checked; at least one row is drift. Name-only token divergences, `flag-only` and `unresolved` rows are **not** drift and do not produce this. |
| `2` | **The run covers less than it set out to.** A story errored, ran out of its budget, or produced a report resting on a Figma read that failed (`incomplete`) — or `--both-modes` was asked for and the theme switch could not be verified. Whatever drift it found is real; the run is not a verdict on the selection. |
| `3` | **Nothing was compared.** Bad usage, no reachable Storybook, no browser driver, nothing registered, or a filter that matched no registered story. Never a statement about drift. |

A CI job that only distinguishes zero from non-zero gets the right answer from
all four. One that branches can tell "the design and the code disagree" from "I
could not find out" — which is the distinction a rate-limited run in CI depends
on, and the reason `incomplete` has never been allowed to mean `0`.

**What it needs.**

- **A running `storybook dev`.** Not a static `storybook build`: the engine that
  reads Figma is a Node module inside Storybook's dev server, and a static build
  has no server channel to reach it through. This is why the check is not
  standalone — a standalone one would need its own copy of the engine *and* its
  own snapshotter, and a second definition of "matches Figma" is the thing this
  command exists not to become.
- **`FIGMA_PAT` in the Storybook process's environment**, not the CLI's, for the
  same reason.
- **Playwright**, an *optional* peer dependency:
  ```sh
  npm i -D playwright && npx playwright install chromium
  ```
  Optional because `audit`, `register`, `ls` and `export-graph` need no browser,
  and a browser download must not be the price of running them in CI. A project
  that already runs `storybook test` has Playwright installed already.

**It never writes.** There is no code path from `check` to an edit, in any
`apply` mode.

**It reports the version Storybook is running.** A dev server keeps serving the
bundle it started with, so if the CLI and the Storybook process are different
releases, `check` says so and tells you the report is the server's answer.

### `verify` — are the assumptions still true?

```sh
npx design-sync verify                    # every contracts/*.spec.json
npx design-sync verify --full             # show verified claims too, not just the rest
npx design-sync verify --json
npx design-sync verify --contracts "specs/*.json"
```

`check` and `verify` ask different questions, and one cannot answer the other:

| | compares | answers |
|---|---|---|
| `check` | rendered code ↔ current Figma | does the build match the design **today**? |
| `verify` | the contract's recorded **claims** ↔ current Figma | are the assumptions this component was **built on** still true? |

The gap is **absence claims.** A drift check compares values that exist, so if
design adds a mode after handoff the check has no row for a mode it was never told
about — while `notInFigma: [...]` quietly becomes false. That is not hypothetical:
two comments asserting the design source lacked something were both untrue, and
licensed 24 invented theme values, 18 of them wrong. They survived review
*because they read as settled findings*.

**It is cheap, which is the point.** No browser and no rendered DOM — one Figma
read per contract plus a JSON compare. So unlike `check` it needs no
`storybook dev` and no Playwright, runs anywhere `audit` runs, and scales with
*components* rather than stories. `FIGMA_PAT` is the only requirement.

**Three verdicts, and the third is why this is worth having:**

- **verified** — re-read, still true, with the evidence quoted.
- **falsified** — the design has moved. A falsified `notInFigma` entry means the
  design now specifies something the code was built to ignore, so it is a
  design → code handoff, not a drift fix, and the report says so.
- **unverifiable** — split, because only one half should block:
  - *could not be read* — a genuine coverage hole. **Blocks** (exit 2), exactly as
    a failed Figma read blocks `check`.
  - *not stated checkably* — the contract words the claim in prose that names no
    Figma fact ("Figma carries no heading semantics"). Re-running changes nothing,
    so it does **not** block — but it is counted, printed, and the summary never
    calls such a run fully verified. Re-word the entry if you want it gated.

| Code | Meaning |
|---|---|
| `0` | every claim that could be re-read still holds |
| `1` | at least one claim is **falsified** |
| `2` | at least one claim **could not be re-read**. Outranks `1` |
| `3` | could not run at all — no contracts matched, or no `FIGMA_PAT` |

**What is checkable today.** The claims that get real verdicts are the ones naming
a Figma fact: `variantNodeIds` / `childNodeIds` (does the node still resolve?), and
`notInFigma` / `notSpecifiedByFigma` entries whose reason asserts something about
the component set's **variant axes or component properties** — "defines no *Focus*
state", "has no *State* axis", "*Asset* is a component property, not a variant".
Those three shapes cover 4 of the 8 absence entries in the two contracts that
exist. The rest are reported honestly as not-checkable with their own wording
quoted, and the axes and properties are available so a human can settle them in
seconds.

`designSource` claims (collections/modes, literals, shared values, uncheckable
properties) are **parsed but not yet re-checked**: no contract in this project
carries that block — it was added on 2026-07-31, after both existing contracts were
written — so there has been no real input to build the checker against. A contract
without it is reported as a gap, never as a passing contract.

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

**Declaring state bindings.** `--state "<pseudo-state>=<nodeId>"` (repeatable,
scoped with `--story`) adds or updates the entry's `states` map, so a forced
pseudo-state is compared against the design's node for that state:

```sh
npx design-sync register --story ui-button--primary --state "hover=4185:3783"
```

Split on the **first** `=` — a state name never contains one, so a second is a
typo rather than part of a node id. Supported states: `hover`, `active`, `focus`,
`focus-visible`, `focus-within`, `disabled`. A design's `Error` / `Open` /
`Checked` state is a prop, not a pseudo-state, and is refused with the
instruction to bind it as its own story. Binding a state to the story's **own**
`nodeId` is also refused — that would compare the forced rendering against the
unforced design and report drift for everything the state deliberately changes.
`ls` prints state bindings nested under their story as `:hover → <node>`.
See [Interaction states](#interaction-states) for what is and is not compared.

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
variant axes · Figma component properties (BOOLEAN, TEXT) · **every one of those
again in a forced `:hover` / `:active` / `:focus` state, where the story declares
the binding** — see [Interaction states](#interaction-states).

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

### Interaction states

**Compared, since v0.0.47, when you declare the binding.** A story's `states`
map names the Figma node for each forced pseudo-state, and the addon measures the
rendered element **in that state** against that node:

```json
"ui-button--primary": {
  "nodeId": "4185:3779",
  "states": { "hover": "4185:3783" }
}
```

`npx design-sync register --story ui-button--primary --state "hover=4185:3783"`.
Rows measured this way carry the state, not a fake element: `--json` reports
`{ "element": null, "state": "hover", … }`, because a forced state is a
**condition on the story root**, not a child of it.

**The vocabulary is forced pseudo-states only** — `hover`, `active`, `focus`,
`focus-visible`, `focus-within`, `disabled`. A design's `State=Error`,
`State=Open` or `State=Checked` is a prop or a `data-state` attribute the
component renders itself, so it needs no forcing: give a story the arg that
renders it and bind *that story* to the node. Declaring one under `states` is
refused with that instruction rather than silently forced.

**How the state is forced, and why it is trustworthy.** Page JavaScript cannot
trigger a real `:hover` — dispatching `pointerover`/`mouseover` moves nothing.
So the stylesheet is rewritten (`.button:hover` gains a parallel
`.button.pseudo-hover`) and the class is toggled. Measured in headless Chromium
on a real component, the class form, a real pointer and CDP's
`CSS.forcePseudoState` all produce identical computed values. Because it is pure
DOM/CSS it behaves the same in the panel and in `design-sync check`, so the two
surfaces agree by construction rather than by testing. Transitions are
**suspended** during the pass, not waited out: `getComputedStyle` mid-transition
returns the interpolated value, which would make a correctly-forced state look
unchanged.

**What is refused rather than approximated.** Each is reported per state, never
folded into a pass:

| Situation | Reported as |
|---|---|
| Forcing changed no computed value | **Not compared.** Either the state is genuinely identical or the forcing failed; the addon cannot tell those apart, so it never reports a match. |
| The state is styled through a `data-*` attribute the component library writes from its own React state (shadcn on Base UI / Radix `data-disabled:*`) | **Not compared**, with the instruction to bind it as its own story. A class cannot make Base UI re-render, so the forced rendering would be missing the declarations the state is made of. |
| **Both modes** was also requested | **Not compared.** States are forced once, in the rendered mode, so a two-mode report has no measurement to attribute to the second mode. Re-run with Both modes unticked. |
| No `states` map on the story | No state rows at all, and no message. |

**`focus` has no design source in the reference file.** Across all 78 component
sets of the Simple Design System there is no `State=Focus` — focus styling is a
code-side decision there. So a focus comparison is *possible* but will have
nothing to compare against unless your design file specifies one. Nothing is
inferred.

**Modes × states is not combined yet.** See the table above.

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

**Which paint is compared** ([#85], v0.0.46). The **first visible** paint in
`fills` / `strokes` — not `fills[0]`. A Figma `Paint` carries an optional
`visible`, and a paint switched off with the current one below it is ordinary
practice (last month's brand colour parked on top, an overlay off for this
variant). Until v0.0.46 nothing read that field, so the switched-off paint was
resolved, token-attributed and compared, while the paint that actually renders was
never compared at all — a false finding *and* a real property silently unchecked,
in one row, and unfalsifiable from the panel because the colour named genuinely is
in the file. Now:

- the rendering paint is the first one with `visible !== false` and a non-zero
  `opacity`, and the row says when it was not the first paint in the array;
- **a visible paint is never skipped for being unreadable** — a gradient above a
  solid wins and resolves to nothing, because skipping to the solid would compare
  something invisible all over again;
- **every paint switched off is not "no fill".** The design paints nothing there
  *on purpose*, which is a different fact from "Figma told us nothing", and the row
  says which — with no verdict and no token attributed. A `strokeWeight` of 1 (the
  variant-template default) is no longer reported as a border the design draws
  when its strokes are all off;
- the **Wiring** column takes its binding from the rendering paint too: a hidden
  paint's variable is not what the element is wired to;
- the same predicate applies to **hidden descendants** — a switched-off TEXT layer
  is not the component's typography and its `characters` are not its copy. The
  node a *story is bound to* is still read even if hidden: there the binding is
  what is wrong, and silently comparing nothing would hide the misbinding instead
  of surfacing it.

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
- **Bindings are only derived from files your entries reach.** `cssEntries` and
  `tsxEntries` are the whole input to the declared-binding dimension, and a story
  whose bindings were never scanned reports on value drift alone. Both scanners now
  apply one shared rule ([#46], [#60]): `node_modules` (plus `*.stories.tsx` /
  `*.test.tsx` for TSX) is unconditional, `dist/` and `storybook-static/` are a
  default that an entry naming the directory beats, and anything suppressed anyway
  is logged at startup as `NOT SCANNED` with a count, example paths and the entry
  responsible. Read the startup line: `derived bindings for 0 selector(s)` means the
  scan found nothing, which looks exactly like a codebase that declares nothing.
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
- **Copy is compared until you say it shouldn't be** ([#63], v0.0.44). Text
  comparison only means something when the design intends the literal string, and
  **Figma cannot express "this is a placeholder"** — while a Storybook story is
  expected to render realistic product copy. So a component whose Figma text is
  lorem and whose stories carry real copy drifts on every story, permanently: on a
  live Card that was 16 of 20 remaining rows. Turn it off with `"copy": "off"` in
  `design-sync.config.json` (whole project) or
  `parameters.designSync.compareCopy: false` (one story, for the common case where
  a component's structural text is placeholder but its labels are not). Off means
  **no rows**, not rows with the verdict withheld. Placeholder-ness is never
  *inferred* from the string: lorem detection is a heuristic that misfires on real
  copy, and a button Figma labels `Save` genuinely should say Save.
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
  `layoutAlign`), blend modes, gradient and image fills, paint stacks below the
  rendering paint, `textAlignVertical`, paragraph spacing, `INSTANCE_SWAP`
  properties. Only **the first visible SOLID paint** is read (see below) — so an
  image-backed variant is uncheckable on that property.
- **A paint at partial opacity** ([#85], v0.0.46). A paint with `0 < opacity < 1`
  renders as its colour blended with whatever is behind it, so its own colour is
  not what appears. The row reports the paint, its token and the opacity and says
  **no comparison was made** (`unresolved`), rather than comparing the opaque
  value. Folding the opacity into the alpha channel would produce a comparable
  number, but one no token holds — and a fix prompt then pointing at the token
  would route the fix to the wrong layer, when the design's intent is an
  element-level blend.
- **Accessibility.** Contrast is not a drift concern: both sides can agree
  perfectly on a pairing that fails WCAG. The sibling
  `storybook-design-inspector` addon grades contrast per element and across
  token pairings.

**What a fix prompt asserts — and what it says it cannot** (v0.0.44).

The fix prompt is the whole write path in v1: detection ships, and every change
that reaches a codebase does so because a human or an agent pasted one. So a
prompt may only assert a change it has *established*. Before proposing an edit it
answers four questions, and **where it cannot answer one it says so** rather than
emitting a confident instruction.

- **Which layer owns this?** A `copy` row is routed to whoever owns the content
  and never into a code edit — in the bulk prompt it has its own section and the
  instructions say not to act on it. Rewriting a story's `args` to match a Figma
  placeholder produces a plausible diff that destroys what the story was for
  ([#63]). A token the project's scanned CSS does not declare is stated as absent,
  with the file where custom properties *are* declared, and the prompt refuses both
  a dangling `var()` and a hardcoded literal ([#67]). A token whose value moved is
  a design-token PR, not a component edit (v0.0.38).
- **What else does it affect?** Properties in one family are named as one change
  (v0.0.36). Where a **Check all** has run, a prompt names the sibling stories that
  expect a *different* value for the same element and property, and drops "keep the
  change minimal" — applying such a row as written contradicted Figma on 7 of 8
  sibling variants on a live Card ([#68]). Where no sibling was compared, the
  prompt says the blast radius is **not established** and what to do about it. Slots
  the component's contract binds to the same token are named too ([#71]).
- **Is it complete across modes?** A mode-varying token carries **both** values and
  says the change is half-applied until both are covered. A prompt with only the
  light value looks right and leaves dark silently wrong ([#66]).
- **Is it still true?** Every prompt carries the **ISO timestamp of the Figma
  read**, the file's `version` and `lastModified` at that read, the node id and the
  addon version, and instructs the applier to re-verify against Figma before
  committing and to **stop** on a mismatch. A prompt built from a cached report
  reports the *cache's* read time, never the moment it was copied; a report with no
  recorded read time says the read time is unknown rather than implying freshness.
  starter PR #5 applied a prompt faithfully and would have re-introduced drift,
  because the Figma edit it cited had been reverted while the PR sat open ([#76]).

Two limits of that machinery, stated plainly. The blast-radius check is only as
wide as the **last Check all in this panel session** — it is not persisted, so a
fresh panel reports "not established" until you run one. And the contract read is
`contracts/<component>.spec.json` only, matched on the token name; it names
consumers, it never compares them.

**Known fragilities.**

- **Story discovery is only as complete as `storyGlobs`.** CSF3 **autotitle**
  files are discovered since v0.0.39, using the installed Storybook's own title
  derivation ([details](#discovery-autotitle-and-what-unreadable-means)) — before
  that they were undercounted, which made a registry look complete over stories
  nothing checked. Two residual limits: a `titlePrefix` in your Storybook
  `main.ts` is not applied (`storyGlobs` cannot express one), and a story file
  living outside every configured glob's directory has no derivable title. Both
  are reported per file, and an unreadable file fails `audit`.
- **Token-name matching is authoritative only when Figma's `codeSyntax` names a
  property your CSS declares, or you declared a
  [`tokenAliases`](#tokenaliases--when-figma-and-your-theme-name-the-same-token-differently)
  entry.** Otherwise it is inferred, and labelled as inferred everywhere it is
  shown. When Figma declares a `codeSyntax` your project does not use, the
  addon can at least quote *Figma's* name instead of guessing at that half too
  — but your name is still a guess. A name divergence whose value matches is
  reported as an advisory rather than drift, so a miss is visible rather than
  alarming.
- **`codeSyntax` is read but never linted.** A variable with no `codeSyntax` is
  not reported as a design-file problem — only as a name the addon had to infer.
  Flagging the gap at handoff time is not built.
- **The headless check needs a running dev server, and is the *bulk* path.**
  `design-sync check` (v0.0.45) runs the panel's check with no panel, and its
  green means what the panel's green means — same preview snapshot, same engine,
  same triage, [demonstrated row for row](#check--the-panels-drift-check-headlessly).
  Four respects in which it is narrower, none of them affecting a verdict:
  it needs `storybook dev` and cannot run against a static `storybook build`
  (a static build has no addon server, so there is no engine to answer); it takes
  the **bulk** per-story budget (8s, 16s with `--both-modes`) rather than the
  explicit check's 30s/60s; it sends `trigger: "bulk"`, so the engine may answer
  from its TTL caches exactly as **Check all** does — the panel's single **Check
  drift** is the only path that revalidates against Figma on demand; and it emits
  no **fix prompts**, only the rows they are built from (`--full-report` carries
  everything a prompt needs, but the prompt text is panel-only).
- **`check` reads the story's declared args, not edited controls.** A headless run
  has nobody to move a control, so there is nothing to lose here — but it does
  mean `check` cannot reproduce a report the panel produced *after* a control
  edit.
- **Upgrading invalidates the drift cache.** `.design-sync/cache.json` carries a
  schema version, bumped whenever a release changes what a report contains or
  what its verdicts mean (v0.0.39 added the layout and opacity comparisons;
  v0.0.41 drops the generation that could contain partial passes; v0.0.43 drops
  the generation whose `Check all` entries were written from requests carrying
  none of the story's context — [#80]; v0.0.44 drops the generation written before
  a report carried the provenance of its Figma read — [#76]). The first check
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
- **Contract-declared siblings are named, not compared** ([#71], v0.0.44).
  `contracts/<component>.spec.json` may record one Figma token driving several
  slots while drift compares only the slots present in the registry, so fixing the
  reported row could leave a declared pair split across two values. The prompt now
  reads the contract and names the other consumers, marking the ones this report
  could not reach — but nothing *compares* them, and the contract is still
  validated by nothing. It informs a human; it never overrules either side. Token
  matching allows the contract's longer, collection-qualified path
  (`size/space/200`) against the report's variable name (`Space/200`), and refuses
  an **ambiguous** suffix match rather than pairing the wrong slot.
- **The panel reports the version it is running, but cannot reload it** ([#62],
  reported since v0.0.41). The header shows the addon version this Storybook
  process loaded, the counters line says how many cache entries an upgrade
  discarded, and a banner appears when the installed version differs from the
  running one — the tell that a restart is needed. It remains a *notice*: the
  running bundle cannot be swapped under a live dev server, so the fix is still
  to restart Storybook (and clear `node_modules/.cache/storybook` if the manager
  bundle is cached).

[#46]: https://github.com/mylesmetalab/storybook-design-sync/issues/46
[#60]: https://github.com/mylesmetalab/storybook-design-sync/issues/60
[#62]: https://github.com/mylesmetalab/storybook-design-sync/issues/62
[#63]: https://github.com/mylesmetalab/storybook-design-sync/issues/63
[#66]: https://github.com/mylesmetalab/storybook-design-sync/issues/66
[#67]: https://github.com/mylesmetalab/storybook-design-sync/issues/67
[#68]: https://github.com/mylesmetalab/storybook-design-sync/issues/68
[#69]: https://github.com/mylesmetalab/storybook-design-sync/issues/69
[#71]: https://github.com/mylesmetalab/storybook-design-sync/issues/71
[#72]: https://github.com/mylesmetalab/storybook-design-sync/issues/72
[#73]: https://github.com/mylesmetalab/storybook-design-sync/issues/73
[#74]: https://github.com/mylesmetalab/storybook-design-sync/issues/74
[#76]: https://github.com/mylesmetalab/storybook-design-sync/issues/76
[#78]: https://github.com/mylesmetalab/storybook-design-sync/issues/78
[#80]: https://github.com/mylesmetalab/storybook-design-sync/issues/80
[#85]: https://github.com/mylesmetalab/storybook-design-sync/issues/85

## What this addon is NOT

- Not *only* a CLI. The panel is the surface a designer works in; the CLI
  (`init`, `check`, `audit`, `register`, `ls`, `export-graph`) is the surface CI and
  agents work in. Both go through the same engine — see
  [`check`](#check--the-panels-drift-check-headlessly).
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
