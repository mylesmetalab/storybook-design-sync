import { splitVariants } from "@metalab/design-sync-core";
import type {
  ChildBindingReport,
  DimensionDiff,
  DimensionStatus,
  NameDivergenceKind,
} from "./dimensions/types.js";

/**
 * Pure row-triage logic for the drift panel, extracted from manager.tsx so
 * the honesty contract (Phase 2: "no Apply button on a row the engine can't
 * honor") is unit-testable outside React.
 *
 * `classifyRow` says what kind of finding a row is (and drives table order);
 * `applyEngineCanAct` gates Apply buttons only; `explainInfo` produces the
 * per-row advisory. P2.2/P2.3 upgraded the props / variant-set advisories from
 * a generic "no engine yet" line to specific, data-driven guidance naming
 * exactly what drifted and what to do on each side.
 *
 * v0.0.37 deleted the old `partitionRow` — the split that decided *where a row
 * appeared* from whether a write engine could apply it. In `apply: "off"` (the
 * shipped default, and v1's only supported mode) no row has a write path, so a
 * collapsed section headed "the addon has no automated apply path for these"
 * was false about its own contents and implied the rows above it did have one.
 * It also buried the single most important finding a designer can hand us — a
 * Figma value detached from its variable — under trivial matches. Rows are now
 * ordered by what the finding *is*; write capability only gates buttons.
 */

export type GroupedRow =
  | { kind: "token"; property: string; value?: DimensionDiff; binding?: DimensionDiff }
  | { kind: "other"; diff: DimensionDiff };

/**
 * Pair each property's `token-value` and `token-binding` diffs into one row;
 * everything else becomes its own row, in engine order.
 *
 * Keyed by element AND property: the story root and a bound child both report
 * `padding-top`, and pairing the root's value with the child's binding would
 * fabricate a row describing neither.
 *
 * Lives here (moved out of `manager.tsx` in v0.0.38) because the panel is no
 * longer the only consumer — the bulk tallies group the same way, and a count
 * that disagreed with the table it summarizes is precisely the inconsistency
 * issue #57 was about.
 */
export function groupDimensions(diffs: readonly DimensionDiff[]): GroupedRow[] {
  const indexByProp = new Map<string, number>();
  const rows: GroupedRow[] = [];
  for (const d of diffs) {
    if (d.kind === "token-value" || d.kind === "token-binding") {
      const key = `${d.childSelector ?? ""}|${d.property}`;
      let idx = indexByProp.get(key);
      if (idx === undefined) {
        idx = rows.length;
        indexByProp.set(key, idx);
        rows.push({ kind: "token", property: d.property });
      }
      const row = rows[idx] as Extract<GroupedRow, { kind: "token" }>;
      if (d.kind === "token-value") row.value = d;
      else row.binding = d;
    } else {
      rows.push({ kind: "other", diff: d });
    }
  }
  return rows;
}

/** Write-gating mode from `design-sync.config.json` (`apply` field). */
export type ApplyMode = "off" | "experimental";

/**
 * v1 "audit-only" gate: whether the panel may render ANY write controls
 * (per-row Apply buttons, Preview all, bulk Apply for real, staged-edit
 * applies). Only an explicit `apply: "experimental"` opts in — `"off"`,
 * `undefined` (config not yet loaded / older config), and anything
 * unrecognized all stay read-only. Rows still show full drift detail and
 * advisories either way; this gates buttons, not information.
 */
export function applyControlsEnabled(mode: ApplyMode | string | undefined): boolean {
  return mode === "experimental";
}

/**
 * Whether the "Staged edits" section renders at all. Staged edits exist
 * solely to be pushed through the pipeline — they are part of the write
 * surface, so in apply:"off" (the v1 audit-only default) the entire
 * section is hidden, not just its Apply buttons. Only an explicit
 * `apply: "experimental"` shows it.
 */
export function stagedEditsVisible(mode: ApplyMode | string | undefined): boolean {
  return applyControlsEnabled(mode);
}

/** True when a diff cell carries something displayable (string or dual-mode map). */
function hasCellValue(v: unknown): boolean {
  return v !== null && v !== undefined;
}

/**
 * Whether a grouped row has anything to show in its Code / Figma cells.
 * Rows where BOTH sides are empty (e.g. a Figma-side binding whose
 * variable name didn't resolve — seen live as an `individualStrokeWeights`
 * row that was all em-dashes plus a "needs setup" pill) carry zero
 * information and are dropped from the drift table entirely.
 */
export function rowHasAnyValue(row: GroupedRow): boolean {
  if (row.kind === "token") {
    for (const d of [row.value, row.binding]) {
      if (d && (hasCellValue(d.codeValue) || hasCellValue(d.figmaValue))) return true;
    }
    return false;
  }
  return hasCellValue(row.diff.codeValue) || hasCellValue(row.diff.figmaValue);
}

