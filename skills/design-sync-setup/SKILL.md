---
name: design-sync-setup
description: Drop the Design Sync Suite (drift auditor + design inspector Storybook addons) into a repo — install, config, token manifest, registry, CI check, and end-to-end verification. Use when setting up design-sync in a new or existing project, or when a user says "set up design sync", "add the drift checker", or "install the design suite".
revised: 2026-07-31
---

# design-sync-setup

Set up the Design Sync Suite in the current repo. The suite is detection-only: it never writes to code or Figma. Follow every step; do not skip verification. Step 3 (token alignment) is the one most likely to be skipped and the most damaging to skip.

## Skill provenance — check this when re-running on an existing project

Every skill in this suite carries a `revised:` date in its frontmatter. The copies in a project's `.claude/skills/` are **project-owned and meant to diverge** — a client's codegen standards aren't universal. But "deliberately diverged" and "silently stale" look identical from inside a repo, which is the whole point of the stamp.

When run on a project that already has `.claude/skills/`, compare each local skill's `revised:` date against the suite master and **report the differences to the user without overwriting anything**: which skills are older, and what changed upstream. Let the human decide per skill — a project that has customised `component-handoff` should keep its version; a project on a stale `fix-drift` probably wants the update. Never silently sync: overwriting a lead's edited conventions is worse than being out of date.

## Preconditions — check before touching anything

1. Node ≥ 20.6 (`node --version`)
2. Storybook **10** in the host project (`npm ls storybook`). SB 8/9: stop and tell the user the suite requires Storybook 10.
3. Ask the user for their **Figma file key** (from the file URL: `figma.com/design/<FILE_KEY>/…`) and confirm the file uses Figma **variables** for its tokens. If tokens are raw hex values in Figma, warn: drift comparison needs variables; the inspector still works.
4. `FIGMA_PAT` present in the environment, or tell the user how to create one (Figma → Settings → Security → Personal access tokens; scopes: file content read, variables read).

## Steps

### 1. Run `design-sync init`

```bash
npm install --save-dev "github:mylesmetalab/storybook-design-sync#v0.0.62" "github:mylesmetalab/storybook-design-inspector#v0.2.7"
npx design-sync init --file-key <your Figma file key>
```

Since addon v0.0.46 `init` does every mechanical step: it registers both addons by merging into `main.*` (preserving quote style and indentation), writes `design-sync.config.json` with `apply: "off"`, derives `cssEntries`/`tsxEntries`/`storyGlobs` from the project's real layout — including **which CSS file holds `@theme`**, which is the difference between a working binding dimension and an empty one — gitignores `.design-sync/cache.json`, and copies these six skills into `.claude/skills/` where they are absent.

**Read its output rather than assuming success.** It is built to refuse rather than guess, and what it refuses is what you still have to do:

- **It never invents a `fileKey`.** Pass `--file-key`, answer the prompt, or it writes a loud placeholder.
- **It never overwrites a user-authored file** — not even with `--force`, which only rewrites its own config. If it can't describe an edit to `main.*` character for character (a comment or a spread in the `addons` array), it prints the snippet instead and says so.
- **It leaves `copy` unset**, because a written default would read as a decision. Step 2 is where you make it.
- **It does not generate the inspector's manifest, align tokens, run `register`, or add CI.** Steps 3–6 below.
- **Exit 0 does not mean "done".** Remaining steps always exist by design; the `NOT DONE` block is the real output.

Re-running is safe and idempotent: it reports what it skipped, keeps the existing config's `fileKey`, and for each skill prints both `revised:` dates and flags a stale local copy **without overwriting it** — an edited convention is yours, and being out of date is better than being silently replaced.

**Upgrading an existing install: bumping the pin is not enough.** `npm install` does not refetch a git dep whose ref moved, and the Storybook manager bundle is built at server start, so a running dev server keeps serving the old addon. After any version change: reinstall the dep by ref, fully restart Storybook, `rm -rf node_modules/.cache/storybook` if the panel still shows the old version, and check the version the panel header prints. It banners on a mismatch with the installed one — treat that banner as "every report in this session is suspect", including the one on screen.

### 2. Auditor config

Create `design-sync.config.json` at the repo root. Derive `cssEntries`/`codeTargets` from the actual project layout (look at where component CSS/TSX lives — do not guess):

```json
{
  "fileKey": "<FILE_KEY>",
  "cssEntries": ["<globs for CSS files that define token usage>"],
  "tsxEntries": ["<globs for TSX files — REQUIRED for Tailwind/inline-styled codebases>"],
  "codeTargets": ["<globs for files fix-prompts should reference>"],
  "apply": "off",
  "copy": "on"
}
```

`apply` stays `"off"` unless the user explicitly asks for the experimental write path. The addon README is the authoritative config reference (`engine`, `registryPath`, `storyGlobs`).

