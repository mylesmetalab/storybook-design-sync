import { tokenNameToCssVar } from "@metalab/design-sync-core";

/**
 * Does the CSS custom property a Figma variable name converts to actually exist
 * in this project? (issues #66, #67)
 *
 * `tokenNameToCssVar` is a **spelling**, not a lookup: `Text/Positive/Secondary`
 * → `--text-positive-secondary`. Presenting that as the project's variable
 * shipped two failures in one prompt on a live component:
 *
 *  - **Wrong namespace.** In a Tailwind v4 consumer `--text-*` is the font-size
 *    namespace (`--text-base`, `--text-2xl`); colours live under `--color-*`. The
 *    suggested name would have registered as a font size.
 *  - **Absent entirely.** The consumer's theme had 93 custom properties and no
 *    positive/success family, so there was nothing to point at. The prompt still
 *    said "if your theme names the same token differently, use the project's
 *    name", which presupposes it exists, and the agent's remaining moves were
 *    hardcoding a hex or creating a dangling `var()`.
 *
 * The whole module is therefore a **lookup, never a guess**. It tries the
 * converted name and then a small set of alternative spellings *derived from
 * namespaces this project actually uses* — each candidate is only accepted if the
 * index really declares it. When nothing matches, the answer is `absent` with the
 * evidence (how many properties were scanned, where they live, what namespace the
 * converted name would have landed in), and the prompt routes the change to the
 * token layer instead of naming a variable nobody declared.
 *
 * Pure: the scan lives in `scan-css.ts`, the wording in `fix-prompt.ts`.
 */

/**
 * Every custom property the CSS scan saw, keyed **without** the leading `--`,
 * mapped to the consumer-relative files declaring it.
 *
 * Covers `:root`, `.dark`, `@theme` — anywhere a `--x: y` declaration appears in a
 * scanned file. `.dark` matters as much as `:root`: a project's dark overrides are
 * where half of a mode-varying token's answer lives.
 */
export type CustomPropertyIndex = Record<string, readonly string[]>;

/** See `fix-prompt.ts` for how each variant is worded. */
export type TokenPresence =
  | {
      kind: "declared";
      /** The project's own custom property, WITH the leading `--`. */
      cssVar: string;
      /** Consumer-relative files declaring it. */
      files: readonly string[];
    }
  | {
      kind: "absent";
      /** What the Figma name converts to by convention, WITH the leading `--`. */
      converted: string;
      /** How many custom properties the scan did see — the evidence for "absent". */
      declaredCount: number;
      /** Files where this project declares custom properties (where a new one would go). */
      themeFiles: readonly string[];
      /** Something true about the namespace the converted name would land in. */
      namespaceNote?: string | undefined;
    }
  | { kind: "unknown" };

/** How many properties a namespace needs before we call it one. */
const NAMESPACE_MIN = 2;

/**
 * Resolve a Figma variable name against the project's declared custom properties.
 *
 * Returns `unknown` — never `absent` — when there is no index to check against.
 * An empty index is indistinguishable from a scan that did not run, and "we found
 * no custom properties" is not evidence that a specific one is missing. Treating
 * it as absence would put a token-layer prompt in front of every row in a project
 * whose CSS the scanner simply could not reach.
 */
export function resolveTokenPresence(
  tokenName: string | undefined,
  index: CustomPropertyIndex | undefined,
): TokenPresence {
  if (!tokenName || tokenName.trim() === "") return { kind: "unknown" };
  if (!index || Object.keys(index).length === 0) return { kind: "unknown" };

  const converted = tokenNameToCssVar(tokenName);
  const bare = converted.replace(/^--/, "");

  const direct = index[bare];
  if (direct) return { kind: "declared", cssVar: `--${bare}`, files: [...direct] };

  // Alternative spellings, each one CHECKED against the index. The two shapes
  // that occur in practice: a project that prefixes the whole Figma path with its
  // own namespace (`--color-text-positive-secondary`), and one that replaces
  // Figma's leading segment with its own (`--color-positive-secondary`).
  const namespaces = namespacesOf(index);
  const withoutFirst = bare.includes("-") ? bare.slice(bare.indexOf("-") + 1) : null;
  for (const ns of namespaces) {
    for (const candidate of [`${ns}-${bare}`, withoutFirst ? `${ns}-${withoutFirst}` : null]) {
      if (!candidate) continue;
      const files = index[candidate];
      if (files) return { kind: "declared", cssVar: `--${candidate}`, files: [...files] };
    }
  }

  return {
    kind: "absent",
    converted,
    declaredCount: Object.keys(index).length,
    themeFiles: themeFilesOf(index),
    ...(namespaceNote(bare, index) ? { namespaceNote: namespaceNote(bare, index)! } : {}),
  };
}

/**
 * The leading segments this project uses as namespaces, most-used first.
 *
 * Derived, not listed: a hardcoded `["color", "spacing", …]` would be a claim
 * about Tailwind rather than about the consumer, and consumers who name their
 * tokens differently would silently get the wrong candidates.
 */
function namespacesOf(index: CustomPropertyIndex): string[] {
  const counts = new Map<string, number>();
  for (const name of Object.keys(index)) {
    const head = name.split("-")[0];
    if (!head || head === name) continue;
    counts.set(head, (counts.get(head) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= NAMESPACE_MIN)
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
    .map(([head]) => head);
}

/**
 * The files where this project declares its custom properties, most-declaring
 * first — i.e. where a new token would go. Capped at two: the prompt needs a
 * place to point, not a manifest.
 */
function themeFilesOf(index: CustomPropertyIndex): string[] {
  const counts = new Map<string, number>();
  for (const files of Object.values(index)) {
    for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]))
    .slice(0, 2)
    .map(([file]) => file);
}

/**
 * What is already in the namespace the converted name would join — the sentence
 * that would have caught the `--text-*` collision.
 *
 * Purely factual: N properties share this prefix, here are up to three. It draws
 * no conclusion about whether the collision matters, because that depends on the
 * consumer's conventions and the addon does not know them.
 */
function namespaceNote(bare: string, index: CustomPropertyIndex): string | undefined {
  const head = bare.split("-")[0];
  if (!head || head === bare) return undefined;
  const siblings = Object.keys(index)
    .filter((name) => name !== bare && name.startsWith(`${head}-`))
    .sort();
  if (siblings.length < NAMESPACE_MIN) return undefined;
  const examples = siblings.slice(0, 3).map((s) => `\`--${s}\``);
  return (
    `Namespace check: \`--${head}-*\` already names ${siblings.length} custom ` +
    `propert${siblings.length === 1 ? "y" : "ies"} in this project (e.g. ${examples.join(", ")}), so a new ` +
    `\`--${bare}\` would join that family — confirm that is the namespace this decision belongs in before ` +
    `anyone declares it.`
  );
}