/**
 * Zero-scanned-bindings detection. True when the report contains at least
 * one token-binding diff but NONE of them carry a code-side binding —
 * i.e. the CSS/TSX scanner found no var(--token) declarations for this
 * story's selector(s) at all (typical for Tailwind/inline-styled
 * codebases).
 *
 * NOTE: as of v0.0.29 the panel no longer renders a Wiring column (the
 * wiring verdict answers a hypothetical future question, not the current
 * state of the component — declared-vs-declared comparison belongs to a
 * static/contract checker). This helper is kept (tested, currently
 * unused by the panel) for that checker to consume.
 */
export function bindingScanEmpty(rows: GroupedRow[]): boolean {
  let sawBinding = false;
  for (const row of rows) {
    if (row.kind !== "token" || !row.binding) continue;
    sawBinding = true;
    if (hasCellValue(row.binding.codeValue)) return false;
  }
  return sawBinding;
}

/**
 * Whether a grouped row carries drift worth offering a fix for. Drives the
 * per-row "Copy fix prompt" button (shown in both apply modes).
 *
 * Value drift only. A binding-name difference whose *value* matches is not a
 * defect: both sides are bound to a token and the component renders exactly
 * what the design specifies — the two systems just spell the token
 * differently (`primary` vs `color/background/brand/default`). Token-name
 * matching is heuristic, so acting on a name mismatch alone would offer a
 * "fix" for something that isn't wrong, on evidence we don't trust. Binding
 * differences stay visible in the row and its advisory; they just don't get a
 * button. When the value genuinely drifts, the fix prompt carries the binding
 * detail with it.
 *
 * v0.0.38 made the rest of the panel agree with this function: those rows now
 * carry `status: "advisory"` from the engine, so the status pill, the bulk
 * tallies and the Check-all columns stopped calling them drift too. Half-fixed
 * was worse than either extreme — a designer saw 89 problems and zero offered
 * fixes.
 */
export function rowHasDrift(row: GroupedRow): boolean {
  if (row.kind === "token") {
    if (row.value) return row.value.status === "drift";
    // No value comparison happened, so we cannot say the render is wrong.
    return false;
  }
  return row.diff.status === "drift";
}

/* ------------------------------------------------------------------------- *
 * name-only binding divergence — advisory, not drift (issue #57)
 * ------------------------------------------------------------------------- */

/**
 * The advisory a token row carries when the two sides bind **differently named**
 * tokens and that difference is not (or not yet) evidence of a defect. Null for
 * every other row.
 *
 * `status: "advisory"` is set by the engine (`diffTokenBindings`), which is the
 * only place that can see both the two names and the paired value comparison.
 * The panel reads it here so the row's verdict, the tallies and the table order
 * all say the same thing — the specific inconsistency issue #57 reported was a
 * row whose status said drift while its (absent) fix button said otherwise.
 */
export interface BindingAdvisory {
  /** `"value-matched"` — values agree, spelling differs. `"unverified"` — no value comparison. */
  kind: NameDivergenceKind;
  /** Short verdict for the status cell. */
  label: string;
  /** The engine's full sentence: both names, and the `tokenAliases` entry to add. */
  detail: string;
  codeName: string;
  figmaName: string;
}

export function bindingAdvisory(row: GroupedRow): BindingAdvisory | null {
  const diff = row.kind === "token" ? row.binding : row.diff;
  if (!diff || diff.status !== "advisory") return null;
  const kind: NameDivergenceKind = diff.nameDivergence ?? "unverified";
  return {
    kind,
    label: kind === "value-matched" ? "name differs" : "name differs · unverified",
    detail: diff.note ?? "The two sides bind differently named tokens.",
    codeName: typeof diff.codeValue === "string" ? diff.codeValue : String(diff.codeValue ?? "—"),
    figmaName: typeof diff.figmaValue === "string" ? diff.figmaValue : String(diff.figmaValue ?? "—"),
  };
}

/** Per-status tallies for a report. */
export interface StatusCounts {
  match: number;
  drift: number;
  /** Name-only divergence whose value matched — real information, not a defect. */
  advisory: number;
  /** Name divergence with no value comparison behind it. Not a match. */
  unverified: number;
  flagOnly: number;
  unresolved: number;
}

export const EMPTY_STATUS_COUNTS: StatusCounts = {
  match: 0,
  drift: 0,
  advisory: 0,
  unverified: 0,
  flagOnly: 0,
  unresolved: 0,
};

/**
 * Tally a report's comparisons by what they actually found.
 *
 * The single source of the panel's `149 match · 89 drift · 75 flag-only` line and
 * of the per-story Check-all columns. `advisory` and `unverified` are broken out
 * rather than folded anywhere: folding them into `drift` is the bug (89 problems
 * where a human sees one), and folding them into `match` would claim agreement
 * the addon hasn't got.
 */
