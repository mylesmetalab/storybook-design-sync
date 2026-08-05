import { describe, expect, it } from "vitest";

import { extractClaims, type ContractClaim } from "./contract-claims.js";
import {
  VERIFY_EXIT,
  parseAbsenceAssertion,
  verifyClaims,
  verifyExitCode,
  type VerifyOutcome,
  verifySummary,
  type DesignSourceSnapshot,
} from "./contract-verify.js";

/**
 * The value of `verify` is entirely in refusing to call an unchecked claim true.
 * A false `verified` re-creates the exact failure it exists to prevent — the two
 * "SDS defines no dark mode" comments that were never checked, read as settled
 * findings, and licensed 24 invented values.
 *
 * So the tests weight the refusals, and the two directions of the blocking rule.
 */

/** The reference Button's real axes, read from Figma 2026-08-03. */
const BUTTON_AXES = {
  Variant: ["Primary", "Neutral", "Subtle"],
  State: ["Default", "Hover", "Disabled"],
  Size: ["Medium", "Small"],
};

function snap(over: Partial<DesignSourceSnapshot> = {}): DesignSourceSnapshot {
  return {
    readAt: "2026-08-03T00:00:00.000Z",
    variantAxes: BUTTON_AXES,
    componentProperties: { Label: "TEXT", "Has Icon End": "BOOLEAN" },
    nodesPresent: new Set(["4185:3779"]),
    nodesMissing: new Set(),
    ...over,
  };
}

function absence(reason: string): ContractClaim {
  return { kind: "absence", path: "notInFigma.x", statement: "the design does not specify x", reason };
}

describe("parseAbsenceAssertion", () => {
  it("recognises a missing variant option", () => {
    expect(parseAbsenceAssertion(absence("The component set defines no Focus state."))).toEqual({
      kind: "no-axis-option",
      option: "Focus",
    });
  });

  it("recognises a missing axis", () => {
    expect(
      parseAbsenceAssertion(absence("The component set has no State axis and no click affordance.")),
    ).toEqual({ kind: "no-axis", axis: "State" });
  });

  it("recognises property-not-a-variant", () => {
    expect(
      parseAbsenceAssertion(
        absence("The Asset boolean is a component property on every variant, not a variant of its own."),
      ),
    ).toEqual({ kind: "property-not-axis", name: "Asset" });
  });

  /**
   * Declining is the safe outcome and must stay the default. A looser parser
   * would "recognise" a claim and then check it against the wrong fact, which
   * produces a confident wrong `verified` — strictly worse than an honest decline.
   */
  it.each([
    "Figma declares no motion. Duration/easing left to the browser default.",
    "Figma carries no heading semantics.",
    "16px is the intrinsic frame of the SDS Star/X icon components.",
    "Figma's Button Group is an instance of another component set.",
  ])("declines prose that names no Figma fact: %s", (reason) => {
    expect(parseAbsenceAssertion(absence(reason))).toBeUndefined();
  });

  it("declines an entry with no reason at all", () => {
    expect(
      parseAbsenceAssertion({ kind: "absence", path: "notInFigma.x", statement: "no x" }),
    ).toBeUndefined();
  });
});

