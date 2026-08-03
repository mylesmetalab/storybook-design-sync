/**
 * Is the project's own stylesheet actually loaded in the Storybook preview?
 *
 * ## Why this check exists
 *
 * `.storybook/preview.ts` has to import the project's CSS entry. `storybook init`
 * does not add that import and neither does `design-sync init`. Without it every
 * story renders **unstyled**, and the drift check then faithfully compares the
 * browser's default button against the design's tokens.
 *
 * Measured on a fresh project (issue #96), same story, one line of difference:
 *
 * | `.storybook/preview.tsx`      | result                  |
 * |-------------------------------|-------------------------|
 * | no CSS import                 | **17 drift · 3 match**  |
 * | `import "../src/index.css"`   | **2 drift · 22 match**  |
 *
 * Fifteen of the seventeen were artefacts. Every one of those comparisons was
 * arithmetically correct — `font-family: Arial` really did differ from `Inter` —
 * which is what makes it dangerous: it does not look like a setup error, it looks
 * like the tool working. A new adopter's rational conclusions are "my component
 * is completely wrong" or "this tool is noise", and the second one loses them in
 * the first ten minutes.
 *
 * This is the project's standing failure shape: **a technically true statement
 * that did not apply.** The question "how does this rendered element compare to
 * Figma?" should not be asked of a document with no stylesheet. So it is an
 * applicability predicate, evaluated before the comparison, exactly as dual mode
 * refuses when no theme mechanism moves a colour.
 *
 * ## The predicate, and the case where it must stay silent
 *
 * The startup scan already knows every custom property the project's CSS
 * declares. If **none** of them resolve on the rendered document, the stylesheet
 * is not there.
 *
 * The trap is the inverse: a project that declares **no** custom properties has
 * nothing to probe, and "no probes resolved" is then vacuously true. Reporting a
 * missing stylesheet there would be a confident claim from zero evidence — the
 * #10-shaped bug over again, one layer up. So zero declared properties means
 * *unknown*, and the check says nothing.
 *
 * Pure, so the honesty rules are testable without a DOM. `probeCustomProperties`
 * in the preview is the only DOM reader.
 */

/** What a probe found for one declared custom property. */
export interface CustomPropertyProbe {
  /** Property name as declared, including the leading `--`. */
  name: string;
  /**
   * The value `getComputedStyle().getPropertyValue()` returned. An unset custom
   * property returns `""` — that is the signal, not an error.
   */
  value: string;
}

export type StylesheetPresence =
  /** At least one declared property resolved: the stylesheet is loaded. */
  | { kind: "loaded"; resolved: number; probed: number }
  /**
   * Every declared property resolved to nothing. The stylesheet is not in the
   * preview, so no comparison should run.
   */
  | { kind: "missing"; probed: number; reason: string; detail: string }
  /**
   * Not enough evidence to say. The project declares no custom properties, so
   * there is nothing to probe — this must never be reported as "missing".
   */
  | { kind: "unknown"; why: string };

/**
 * How many probes are enough to trust a "missing" verdict.
 *
 * One is too few: a single mistyped or theme-scoped property that legitimately
 * does not resolve at `:root` would condemn a perfectly loaded stylesheet. Three
 * simultaneously absent is not a coincidence — and any project with a theme has
 * far more than three.
 */
export const MIN_PROBES_FOR_MISSING = 3;

/**
 * How many declared custom properties the server sends for probing.
 *
 * A sample, not the whole set: the predicate needs enough to be confident, and a
 * foundations-scale project has hundreds. Sorted before slicing so the sample is
 * deterministic — a probe set that varied per run would make a refusal
 * unreproducible.
 */
export const PROBE_SAMPLE_SIZE = 24;

