---
name: design-sync-update
description: Check whether the installed Drift Auditor and Design Inspector addons are behind the latest release, show exactly what shipped since the project's current pin, and — only if the human wants to proceed — bump the pin as a reviewed PR rather than a silent edit. Use when someone asks "is there a new version", "check for design-sync updates", "are we behind", or before a long stretch of new component work, since a check is only as trustworthy as the version of the tool running it.
revised: 2026-08-10
---

# design-sync-update

> **FIRST DRAFT** — the engineering lead owns how aggressively this should push toward upgrading, and should adjust anything marked ⚙ DRAFT.

The suite ships fixes and features as new tagged versions the same way any dependency does — nobody is notified. `check-pins.mjs`, in the suite's own repo, only verifies consistency *inside* the suite's own trees; it has no view of a downstream project sitting on whatever tag it happened to install months ago. This skill is that missing outside view, run *from* a consumer project rather than from the suite.

**Nothing here runs on a schedule by default.** A team may wire a cron'd CI job to run this periodically; many won't. Don't assume it's being checked in the background — if nothing is actually invoking this skill on some cadence, that's a gap to close deliberately (a recurring reminder, a habit at the start of each `design-sync-session`), not one to silently accept.

## What it checks

The addon (`storybook-design-sync`) and the inspector (`storybook-design-inspector`) are versioned independently — a project can be behind on one and current on the other. Check both.

1. **What's actually installed**, not what the pin string in `package.json` claims — the two can silently disagree if `npm install` wasn't re-run after the pin last changed:

   ```bash
   node -p "require('./node_modules/@metalab/storybook-design-sync/package.json').version"
   node -p "require('./node_modules/storybook-design-inspector/package.json').version"
   ```

2. **What's latest**, no clone required:

   ```bash
   git ls-remote --tags --sort=-v:refname https://github.com/mylesmetalab/storybook-design-sync.git | head -1
   git ls-remote --tags --sort=-v:refname https://github.com/mylesmetalab/storybook-design-inspector.git | head -1
   ```

If installed == latest for both, say so in one line and stop. That's the common case and doesn't need a report.

## If either is behind: show what shipped, don't characterize it

**Never call a release "safe" or "breaking" from its version number alone — nothing here follows semver strictly, and a wrong guess is worse than making the human read a short list.** List every tag between the installed version (exclusive) and latest (inclusive) with the message it actually carries. These repos have no separate CHANGELOG, so the tag's message — for a lightweight tag, the message of the commit it points to — *is* the release note:

```bash
# works for anyone with `gh` authenticated against the repo (no local clone needed):
gh api repos/mylesmetalab/storybook-design-sync/compare/v0.0.63...v0.0.64 --jq '.commits[].commit.message'

# if the addon's source happens to be cloned locally instead, equivalent:
git -C <path-to-your-clone> fetch --tags && git -C <path-to-your-clone> log v0.0.63..v0.0.64 --oneline
```

(If these repos are private when you run this, `gh api` needs the same read access `npm install` already required to fetch the dependency in the first place — nothing extra to provision.)

Show the human the full list. Don't pre-filter it to what looks relevant: this suite has already shipped a bug (the `codeSyntax` tier-1 gap — see CLAUDE.md) that a "looks unrelated" filter would have hidden, because the change that mattered didn't announce itself as a config or contract change.

## Upgrading — a reviewed change, same as any other

A version bump gets the same treatment as a drift fix: **a branch and a PR, never a direct edit to the pin on main.** Use `design-sync-session`'s worktree pattern to isolate it.

1. Bump the pin(s) in `package.json` to the new tag(s).
2. `npm install` — **do not hand-edit `package-lock.json`.** A git-dependency's lockfile entry is a resolved commit SHA; only a real install produces a correct one.
3. Fully restart Storybook. If the panel still shows the old version afterward, `rm -rf node_modules/.cache/storybook` — the manager bundle is built at server start, so a dev server left running through the bump keeps serving the old addon.
4. Run, locally, before opening the PR:
   - `npm run typecheck`
   - `npm test`
   - `npx design-sync audit`
   - Open the panel and confirm its header now shows the version you just installed (a mismatch banners); run **Check drift** on at least one story and confirm it renders a report, not an error.
5. Open the PR only if all four are clean. If something breaks, that is real, specific information about what changed for this project — report it and understand it before merging, rather than retrying past it.

⚙ DRAFT: how often to run this proactively — weekly, at the start of each new `design-sync-session`, or some other cadence — is a team-rhythm decision, not a tooling one. The engineering lead should set it once there's a real usage pattern to look at.