export function countStatuses(diffs: readonly DimensionDiff[]): StatusCounts {
  const counts: StatusCounts = { ...EMPTY_STATUS_COUNTS };
  for (const d of diffs) {
    switch (d.status) {
      case "match":
        counts.match++;
        break;
      case "drift":
        counts.drift++;
        break;
      case "advisory":
        // Missing `nameDivergence` counts as unverified: the weaker claim wins,
        // never the stronger one (an older cached report, or a future advisory
        // that hasn't said which it is, must not be tallied as "values agree").
        if (d.nameDivergence === "value-matched") counts.advisory++;
        else counts.unverified++;
        break;
      case "flag-only":
        counts.flagOnly++;
        break;
      case "unresolved":
        counts.unresolved++;
        break;
    }
  }
  return counts;
}

/**
 * Tally a report by the **rows the panel shows**, one entry per row.
 *
 * `countStatuses` counts comparisons; this counts findings. The difference is
 * `groupDimensions`: a token property produces up to two dimensions (a value
 * comparison and a binding comparison) and the table renders them as one row
 * whose verdict is the value comparison's — a binding-name difference is not a
 * defect (#57), and a Figma property detached from its variable is reported on
 * the same row as the value it now holds.
 *
 * Counting dimensions therefore said something different from the table about the
 * same story: `ui-button--neutral` rendered 4 drifted rows while the Check-all
 * summary said 7 drift, because three properties each drifted on both their value
 * and their binding. Same report, two numbers, nothing saying which was right —
 * and the inflated one is the number a reviewer sees at the definition-of-done
 * gate (#80).
 *
 * Precedence per row, strongest finding first: drift, then a name divergence,
 * then whatever the row's substantive comparison said. Exactly one bucket per
 * row, so the totals are row counts.
 */
export function countRowStatuses(rows: readonly GroupedRow[]): StatusCounts {
  const counts: StatusCounts = { ...EMPTY_STATUS_COUNTS };
  const countAdvisory = (kind: NameDivergenceKind | undefined): void => {
    // Same rule as `countStatuses`: missing `nameDivergence` is unverified, so
    // the weaker claim wins rather than the stronger one.
    if (kind === "value-matched") counts.advisory++;
    else counts.unverified++;
  };
  for (const row of rows) {
    if (rowHasDrift(row)) {
      counts.drift++;
      continue;
    }
    const nameDivergence = bindingAdvisory(row);
    if (nameDivergence) {
      countAdvisory(nameDivergence.kind);
      continue;
    }
    // What the row's verdict pill reads: the value comparison, or the binding
    // comparison when no value comparison happened.
    const primary = row.kind === "token" ? (row.value ?? row.binding) : row.diff;
    switch (primary?.status) {
      case "match":
        counts.match++;
        break;
      case "advisory":
        countAdvisory(primary.nameDivergence);
        break;
      case "flag-only":
        counts.flagOnly++;
        break;
      case "unresolved":
        counts.unresolved++;
        break;
      case "drift":
        // Only reachable as a binding drift on a row with no value comparison:
        // `rowHasDrift` refuses to call the render wrong when nothing compared
        // it, and calling it a match would claim agreement that wasn't tested.
        counts.unverified++;
        break;
      default:
        // A row with no diff at all carries no finding to count.
        break;
    }
  }
  return counts;
}

/* ------------------------------------------------------------------------- *
 * which layer a fix belongs in
 * ------------------------------------------------------------------------- */

/**
 * Which layer of the system a drifted row's fix belongs to.
 *
 *  - `"design"` — Figma's value is a literal with no variable behind it. The
 *    design names no token; the work is in Figma. (Same population as the
 *    `unbound-figma-value` finding.)
 *  - `"token"` — the code correctly binds the token Figma binds (reconciled by
 *    `tokenAliases` or by spelling), and only the **value** disagrees. The
 *    component is right; the token's value moved. Fixing this in the component
 *    would paper over a token-layer change, so the prompt must say so and must
 *    NOT propose a class swap or a literal.
 *  - `"component"` — the code binds a different token, or no token at all
 *    (a literal). This is the ordinary component fix.
 *
 * This exists because of a prompt found live that asked an agent to swap
 * `bg-primary` for "the utility class whose theme variable resolves to
 * `--background-brand-default`" — a *Figma* variable name presented as a
 * code-side target. No such utility exists, and the change wasn't a code change
 * at all. The panel already holds everything needed to classify the row; the
 * prompt's job is to state the layer, not to invent an edit.
 */
export type FixLayer = "design" | "token" | "component";

export function fixLayer(row: GroupedRow): FixLayer {
  if (row.kind !== "token") return "component";
  const value = row.value;
  if (!value || value.status !== "drift") return "component";
  const hasFigmaToken =
    value.tokenName !== undefined && value.tokenName !== null && value.tokenName !== "";
  // Figma HAS a value but nothing named behind it — detached from its variable.
  if (!hasFigmaToken) return hasCellValue(value.figmaValue) ? "design" : "component";
  // The binding comparison is the evidence for "the code already points at the
  // right token": only a `match` says the two sides name the same decision.
  return row.binding?.status === "match" ? "token" : "component";
}

