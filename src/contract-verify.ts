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
import type { ResolvedVariable } from "./variable-resolution.js";

/**
 * The grammar of a real Figma node id: `1:2`, or an instance path like
 * `I192:31517;227:16985;34:12257`. Everything else is prose.
 *
 * This is a guard, not a parser: a prose id ("68:16009 / 68:16113 (Star / X icon
 * instances)") must never be sent to the nodes endpoint — one rejected batch
 * drops every OTHER id in the chunk into "unread", so one badly-worded contract
 * entry would cost clean claims their verdicts.
 */
const NODE_ID_RE = /^[IT]?\d+:\d+(?:;\d+:\d+)*$/;

export function isCleanNodeId(id: string): boolean {
  return NODE_ID_RE.test(id);
}

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
  /**
   * Every variable collection in the file, as read this time. Absent when
   * `/variables/local` could not be read — which makes collection claims
   * `read-failed`, never verified.
   *
   * `id` is carried because **collection NAME IS NOT UNIQUE.** The reference file
   * has two named `Typography` and two named `Size`: a local one and a second
   * imported from another library file (composite ids, `<libKey>/<id>`). A checker
   * keyed on name alone would silently compare the wrong collection.
   */
  collections?: ReadonlyArray<{ id: string; name: string; modes: readonly string[] }>;
  /**
   * Every variable in the file with its per-mode RESOLVED values (aliases
   * followed). Absent when `/variables/local` could not be read — which makes
   * shared-value claims `read-failed`, never verified.
   */
  variables?: ReadonlyArray<ResolvedVariable>;
  /**
   * Per node named by a `literal` claim: which properties are bound to variables
   * on this read, and the current value of the claimed property. A node absent
   * here was not read — `read-failed`, never verified.
   */
  literalNodes?: Readonly<
    Record<string, { boundProperties: readonly string[]; values: Readonly<Record<string, unknown>> }>
  >;
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
 * quietly passed.
 *
 * The wording used to say "no contract in this project carries a `designSource`
 * block yet, so there has been no real input to build it against" — true when
 * written, and **false from the moment a contract carried one**. The Dialog
 * contract (2026-08-06) printed that sentence 14 times while the block it claimed
 * did not exist was being read two lines above. A stale excuse that contradicts its
 * own input is worse than no explanation: it tells the reader not to expect the
 * check, on grounds they can see are wrong.
 *
 * So the message now states only what is true — the checker is unbuilt — and does
 * not editorialise about why.
 */
/**
 * `designSource.collections` — "this collection has these modes".
 *
 * The claim `verify` was built for. The fabrication that motivated the whole
 * `designSource` block was *"SDS defines no dark mode"*, written as settled fact,
 * false, and worth 24 invented theme values of which 18 were wrong. This is the
 * check that catches it.
 *
 * **Matched by id when the contract has one, by name only when the name is
 * unambiguous, and refused otherwise.** The reference file has two collections
 * named `Typography` and two named `Size` — one local, one imported from another
 * library — so guessing between them would produce a confident verdict about the
 * wrong collection. Refusing names both candidates instead.
 *
 * Only the **modes** are gated. Variable counts move whenever a designer adds a
 * variable, which is ordinary work rather than a broken claim, so they are reported
 * as context and never as a verdict.
 */