describe("verifying absence claims", () => {
  it("verifies an absence the design still does not specify", () => {
    const [r] = verifyClaims([absence("The component set defines no Focus state.")], snap()).results;
    expect(r!.verdict).toBe("verified");
    // The evidence has to show what was read, or the verdict is unfalsifiable.
    expect(r!.evidence).toContain("Variant=Primary|Neutral|Subtle");
  });

  /**
   * The headline case, and the one the whole feature exists for: the design gained
   * something the code was built to ignore.
   */
  it("falsifies an absence the design now specifies", () => {
    const withFocus = snap({
      variantAxes: { ...BUTTON_AXES, State: ["Default", "Hover", "Focus", "Disabled"] },
    });
    const [r] = verifyClaims([absence("The component set defines no Focus state.")], withFocus)
      .results;
    expect(r!.verdict).toBe("falsified");
    expect(r!.evidence).toContain('axis "State" offers "Focus"');
    // It must route the work, not just report a diff.
    expect(r!.evidence).toMatch(/design → code handoff, not a drift fix/);
  });

  it("falsifies a no-axis claim when the axis appears", () => {
    const [r] = verifyClaims(
      [absence("The component set has no State axis and no click affordance.")],
      snap(),
    ).results;
    expect(r!.verdict).toBe("falsified");
    expect(r!.evidence).toContain('"State" axis');
  });

  it("verifies a no-axis claim when the axis really is absent", () => {
    const cardAxes = { Variant: ["Default", "Stroke"], Direction: ["Horizontal", "Vertical"] };
    const [r] = verifyClaims(
      [absence("The component set has no State axis and no click affordance.")],
      snap({ variantAxes: cardAxes }),
    ).results;
    expect(r!.verdict).toBe("verified");
  });

  it("falsifies property-not-a-variant when the property becomes an axis", () => {
    const [r] = verifyClaims(
      [absence("The Asset boolean is a component property, not a variant of its own.")],
      snap({ variantAxes: { ...BUTTON_AXES, Asset: ["On", "Off"] } }),
    ).results;
    expect(r!.verdict).toBe("falsified");
    expect(r!.evidence).toMatch(/one story per option/);
  });

  it("is unverifiable — never verified — when the component set could not be read", () => {
    const blind = { readAt: "now" } as DesignSourceSnapshot;
    const [r] = verifyClaims([absence("The component set defines no Focus state.")], blind).results;
    expect(r!.verdict).toBe("unverifiable");
    expect(r!.reason).toBe("read-failed");
    expect(r!.evidence).toMatch(/not a pass/);
  });

  it("marks unparseable prose not-expressible, and quotes the contract's own words", () => {
    const [r] = verifyClaims([absence("Figma carries no heading semantics.")], snap()).results;
    expect(r!.verdict).toBe("unverifiable");
    expect(r!.reason).toBe("not-expressible");
    expect(r!.evidence).toContain("Figma carries no heading semantics");
  });
});

describe("verifying node claims", () => {
  const node = (id: string): ContractClaim => ({
    kind: "node",
    path: `variantNodeIds.primary.default.medium`,
    statement: `primary.default.medium is Figma node ${id}`,
    nodeId: id,
  });

  it("verifies a node that still resolves", () => {
    expect(verifyClaims([node("4185:3779")], snap()).results[0]!.verdict).toBe("verified");
  });

  it("falsifies a node that no longer resolves", () => {
    const gone = snap({ nodesPresent: new Set(), nodesMissing: new Set(["4185:3779"]) });
    const [r] = verifyClaims([node("4185:3779")], gone).results;
    expect(r!.verdict).toBe("falsified");
    // Explains why this matters, not just that it changed.
    expect(r!.evidence).toMatch(/confusing drift row/);
  });

  it("is unverifiable when the node was never read", () => {
    const unread = snap({ nodesPresent: new Set(), nodesMissing: new Set() });
    const [r] = verifyClaims([node("4185:3779")], unread).results;
    expect(r!.verdict).toBe("unverifiable");
    expect(r!.reason).toBe("read-failed");
  });
});

