import type { DimensionDiff, NameDivergenceKind } from "./dimensions/types.js";

/**
 * Triage for a **token-binding name divergence**: the code binds one token name,
 * the Figma node binds another, and nothing reconciled them (neither
 * `tokenAliases` nor the spelling heuristic).
 *
 * The governing rule, learned repeatedly on this project: *a confident signal
 * that doesn't apply is worse than no signal.* A name comparison on its own is
 * weak evidence — token-name matching is heuristic — so it must never be the
 * thing that calls a component broken. What decides is the **value**:
 *
 *   value matched      → advisory (`value-matched`). The component renders what
 *                        the design specifies; only the spelling differs. Issue
 *                        #57: this case alone produced 89 "drift" on a component
 *                        with one real difference.
 *   value drifted      → drift. There IS a defect on this property, and the
 *                        binding row carries the extra fact that the two sides
 *                        also name different tokens.
 *   no value to check  → advisory (`unverified`). Deliberately NOT "match": we
 *                        have no evidence the render is right. Also not drift: we
 *                        have no evidence it is wrong. It is reported, tallied
 *                        under its own count, and labelled unverified.
 */
export function nameDivergenceStatus(
  property: string,
  valueDiffs: readonly DimensionDiff[],
): "drift" | NameDivergenceKind {
  const value = valueDiffs.find((d) => d.kind === "token-value" && d.property === property);
  if (!value) return "unverified";
  if (value.status === "drift") return "drift";
  if (value.status === "match") return "value-matched";
  // `flag-only` / `unresolved` / `advisory` — no comparison actually landed.
  return "unverified";
}

/**
 * The `tokenAliases` entry that would state the equivalence outright. Quoted in
 * the row's note so the fix is copy-pasteable rather than described.
 */
export function suggestAliasEntry(figmaName: string, codeName: string): string {
  return `"${figmaName}": "${codeName}"`;
}

/**
 * The note text for a divergent binding row. One place, so the panel, the
 * markdown export and the fix prompts all say the same thing.
 */
export function divergenceNote(input: {
  codeValue: string;
  figmaName: string;
  kind: "drift" | NameDivergenceKind;
  aliasExpected?: string | undefined;
}): string {
  const { codeValue, figmaName, kind, aliasExpected } = input;
  // An alias exists for this Figma variable and the code binds something else.
  // That is the project's own statement being contradicted, so it leads.
  const aliasClause =
    aliasExpected !== undefined
      ? ` \`tokenAliases\` maps \`${figmaName}\` to \`${aliasExpected}\`, but the code binds \`${codeValue}\`.`
      : ` Add ${suggestAliasEntry(figmaName, codeValue)} to \`tokenAliases\` in design-sync.config.json if these name the same decision.`;

  if (kind === "value-matched") {
    return (
      `Name-only divergence: code binds \`${codeValue}\`, Figma binds \`${figmaName}\`, and the resolved values match — ` +
      `this is not drift.${aliasClause}`
    );
  }
  if (kind === "unverified") {
    return (
      `Token names differ (code \`${codeValue}\` vs Figma \`${figmaName}\`) and no value comparison was available for this property, ` +
      `so the divergence is unverified — it is NOT a match.${aliasClause}`
    );
  }
  return (
    `Code binds \`${codeValue}\`, Figma binds \`${figmaName}\`, and the values also disagree.${aliasClause}`
  );
}