/** The code-side token name a row binds, when the scanner found one. */
export function codeTokenName(row: GroupedRow): string | undefined {
  if (row.kind !== "token") return undefined;
  const code = row.binding?.codeValue;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/* ------------------------------------------------------------------------- *
 * variant-set applicability
 * ------------------------------------------------------------------------- */

/**
 * Tailwind utility families. A class whose head segment is one of these AND
 * which carries a scale tail (`bg-primary`, `px-4`, `text-sm`) is a utility,
 * not a variant modifier. Heads only — the tail is deliberately unconstrained
 * so an unknown consumer scale key (`bg-brandish`) still reads as a utility.
 */
const UTILITY_FAMILY_HEADS = new Set([
  "accent", "align", "animate", "appearance", "aspect", "auto", "backdrop", "basis",
  "bg", "block", "blur", "border", "bottom", "box", "break", "brightness", "caption",
  "caret", "clear", "col", "columns", "content", "contrast", "cursor", "decoration",
  "delay", "divide", "drop", "duration", "ease", "field", "fill", "filter", "flex",
  "float", "font", "from", "gap", "grayscale", "grid", "grow", "h", "hue", "hyphens",
  "indent", "inset", "invert", "isolation", "items", "justify", "leading", "left",
  "line", "list", "m", "mask", "max", "mb", "min", "mix", "ml", "mr", "mt", "mx",
  "my", "object", "opacity", "order", "origin", "outline", "overflow", "overscroll",
  "p", "pb", "peer", "pl", "place", "pointer", "pr", "pt", "px", "py", "right",
  "ring", "rotate", "rounded", "row", "saturate", "scale", "scroll", "select",
  "self", "sepia", "shadow", "shrink", "size", "skew", "snap", "space", "stroke",
  "subpixel", "supports", "table", "tab", "text", "to", "top", "touch", "tracking",
  "transform", "transition", "translate", "underline", "via", "w", "whitespace",
  "will", "wrap", "z",
]);

/**
 * Standalone utilities (no scale tail). Deliberately excludes words that are
 * equally plausible as hand-authored state modifiers — `hidden`, `visible`,
 * `active`, `open`, `disabled`, `checked` are NOT here, because misreading one
 * of those as a utility would suppress a check a BEM/adjacent-modifier
 * consumer legitimately relies on.
 */
const STANDALONE_UTILITIES = new Set([
  "antialiased", "border", "capitalize", "container", "contents", "flex", "grid",
  "inline", "inline-block", "inline-flex", "inline-grid", "isolate", "italic",
  "line-through", "lowercase", "no-underline", "overline", "relative", "absolute",
  "fixed", "sticky", "static", "rounded", "ring", "shadow", "sr-only", "table",
  "flow-root", "truncate", "underline", "uppercase",
]);

/**
 * Whether a class is recognizably a utility-framework class rather than a
 * component modifier.
 *
 * Honesty direction: an unrecognized class is treated as a *possible* modifier
 * (returns false), which keeps the variant-set row visible. Being wrong here
 * therefore preserves the pre-existing behaviour rather than silently dropping
 * a check.
 */
export function isUtilityShapedClass(cls: string): boolean {
  if (cls.length === 0) return false;
  // `hover:`, `dark:`, `data-[state=open]:`, `[&_svg]:` — variant-modified
  // classes only exist in utility frameworks.
  if (splitVariants(cls).variants.length > 0) return true;
  const bare = cls.replace(/^!/, "");
  // Arbitrary values / opacity modifiers / CSS-var shorthands: `bg-[#444]`,
  // `bg-primary/90`, `w-(--sidebar)`.
  if (/[[\]()/@]/.test(bare)) return true;
  if (STANDALONE_UTILITIES.has(bare)) return true;
  const unsigned = bare.replace(/^-/, "");
  const dash = unsigned.indexOf("-");
  if (dash <= 0) return false;
  return UTILITY_FAMILY_HEADS.has(unsigned.slice(0, dash));
}

/**
 * The modifier-class evidence on an element, using exactly the two
 * conventions the variant-set check knows how to reason about:
 *
 *  - **BEM modifiers** — any class containing `--`; the suffix is the
 *    modifier (`icon-button--accent` → `accent`). Unambiguous, so a class
 *    list containing one always counts as evidence.
 *  - **Adjacent modifiers** — `.file-item.active`: any class after the first
 *    (the base) that is not recognizably a utility class.
 *
 * Returns the candidates it found; empty means the check's premise — that
 * variants are expressed as modifier classes — does not hold for this
 * element.
 */
export function modifierClassCandidates(classes: string[]): string[] {
  const bem: string[] = [];
  for (const c of classes) {
    const i = c.indexOf("--");
    if (i > 0) bem.push(c.slice(i + 2));
  }
  if (bem.length > 0) return [...new Set(bem)];
  const adjacent = classes.slice(1).filter((c) => c.length > 0 && !isUtilityShapedClass(c));
  return [...new Set(adjacent)];
}

/** Everything the applicability decision is allowed to look at. */
export interface VariantSetContext {
  /**
   * Every class on the snapshotted element, in DOM order (the first is the
   * base). `undefined` when the snapshot predates `rootClasses` (an older
   * preview bundle) — treated as "evidence unknown", which keeps the row.
   */
  rootClasses?: string[] | undefined;
  /**
   * Figma variant axes this row actually evaluated (falsy/default axes
   * excluded — the check skips those). Empty for the COMPONENT_SET shape,
   * which has no per-axis props comparison to be redundant with.
   */
  evaluatedAxes?: string[];
  /** Status of the `props` row for each axis, by axis name. */
  propsStatuses?: Record<string, DimensionStatus>;
}

/**
 * Whether the `variant-set` row has any business being reported.
 *
 * The check compares Figma's variant values against modifier classes found on
 * the rendered element, using two CSS-era conventions (BEM `--` suffixes and
 * adjacent modifier classes). On a cva / Tailwind component that premise is
 * structurally false: variants are cva keys chosen by **props**, and the
 * element carries a long list of utility classes that are not modifiers at
 * all. Reported anyway, the row swept 25 utility classes into its "code
 * variants" cell, claimed `Figma variants not present in code`, and advised
 * adding a BEM modifier rule — confident guidance that is wrong for that
 * architecture, while the `props` rows right below it had already compared
 * the same axes against the story args and matched.
 *
 * So the row is suppressed when EITHER:
 *
 *  1. **No modifier-class evidence.** `modifierClassCandidates` finds neither
 *     a BEM `--` class nor a non-utility adjacent class, so there is nothing
 *     the check's heuristics can reason about.
 *  2. **The `props` rows already cover every axis, and all of them match.**
 *     Nothing is left to report or to add.
 *
 * Conservative by construction: a class list containing a BEM `--` class is
 * always evidence, an unrecognized class counts as a possible modifier, and
 * rule 2 needs at least one evaluated axis and a `match` on every one of
 * them. Whenever there is real modifier evidence and anything unconfirmed,
 * the row (and its advisory) is reported exactly as before.
 */
export function variantSetRowApplicable(ctx: VariantSetContext): boolean {
  if (ctx.rootClasses !== undefined && modifierClassCandidates(ctx.rootClasses).length === 0) {
    return false;
  }
  const axes = ctx.evaluatedAxes ?? [];
  if (axes.length > 0) {
    const statuses = ctx.propsStatuses ?? {};
    if (axes.every((axis) => statuses[axis] === "match")) return false;
  }
  return true;
}

/**
 * Collapse a long list-shaped cell value into "N items" plus the items
 * themselves, so a `variant-set` row that legitimately appears doesn't paste
 * a 25-class dump into the table (and again into its Notes). Returns null
 * when the value is short enough to read inline — three or fewer entries are
 * clearer flat than behind a disclosure.
 */
export function summarizeListCell(
  value: unknown,
  threshold = 3,
): { count: number; items: string[] } | null {
  if (!Array.isArray(value)) return null;
  const items = value.map((v) => String(v));
  if (items.length <= threshold) return null;
  return { count: items.length, items };
}

/**
 * If a value is a `{light, dark}` map produced by dual-mode merging,
 * flatten it to a single string when both modes agree. If modes disagree,
 * return null — that's a per-mode edit which v0 doesn't model.
 */
export function flattenDualModeValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const modeValues = Object.values(v).filter((x): x is string => typeof x === "string");
    if (modeValues.length === 0) return null;
    const first = modeValues[0]!;
    if (modeValues.every((m) => m === first)) return first;
  }
  return null;
}

