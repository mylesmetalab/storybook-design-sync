/**
 * What `register` should do with a hints file, decided as data (issue #97).
 *
 * ## The bug this exists to prevent
 *
 * `register` skipped any story that already had a registry entry, **before even
 * reading the hint**. That is the right rule for a *bound* entry — "register only
 * adds" — and the wrong rule for a `pending` stub, which by definition means *not
 * yet bound*.
 *
 * The consequence was silent and unrecoverable-looking. `ONBOARDING.md` presented
 * `--hints` as optional, so a new user ran `register` first and got a pending stub
 * for every story. Writing `hints.json` and re-running then printed:
 *
 *     0 registered from hints, 0 stubbed as pending
 *
 * — which reads as "there were no hints" — and exited **0**. Nothing bound,
 * nothing reported. The only way forward was deleting the registry, which nobody
 * would try, because the command said nothing was wrong.
 *
 * ## The two rules
 *
 * 1. **A hint upgrades a pending stub.** Nothing is lost: the stub carries no
 *    information the hint doesn't supersede.
 * 2. **A discarded hint is never silent.** A hint that disagrees with a *real*
 *    binding is still not applied — "register only adds" protects a deliberate
 *    binding from a stale hints file — but it is reported, with both node ids, so
 *    the user can see the disagreement and settle it.
 *
 * Pure so both rules are unit-testable without a filesystem or a registry on disk.
 */

import type { RegistryEntry } from "./registry.js";

/** What to do with one story. */
export type HintAction =
  /** No entry yet, and a hint exists → bind it. */
  | { kind: "add"; storyId: string; nodeId: string }
  /** No entry yet, no hint → write a `pending` stub. */
  | { kind: "stub"; storyId: string }
  /** A `pending` stub plus a hint → bind it, dropping the stub status. */
  | { kind: "upgrade"; storyId: string; nodeId: string; previous: RegistryEntry }
  /** Already bound to a different node → do nothing, but say so. */
  | { kind: "conflict"; storyId: string; nodeId: string; boundTo: string }
  /** Already bound to exactly this node, or bound with no hint → nothing to do. */
  | { kind: "unchanged"; storyId: string };

export interface HintPlan {
  actions: HintAction[];
  counts: { add: number; stub: number; upgrade: number; conflict: number; unchanged: number };
}

function hintFor(hints: Record<string, unknown>, storyId: string): string | undefined {
  const raw = hints[storyId];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isPendingEntry(entry: RegistryEntry): boolean {
  return entry.status === "pending" || entry.nodeId === null;
}

/**
 * Decide, per story, what `register` should do.
 *
 * `stories` is the discovered set on disk; `existing` is the registry as loaded;
 * `hints` is the raw parsed hints file (untrusted shape).
 */
export function planHintRegistration(
  stories: readonly { id: string }[],
  hints: Record<string, unknown>,
  existing: Record<string, RegistryEntry>,
): HintPlan {
  const actions: HintAction[] = [];
  for (const story of stories) {
    const hint = hintFor(hints, story.id);
    const entry = existing[story.id];

    if (!entry) {
      actions.push(
        hint === undefined
          ? { kind: "stub", storyId: story.id }
          : { kind: "add", storyId: story.id, nodeId: hint },
      );
      continue;
    }
    if (hint === undefined) {
      actions.push({ kind: "unchanged", storyId: story.id });
      continue;
    }
    if (isPendingEntry(entry)) {
      actions.push({ kind: "upgrade", storyId: story.id, nodeId: hint, previous: entry });
      continue;
    }
    if (entry.nodeId === hint) {
      actions.push({ kind: "unchanged", storyId: story.id });
      continue;
    }
    actions.push({
      kind: "conflict",
      storyId: story.id,
      nodeId: hint,
      boundTo: entry.nodeId ?? "(none)",
    });
  }

  const counts = { add: 0, stub: 0, upgrade: 0, conflict: 0, unchanged: 0 };
  for (const a of actions) counts[a.kind] += 1;
  return { actions, counts };
}

/**
 * Apply a plan to a registry, returning the new `stories` map.
 *
 * Never mutates the input. `conflict` and `unchanged` produce no write — that is
 * the "register only adds" rule, kept intact for real bindings.
 */
export function applyHintPlan(
  plan: HintPlan,
  existing: Record<string, RegistryEntry>,
): Record<string, RegistryEntry> {
  const out: Record<string, RegistryEntry> = { ...existing };
  for (const action of plan.actions) {
    if (action.kind === "add") {
      out[action.storyId] = { nodeId: action.nodeId, lastSyncedHash: null };
    } else if (action.kind === "stub") {
      out[action.storyId] = { nodeId: null, lastSyncedHash: null, status: "pending" };
    } else if (action.kind === "upgrade") {
      // Drop `status` rather than leaving `status: "pending"` beside a real
      // nodeId — `isPending` keys off it, so a bound-but-still-pending entry
      // would be skipped by every consumer that asks "is this registered".
      const { status: _dropped, ...rest } = action.previous;
      out[action.storyId] = { ...rest, nodeId: action.nodeId };
    }
  }
  return out;
}