function verifyCollection(claim: ContractClaim, snap: DesignSourceSnapshot): ClaimResult {
  if (!snap.collections) {
    return {
      claim,
      verdict: "unverifiable",
      reason: "read-failed",
      evidence:
        "the file's variable collections could not be read this time, so this claim was not " +
        "re-checked. A failed read is not evidence that the claim still holds.",
    };
  }

  const expected = claim.expectedModes;
  if (!expected || expected.length === 0) {
    return {
      claim,
      verdict: "unverifiable",
      reason: "not-expressible",
      evidence:
        "the contract records this collection with no modes, so there is nothing to compare. " +
        "Re-run `handoff-ready-component` to record them.",
    };
  }

  const name = claim.token;
  const byName = snap.collections.filter((c) => c.name === name);

  if (byName.length === 0) {
    return {
      claim,
      verdict: "falsified",
      evidence:
        `no collection named "${name}" exists in the file now. Present: ` +
        `${snap.collections.map((c) => `"${c.name}"`).join(", ")}.`,
    };
  }

  if (byName.length > 1) {
    return {
      claim,
      verdict: "unverifiable",
      reason: "not-expressible",
      evidence:
        `"${name}" is ambiguous — ${byName.length} collections share that name, so this claim ` +
        `cannot be matched to one without an id. Candidates: ` +
        `${byName.map((c) => `${c.id} (modes ${c.modes.join("|")})`).join(" · ")}. ` +
        `Record the collection's id in the contract to make this checkable. ` +
        `A composite id containing "/" is a collection imported from another library file.`,
    };
  }

  const actual = byName[0]!;
  const want = [...expected].sort();
  const got = [...actual.modes].sort();
  const same = want.length === got.length && want.every((m, i) => m === got[i]);

  if (!same) {
    return {
      claim,
      verdict: "falsified",
      evidence:
        `collection "${name}" (${actual.id}) now has modes ${got.map((m) => `"${m}"`).join(", ")}; ` +
        `the contract recorded ${want.map((m) => `"${m}"`).join(", ")}. A mode added or removed ` +
        `since handoff changes what the theme must define.`,
    };
  }

  return {
    claim,
    verdict: "verified",
    evidence: `collection "${name}" (${actual.id}) still has exactly modes ${got.map((m) => `"${m}"`).join(", ")}.`,
  };
}

/**
 * `designSource.sharedValues` — "these variables resolve to the same value".
 *
 * The claim exists because of a real incident: two variables sharing a hex were
 * collapsed onto one theme token, and when design later changed one, the other
 * followed — an invisible border, silent until a later change exposed it. The
 * moment that matters is the values DIVERGING, so that is what gets gated:
 * current-vs-current, mode by mode. The recorded value only dates the claim.
 */