export function tokenRowFixability(
  value: DimensionDiff | undefined,
  binding: DimensionDiff | undefined,
): { bindingFixable: boolean; valueFixable: boolean } {
  const bindingFixable = !!(
    binding &&
    binding.status === "drift" &&
    flattenDualModeValue(binding.codeValue) !== null &&
    flattenDualModeValue(binding.figmaValue) !== null
  );
  const valueTokenName = value?.tokenName ?? null;
  const valueFixable = !!(
    !bindingFixable &&
    value &&
    value.status === "drift" &&
    valueTokenName !== null
  );
  return { bindingFixable, valueFixable };
}

/**
 * Whether the addon's **write engines** could act on this row.
 *
 * This is the old `partitionRow` predicate, unchanged in behaviour and renamed
 * to what it actually decides. Its only remaining job is to keep an Apply
 * button off a drifted row no engine could honor (only reachable at all under
 * `apply: "experimental"`). It must NEVER decide where a row appears or how
 * prominent it is — that was the false partition v0.0.37 removed.
 *
 * Invariant (P2.2): `props` and `variant-set` drift ALWAYS answers `false` —
 * there is no engine that can honor an Apply for them, so no Apply button may
 * ever render. Enforced by test.
 *
 * Matches answer `true` because there is nothing to refuse; that is the
 * pre-existing behaviour and is preserved deliberately.
 */