describe("exit codes", () => {
  const claims = [absence("The component set defines no Focus state.")];

  it("exits 0 when everything checkable was checked and holds", () => {
    expect(verifyExitCode(verifyClaims(claims, snap()))).toBe(VERIFY_EXIT.Verified);
  });

  it("exits 1 on a falsified claim", () => {
    const withFocus = snap({ variantAxes: { ...BUTTON_AXES, State: ["Default", "Focus"] } });
    expect(verifyExitCode(verifyClaims(claims, withFocus))).toBe(VERIFY_EXIT.Falsified);
  });

  it("exits 2 on a failed read, outranking a falsified claim", () => {
    // "I re-read everything and found a problem" is a stronger claim than a run
    // with holes is entitled to make — same ordering as `check`.
    const blind = { readAt: "now" } as DesignSourceSnapshot;
    const mixed = verifyClaims(
      [
        absence("The component set defines no Focus state."),
        absence("The component set has no Direction axis."),
      ],
      blind,
    );
    expect(mixed.counts.falsified + mixed.counts.verified).toBe(0);
    expect(verifyExitCode(mixed)).toBe(VERIFY_EXIT.Unverifiable);
  });

  /**
   * The design tension worth pinning: prose that names no Figma fact is a property
   * of the contract's *wording*, not of the read. Blocking on it would mean
   * `verify` could never pass on either contract that exists, so it would be
   * switched off — worse than a narrower honest gate.
   */
  /**
   * CHANGED 2026-08-06, deliberately. This pair used to assert exit 0 for a contract
   * whose ONLY claim was inexpressible prose. The rule "not-expressible must not
   * block" is right for a MIX — Button verifies 19 and cannot express 2, and failing
   * that would push a team to switch `verify` off — but it conflated that with the
   * case where NOTHING was verified. The Dialog contract exposed it: 0 verified, 23
   * not expressible, exit 0, under a summary reading "every claim this tool can
   * re-read still holds". Vacuously true, because there were none.
   *
   * A single inexpressible claim is the same shape: the run gated nothing, so it is
   * incomplete coverage, not a pass. See the `zero verified` block below for the
   * mix case, which still exits 0.
   */
  it("blocks when the ONLY claim is prose that cannot be expressed checkably", () => {
    const outcome = verifyClaims([absence("Figma carries no heading semantics.")], snap());
    expect(outcome.unverifiable["not-expressible"]).toBe(1);
    expect(outcome.counts.verified).toBe(0);
    expect(verifyExitCode(outcome)).toBe(VERIFY_EXIT.Unverifiable);
  });

  it("and says nothing was verified, rather than that everything holds", () => {
    const outcome = verifyClaims([absence("Figma carries no heading semantics.")], snap());
    const summary = verifySummary(outcome);
    expect(summary).toMatch(/not stated checkably/);
    expect(summary).toMatch(/NOTHING in this contract was verified/);
    expect(summary).not.toMatch(/every claim re-read and still true/);
    expect(summary).not.toMatch(/every claim this tool can re-read still holds/);
  });

  it("says plainly when a read failed", () => {
    const blind = { readAt: "now" } as DesignSourceSnapshot;
    // Prose that DOES parse, so the failure is the read and not the wording.
    const summary = verifySummary(
      verifyClaims([absence("The component set defines no Focus state.")], blind),
    );
    expect(summary).toMatch(/INCOMPLETE/);
    expect(summary).toMatch(/not a claim that holds/);
  });
});

describe("against the contracts that actually exist", () => {
  // Guards the integration the unit cases cannot: that the claim extractor and the
  // verifier agree on shape, on real files rather than fixtures shaped to pass.
  const BUTTON_SPEC = {
    component: "Button",
    source: { fileKey: "Nq23XwGfazYZZZ5vr8OezI" },
    notInFigma: {
      focusVisible: { reason: "The component set defines no Focus state. --ring is SDS Border/Neutral/Default." },
      transition: { reason: "Figma declares no motion. Duration/easing left to the browser default." },
    },
    variantNodeIds: { "primary.default.medium": "4185:3779" },
  };

  it("reads the file key from `source`, so a verify needs no extra config", () => {
    expect(extractClaims("contracts/button.spec.json", BUTTON_SPEC).fileKey).toBe(
      "Nq23XwGfazYZZZ5vr8OezI",
    );
  });

  it("reports the absent designSource block as a gap, not as a failed claim", () => {
    // Both real contracts predate `designSource`. A contract that never asserted
    // these facts has nothing to contradict — calling that falsified would invent
    // a finding; saying nothing would let a thin contract pass as a thorough one.
    const claims = extractClaims("contracts/button.spec.json", BUTTON_SPEC);
    expect(claims.gaps.join(" ")).toMatch(/no `designSource` block/);
    expect(claims.claims.some((c) => c.kind === "collection")).toBe(false);
  });

  it("produces the verdicts the real Button contract should get", () => {
    const claims = extractClaims("contracts/button.spec.json", BUTTON_SPEC);
    const outcome = verifyClaims(claims.claims, snap(), claims.gaps);
    // focusVisible verified (no Focus axis option), node verified, transition not
    // expressible.
    expect(outcome.counts.verified).toBe(2);
    expect(outcome.counts.falsified).toBe(0);
    expect(outcome.unverifiable["not-expressible"]).toBe(1);
    expect(verifyExitCode(outcome)).toBe(VERIFY_EXIT.Verified);
  });

  it("carries the contract's gaps through to the outcome", () => {
    const claims = extractClaims("contracts/button.spec.json", BUTTON_SPEC);
    expect(verifyClaims(claims.claims, snap(), claims.gaps).gaps.length).toBeGreaterThan(0);
  });
});

