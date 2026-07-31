# Vendored workflow skills

These six skills are **copies**. The master set lives in the Design Sync Suite's
`handover/skills/` (the parent folder of this repo), which is where they are
edited. They are vendored here for one reason: `design-sync init` offers to copy
them into a consumer's `.claude/skills/`, and a consumer who installs this package
has no access to the suite's parent folder — so printing a path would have pointed
at nothing.

Two consequences, both deliberate:

- **They can go stale relative to the master.** Re-syncing them is a release-time
  step (`cp -R ../handover/skills/* skills/`), not something any code does. Each
  skill carries a `revised:` date in its frontmatter, which is what makes the
  staleness visible instead of invisible.
- **`init` never overwrites a consumer's copy** — not even under `--force`. A
  project's skills are meant to diverge; a client's codegen standards are not
  universal. On a re-run `init` reports both `revised:` dates per skill and flags
  the consumer's when it is older, then leaves the decision to the human. See the
  addon README's `design-sync init` section.

Do not edit these files here. Edit the master and re-copy, or the two diverge with
nothing to say which is current.
