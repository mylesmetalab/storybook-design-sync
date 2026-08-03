/**
 * Re-checking a contract's claims against a fresh read of the design source
 * (issue #92). The pure half: verdicts, given facts. The Figma reads live in the
 * CLI command.
 *
 * ## Three verdicts, and why the third is the point
 *
 * `verified` / `falsified` / `unverifiable`. Separating the third is the whole
 * discipline: **a claim that could not be re-read is not a passing claim.** A run
 * that is all `unverifiable` has established nothing, and must not exit 0. Same
 * ordering as `check`, where incomplete coverage outranks a found problem.
 *
 * ## What is honestly mechanical, which is less than the issue assumed
 *
 * Issue #92's acceptance says a `notInFigma` entry the design now specifies is
 * falsified "with the node and variable that falsify it". Reading the two
 * contracts that exist, **most `notInFigma` entries name no Figma fact to
 * re-read**:
 *
 * | entry | reason as written | re-checkable? |
 * |---|---|---|
 * | `focusVisible` | "The component set defines no Focus state." | **yes** — is there a `Focus` option on a variant axis? |
 * | `noInteractionStates` | "The component set has no State axis…" | **yes** — is there a `State` axis? |
 * | `WithoutAsset` | "The Asset boolean is a component property, not a variant." | **yes** — is `Asset` a property rather than an axis? |
 * | `transition` | "Figma declares no motion." | no — REST does not expose prototype motion |
 * | `titleAs` | "Figma carries no heading semantics." | no — Figma has no such concept to gain |
 * | `iconSize` | "16px is the intrinsic frame of the icon components." | no — not an absence of a fact |
 *
 * So the checkable ones share one shape: **assertions about the component set's
 * variant axes and component properties**, which is exactly what
 * `componentPropertyDefinitions` returns. Those get real verdicts. The rest are
 * reported `unverifiable` **with the reason they cannot be checked**, and the
 * report prints the axes and properties as they read *now* — so a human can
 * falsify an unparseable claim in seconds even where the tool cannot.
 *
 * Reporting them as `verified` because nothing contradicted them would be the
 * exact failure this whole feature exists to prevent.
 */

import type { ContractClaim } from "./contract-claims.js";

/** The freshly-read design facts a verdict is computed against. */
export interface DesignSourceSnapshot {
  /** When the read happened, ISO. Quoted in the report next to the contract's own citation. */
  readAt: string;
  /**
   * Variant axes of the component set the contract names, `axis → options`.
   * Absent when the set could not be read — which makes axis claims
   * `unverifiable`, never verified.
   */
  variantAxes?: Record<string, string[]>;
  /** Non-variant component properties, `name → type` (BOOLEAN / TEXT / INSTANCE_SWAP). */
  componentProperties?: Record<string, string>;
  /** Node ids that resolved on this read. */
  nodesPresent?: Set<string>;
  /** Node ids that were requested and did not resolve. */
  nodesMissing?: Set<string>;
}

export type Verdict = "verified" | "falsified" | "unverifiable";

/**
 * Why a claim was not verified. The distinction decides whether a run can be
 * gated, and getting it wrong makes the tool either useless or dishonest.
 *
 *  - `read-failed` — the design source could not be read this time. A genuine
 *    **coverage hole**: transient, retryable, and it must block, exactly as a
 *    failed Figma read blocks `check`.
 *  - `not-expressible` — the contract states the claim in prose that names no
 *    Figma fact ("Figma carries no heading semantics"). Re-running changes
 *    nothing; the limitation is the contract's wording, not the read. Blocking on
 *    it forever would mean `verify` could never gate anything, so it does **not**
 *    fail the run — but it is counted, printed, and the summary never calls such
 *    a run fully verified.
 */
export type UnverifiableReason = "read-failed" | "not-expressible";

export interface ClaimResult {
  claim: ContractClaim;
  verdict: Verdict;
  /** What the fresh read found. Always populated — a verdict with no evidence is a guess. */
  evidence: string;
  /** Set only when `verdict === "unverifiable"`. */
  reason?: UnverifiableReason;
}

export interface VerifyOutcome {
  results: ClaimResult[];
  counts: Record<Verdict, number>;
  /** Split of `counts.unverifiable`, because only one half blocks. */
  unverifiable: Record<UnverifiableReason, number>;
  /** Non-claim problems (an absent `designSource`, an unreadable section). */
  gaps: string[];
}

/* ------------------------------------------------------------------------- *
 * Parsing an absence claim's prose for a machine-checkable assertion
 * ------------------------------------------------------------------------- */

/** A machine-checkable assertion recovered from an absence claim's reason. */
export type AbsenceAssertion =
  /** "the component set defines no <Option> state" → is `Option` on any axis? */
  | { kind: "no-axis-option"; option: string }
  /** "the component set has no <Axis> axis" → does that axis exist? */
  | { kind: "no-axis"; axis: string }
  /** "<Name> is a component property, not a variant" → is it still? */
  | { kind: "property-not-axis"; name: string };

