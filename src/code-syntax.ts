/**
 * Figma's `codeSyntax` as a source of token names (issue #93).
 *
 * ## What the issue expected, and what the file actually says
 *
 * #93 predicted `codeSyntax` would be **empty** — "quite likely empty, because
 * nobody has filled it in" — and told us to check before designing. Checked
 * against the reference file (`Nq23XwGfazYZZZ5vr8OezI`) on 2026-08-04:
 *
 *   - **356 of 361** variables carry a `codeSyntax.WEB`
 *   - every one is exactly the shape `var(--name)`
 *   - **every one uses the `--sds-` prefix** — zero exceptions
 *
 * So it is almost fully populated, and it names **SDS's own reference
 * implementation**, not any given consumer's theme:
 *
 * | Figma variable | `codeSyntax.WEB` | the starter's actual token |
 * |---|---|---|
 * | `Background/Brand/Default` | `var(--sds-color-background-brand-default)` | `--primary` |
 * | `Border/Brand/Default` | `var(--sds-color-border-brand-default)` | `--border-brand` |
 * | `Radius/200` | `var(--sds-size-radius-200)` | `--radius` |
 *
 * ## Why the issue's precedence rule had to change
 *
 * #93 says a `codeSyntax` naming a property **not declared in the scanned CSS**
 * is "a *finding*, not a fallback trigger — Figma asserts a code name the code
 * doesn't have, which is a real disagreement."
 *
 * On the only real file we have, that rule produces **~356 findings**, every one
 * of them noise. SDS is a community design system that ships its own CSS; the
 * starter deliberately maps it onto shadcn's vocabulary. Neither side is wrong,
 * and a report full of false disagreements is precisely the failure this feature
 * was meant to remove.
 *
 * So `codeSyntax` is authoritative about **what the design system calls it in the
 * design system's own implementation**. That is a different question from **what
 * this consumer calls it**, and conflating them is what the original rule did.
 *
 * ## The precedence that follows from the data
 *
 * 1. `codeSyntax.WEB` **and the project declares that property** → authoritative.
 *    No inference at all; this is the case #93 was reaching for, and it happens
 *    whenever a consumer adopts the design system's own CSS.
 * 2. `codeSyntax.WEB` **and the project does not declare it** → the consumer has
 *    their own vocabulary. **Not a finding.** But we now *know* Figma's name, so
 *    the message stops guessing at that half.
 * 3. `tokenAliases` → the consumer's explicit declaration.
 * 4. heuristic normalisation → inference, and labelled as inference.
 *
 * A tier-1 name that disagrees with an explicit `tokenAliases` entry is
 * **reported, not silently resolved** — a genuine contradiction between two
 * authorities.
 *
 * Pure: it decides a name and a provenance given facts. No Figma calls, no CSS
 * scanning.
 */

import { normalizeTokenName } from "@metalab/design-sync-core";

/**
 * Where a token name came from. Carried into the report and the fix prompt,
 * because "Figma says so" and "we guessed" must never read the same.
 */
export type TokenNameSource =
  /** Figma's `codeSyntax`, and this project declares that custom property. */
  | "code-syntax"
  /**
   * Figma's `codeSyntax`, naming a property this project does not declare — the
   * design system's own vocabulary, not this consumer's. Informative, never a
   * defect.
   */
  | "code-syntax-foreign"
  /** The consumer's `tokenAliases` declaration. */
  | "alias"
  /** `normalizeTokenName` inference. Must be labelled as such wherever shown. */
  | "heuristic";

export interface ResolvedTokenName {
  /** The name to compare against the code side, without leading dashes. */
  name: string;
  source: TokenNameSource;
  /**
   * Figma's own `codeSyntax` custom property, when it declared one — regardless
   * of which tier won. Lets a message state Figma's name even when the consumer
   * uses a different one.
   */
  figmaCodeSyntax?: string;
  /**
   * Set when tier 1 and `tokenAliases` name different properties. Both are
   * assertions by an authority, so the tool reports the contradiction rather
   * than picking a winner.
   */
  conflict?: string;
}

/**
 * Extract the custom property from a `codeSyntax` value.
 *
 * The reference file is uniformly `var(--name)` (356/356), but a bare `--name` is
 * equally valid in the field and costs nothing to accept. Anything else — a
 * Tailwind class, a JS token path, a composite value — returns `undefined` rather
 * than being coerced: a name we cannot parse is not a name we may assert.
 */