**`copy` (default `"on"`) — decide it at setup, not after the first noisy report.** Text content is compared, and Figma cannot express "this string is a placeholder" while a story is expected to render realistic product copy. So if the design's components carry lorem, every story drifts on copy forever (16 of 20 remaining rows on a live Card). Look at the design file: lorem throughout → set `"copy": "off"` and tell the user why; real strings → leave it on. Per-story control is `parameters.designSync.compareCopy: false`, for the common case where a component's structural text is placeholder but its labels are real. `"off"` means **no rows**, not rows with the verdict withheld — and placeholder-ness is never inferred from the string, because that heuristic misfires on real copy.

**Tailwind / shadcn / cva projects** (addon v0.0.32+): `tsxEntries` carries the bindings — the addon reads `cva()` calls and literal `className` attributes and maps each utility to the token it reads. But `cssEntries` is still required and must include the file holding the Tailwind `@theme` block (usually `src/index.css`), because that is where the utility → token mapping comes from. Without it the addon can't tell `bg-primary` from an unknown utility and derives nothing. Two more things to know:

- The mapping only covers what the project's **own** `@theme` declares. Utilities resolving against Tailwind's built-in defaults (`bg-transparent`, `font-normal`) and numeric spacing under the `--spacing` multiplier (`p-3`, `gap-2`) yield no binding by design — the tool refuses to name a token it can't verify. If the team wants padding tracked, they declare `--spacing-3` etc. in `@theme`.
- Requires Tailwind **v4**'s CSS-first theme. A v3 `tailwind.config.js` scale is not evaluated, so a v3 project gets no Tailwind bindings.

**Overlay components** (Dialog, Popover, Tooltip, Select, Dropdown): Radix and Base UI portal their content outside `#storybook-root`. The addon finds it, but when both the trigger (in the root) and the popup (in a portal) are plausible targets it reports the ambiguity instead of guessing. Set `parameters.designSync.target` on those stories — e.g. `'[role="dialog"]'` — and note that the selector is queried against the whole document, so it reaches portalled content.

**Declare how the project switches theme** (addon v0.0.41+), globally in `.storybook/preview.ts`. Dual-mode checking is only as good as this declaration:

```ts
parameters: {
  designSync: {
    modeSwitch: { kind: "class", on: "html" },  // Tailwind v4 / shadcn `.dark`
    // modes: ["day", "night"],                 // ONLY if not called light/dark
  },
},
```

- `modeSwitch` — `{ kind: "class" | "attribute", attribute?, on?: "html" | "body" }`. Leave it unset and the preview detects a mode-named class then `data-theme`/`data-mode`/`data-color-scheme`; declare it when you know, because a report measured against a mechanism you didn't declare is its own kind of wrong. Either way the addon **verifies** it: if flipping the theme moves no computed colour, the story reports that the mode comparison **did not happen** rather than comparing one mode twice.
- `modes` — set it only when the project's two modes aren't named `light` and `dark`. A project on `["day","night"]` was previously measured as light/dark in silence. Anything other than exactly two non-empty names is refused with a console warning.

### 3. Align the project's tokens with the Figma source (do NOT skip)

**This is the step that decides whether the team's first drift check is trustworthy.** If the project's theme holds a UI kit's default values (shadcn, MUI, Tailwind defaults) while Figma holds the client's, every component will report real-but-uninformative colour/font drift on day one and the team will stop believing the tool.

1. Harvest the design source's token values: `get_variable_defs` on a few representative component nodes plus the file's foundations page (Figma MCP tools).
2. Compare against the project's theme (the CSS custom-property block — `src/index.css` or equivalent) and its font stack.
3. If they disagree, align the **theme values** to Figma, keeping the theme's variable *names* (components reference them). Include the dark/alternate themes.

   **Before writing a single derived value, read the design file's collection modes.** "The design file has no dark mode" is an absence claim, and an uncited one is more dangerous than an uncited value: it forecloses the lookup that would correct it. This exact claim was written into a theme's `.dark` block, alongside "SDS has no dark brand border" — both false; the file's `Color` collection had two modes and 118 mode-varying variables. They licensed 24 invented values, 18 of them wrong, and they survived two days of review *because* they read as settled findings. So: enumerate the modes, and only if the file genuinely holds one may you derive — with a comment naming the tool call and date that established it, and stating plainly that the values are derived, not the design's.

   **Map design variables 1:1 onto theme tokens. Never merge two distinct design variables onto one theme token because their values happen to match today.** This is the single most damaging shortcut available here. Real example: `Background/Brand/Default` and `Border/Brand/Default` both read `#2c2c2c`, so both were mapped to `--primary` and a Button used `bg-primary` *and* `border-primary`. It worked until the background changed — then the border followed it, producing an invisible pink-on-pink border and a fresh drift row the design never asked for. The bug was silent for as long as the two values agreed, and only a *later* design change exposed it. If the design system names two variables, the theme needs two tokens, even when they're currently identical. Where a UI kit's vocabulary genuinely has no slot for one of them, add the token (see the disabled/hover precedents) rather than collapsing.