/**
 * Zero verified is not a pass (found by the Dialog contract, 2026-08-06).
 *
 * `not-expressible` exiting 0 is deliberate and right for a MIX: Button verifies 19
 * claims and cannot express 2, and failing that would push a team to switch `verify`
 * off — a narrower honest gate beats no gate.
 *
 * It is wrong when the verified count is **zero**. The Dialog contract produced
 * 0 verified · 23 not-expressible · exit 0, under a summary reading "every claim this
 * tool can re-read still holds" — vacuously true, because there were none. A gate
 * that passes when nothing was gated is not a gate.
 */
describe("zero verified claims is incomplete coverage, not a pass", () => {
  const outcome = (over: Partial<VerifyOutcome> = {}): VerifyOutcome =>
    ({
      counts: { verified: 0, falsified: 0, unverifiable: 0 },
      unverifiable: { "read-failed": 0, "not-expressible": 0 },
      results: [],
      gaps: [],
      ...over,
    }) as VerifyOutcome;

  it("exits Unverifiable when every claim was inexpressible", () => {
    const o = outcome({
      counts: { verified: 0, falsified: 0, unverifiable: 0 },
      unverifiable: { "read-failed": 0, "not-expressible": 23 },
    });
    expect(verifyExitCode(o)).toBe(VERIFY_EXIT.Unverifiable);
  });

  it("says NOTHING was verified rather than that everything holds", () => {
    const o = outcome({
      counts: { verified: 0, falsified: 0, unverifiable: 0 },
      unverifiable: { "read-failed": 0, "not-expressible": 23 },
    });
    const summary = verifySummary(o);
    expect(summary).toMatch(/NOTHING in this contract was verified/);
    expect(summary).toMatch(/gated nothing at all/);
    // The vacuous reassurance must be gone.
    expect(summary).not.toMatch(/every claim this tool can re-read still holds/);
  });

  it("still exits Verified for a MIX — one verified claim is a real gate", () => {
    const o = outcome({
      counts: { verified: 1, falsified: 0, unverifiable: 23 },
      unverifiable: { "read-failed": 0, "not-expressible": 23 },
    });
    expect(verifyExitCode(o)).toBe(VERIFY_EXIT.Verified);
    expect(verifySummary(o)).toMatch(/every claim this tool can re-read still holds/);
  });

  /**
   * A contract with no claims at all is a different thing from one whose claims
   * could not be checked, and must not be dragged into exit 2 — there is nothing
   * incomplete about asserting nothing.
   */
  it("exits Verified for a contract that makes no claims at all", () => {
    expect(verifyExitCode(outcome())).toBe(VERIFY_EXIT.Verified);
  });

  it("read-failed still outranks, whatever the verified count", () => {
    expect(
      verifyExitCode(
        outcome({
          counts: { verified: 5, falsified: 2, unverifiable: 1 },
          unverifiable: { "read-failed": 1, "not-expressible": 0 },
        }),
      ),
    ).toBe(VERIFY_EXIT.Unverifiable);
  });
});

describe("the not-implemented evidence does not claim designSource is absent", () => {
  /**
   * The old wording said "No contract in this project carries a `designSource` block
   * yet, so there has been no real input to build it against". True when written;
   * false the moment one did. The Dialog contract printed it 14 times while the block
   * it denied was being read. A stale excuse that contradicts its own input tells the
   * reader not to expect a check, on grounds they can see are wrong.
   */
  it("states only that the checker is unbuilt", () => {
    // Uses `literals`, not `collections`: collection claims became implemented in
    // v0.0.59, so pointing this at them would test the new checker instead of the
    // not-implemented wording it exists to pin.
    const extracted = extractClaims("contracts/x.spec.json", {
      designSource: {
        readAt: "2026-08-06",
        literals: [{ nodeId: "1:2", node: "Slot", property: "itemSpacing", value: "24" }],
      },
    });
    const out = verifyClaims(extracted.claims, snap());
    const ev = out.results.map((r) => r.evidence).join("\n");
    expect(ev).toMatch(/not implemented/);
    expect(ev).not.toMatch(/no real input/);
    expect(ev).not.toMatch(/carries a `designSource` block yet/);
  });
});

/**
 * `designSource.collections` re-checking (v0.0.59).
 *
 * This is the claim the whole `designSource` block was added for. The fabrication
 * that motivated it — *"SDS defines no dark mode"*, written as settled fact, false,
 * and worth 24 invented theme values of which 18 were wrong — is exactly a mode
 * claim. Until now it was parsed and reported unimplemented.
 */
