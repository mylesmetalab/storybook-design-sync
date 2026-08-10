---
name: designer-setup
description: One-time environment setup for a designer joining a project that already has design-sync configured — clones the project, installs dependencies, adds the shared Figma token, and verifies Storybook boots with both the Design Inspector and Drift Auditor panels working. Use when a designer says "set me up", "I'm new to this project", "get me started with design-sync", or asks how to install it as a designer. Not for setting up a NEW project — that's design-sync-setup, run once by an engineer.
revised: 2026-08-10
---

# designer-setup

> **FIRST DRAFT** — the engineering lead owns this and should adjust anything marked ⚙ DRAFT.

Everything here runs entirely on the designer's own machine. Nothing about their setup is shared with anyone else's, and nothing they do here can affect another designer working on the same project at the same time — see `design-sync-session` for how that isolation actually works once they're set up.

**Narrate every step as you go — what you're doing and why, not just the command.** A designer who sees a wall of terminal output with no explanation will assume something broke even when it didn't. State the check, why it matters, and the result, in plain language, before moving to the next one.

## Preconditions — check before touching anything

1. **Node ≥ 20.6** (`node --version`). If missing or older, stop and say so — don't attempt to install Node yourself; that's a machine-level change outside this skill's scope, and directing them to nodejs.org or their own package manager is safer than guessing at their setup.
2. **git** is installed and configured with an identity (`git config user.email`) — needed for the commits and PRs later. If unset, ask for their name/email rather than inventing one.
3. **A GitHub account with read+write access to the project repo.** This is the one thing that can't be set up from inside this skill — if they don't have it yet, that's a request to whoever manages repo access, and everything downstream waits on it.
4. **Already set up?** If `storybook dev` already runs cleanly in an existing checkout, skip to the verification step at the end — don't redo work that's already done. Re-running this skill should never be destructive.

## Steps

1. **Clone the project repo.** Ask which repo if it isn't already obvious from context — this skill is deliberately generic, not tied to any one project. Clone to wherever the designer wants their working copy to live; this becomes the base every isolated worktree (see `design-sync-session`) branches off from.

2. **`npm install`.** If this fails on a `github:` dependency with an authentication error, that's the project's own addon repo — say so plainly and stop; it's a repo-access problem to escalate, not something to work around.

3. **Add the shared Figma token to their environment.** One thing to get right here that isn't obvious: an `export` line added to `~/.zshrc` (or `~/.bashrc`) only takes effect in *interactive* shells — an agent (this one, or any future automation) spawning a fresh shell often won't see it. Add it to `~/.zshenv` instead (or the zsh-equivalent for their shell), which is sourced for every invocation, interactive or not. This exact gap cost real debugging time once already — don't repeat it.

   ```sh
   echo 'export FIGMA_PAT="<the shared token — ask the engineering lead, never generate your own>"' >> ~/.zshenv
   ```

   **Why a shared token, not one they mint themselves:** designers never need to see or handle Figma's token-generation flow at all — provisioning that credential is the one genuinely sensitive step in this whole system, and keeping it centralized (one token, one place it's rotated) is what makes that true in practice, not just in principle. If they don't have the token yet, that's a request to the engineering lead — don't proceed without it; a check running with no token produces incomplete, misleading results, not a clean failure.

   Immediately verify it landed somewhere a **non-interactive** shell will actually read (open a fresh terminal, or run a subshell, and check `echo $FIGMA_PAT` is non-empty there specifically — not just in the terminal they just typed the export into).

4. **Start Storybook for the first time** (`npm run storybook`, or whatever the project's `package.json` names — check `scripts` rather than assuming). Confirm it boots without errors, then check both panels:
   - **Design Inspector** — click any element in a story; confirm the panel shows computed styles and token resolution (green/orange/grey), not a blank or errored panel.
   - **Drift Auditor** — open the panel, confirm it shows registered stories with no "config" or "registry" error banner. Don't run an actual check yet; this step only confirms the panel *can* talk to the running server, not that any particular component is clean.

5. **Report a plain summary**: what's installed, where the token went, and that both panels loaded — plus the one thing they now know how to do next (start a piece of work — see `design-sync-session`).

## If something's wrong

Every failure here should be reported as **what failed and what it means**, never silently retried or worked around. A `storybook dev` that won't boot, a panel that errors, a token that doesn't verify — each of those is real information about their specific machine, and guessing past it just relocates the problem to later, where it's harder to diagnose.