export function applyEngineCanAct(row: GroupedRow): boolean {
  if (row.kind === "token") {
    const valueDrifted = row.value?.status === "drift";
    const bindingDrifted = row.binding?.status === "drift";
    if (!valueDrifted && !bindingDrifted) return true;
    const { bindingFixable, valueFixable } = tokenRowFixability(row.value, row.binding);
    return bindingFixable || valueFixable;
  }
  // `other`-kind diffs (copy, props, variant-set, structure, motion): no
  // engine, with one exception — `copy` has a real engine pair (code-tsx-text
  // + the plugin's characters write) when both sides carry concrete strings.
  if (row.diff.status !== "drift") return true;
  if (row.diff.kind === "copy") {
    const codeFlat = flattenDualModeValue(row.diff.codeValue);
    const figmaFlat = flattenDualModeValue(row.diff.figmaValue);
    return codeFlat !== null && figmaFlat !== null;
  }
  return false;
}

/* ------------------------------------------------------------------------- *
 * what kind of finding a row is (drives table order + row labelling)
 * ------------------------------------------------------------------------- */

/**
 * What a row actually found. This is the honest classification the panel
 * presents, and it replaces the deleted fixability partition.
 *
 * - `unbound-figma-value` — drift where Figma's side is a **literal with no
 *   variable behind it**. A designer detaching a property from its variable is
 *   a design-system violation and one of the most significant things this tool
 *   can detect; it used to be *demoted* (no token name → "unfixable") which
 *   inverted its importance. First-class, top of the table, and its fix routes
 *   to Figma — never to a hardcoded literal or a re-tuned theme token.
 * - `value-drift` — drift with a named property and a concrete expected value.
 *   Mechanical: paste the fix prompt and go.
 * - `judgement` — the two models disagree structurally and a human has to
 *   decide which side is wrong: `props` / `variant-set` advisories, a `copy`
 *   row whose code side is dynamic, and drift where Figma has **no** value for
 *   a property the code declares.
 * - `no-drift` — match, `flag-only`, or `unresolved`. Confirmation or setup,
 *   not a problem.
 */
export type RowFinding = "unbound-figma-value" | "value-drift" | "judgement" | "no-drift";

export function classifyRow(row: GroupedRow): RowFinding {
  if (row.kind === "token") {
    // `rowHasDrift` is value-drift only (a binding-name difference whose value
    // matches is not a defect), so a row that isn't drifted is `no-drift` even
    // when its binding names differ.
    if (!rowHasDrift(row)) return "no-drift";
    const value = row.value;
    if (!value) return "no-drift";
    if (value.tokenName !== undefined && value.tokenName !== null && value.tokenName !== "") {
      return "value-drift";
    }
    // No token name behind Figma's side. Two very different situations:
    //  - Figma HAS a value → it was typed in / detached from its variable.
    //  - Figma has NO value → the design says nothing about a property the
    //    code declares, which is a structural disagreement, not a detached
    //    token. Routing that to "re-bind it in Figma" would be wrong.
    return hasCellValue(value.figmaValue) ? "unbound-figma-value" : "judgement";
  }
  const d = row.diff;
  if (d.status !== "drift") return "no-drift";
  if (d.kind === "copy") {
    const codeFlat = flattenDualModeValue(d.codeValue);
    const figmaFlat = flattenDualModeValue(d.figmaValue);
    return codeFlat !== null && figmaFlat !== null ? "value-drift" : "judgement";
  }
  // props / variant-set / structure / motion.
  return "judgement";
}

/**
 * Sort rank for the single drift table. Lower sorts higher:
 *
 *   0  unbound Figma value — a detached token, the most significant finding
 *   1  value drift — mechanical, one prompt away from fixed
 *   2  needs a judgement call — structural disagreement, no mechanical fix
 *   3  no drift, but something wants attention: a name-only binding divergence
 *      (`advisory`), or something unset or unreadable (`flag-only` /
 *      `unresolved`) — all worth seeing before a wall of matches
 *   4  no drift, everything agreed
 *
 * Drift at the top, matches at the bottom, and nothing hidden. An advisory shares
 * rank 3 rather than getting one of its own: it is genuinely "no drift, but read
 * me", the same class of finding as an unset property.
 */
export function rowRank(row: GroupedRow): number {
  const finding = classifyRow(row);
  if (finding === "unbound-figma-value") return 0;
  if (finding === "value-drift") return 1;
  if (finding === "judgement") return 2;
  if (bindingAdvisory(row)) return 3;
  const statuses =
    row.kind === "token"
      ? [row.value?.status, row.binding?.status]
      : [row.diff.status];
  return statuses.some((s) => s === "flag-only" || s === "unresolved") ? 3 : 4;
}

/**
 * Order rows for display: by finding, then by their original order (stable), so
 * within a rank the engine's / registry's ordering is preserved exactly. Never
 * drops or merges a row — the input length is the output length.
 */
export function sortRowsByFinding(rows: readonly GroupedRow[]): GroupedRow[] {
  return rows
    .map((row, i) => ({ row, i, rank: rowRank(row) }))
    .sort((a, b) => (a.rank === b.rank ? a.i - b.i : a.rank - b.rank))
    .map((entry) => entry.row);
}