4. Fonts must actually render: install the real font (e.g. `@fontsource-variable/inter`) and import it, don't just name it in the stack. Drift compares computed `font-family`.
5. Leave a comment at the top of the theme block naming the source file key and stating that updates go through the `component-update` skill's token-layer path, not by hand.
6. Report the mapping you applied and anything you could not map.

If the project genuinely has no tokens yet, generate the theme *from* the Figma variables and say that's what you did.

### 4. Inspector token manifest

Generate `tokens/manifest.json` from the project's (now aligned) CSS custom properties: categories (color/spacing/typography/radius/size), each token's name, value, and `cssVariable`. Include `themes` entries if the project has a theme mechanism (class or data-attribute). The schema with a full example lives in the storybook-design-inspector README — read it rather than guessing field names. Wire it in `.storybook/preview.ts` (or `preview.tsx` — current `storybook init` generates the tsx variant for React) under `parameters.designInspector.tokens`. If the project has no tokens yet, create a minimal manifest from the values actually used and tell the user it's a starting point.

The manifest must agree with the CSS — if it disagrees, the inspector's on-token/off-token dots lie.

### 5. Registry

```bash
npx design-sync register --hints
npx design-sync audit
```

Bind each story to its Figma node id. `registry.json` lives in `.design-sync/` and is committed. CSF3 **autotitle** files are discovered since v0.0.39 using the installed Storybook's own title derivation, so they are no longer undercounted — but read the output for the two cases it still can't resolve: a `titlePrefix` in `.storybook/main.ts` (not applied, and `storyGlobs` can't express one) and a story file outside every configured glob's directory (no derivable title). Both are reported per file, and any unreadable file fails `audit` rather than being warned about. If the project has stories with no Figma counterpart yet (welcome/docs stories, or a fresh shell awaiting handoffs), register them as **pending stubs** (addon README) so `audit` exits 0 honestly instead of failing on intentional gaps.

### 6. CI

Add `npx design-sync audit` to the project's PR checks (whatever CI the project uses). It needs no `FIGMA_PAT`.

**`audit` gates the registry, not drift.** What it catches is a story that drifted out of the registry, an unreadable story file, and malformed child-binding shapes.

**Drift itself can also be gated, since addon v0.0.45:**

```bash
npx design-sync check            # every registered story
npx design-sync check --json     # machine-readable, for a report artifact
```

`check` is not a second implementation — it opens the project's own Storybook preview in headless Chromium, so the same code measures the same DOM against the same engine and triage. It is verified row-for-row identical to a panel **Check all**; that parity is its acceptance test, so re-establish it after any change to the snapshot, engine or triage.

Two prerequisites to state plainly when you wire it up: it needs **`storybook dev` running** (a static build has no server channel, so no engine — `check` cannot audit a deployed static site), and **Playwright**, an optional peer dependency that only `check` requires.

Exit codes are ordered so a gap in coverage can never read as a pass: `0` clean and everything checked · `1` drift with complete coverage · `2` **coverage incomplete** (Figma unread, a timeout, an error, or a mode comparison requested but unverifiable) · `3` could not run. **`2` outranks `1`** — never treat a non-zero exit as merely "drift found" without reading which.

### 7. Verify end-to-end (mandatory)

0. Start Storybook and read the addon's startup line in the terminal:

   ```
   [design-sync] Scanned 1 CSS + 1 TSX file(s); derived bindings for 4 selector(s)
     (css: 0, tsx: 0, tailwind-cva: 4 scope(s) across 1 component(s) [button]);
     Tailwind @theme vars: 50.
   ```

   **`derived bindings for 0 selector(s)` means the scan found nothing** — the declared-binding dimension will be empty for every story. Fix `cssEntries`/`tsxEntries` before going further. On a Tailwind project, a non-zero `@theme vars` count with `tailwind-cva: 0` means the theme was read but no utility resolved to a project token; check for arbitrary values and Tailwind-default utilities. (This line only appears under `storybook dev`, not `storybook build`.)

1. Open a registered story; confirm the panel header shows the version you just installed (a mismatch banners — restart Storybook); run **Check drift** and confirm a report renders (clean or with honest rows, not an error banner).
2. **Tick "Both modes" and re-check.** Confirm the report actually compared two modes — if it says the mode comparison was **not performed**, the theme switch moved no computed colour and your `modeSwitch` declaration is wrong. Fix it here; a project that ships with a broken switch gets single-mode reports it believes are two-mode.
3. Run **Check all** once. Confirm the coverage line adds up: `N/M stories checked`, plus any `incomplete (Figma unread)` — those are rate-limited, not clean, and re-running retries them. Confirm one story's drift count matches what **Check drift** reports for the same story; a discrepancy is an addon bug worth filing.
4. Open the **Design** panel; click an element; confirm properties resolve with token names.
5. Deliberately break one token usage in CSS; re-check drift; confirm the row appears; click **Copy fix prompt**; confirm the prompt names the right file/property/token *and* carries a Figma read timestamp; revert the break.

Report the outcome of all five checks to the user. If any fail, debug before declaring setup complete — a half-configured suite that silently shows "no drift" is worse than none.
