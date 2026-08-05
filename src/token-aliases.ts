import { normalizeTokenName } from "@metalab/design-sync-core";

import { customPropertyFromCodeSyntax } from "./code-syntax.js";

/**
 * Reconciling two token-naming schemes.
 *
 * A Figma library and a codebase routinely name the same design decision
 * differently: Figma says `color/background/brand/default`, the code's theme
 * says `primary`. `normalizeTokenName` (design-sync-core) collapses *spelling*
 * differences — separators, case, whitespace, a leading `--` — and that is all
 * it can honestly do. It cannot know that two genuinely different words name one
 * decision.
 *
 * That gap is what made a clean component report 89 drift (issue #57): every
 * binding row on every story compared `primary` against
 * `color/background/brand/default`, found them different, and called it drift
 * while the *values* matched.
 *
 * Two things fix it, and this module is the first:
 *
 *  0. **Figma's `codeSyntax.WEB`** naming the exact custom property the code
 *     binds. Added in v0.0.53; outranks everything below, because it is both
 *     sides asserting the same name rather than anyone reconciling them. A row
 *     resolved this way needs no `tokenAliases` entry and must not be offered one.
 *  1. **`tokenAliases`** in `design-sync.config.json` — an explicit, project-
 *     authored map from the Figma variable name to the project's token name.
 *     Consulted BEFORE the heuristic, because it is evidence and the heuristic
 *     is a guess.
 *  2. Treating an unreconciled *name* divergence whose value matches as an
 *     advisory rather than drift (see `figma-rest.ts` / `row-triage.ts`).
 *
 * Every result says which mechanism produced it, so the panel can tell the
 * reader how much to trust it.
 */

/** Figma variable name → the project's token name. Validated in `config.ts`. */
export type TokenAliasMap = Record<string, string>;

export type NameMatchVia =
  /**
   * Figma's own `codeSyntax.WEB` names the very custom property the code binds.
   * The strongest evidence there is — both sides asserted it — so it outranks an
   * alias, and a row resolved this way needs no `tokenAliases` entry.
   */
  | "code-syntax"
  | "alias"
  | "heuristic";

export type TokenNameMatch =
  | {
      same: true;
      /**
       * `"alias"` — an explicit `tokenAliases` entry says these are the same
       * decision. `"heuristic"` — the two names collapse to the same canonical
       * form (`radius/xl` ≡ `--radius-xl`), which is a spelling judgement, not
       * a statement about intent.
       */
      via: NameMatchVia;
    }
  | {
      same: false;
      via: null;
      /**
       * Set when `tokenAliases` DOES carry an entry for this Figma variable but
       * the code binds something else. That is a stronger finding than an
       * unreconciled name: the project has stated what this variable is called
       * in code, and this is not it.
       */
      aliasExpected?: string;
    };

/**
 * Whether a code-side binding and a Figma variable name the same design
 * decision.
 *
 * `codeSyntax` first, then alias: an explicit mapping is the project telling us
 * the answer, so it wins over — and can contradict — the heuristic. Alias keys and values are
 * compared through `normalizeTokenName` as well, so a consumer doesn't have to
 * guess whether to write `color/background/brand/default` or
 * `--color-background-brand-default` on either side of the map.
 */
export function matchTokenNames(
  codeName: string | null | undefined,
  figmaName: string | null | undefined,
  aliases: TokenAliasMap = {},
  /**
   * The Figma variable's `codeSyntax.WEB`, when it declared one (#93). Optional
   * so every existing caller keeps its behaviour; absent means "no such
   * assertion", never "it disagreed".
   */
  figmaCodeSyntax?: string | undefined,
): TokenNameMatch {
  const code = normalizeTokenName(codeName);
  const figma = normalizeTokenName(figmaName);

  // `codeSyntax` first. Figma naming the exact property the code binds is not an
  // inference to be reconciled — it is both sides saying the same thing, so it
  // outranks even an explicit alias and must not produce an alias suggestion.
  //
  // Found by making it reachable: until the reference file had one variable
  // pointing at a property the consumer declares, this branch could not run, and
  // the tool reported `border-brand` vs `Border/Brand/Default` as a name
  // divergence — advising a `tokenAliases` entry that Figma had already made
  // unnecessary. #93 wired `codeSyntax` into token *presence* and not into this
  // comparison.
  const declaredProperty = customPropertyFromCodeSyntax(figmaCodeSyntax);
  if (declaredProperty !== undefined && code !== "" && normalizeTokenName(declaredProperty) === code) {
    return { same: true, via: "code-syntax" };
  }

  const aliased = lookupAlias(figmaName, aliases);
  if (aliased !== null) {
    if (normalizeTokenName(aliased) === code) return { same: true, via: "alias" };
    // The project declared a code-side name for this Figma variable and the
    // code binds a different one. Never fall through to the heuristic here: the
    // explicit statement is the better evidence, including when it disagrees.
    return { same: false, via: null, aliasExpected: aliased };
  }
  if (code !== "" && code === figma) return { same: true, via: "heuristic" };
  return { same: false, via: null };
}

/**
 * The project's token name for a Figma variable, or null when no entry matches.
 * Matching is normalized on the key so the map is forgiving about spelling.
 */
export function lookupAlias(
  figmaName: string | null | undefined,
  aliases: TokenAliasMap = {},
): string | null {
  const figma = normalizeTokenName(figmaName);
  if (figma === "") return null;
  for (const [key, value] of Object.entries(aliases)) {
    if (normalizeTokenName(key) === figma) return value;
  }
  return null;
}

/**
 * Stable signature of an alias map, for cache invalidation.
 *
 * The persistent report cache is keyed on the Figma file's `lastModified` plus
 * the code snapshot — neither of which moves when someone edits
 * `design-sync.config.json`. Without this, adding the alias that fixes a run's
 * false drift would leave a bulk run replaying the pre-alias report and still
 * calling it drift. Empty map → empty string, so every consumer that configures
 * no aliases keeps hitting the cache entries it already has.
 */
export function aliasSignature(aliases: TokenAliasMap | undefined): string {
  const entries = Object.entries(aliases ?? {});
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${normalizeTokenName(k)}=${normalizeTokenName(v)}`)
    .sort()
    .join(",");
}