/**
 * Turn the CSS scan's custom-property index into names the DOM will answer for.
 *
 * Two jobs, both load-bearing:
 *
 * 1. **Add the `--` prefix back.** `scan-css.ts` stores names with it stripped
 *    (`decl.prop.slice(2)`), and `getPropertyValue("color-primary")` returns `""`
 *    for any name without it. Passing the scan's keys through unchanged made the
 *    stylesheet check conclude "missing" on every healthy project and suppress
 *    its entire comparison. That shipped in the first wiring and was caught only
 *    by running it against a real project.
 * 2. **Sort before sampling**, so the probe set is deterministic. A sample that
 *    varied between runs would make a refusal unreproducible.
 */
export function probeNamesFromScan(
  customProperties: Readonly<Record<string, unknown>>,
  limit: number = PROBE_SAMPLE_SIZE,
): string[] {
  return Object.keys(customProperties)
    .map((name) => (name.startsWith("--") ? name : `--${name}`))
    .sort()
    .slice(0, limit);
}

export function classifyStylesheetPresence(
  probes: readonly CustomPropertyProbe[],
  context: { cssEntries?: readonly string[] } = {},
): StylesheetPresence {
  if (probes.length === 0) {
    return {
      kind: "unknown",
      why: "the project's CSS declares no custom properties, so there is nothing to probe.",
    };
  }
  // A name without the `--` prefix can never resolve, so a set of them would
  // manufacture a "missing" verdict out of a caller bug and suppress a healthy
  // project's entire comparison. That happened: the CSS scan stores names with
  // the prefix stripped, and the first wiring passed them through unchanged.
  // Refusing to conclude anything here makes the failure loud instead of
  // catastrophic.
  const malformed = probes.filter((p) => !p.name.startsWith("--"));
  if (malformed.length > 0) {
    return {
      kind: "unknown",
      why:
        `${malformed.length} of ${probes.length} probe names are missing the "--" prefix ` +
        `(e.g. "${malformed[0]!.name}"), so they could never resolve. This is a caller bug, ` +
        `not evidence about the stylesheet.`,
    };
  }
  const resolved = probes.filter((p) => p.value.trim().length > 0);
  if (resolved.length > 0) {
    return { kind: "loaded", resolved: resolved.length, probed: probes.length };
  }
  if (probes.length < MIN_PROBES_FOR_MISSING) {
    return {
      kind: "unknown",
      why:
        `only ${probes.length} custom propert${probes.length === 1 ? "y" : "ies"} could be probed, ` +
        `which is too few to conclude the stylesheet is absent rather than that ` +
        `those properties are theme-scoped.`,
    };
  }
  const entries = context.cssEntries ?? [];
  // Only name a file when there is exactly one entry AND it is a concrete path.
  // A glob cannot be turned into an import specifier, and naming a path that may
  // not exist is worse than naming none.
  const only = entries.length === 1 ? entries[0]! : undefined;
  const concrete = only !== undefined && !isGlob(only) ? toPreviewImport(only) : undefined;
  const importHint =
    concrete !== undefined
      ? `Add \`import "${concrete}"\` to .storybook/preview.ts (or preview.tsx).`
      : `Import your CSS entry in .storybook/preview.ts (or preview.tsx) — the file that holds your theme.`;
  return {
    kind: "missing",
    probed: probes.length,
    reason: "this project's stylesheet is not loaded in the Storybook preview",
    detail:
      `Not checked — this project's stylesheet is not loaded in the Storybook preview. ` +
      `None of the ${probes.length} custom properties declared in your CSS resolve on the ` +
      `rendered document, so every value measured here would be a browser default and ` +
      `comparing them against Figma would report drift that does not exist. ${importHint} ` +
      `Then re-check.`,
  };
}

function isGlob(entry: string): boolean {
  return /[*?[\]{}]/.test(entry);
}

/**
 * Turn a concrete `cssEntries` path into the specifier a `preview.ts` would use.
 * `.storybook/` sits one level below the project root, so a root-relative path
 * becomes `../<path>`. Callers must screen out globs first (`isGlob`).
 */
function toPreviewImport(entry: string): string {
  return `../${entry.replace(/^\.\//, "")}`;
}
