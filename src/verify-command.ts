/**
 * `design-sync verify` — re-read the contract's claims against the design source
 * (issue #92).
 *
 * ## Why it is not `check`
 *
 * | | compares | answers |
 * |---|---|---|
 * | `check` | rendered code ↔ current Figma | does the build match the design **today**? |
 * | `verify` | the contract's recorded **claims** ↔ current Figma | are the assumptions this component was built on still true? |
 *
 * The gap is **absence claims**, and it is where every fabrication in this project
 * has lived. A drift check compares values that exist; if design adds a mode after
 * handoff, the check has no row for a mode it was never told about while
 * `notInFigma` quietly goes false.
 *
 * ## Why it is cheap, which is the point
 *
 * **No browser and no rendered DOM** — one Figma read per contract plus a JSON
 * comparison. So unlike `check` (which needs `storybook dev` and Playwright) this
 * runs anywhere `audit` runs, in seconds, with just a `FIGMA_PAT`. It scales with
 * *components*, not with stories, which is what makes it the realistic gate for a
 * 50+ component library.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { glob } from "tinyglobby";

import { loadConfig } from "./config.js";
import { extractClaims, type ContractClaims } from "./contract-claims.js";
import {
  VERIFY_EXIT,
  verifyClaims,
  verifyExitCode,
  verifySummary,
  type DesignSourceSnapshot,
  type VerifyOutcome,
} from "./contract-verify.js";

export interface VerifyOptions {
  cwd: string;
  /** Globs for contract files. Defaults to `contracts/*.spec.json`. */
  contractGlobs: string[];
  /** Print every claim, not just the ones that are not verified. */
  full: boolean;
  json: boolean;
}

export function parseVerifyArgs(rest: string[]): VerifyOptions {
  const globs: string[] = [];
  let full = false;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--full") full = true;
    else if (arg === "--json") json = true;
    else if (arg === "--contracts") {
      const value = rest[++i];
      if (value === undefined) throw new Error("--contracts needs a glob");
      globs.push(value);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    cwd: process.cwd(),
    contractGlobs: globs.length > 0 ? globs : ["contracts/*.spec.json"],
    full,
    json,
  };
}

interface FigmaComponentSet {
  variantAxes: Record<string, string[]>;
  componentProperties: Record<string, string>;
}

/**
 * Read one component set's axes and properties.
 *
 * `componentPropertyDefinitions` is the single source for both: a `VARIANT` entry
 * is an axis with `variantOptions`, anything else is a component property. That is
 * exactly the distinction the checkable absence claims turn on.
 */
async function readComponentSet(
  fileKey: string,
  nodeId: string,
  pat: string,
): Promise<FigmaComponentSet | undefined> {
  const url = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&depth=1`;
  const res = await fetch(url, { headers: { "X-Figma-Token": pat } });
  if (!res.ok) return undefined;
  const body = (await res.json()) as {
    nodes?: Record<string, { document?: { componentPropertyDefinitions?: Record<string, unknown> } }>;
  };
  const defs = body.nodes?.[nodeId]?.document?.componentPropertyDefinitions;
  if (!defs) return undefined;
  const variantAxes: Record<string, string[]> = {};
  const componentProperties: Record<string, string> = {};
  for (const [rawName, rawDef] of Object.entries(defs)) {
    const def = rawDef as { type?: string; variantOptions?: unknown };
    // Figma suffixes non-variant property names with an instance id (`Label#2:0`);
    // the contract speaks the human name, so strip it.
    const name = rawName.split("#")[0]!;
    if (def.type === "VARIANT" && Array.isArray(def.variantOptions)) {
      variantAxes[name] = def.variantOptions.filter((o): o is string => typeof o === "string");
    } else if (typeof def.type === "string") {
      componentProperties[name] = def.type;
    }
  }
  return { variantAxes, componentProperties };
}