function verifySharedValue(claim: ContractClaim, snap: DesignSourceSnapshot): ClaimResult {
  const names = claim.variables;
  if (!names || names.length < 2) {
    return {
      claim,
      verdict: "unverifiable",
      reason: "not-expressible",
      evidence:
        "the claim carries fewer than two variable names as data, so there is nothing to " +
        "compare. Re-run `handoff-ready-component` to record them.",
    };
  }
  if (!snap.variables) {
    return {
      claim,
      verdict: "unverifiable",
      reason: "read-failed",
      evidence:
        "the file's variables could not be read this time, so this claim was not re-checked. " +
        "A failed read is not evidence that the values still agree.",
    };
  }

  const matched: ResolvedVariable[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const candidates = snap.variables.filter((v) => v.name === name);
    if (candidates.length === 0) {
      missing.push(name);
    } else if (candidates.length > 1) {
      return {
        claim,
        verdict: "unverifiable",
        reason: "not-expressible",
        evidence:
          `"${name}" is ambiguous — ${candidates.length} variables share that name ` +
          `(${candidates.map((c) => `${c.collectionName} ${c.collectionId}`).join(" · ")}), so this ` +
          `claim cannot be matched without a collection recorded in the contract.`,
      };
    } else {
      matched.push(candidates[0]!);
    }
  }
  if (missing.length > 0) {
    return {
      claim,
      verdict: "falsified",
      evidence:
        `${missing.map((n) => `"${n}"`).join(" and ")} no longer exist${missing.length === 1 ? "s" : ""} ` +
        `in the file (renames cannot be traced). The shared-value assertion as recorded no longer ` +
        `holds; re-run \`handoff-ready-component\` to re-establish it.`,
    };
  }

  const collectionIds = new Set(matched.map((v) => v.collectionId));
  if (collectionIds.size > 1) {
    return {
      claim,
      verdict: "unverifiable",
      reason: "not-expressible",
      evidence:
        `the named variables live in different collections ` +
        `(${matched.map((v) => `${v.name} in ${v.collectionName}`).join(" · ")}), whose modes do not ` +
        `line up, so a per-mode comparison is undefined. Record variables from one collection per entry.`,
    };
  }

  // The mode universe is the UNION across the matched variables — a mode one of
  // them failed to resolve must fail the comparison, not silently shrink it.
  const modes = [
    ...new Set(matched.flatMap((v) => [...Object.keys(v.resolvedByMode), ...v.unresolved])),
  ];
  for (const variable of matched) {
    const failed = modes.filter((m) => variable.resolvedByMode[m] === undefined);
    if (failed.length > 0) {
      return {
        claim,
        verdict: "unverifiable",
        reason: "read-failed",
        evidence:
          `"${variable.name}" could not be resolved in mode(s) ` +
          `${failed.map((m) => `"${m}"`).join(", ")} (broken alias chain?), ` +
          `so the comparison was not made. This is not a pass.`,
      };
    }
  }

  for (const mode of modes) {
    const values = matched.map((v) => v.resolvedByMode[mode]!);
    if (new Set(values).size > 1) {
      return {
        claim,
        verdict: "falsified",
        evidence:
          `in mode "${mode}": ${matched.map((v) => `${v.name} = ${v.resolvedByMode[mode]}`).join(", ")} — ` +
          `they no longer share a value. Anything in the theme that mapped them to one token is now ` +
          `coupling two values the design has separated.`,
      };
    }
  }

  return {
    claim,
    verdict: "verified",
    evidence:
      `still shared in every mode: ` +
      `${modes.map((m) => `"${m}" = ${matched[0]!.resolvedByMode[m]}`).join(", ")} across ` +
      `${matched.map((v) => v.name).join(" and ")}.`,
  };
}

/**
 * `designSource.literals` — "this value is typed in, not bound to a variable".
 *
 * The premise the code was built on: an unbound value has no token to map, so
 * drift can compare the number but never attribute it. Only the BINDING is gated
 * — a changed value that stayed unbound is design work drift checking already
 * sees, not a broken claim.
 */
function verifyLiteral(claim: ContractClaim, snap: DesignSourceSnapshot): ClaimResult {
  const property = claim.property;
  if (property === undefined || claim.nodeId === undefined) {
    return {
      claim,
      verdict: "unverifiable",
      reason: "not-expressible",
      evidence: "the claim names no node/property pair, so there is nothing to re-read.",
    };
  }
  const node = snap.literalNodes?.[claim.nodeId];
  if (!node) {
    return {
      claim,
      verdict: "unverifiable",
      reason: "read-failed",
      evidence: `node ${claim.nodeId} was not read on this pass, so its bindings are unconfirmed.`,
    };
  }
  if (node.boundProperties.includes(property)) {
    return {
      claim,
      verdict: "falsified",
      evidence:
        `${property} on node ${claim.nodeId} is now BOUND to a variable — the premise "raw ` +
        `literal" no longer holds, and a token mapping may now exist for it. Re-run ` +
        `\`handoff-ready-component\` and let the binding into the comparison.`,
    };
  }
  const current = node.values[property];
  const currentText = current === undefined ? undefined : String(current);
  const recorded = claim.recordedValue;
  let detail = "";
  if (currentText !== undefined && recorded !== undefined && currentText !== recorded) {
    detail =
      `; the value moved ${recorded} → ${currentText} but remains unbound — a design value ` +
      `change, which drift checking sees, not a binding change`;
  } else if (currentText !== undefined) {
    detail = `; current value ${currentText}${recorded !== undefined ? ` (recorded ${recorded})` : ""}`;
  }
  return {
    claim,
    verdict: "verified",
    evidence: `${property} on node ${claim.nodeId} is still a raw literal${detail}.`,
  };
}