export function customPropertyFromCodeSyntax(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  const wrapped = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(trimmed);
  if (wrapped?.[1]) return wrapped[1];
  return /^--[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : undefined;
}

/** `--color-primary` → `color-primary`, so tiers are comparable. */
function stripLeadingDashes(name: string): string {
  return name.replace(/^--/, "");
}

export interface ResolveTokenNameInput {
  /** The Figma variable's name (`Background/Brand/Default`). */
  figmaVariableName: string;
  /** Its `codeSyntax.WEB`, if any. */
  codeSyntax?: string | undefined;
  /** `tokenAliases` from the consumer's config: Figma name → project token. */
  aliases?: Readonly<Record<string, string>> | undefined;
  /**
   * Custom properties the project's own CSS declares, WITHOUT leading dashes.
   * This decides tier 1 vs tier 2 — and an empty set must not promote a foreign
   * name to authoritative, so tier 1 is then unreachable.
   */
  declaredCustomProperties?: ReadonlySet<string> | undefined;
}

export function resolveTokenName(input: ResolveTokenNameInput): ResolvedTokenName {
  const { figmaVariableName, codeSyntax, aliases, declaredCustomProperties } = input;
  const property = customPropertyFromCodeSyntax(codeSyntax);
  const bare = property ? stripLeadingDashes(property) : undefined;
  const declared = bare !== undefined && (declaredCustomProperties?.has(bare) ?? false);
  const aliased = aliases?.[figmaVariableName];

  // Tier 1 — Figma names it and this project declares it. Nothing inferred.
  if (bare !== undefined && declared && property !== undefined) {
    const result: ResolvedTokenName = {
      name: bare,
      source: "code-syntax",
      figmaCodeSyntax: property,
    };
    if (aliased !== undefined && stripLeadingDashes(aliased) !== bare) {
      result.conflict =
        `Figma's codeSyntax names \`${property}\`, which this project declares, but ` +
        `\`tokenAliases\` maps "${figmaVariableName}" to \`${aliased}\`. Both are explicit ` +
        `declarations and they disagree — remove whichever is stale rather than trusting this row.`;
    }
    return result;
  }

  // Tier 2 — the consumer's own declaration beats inference. Figma's name rides
  // along so a message can cite it without asserting it.
  if (aliased !== undefined) {
    return {
      name: stripLeadingDashes(aliased),
      source: "alias",
      ...(property !== undefined ? { figmaCodeSyntax: property } : {}),
    };
  }

  // Tier 3 — inference, labelled. `code-syntax-foreign` is still inference about
  // *this project's* name; what it adds is that Figma's own property can be
  // quoted instead of guessed at too.
  return {
    name: normalizeTokenName(figmaVariableName),
    source: property !== undefined ? "code-syntax-foreign" : "heuristic",
    ...(property !== undefined ? { figmaCodeSyntax: property } : {}),
  };
}

/** True when the name was asserted by an authority rather than inferred. */
export function isAuthoritative(source: TokenNameSource): boolean {
  return source === "code-syntax" || source === "alias";
}

/**
 * How a report or prompt should describe where the name came from.
 *
 * `heuristic` and `code-syntax-foreign` both admit inference — the difference is
 * that the second names Figma's own property instead of guessing at that half,
 * which is the whole gain on a file like SDS where every `codeSyntax` describes
 * the design system's CSS rather than the consumer's.
 */
export function describeTokenNameSource(resolved: ResolvedTokenName): string {
  switch (resolved.source) {
    case "code-syntax":
      return `Figma's own \`codeSyntax\` names \`${resolved.figmaCodeSyntax}\`, and this project declares it.`;
    case "alias":
      return resolved.figmaCodeSyntax
        ? `\`tokenAliases\` maps this to \`--${resolved.name}\`. (Figma's \`codeSyntax\` says ` +
            `\`${resolved.figmaCodeSyntax}\`, which this project does not declare — the design ` +
            `system's own vocabulary, not yours.)`
        : `\`tokenAliases\` maps this to \`--${resolved.name}\`.`;
    case "code-syntax-foreign":
      return (
        `Figma's \`codeSyntax\` names \`${resolved.figmaCodeSyntax}\`, which this project does ` +
        `not declare — that is the design system's own implementation. \`--${resolved.name}\` is ` +
        `converted by convention and NOT confirmed; declare it in \`tokenAliases\` to state the ` +
        `mapping.`
      );
    case "heuristic":
      return (
        `Figma declares no \`codeSyntax\` for this variable, so \`--${resolved.name}\` is ` +
        `converted by convention and NOT confirmed. Setting \`codeSyntax\` in Figma, or ` +
        `\`tokenAliases\` here, removes the guess.`
      );
  }
}