describe("collection claims", () => {
  const claim = (name: string, modes: string[]): ContractClaim => ({
    kind: "collection",
    path: `designSource.collections.${name}`,
    statement: `collection "${name}" has modes ${modes.join(", ")}`,
    token: name,
    expectedModes: modes,
  });
  const withCollections = (
    collections: Array<{ id: string; name: string; modes: string[] }>,
  ): DesignSourceSnapshot => ({ readAt: "2026-08-06", collections }) as DesignSourceSnapshot;

  it("verifies when the modes still match, order-insensitively", () => {
    const out = verifyClaims(
      [claim("Color", ["SDS Dark", "SDS Light"])],
      withCollections([{ id: "c1", name: "Color", modes: ["SDS Light", "SDS Dark"] }]),
    );
    expect(out.counts.verified).toBe(1);
    expect(out.results[0]!.evidence).toMatch(/still has exactly modes/);
  });

  /** The .dark case: a mode the contract recorded is gone. */
  it("falsifies when a mode disappears, naming both lists", () => {
    const out = verifyClaims(
      [claim("Color", ["SDS Light", "SDS Dark"])],
      withCollections([{ id: "c1", name: "Color", modes: ["SDS Light"] }]),
    );
    expect(out.counts.falsified).toBe(1);
    const ev = out.results[0]!.evidence;
    expect(ev).toMatch(/now has modes "SDS Light"/);
    expect(ev).toMatch(/contract recorded "SDS Dark", "SDS Light"/);
  });

  it("falsifies when a mode is ADDED — a new mode is theme work nobody did", () => {
    const out = verifyClaims(
      [claim("Color", ["SDS Light"])],
      withCollections([{ id: "c1", name: "Color", modes: ["SDS Light", "SDS HC"] }]),
    );
    expect(out.counts.falsified).toBe(1);
  });

  it("falsifies when the collection is gone entirely, listing what is present", () => {
    const out = verifyClaims(
      [claim("Color", ["SDS Light"])],
      withCollections([{ id: "c1", name: "Size", modes: ["Default"] }]),
    );
    expect(out.counts.falsified).toBe(1);
    expect(out.results[0]!.evidence).toMatch(/no collection named "Color" exists/);
  });

  /**
   * Collection name is NOT unique — the reference file has two `Typography` and two
   * `Size`, one local and one imported from another library. Guessing would produce
   * a confident verdict about the wrong collection.
   */
  it("refuses an ambiguous name rather than guessing, naming both candidates", () => {
    const out = verifyClaims(
      [claim("Size", ["Default"])],
      withCollections([
        { id: "VariableCollectionId:9:11257", name: "Size", modes: ["Default"] },
        { id: "VariableCollectionId:abc/348:243", name: "Size", modes: ["Default"] },
      ]),
    );
    expect(out.counts.verified).toBe(0);
    expect(out.counts.falsified).toBe(0);
    const ev = out.results[0]!.evidence;
    expect(ev).toMatch(/ambiguous/);
    expect(ev).toMatch(/9:11257/);
    expect(ev).toMatch(/abc\/348:243/);
    expect(ev).toMatch(/imported from another library/);
  });

  /**
   * A failed read must never verify and never falsify. `read-failed` blocks, which
   * is the point: not knowing is worse than knowing something is wrong.
   */
  it("is read-failed when collections could not be read at all", () => {
    const out = verifyClaims([claim("Color", ["SDS Light"])], {
      readAt: "2026-08-06",
    } as DesignSourceSnapshot);
    expect(out.unverifiable["read-failed"]).toBe(1);
    expect(verifyExitCode(out)).toBe(VERIFY_EXIT.Unverifiable);
  });

  it("does not verify a collection the contract recorded with no modes", () => {
    const bare: ContractClaim = {
      kind: "collection",
      path: "designSource.collections.Color",
      statement: 'collection "Color" exists',
      token: "Color",
    };
    const out = verifyClaims(
      [bare],
      withCollections([{ id: "c1", name: "Color", modes: ["SDS Light"] }]),
    );
    expect(out.counts.verified).toBe(0);
    expect(out.unverifiable["not-expressible"]).toBe(1);
  });
});