/**
 * Whether a row carries an advisory (a sentence about why there is no
 * mechanical fix, or what actually happened in Figma). True exactly for the two
 * findings whose next step is not "paste the prompt": `judgement` and
 * `unbound-figma-value`.
 */
export function rowHasAdvisory(row: GroupedRow): boolean {
  const finding = classifyRow(row);
  return finding === "judgement" || finding === "unbound-figma-value";
}

/** Format a `{Prop: Value}` map or array as a compact `[a=b, c]` list. */
function describeSide(value: unknown): string {
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (value && typeof value === "object") {
    return `[${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(", ")}]`;
  }
  return String(value ?? "—");
}

/**
 * The code side of a variant-set row, without pasting the whole candidate list
 * a second time — the row's Code cell already carries the list (behind a
 * disclosure when it's long). Long lists become a count so the advisory stays
 * readable; short ones are still spelled out, since naming two classes is more
 * useful than counting them.
 */
function describeCodeVariants(value: unknown): string {
  const long = summarizeListCell(value);
  return long ? `${long.count} candidate modifier classes` : describeSide(value);
}

/* ------------------------------------------------------------------------- *
 * per-element grouping (declared child bindings)
 * ------------------------------------------------------------------------- */

/**
 * Which element a grouped row describes. `undefined` = the story root.
 * Every diff in a token row shares one element, so the first one that carries
 * the field answers for the row.
 */
export function rowChildSelector(row: GroupedRow): string | undefined {
  if (row.kind === "token") return row.value?.childSelector ?? row.binding?.childSelector;
  return row.diff.childSelector;
}

export interface ElementGroup {
  /** `undefined` for the story root; otherwise the declared child selector. */
  selector: string | undefined;
  /** Heading text: "Story root", or the selector plus the Figma node's name. */
  label: string;
  /** Figma node id compared for this element, when known. */
  nodeId?: string;
  /** The Figma node's own name, when the node was read successfully. */
  nodeName?: string;
  rows: GroupedRow[];
}

/**
 * Split rows into per-element groups, **root first**, then declared children in
 * registry order.
 *
 * A flat table where a child's `padding-top` is indistinguishable from the
 * root's would be worse than no feature: both rows are individually true, and
 * together they read as one contradictory element. So grouping is not cosmetic
 * — it is what makes a child row mean anything.
 *
 * Returns a single root group (with no label shown by the caller) for a story
 * with no child bindings, which is how the pre-existing panel layout is
 * preserved exactly.
 */
export function groupRowsByElement(
  rows: GroupedRow[],
  children: readonly ChildBindingReport[] | undefined,
): ElementGroup[] {
  const rootRows: GroupedRow[] = [];
  const byselector = new Map<string, GroupedRow[]>();
  for (const row of rows) {
    const selector = rowChildSelector(row);
    if (selector === undefined) {
      rootRows.push(row);
      continue;
    }
    const list = byselector.get(selector) ?? [];
    list.push(row);
    byselector.set(selector, list);
  }

  const groups: ElementGroup[] = [{ selector: undefined, label: "Story root", rows: rootRows }];

  // Registry order first, so the panel matches the order the author wrote.
  const seen = new Set<string>();
  for (const child of children ?? []) {
    seen.add(child.selector);
    const group: ElementGroup = {
      selector: child.selector,
      label: childGroupLabel(child),
      rows: byselector.get(child.selector) ?? [],
    };
    if (child.nodeId) group.nodeId = child.nodeId;
    if (child.nodeName) group.nodeName = child.nodeName;
    groups.push(group);
  }
  // Any selector with rows but no report entry (defensive — the server builds
  // `children` from the same declarations). Shown rather than dropped.
  for (const [selector, list] of byselector) {
    if (seen.has(selector)) continue;
    groups.push({ selector, label: selector, rows: list });
  }
  return groups;
}

/** `[data-slot=header] → "Card header"` when Figma named the node. */
export function childGroupLabel(child: ChildBindingReport): string {
  return child.nodeName ? `${child.selector} → ${child.nodeName}` : child.selector;
}

/**
 * Child bindings that produced no comparison. Rendered as a prominent block, not
 * folded into the table: each one is a piece of the component that a "clean"
 * report does NOT cover, and the user has to know that.
 */
export function unresolvedChildBindings(
  children: readonly ChildBindingReport[] | undefined,
): ChildBindingReport[] {
  return (children ?? []).filter((c) => c.status !== "compared");
}

/**
 * Per-row advisory: what this row means and what the concrete next step is.
 * Shown on every `judgement` and `unbound-figma-value` row (see
 * `rowHasAdvisory`). Each branch points at the actual blocker so the user knows
 * what to change — never a generic "no engine" shrug (P2.3).
 *
 * Every branch below other than the two token-value ones is byte-identical to
 * the text this function has always produced; removing the fixability partition
 * was a presentation change, not a truthfulness change.
 */