/**
 * Recover an assertion from an absence entry's prose, or `undefined`.
 *
 * Deliberately narrow and literal. A looser parser would "recognise" claims it
 * then checks against the wrong fact, which is worse than declining: a wrong
 * `verified` is the failure mode, and a decline is visible.
 */
export function parseAbsenceAssertion(claim: ContractClaim): AbsenceAssertion | undefined {
  const text = `${claim.statement} ${claim.reason ?? ""}`;

  // "defines no Focus state" / "has no Hover state"
  const noOption = /\b(?:defines|has|carries) no ([A-Z][A-Za-z-]*) state\b/.exec(text);
  if (noOption?.[1]) return { kind: "no-axis-option", option: noOption[1] };

  // "has no State axis"
  const noAxis = /\bno ([A-Z][A-Za-z ]*?) axis\b/.exec(text);
  if (noAxis?.[1]) return { kind: "no-axis", axis: noAxis[1].trim() };

  // "The Asset boolean is a component property on every variant, not a variant of
  // its own" / "the Button boolean is a property, not a variant"
  const propNotAxis =
    /\b(?:The |the )?([A-Z][A-Za-z]*) (?:boolean|property) is a (?:component )?property[^.]*?not a variant\b/.exec(
      text,
    );
  if (propNotAxis?.[1]) return { kind: "property-not-axis", name: propNotAxis[1] };

  return undefined;
}

function axisOptionsInclude(axes: Record<string, string[]>, option: string): string | undefined {
  const wanted = option.toLowerCase();
  for (const [axis, options] of Object.entries(axes)) {
    if (options.some((o) => o.toLowerCase() === wanted)) return axis;
  }
  return undefined;
}

/* ------------------------------------------------------------------------- *
 * Verdicts
 * ------------------------------------------------------------------------- */

function verifyAbsence(claim: ContractClaim, snap: DesignSourceSnapshot): ClaimResult {
  const assertion = parseAbsenceAssertion(claim);
  if (!assertion) {
    return {
      claim,
      verdict: "unverifiable",
      reason: "not-expressible",
      evidence:
        `the contract's reason names no Figma fact this tool can re-read ` +
        `(${claim.reason ? `"${truncate(claim.reason)}"` : "no reason recorded"}). ` +
        `Check it against the axes and properties printed below.`,
    };
  }
  const axes = snap.variantAxes;
  const props = snap.componentProperties;
  if (!axes || !props) {
    return {
      claim,
      verdict: "unverifiable",
      reason: "read-failed",
      evidence:
        "the component set could not be read on this pass, so nothing was compared. " +
        "This is not a pass.",
    };
  }

  if (assertion.kind === "no-axis-option") {
    const found = axisOptionsInclude(axes, assertion.option);
    return found === undefined
      ? {
          claim,
          verdict: "verified",
          evidence: `no variant axis offers "${assertion.option}" (axes read: ${describeAxes(axes)}).`,
        }
      : {
          claim,
          verdict: "falsified",
          evidence:
            `the design now specifies it: axis "${found}" offers "${assertion.option}". ` +
            `The code was built to ignore this, so it is a design → code handoff, not a drift fix.`,
        };
  }

  if (assertion.kind === "no-axis") {
    const match = Object.keys(axes).find((a) => a.toLowerCase() === assertion.axis.toLowerCase());
    return match === undefined
      ? {
          claim,
          verdict: "verified",
          evidence: `there is no "${assertion.axis}" axis (axes read: ${describeAxes(axes)}).`,
        }
      : {
          claim,
          verdict: "falsified",
          evidence:
            `the design now has a "${match}" axis, offering ${axes[match]!.map((o) => `"${o}"`).join(", ")}. ` +
            `Everything the contract justified by its absence needs revisiting.`,
        };
  }

  // property-not-axis
  const asAxis = Object.keys(axes).find((a) => a.toLowerCase() === assertion.name.toLowerCase());
  if (asAxis !== undefined) {
    return {
      claim,
      verdict: "falsified",
      evidence:
        `"${assertion.name}" is now a VARIANT axis (offering ${axes[asAxis]!.map((o) => `"${o}"`).join(", ")}), ` +
        `not a component property. A story bound per-variant may now need one story per option.`,
    };
  }
  const asProp = Object.keys(props).find((p) => p.toLowerCase().startsWith(assertion.name.toLowerCase()));
  return asProp === undefined
    ? {
        claim,
        verdict: "unverifiable",
        reason: "read-failed",
        evidence:
          `"${assertion.name}" is neither a variant axis nor a component property on this read — ` +
          `it may have been renamed or removed, which the contract does not describe. ` +
          `Properties read: ${Object.keys(props).join(", ") || "none"}.`,
      }
    : {
        claim,
        verdict: "verified",
        evidence: `"${asProp}" is still a component property (${props[asProp]}), not a variant axis.`,
      };
}

