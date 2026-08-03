/**
 * Reading a contract as a **list of claims that can be re-checked** (issue #92).
 *
 * ## Why this exists
 *
 * `contracts/<component>.spec.json` records what the design said on handoff day.
 * Until now nothing re-read it, so its statements aged silently.
 *
 * A drift check cannot cover this, and the gap is specifically **absence claims**.
 * A drift check compares values that exist; if design adds a dark mode after
 * handoff, the check has no row for a mode it was never told about, while
 * `notInFigma: ["dark mode"]` quietly becomes false. That is not hypothetical:
 * two comments asserting the design source lacked something were both untrue and
 * licensed 24 invented theme values, 18 of them wrong. They survived review
 * *because they read as settled findings*. Nothing could have caught them except
 * re-reading the source.
 *
 * ## The three verdicts, and the one that must never be mistaken for another
 *
 * `verified` / `falsified` / `unverifiable`. The third is the whole point of
 * separating them: a claim that could not be re-read is **not** a passing claim,
 * and a run full of them is not a clean run. Same discipline as `check`'s exit
 * codes, where incomplete coverage outranks a found problem.
 *
 * ## What is actually checkable today, which is less than the issue assumed
 *
 * Issue #92 leads with `designSource.collections`, `literals`, `sharedValues`,
 * `textStyles` and `uncheckable`. **Neither contract in existence carries a
 * `designSource` block at all** — both were written before it was added on
 * 2026-07-31. Verifying those keys against the real contracts would report
 * `unverifiable` for every one: true, and useless.
 *
 * So this reads whatever the contract actually carries, and says plainly when a
 * contract predates `designSource` rather than reporting its absence as a
 * failure. The keys both real contracts do carry — `notInFigma`,
 * `variantNodeIds`, `tokenBindings` — include the highest-value check in the
 * issue's own list.
 *
 * Pure: it turns JSON into claims and nothing else. The Figma reads live in
 * `contract-verify.ts`.
 */

/** What a claim asserts, which decides how it is re-checked. */
export type ClaimKind =
  /** "the design does not specify this" — falsified by finding that it does. */
  | "absence"
  /** "this Figma node exists and is this variant" — falsified by it being gone. */
  | "node"
  /** "this slot binds this Figma token" — falsified by a different binding. */
  | "binding"
  /** "this collection has these modes, by name" — falsified by a change. */
  | "collection"
  /** "these variables share a value" — falsified by divergence. */
  | "shared-value"
  /** "this value is a raw literal, not bound" — falsified by it becoming bound. */
  | "literal"
  /** "the tool cannot read this property" — falsified by it becoming readable. */
  | "uncheckable";

export interface ContractClaim {
  kind: ClaimKind;
  /** Dotted path in the contract, so a report can cite exactly what it read. */
  path: string;
  /** One-line restatement in the contract's own words. */
  statement: string;
  /** Figma node id this claim is about, when it names one. */
  nodeId?: string;
  /** Figma variable / token name this claim is about, when it names one. */
  token?: string;
  /** The reason the contract gave, when it gave one. Quoted back, never judged. */
  reason?: string;
  /**
   * The read the contract cited for this claim, when it cited one.
   *
   * The working agreement says an absence claim must cite the read that
   * established it. Carrying it here lets a report show the original citation
   * next to the fresh one — which is what turns "trust me" into "here is then,
   * here is now".
   */
  citedRead?: string;
}