export function explainInfo(row: GroupedRow): string {
  if (row.kind === "token") {
    const valueDrift = row.value?.status === "drift";
    const bindingDrift = row.binding?.status === "drift";
    if (valueDrift && row.value?.tokenName == null) {
      // Figma has a value but nothing named behind it: the property was
      // detached from its variable (or typed in directly). Say what happened —
      // the old wording ("no token to promote the code literal to") described
      // the addon's inconvenience, not the design-system violation, and read as
      // a demotion of the row.
      if (hasCellValue(row.value?.figmaValue)) {
        return (
          `Figma's value here is NOT bound to a variable — it is a literal in the design, so there is no token to point at. ` +
          `Fix it in Figma by binding this property to the variable it should use, then re-run the check. ` +
          `Do not hardcode Figma's literal in code and do not retune a theme token to match it: either would bake a detached value into the codebase and hide the violation.`
        );
      }
      // Figma has no value at all for a property the code declares.
      return (
        `The code declares this property but Figma's node has no value for it, so there is nothing to match it against. ` +
        `Decide which side is right: drop the declaration in code, or specify the property in Figma (bound to a variable) and re-run the check.`
      );
    }
    if (bindingDrift) {
      return "Wiring drift, but the scanner couldn't find a clean var(--token) binding on the code side. Convert the inline value to `\"var(--token)\"` (or the equivalent CSS) so the engine has something to rewrite.";
    }
    return "Drifted, but the addon couldn't find a token binding for this property — wire it up in CSS/JSX, or fix manually.";
  }
  const d = row.diff;
  if (d.kind === "copy") {
    const codeFlat = flattenDualModeValue(d.codeValue);
    const figmaFlat = flattenDualModeValue(d.figmaValue);
    if (codeFlat === null && figmaFlat !== null) {
      return `Code renders no static text matching "${figmaFlat}". The component likely uses a dynamic child (e.g. \`{label}\`) — copy auto-apply can only rewrite literal JSX text.`;
    }
    if (codeFlat !== null && figmaFlat === null) {
      return "Figma's matching TEXT node is empty or missing — nothing to compare against, fix manually.";
    }
    return "Copy drift detected but values aren't both concrete strings — fix manually.";
  }
  if (d.kind === "variant-set") {
    // Two shapes (see figma-rest diffVariantSet): "active-variant" compares
    // a bound COMPONENT's variant props against code modifier classes;
    // "variant-options" compares code modifiers against a COMPONENT_SET's
    // option list.
    if (d.property === "active-variant") {
      const missing = d.note?.match(/\[(.+)\]/)?.[1];
      const what = missing ? `Figma variant(s) ${`[${missing}]`}` : `Figma side ${describeSide(d.figmaValue)}`;
      return (
        `${what} have no matching modifier class in code (code has ${describeCodeVariants(d.codeValue)}). ` +
        `Fix code-side by adding the BEM modifier rule and story, or Figma-side by removing/renaming the variant. ` +
        `No auto-apply: creating an empty CSS rule or deleting a Figma variant would be a guess — see roadmap P3.1 (per-variant-explicit codemod).`
      );
    }
    return (
      `Code declares variant class(es) ${describeCodeVariants(d.codeValue)} not in the Figma component set's options ${describeSide(d.figmaValue)}. ` +
      `Fix Figma-side by adding the option to the variant property, or code-side by renaming/removing the modifier class. ` +
      `No auto-apply: which side is wrong isn't inferable from the diff.`
    );
  }
  if (d.kind === "props") {
    const figma = flattenDualModeValue(d.figmaValue) ?? describeSide(d.figmaValue);
    return (
      `Figma variant sets ${d.property}=${figma}, but the story args carry no matching value. ` +
      `Fix code-side by setting the matching value in the story's \`args\`, or re-register the story against the variant node that matches the current args. ` +
      `Prop-default auto-writes are deferred: this diff has no unambiguous write target (arg? registry binding? Figma default?) — guessing would violate the honesty contract.`
    );
  }
  if (d.kind === "structure") {
    // Visible since v0.0.39, so the old "reserved for a future engine" line
    // would now be false on a row carrying two real values. There is still no
    // Apply path (rewriting a layout property is a component decision, not a
    // token swap), so this says which two values disagree and that the fix is
    // a human one.
    const code = flattenDualModeValue(d.codeValue) ?? describeSide(d.codeValue);
    const figma = flattenDualModeValue(d.figmaValue) ?? describeSide(d.figmaValue);
    return (
      `Figma's auto-layout implies \`${d.property}: ${figma}\`, the rendered element computes \`${code}\`. ` +
      `Decide which side is right: change the layout in code, or change the auto-layout in Figma. ` +
      `No auto-apply — a layout property is a component decision, and the addon will not rewrite one from a diff.`
    );
  }
  if (d.kind === "motion") {
    return `\`${d.kind}\` dimension is reserved for a future engine — surfaced for awareness only.`;
  }
  return `No engine for "${d.kind}" dimension yet — fix in code or Figma manually.`;
}
