---
name: design-sync-session
description: Start, pause, resume, or finish a piece of design work — building a new component from Figma, or fixing/updating an existing one. Creates an isolated git worktree and branch per piece of work, manages the local Storybook server's lifecycle, and hands off to component-handoff or fix-drift for the actual work. Use when a designer says "I want to build/work on/fix a component", "start a new task", "pause my server", "I'm done for today", or "open a PR for this". Requires designer-setup to have already run once.
revised: 2026-08-10
---

# design-sync-session

> **FIRST DRAFT** — the engineering lead owns the branch-naming and PR conventions below and should adjust them.

The thing this skill exists to prevent: two designers (or one designer with two things in flight) editing the same working copy, colliding on ports, or losing track of which server belongs to which task. Every piece of work gets its own **git worktree** — a separate, real checkout on disk sharing the same repo history — never a shared working directory. This is the same pattern this project already uses for every isolated task; there is nothing designer-specific about it.

Because every designer's worktrees live on their own machine, nothing here needs coordinating *between* designers — four people running this at once never touch each other's files, branches, or servers. The one place their work meets is the PR review, same as any other contributor.

## Starting a new piece of work

**If it's been a while since anyone checked, consider running `design-sync-update` first.** A component built or a drift check run against a stale addon can report false drift that a newer version already fixed, or miss a real check a newer version added — not a hard gate before every task, but worth a habit at the start of a stretch of new work.

1. **Ask what they're doing**, if it isn't already clear: building a component that doesn't exist in code yet (→ hand off to `component-handoff`, after confirming `handoff-ready-component` passes), or something that already exists needs to change (→ hand off to `fix-drift`, which triages further). Don't guess; the wrong skill produces confidently wrong output.

2. **Create the worktree.** Naming: `claude/<short-descriptive-slug>-<random-6-char-suffix>` for both the branch and the worktree directory, e.g. `claude/dialog-component-handoff-6a3572` — matching this project's own existing convention exactly, not inventing a new one. The random suffix is what makes two designers naming their work similarly never collide.

   ```sh
   git worktree add .claude/worktrees/<slug>-<suffix> -b claude/<slug>-<suffix>
   ```

3. **Pick a free port before starting the server.** Don't assume 6006 is free — the same designer may already have another worktree's Storybook running. Check first (e.g. `lsof -i :6006`); if taken, try 6007, 6008, and so on. Start it backgrounded, in the new worktree's directory, and confirm it actually booted (poll for the port, don't just assume) before handing back a URL.

4. **State the URL and the branch name plainly**, then proceed into whichever skill this task actually needs.

## Pausing (not finished, stopping for now)

Stop the server process for that worktree — find it by the port you started it on, not by name (several worktrees may all be running `storybook`). **Leave the worktree and branch exactly as they are.** Nothing about pausing should touch git state; uncommitted changes stay uncommitted, ready to resume.

## Resuming

Find the existing worktree for this task (`git worktree list`) rather than creating a new one — a designer asking to continue something means exactly that, not starting over. Restart the server on a free port (it may not be the same one as last time) and continue.

## Finishing — opening the PR

1. Confirm the underlying skill (`component-handoff` / `fix-drift` / `component-update`) has already run its own verification — this skill doesn't re-check the work, it ships it.
2. Commit with a message describing what changed and why, matching the style already used in this project's history — not a generic "update component."
3. Push the branch, open the PR (`gh pr create`). **Never push to the project's main branch directly** — every piece of work, from every designer, lands as a PR, same review gate as an engineer's own change. This is true regardless of how small the change looks.
4. Ask whether to stop the server or leave it running — don't assume either.

## Why worktrees, not just branches

A plain `git checkout -b` on one shared working directory means switching tasks discards whatever's on disk for the other one — fine for a single engineer context-switching deliberately, wrong here, where the whole point is that nothing about starting task B should touch task A's uncommitted state, and two things (or two people) can be genuinely simultaneous rather than taking turns.