export interface ContractClaims {
  /** Consumer-relative path of the spec. */
  path: string;
  component?: string;
  /** The Figma file the contract was written against, when it records one. */
  fileKey?: string;
  claims: ContractClaim[];
  /**
   * Notes about what could NOT be turned into claims — an absent `designSource`
   * block, an unparseable section. Reported, never silent: a contract that
   * yields few claims must not look like a contract that passed.
   */
  gaps: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Keys that are documentation rather than claims, skipped everywhere. */
const META_KEYS = new Set(["$comment", "$schema"]);

/**
 * `notInFigma` — the highest-value claims in the contract.
 *
 * Shape varies because the file is written by a skill and validated by nothing:
 * the Button's is an object of named entries each with `reason`/`utility`, and the
 * issue's own example shows a plain array of strings. Both are read.
 */
function absenceClaims(
  raw: unknown,
  section: string,
  out: ContractClaim[],
  gaps: string[],
): void {
  if (raw === undefined || raw === null) return;
  if (Array.isArray(raw)) {
    raw.forEach((entry, i) => {
      const text = str(entry);
      if (text === undefined) return;
      out.push({
        kind: "absence",
        path: `${section}[${i}]`,
        statement: `the design does not specify ${text}`,
      });
    });
    return;
  }
  const obj = asRecord(raw);
  if (!obj) {
    gaps.push(`\`${section}\` is neither an object nor an array, so no absence claims were read.`);
    return;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (META_KEYS.has(key)) continue;
    const detail = asRecord(value);
    const reason = detail ? str(detail["reason"]) : str(value);
    const claim: ContractClaim = {
      kind: "absence",
      path: `${section}.${key}`,
      statement: `the design does not specify ${key}`,
    };
    if (reason !== undefined) claim.reason = reason;
    const nodeId = detail ? str(detail["nodeId"]) : undefined;
    if (nodeId !== undefined) claim.nodeId = nodeId;
    out.push(claim);
  }
}

/** `variantNodeIds` / `childNodeIds` — "this node exists and is this thing". */
function nodeClaims(raw: unknown, section: string, out: ContractClaim[]): void {
  const obj = asRecord(raw);
  if (!obj) return;
  for (const [name, value] of Object.entries(obj)) {
    if (META_KEYS.has(name)) continue;
    const nodeId = str(value);
    if (nodeId === undefined) continue;
    out.push({
      kind: "node",
      path: `${section}.${name}`,
      statement: `\`${name}\` is Figma node ${nodeId}`,
      nodeId,
    });
  }
}

/**
 * `designSource` — present only on contracts written after 2026-07-31.
 *
 * Its absence is a **gap**, not a falsified claim: a contract that predates the
 * block never asserted these facts, so there is nothing to contradict. Saying
 * "falsified" there would invent a finding; saying nothing would let a thin
 * contract pass as a thorough one.
 */
function designSourceClaims(raw: unknown, out: ContractClaim[], gaps: string[]): void {
  const ds = asRecord(raw);
  if (!ds || Object.keys(ds).filter((k) => !META_KEYS.has(k)).length === 0) {
    gaps.push(
      "no `designSource` block — this contract predates it (added 2026-07-31), so the " +
        "design-source facts behind it were never recorded and cannot be re-checked. " +
        "Re-run `handoff-ready-component` to establish them.",
    );
    return;
  }
  const citedRead = str(ds["readAt"]);
  const withRead = (claim: ContractClaim): ContractClaim =>
    citedRead === undefined ? claim : { ...claim, citedRead };

  for (const entry of Array.isArray(ds["collections"]) ? ds["collections"] : []) {
    const c = asRecord(entry);
    const name = c ? str(c["name"]) : undefined;
    if (!c || name === undefined) continue;
    const modes = (Array.isArray(c["modes"]) ? c["modes"] : [])
      .map((m) => (asRecord(m) ? str(asRecord(m)!["name"]) : undefined))
      .filter((n): n is string => n !== undefined);
    out.push(
      withRead({
        kind: "collection",
        path: `designSource.collections.${name}`,
        statement:
          modes.length > 0
            ? `collection "${name}" has modes ${modes.map((m) => `"${m}"`).join(", ")}`
            : `collection "${name}" exists`,
        token: name,
      }),
    );
  }

  for (const [i, entry] of (Array.isArray(ds["sharedValues"]) ? ds["sharedValues"] : []).entries()) {
    const sv = asRecord(entry);
    const value = sv ? str(sv["value"]) : undefined;
    const vars = sv && Array.isArray(sv["variables"]) ? sv["variables"].filter((v) => str(v)) : [];
    if (!sv || value === undefined || vars.length < 2) continue;
    out.push(
      withRead({
        kind: "shared-value",
        path: `designSource.sharedValues[${i}]`,
        statement: `${vars.join(" and ")} all resolve to ${value}`,
      }),
    );
  }

  for (const [i, entry] of (Array.isArray(ds["literals"]) ? ds["literals"] : []).entries()) {
    const lit = asRecord(entry);
    const nodeId = lit ? str(lit["nodeId"]) : undefined;
    const property = lit ? str(lit["property"]) : undefined;
    if (!lit || nodeId === undefined || property === undefined) continue;
    const claim: ContractClaim = withRead({
      kind: "literal",
      path: `designSource.literals[${i}]`,
      statement: `${property} on node ${nodeId} is a raw literal, not bound to a variable`,
      nodeId,
    });
    const value = str(lit["value"]);
    if (value !== undefined) claim.reason = `recorded value ${value}`;
    out.push(claim);
  }

  for (const [i, entry] of (Array.isArray(ds["uncheckable"]) ? ds["uncheckable"] : []).entries()) {
    const un = asRecord(entry);
    const nodeId = un ? str(un["nodeId"]) : undefined;
    const property = un ? str(un["property"]) : undefined;
    if (!un || nodeId === undefined || property === undefined) continue;
    const claim: ContractClaim = withRead({
      kind: "uncheckable",
      path: `designSource.uncheckable[${i}]`,
      statement: `${property} on node ${nodeId} cannot be read by this tool`,
      nodeId,
    });
    const reason = str(un["reason"]);
    if (reason !== undefined) claim.reason = reason;
    out.push(claim);
  }
}

/**
 * Turn a parsed contract into the claims a re-read can verify.
 *
 * Deliberately tolerant of shape, for the reason `contract.ts` already documents:
 * the file is skill-written and validated by nothing, so a reader that assumed
 * one shape would silently see nothing on another — the same failure as reading
 * nothing at all, minus the honesty.
 */
export function extractClaims(path: string, raw: unknown): ContractClaims {
  const doc = asRecord(raw);
  const claims: ContractClaim[] = [];
  const gaps: string[] = [];
  if (!doc) {
    return {
      path,
      claims: [],
      gaps: [`${path} is not a JSON object, so no claims could be read from it.`],
    };
  }

  const result: ContractClaims = { path, claims, gaps };
  const component = str(doc["component"]);
  if (component !== undefined) result.component = component;
  const source = asRecord(doc["source"]);
  const fileKey = str(doc["fileKey"]) ?? (source ? str(source["fileKey"]) : undefined);
  if (fileKey !== undefined) result.fileKey = fileKey;

  // Two distinct absence sections exist in the wild. `notSpecifiedByFigma` is the
  // Card's spelling of the same claim; reading only one would silently skip half.
  absenceClaims(doc["notInFigma"], "notInFigma", claims, gaps);
  absenceClaims(doc["notSpecifiedByFigma"], "notSpecifiedByFigma", claims, gaps);
  nodeClaims(doc["variantNodeIds"], "variantNodeIds", claims);
  nodeClaims(doc["childNodeIds"], "childNodeIds", claims);
  designSourceClaims(doc["designSource"], claims, gaps);

  if (claims.length === 0) {
    gaps.push(
      "no re-checkable claims were found in this contract at all, so a clean " +
        "verify result would say nothing about it.",
    );
  }
  return result;
}