/** Batch-resolve node existence. Missing ids come back in `missing`, never as an error. */
async function readNodes(
  fileKey: string,
  ids: readonly string[],
  pat: string,
): Promise<{ present: Set<string>; missing: Set<string> }> {
  const present = new Set<string>();
  const missing = new Set<string>();
  if (ids.length === 0) return { present, missing };
  // Chunked so a component with 18 variant nodes does not build an unbounded URL.
  const CHUNK = 40;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const url = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${batch.map(encodeURIComponent).join(",")}&depth=1`;
    const res = await fetch(url, { headers: { "X-Figma-Token": pat } });
    if (!res.ok) {
      // A failed read is NOT evidence of absence. Leaving these out of both sets
      // makes them `unverifiable`, which is the honest verdict.
      continue;
    }
    const body = (await res.json()) as { nodes?: Record<string, unknown> };
    for (const id of batch) {
      if (body.nodes && body.nodes[id]) present.add(id);
      else missing.add(id);
    }
  }
  return { present, missing };
}

/** The Figma node id of the component set a contract is about, if it records one. */
function componentSetId(raw: unknown): string | undefined {
  const doc = raw as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") return undefined;
  const source = doc["source"] as Record<string, unknown> | undefined;
  for (const key of ["componentSet", "componentSetId", "nodeId"]) {
    const value = source?.[key] ?? doc[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export interface ContractVerification {
  claims: ContractClaims;
  outcome: VerifyOutcome;
}

export async function runVerify(opts: VerifyOptions): Promise<number> {
  const pat = process.env["FIGMA_PAT"];
  const files = await glob(opts.contractGlobs, { cwd: opts.cwd, absolute: false });
  if (files.length === 0) {
    console.error(
      `No contracts matched ${opts.contractGlobs.join(", ")}. ` +
        `Contracts are written by the \`component-handoff\` skill into \`contracts/\`; ` +
        `nothing was verified.`,
    );
    return VERIFY_EXIT.CouldNotRun;
  }
  if (!pat) {
    console.error(
      `FIGMA_PAT is not set, so the design source cannot be re-read and no claim can be ` +
        `verified. Nothing was checked — this is not a pass.`,
    );
    return VERIFY_EXIT.CouldNotRun;
  }

  let config: Awaited<ReturnType<typeof loadConfig>> | undefined;
  try {
    config = await loadConfig(opts.cwd);
  } catch {
    config = undefined;
  }

  const verifications: ContractVerification[] = [];
  for (const file of files.sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(resolve(opts.cwd, file), "utf8"));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${file}: could not be parsed (${message}); no claims were read from it.`);
      verifications.push({
        claims: { path: file, claims: [], gaps: [`unparseable: ${message}`] },
        outcome: {
          results: [],
          counts: { verified: 0, falsified: 0, unverifiable: 0 },
          unverifiable: { "read-failed": 0, "not-expressible": 0 },
          gaps: [`unparseable: ${message}`],
        },
      });
      continue;
    }
    const claims = extractClaims(file, raw);
    const fileKey = claims.fileKey ?? config?.fileKey;
    const snapshot: DesignSourceSnapshot = { readAt: new Date().toISOString() };
    if (fileKey) {
      const setId = componentSetId(raw);
      if (setId) {
        const set = await readComponentSet(fileKey, setId, pat);
        if (set) {
          snapshot.variantAxes = set.variantAxes;
          snapshot.componentProperties = set.componentProperties;
        }
      }
      const nodeIds = [
        ...new Set(claims.claims.map((c) => c.nodeId).filter((id): id is string => !!id)),
      ];
      const { present, missing } = await readNodes(fileKey, nodeIds, pat);
      snapshot.nodesPresent = present;
      snapshot.nodesMissing = missing;
    } else {
      claims.gaps.push(
        "no Figma file key in the contract or in design-sync.config.json, so nothing could be re-read.",
      );
    }
    verifications.push({ claims, outcome: verifyClaims(claims.claims, snapshot, claims.gaps) });
  }

  if (opts.json) {
    console.log(JSON.stringify(toJson(verifications), null, 2));
  } else {
    printReport(verifications, opts.full);
  }
  return worstExit(verifications);
}

function worstExit(verifications: readonly ContractVerification[]): number {
  let worst: number = VERIFY_EXIT.Verified;
  for (const v of verifications) {
    const code = verifyExitCode(v.outcome);
    // Ordering, not max: `CouldNotRun` is not reachable here, and
    // `Unverifiable` (2) must outrank `Falsified` (1) — which numeric max happens
    // to give, but relying on that would break the moment a code is added.
    if (code === VERIFY_EXIT.Unverifiable) worst = VERIFY_EXIT.Unverifiable;
    else if (code === VERIFY_EXIT.Falsified && worst !== VERIFY_EXIT.Unverifiable) {
      worst = VERIFY_EXIT.Falsified;
    }
  }
  return worst;
}

function toJson(verifications: readonly ContractVerification[]): unknown {
  return {
    tool: "@metalab/storybook-design-sync",
    command: "verify",
    schema: 1,
    contracts: verifications.map((v) => ({
      path: v.claims.path,
      component: v.claims.component ?? null,
      counts: v.outcome.counts,
      unverifiable: v.outcome.unverifiable,
      gaps: v.outcome.gaps,
      claims: v.outcome.results.map((r) => ({
        kind: r.claim.kind,
        path: r.claim.path,
        statement: r.claim.statement,
        verdict: r.verdict,
        reason: r.reason ?? null,
        evidence: r.evidence,
        citedRead: r.claim.citedRead ?? null,
      })),
    })),
    exitCode: worstExit(verifications),
  };
}

const MARK: Record<string, string> = {
  verified: "✓",
  falsified: "✗",
  unverifiable: "?",
};

function printReport(verifications: readonly ContractVerification[], full: boolean): void {
  for (const { claims, outcome } of verifications) {
    console.log(`\n${claims.path}${claims.component ? ` — ${claims.component}` : ""}`);
    const shown = full
      ? outcome.results
      : outcome.results.filter((r) => r.verdict !== "verified");
    for (const r of shown) {
      console.log(`  ${MARK[r.verdict]} ${r.claim.path} — ${r.claim.statement}`);
      console.log(`      ${r.evidence}`);
      if (r.claim.citedRead) {
        console.log(`      contract cited: ${r.claim.citedRead}`);
      }
    }
    if (!full && shown.length === 0) {
      console.log(`  ✓ ${outcome.counts.verified} claim(s), all still true.`);
    }
    for (const gap of outcome.gaps) console.log(`  ⚠ ${gap}`);
    console.log(`  ${verifySummary(outcome)}`);
  }
}