/**
 * `designSource.uncheckable` — "the tool cannot read this property here".
 *
 * Both real entries put PROSE in `nodeId` ("68:16009 / 68:16113 (Star / X icon
 * instances, wherever used…)"), which names no single node to re-read, and
 * inventing a parse would re-check the wrong node confidently. So prose gets a
 * precise path to becoming checkable, and a clean id is reported as asserted —
 * the re-check itself stays unbuilt until a contract exists to build it against,
 * the same rule the rest of `designSource` followed.
 */
function verifyUncheckable(claim: ContractClaim): ClaimResult {
  if (claim.nodeId === undefined || !isCleanNodeId(claim.nodeId)) {
    return {
      claim,
      verdict: "unverifiable",
      reason: "not-expressible",
      evidence:
        `the entry's nodeId is prose (${claim.nodeId ? `"${truncate(claim.nodeId)}"` : "absent"}), ` +
        `not a node id, so nothing can be re-read. Record one clean node id per entry — one entry ` +
        `per node — to make this claim checkable.`,
    };
  }
  return {
    claim,
    verdict: "unverifiable",
    reason: "not-expressible",
    evidence:
      "re-checking tool-limitation claims is not built; the claim is reported as asserted, not verified.",
  };
}

function verifyNotImplemented(claim: ContractClaim): ClaimResult {
  return {
    claim,
    verdict: "unverifiable",
    reason: "not-expressible",
    evidence:
      `re-checking \`${claim.kind}\` claims is not implemented, so this claim was NOT ` +
      `verified — it is reported here only as something the contract asserts.`,
  };
}

export function verifyClaims(
  claims: readonly ContractClaim[],
  snap: DesignSourceSnapshot,
  gaps: readonly string[] = [],
): VerifyOutcome {
  const results = claims.map((claim): ClaimResult => {
    switch (claim.kind) {
      case "collection":
        return verifyCollection(claim, snap);
      case "absence":
        return verifyAbsence(claim, snap);
      case "node":
        return verifyNode(claim, snap);
      case "shared-value":
        return verifySharedValue(claim, snap);
      case "literal":
        return verifyLiteral(claim, snap);
      case "uncheckable":
        return verifyUncheckable(claim);
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
  // Nothing verified, yet claims were made: the contract was not gated at all, and
  // a gate that passes when nothing was gated is not a gate.
  //
  // `not-expressible` exiting 0 is right for a MIX — Button verifies 19 and cannot
  // express 2, and failing that would push people to switch `verify` off. It is
  // wrong when the verified count is zero, which is what the Dialog contract
  // exposed: 0 verified, 23 not expressible, exit 0, and a summary reading "every
  // claim this tool can re-read still holds" — vacuously true, because there were
  // none. Incomplete coverage outranks a clean result, the same rule `check` uses.
  if (outcome.counts.verified === 0 && totalClaims(outcome) > 0) {
    return VERIFY_EXIT.Unverifiable;
  }
  return VERIFY_EXIT.Verified;
}

/** Every claim the run considered, whatever the verdict. */
function totalClaims(outcome: VerifyOutcome): number {
  return (
    outcome.counts.verified +
    outcome.counts.falsified +
    outcome.unverifiable["read-failed"] +
    outcome.unverifiable["not-expressible"]
  );
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
    // Zero verified is not a pass, and must not be described as one. "Every claim
    // this tool can re-read still holds" is vacuously true when there are none,
    // which is the most misleading thing this command could say.
    if (verified === 0) {
      return (
        `${head} — NOTHING in this contract was verified. Every claim is worded in prose that ` +
        `names no Figma fact this tool can re-read, so this run gated nothing at all. Re-word ` +
        `them to name the axis, node or variable they rest on. (exit ${VERIFY_EXIT.Unverifiable})`
      );
    }
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