function verifyNode(claim: ContractClaim, snap: DesignSourceSnapshot): ClaimResult {
  const id = claim.nodeId;
  if (id === undefined) {
    return {
      claim,
      verdict: "unverifiable",
      reason: "not-expressible",
      evidence: "the claim names no node id.",
    };
  }
  if (snap.nodesPresent?.has(id)) {
    return { claim, verdict: "verified", evidence: `node ${id} resolved on this read.` };
  }
  if (snap.nodesMissing?.has(id)) {
    return {
      claim,
      verdict: "falsified",
      evidence:
        `node ${id} no longer resolves in this file. A renamed or deleted variant otherwise ` +
        `surfaces as a confusing drift row rather than "the design moved".`,
    };
  }
  return {
    claim,
    verdict: "unverifiable",
    reason: "read-failed",
    evidence: `node ${id} was not read on this pass, so its existence is unconfirmed.`,
  };
}

/**
 * Claims whose re-check is not built yet.
 *
 * Reported `unverifiable` **with the reason**, not silently dropped and not
 * quietly passed. `designSource` does not exist on either real contract, so these
 * kinds have no data in practice — building a checker for them before any contract
 * carries the block would be writing against an imagined input.
 */
function verifyNotImplemented(claim: ContractClaim): ClaimResult {
  return {
    claim,
    verdict: "unverifiable",
    reason: "not-expressible",
    evidence:
      `re-checking \`${claim.kind}\` claims is not implemented. No contract in this project ` +
      `carries a \`designSource\` block yet, so there has been no real input to build it against.`,
  };
}

export function verifyClaims(
  claims: readonly ContractClaim[],
  snap: DesignSourceSnapshot,
  gaps: readonly string[] = [],
): VerifyOutcome {
  const results = claims.map((claim): ClaimResult => {
    switch (claim.kind) {
      case "absence":
        return verifyAbsence(claim, snap);
      case "node":
        return verifyNode(claim, snap);
      default:
        return verifyNotImplemented(claim);
    }
  });
  const counts: Record<Verdict, number> = { verified: 0, falsified: 0, unverifiable: 0 };
  const unverifiable: Record<UnverifiableReason, number> = {
    "read-failed": 0,
    "not-expressible": 0,
  };
  for (const r of results) {
    counts[r.verdict] += 1;
    if (r.verdict === "unverifiable") unverifiable[r.reason ?? "read-failed"] += 1;
  }
  return { results, counts, unverifiable, gaps: [...gaps] };
}

/**
 * Exit codes, mirroring `check`'s discipline: **a hole in coverage outranks a
 * found problem**, because "I re-read everything and found a falsified claim" is
 * a stronger statement than a run with gaps is entitled to make.
 */
export const VERIFY_EXIT = {
  /** Every claim was re-read and every one still holds. */
  Verified: 0,
  /** Every claim was re-read; at least one is falsified. */
  Falsified: 1,
  /** At least one claim could not be re-read. Outranks `Falsified`. */
  Unverifiable: 2,
  /** Could not run at all — no contracts, no PAT, no file key. */
  CouldNotRun: 3,
} as const;

/**
 * Only a **failed read** blocks. A claim the contract does not state checkably is
 * a permanent property of its wording, so gating on it would mean `verify` could
 * never pass on any contract that exists — the tool would be unusable and would
 * then simply be switched off, which is worse than a narrower honest gate.
 *
 * The report still counts and prints those, and never describes such a run as
 * fully verified.
 */
export function verifyExitCode(outcome: VerifyOutcome): number {
  if (outcome.unverifiable["read-failed"] > 0) return VERIFY_EXIT.Unverifiable;
  if (outcome.counts.falsified > 0) return VERIFY_EXIT.Falsified;
  return VERIFY_EXIT.Verified;
}

/** One line stating what the run established — never "clean" when something was not checked. */
export function verifySummary(outcome: VerifyOutcome): string {
  const { verified, falsified } = outcome.counts;
  const notExpressible = outcome.unverifiable["not-expressible"];
  const readFailed = outcome.unverifiable["read-failed"];
  const parts = [`${verified} verified`];
  if (falsified > 0) parts.push(`${falsified} FALSIFIED`);
  if (readFailed > 0) parts.push(`${readFailed} could not be read`);
  if (notExpressible > 0) parts.push(`${notExpressible} not stated checkably`);
  const head = parts.join(" · ");
  if (readFailed > 0) {
    return `${head} — INCOMPLETE. A claim that could not be re-read is not a claim that holds. (exit ${VERIFY_EXIT.Unverifiable})`;
  }
  if (falsified > 0) {
    return `${head} — the design has moved away from what this contract records. (exit ${VERIFY_EXIT.Falsified})`;
  }
  if (notExpressible > 0) {
    return (
      `${head} — every claim this tool can re-read still holds. The rest are worded in prose ` +
      `that names no Figma fact, so they were NOT verified; re-word them in the contract if you ` +
      `want them gated. (exit ${VERIFY_EXIT.Verified})`
    );
  }
  return `${head} — every claim re-read and still true. (exit ${VERIFY_EXIT.Verified})`;
}

function describeAxes(axes: Record<string, string[]>): string {
  const entries = Object.entries(axes);
  if (entries.length === 0) return "none";
  return entries.map(([a, o]) => `${a}=${o.join("|")}`).join(", ");
}

function truncate(text: string, max = 90): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
