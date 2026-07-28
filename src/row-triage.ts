import { splitVariants } from "@metalab/design-sync-core";
import type {
  ChildBindingReport,
  DimensionDiff,
  DimensionStatus,
} from "./dimensions/types.js";

/**
 * Pure row-triage logic for the drift panel, extracted from manager.tsx so
 * the honesty contract (Phase 2: "no Apply button on a row the engine can't
 * honor") is unit-testable outside React.
 *
 * `partitionRow` decides main-table vs collapsed-informational; `explainInfo`
 * produces the per-row advisory for informational rows. P2.2/P2.3 upgraded
 * the props / variant-set advisories from a generic "no engine yet" line to
 * specific, data-driven guidance naming exactly what drifted and what to do
 * on each side.
 */

export type GroupedRow =
  | { kind: "token"; property: string; value?: DimensionDiff; binding?: DimensionDiff }
  | { kind: "other"; diff: DimensionDiff };

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
 * Decide whether a grouped row belongs in the main action table or the
 * collapsed informational section. A row is "informational" when there
 * is drift but the addon's Apply path can't act on it — either because
 * the dimension kind has no engine, or because the row's data can't be
 * turned into a valid Edit. Matches always stay in the main section —
 * they're confirmation, not a problem.
 *
 * Invariant (P2.2): `props` and `variant-set` drift ALWAYS partitions to
 * "info" — there is no engine that can honor an Apply for them, so no
 * Apply button may ever render. Enforced by test.
 */
export function partitionRow(row: GroupedRow): "main" | "info" {
  if (row.kind === "token") {
    const valueDrifted = row.value?.status === "drift";
    const bindingDrifted = row.binding?.status === "drift";
    if (!valueDrifted && !bindingDrifted) return "main";
    const { bindingFixable, valueFixable } = tokenRowFixability(row.value, row.binding);
    return bindingFixable || valueFixable ? "main" : "info";
  }
  // `other`-kind diffs (copy, props, variant-set, structure, motion):
  // most are informational. The exception is `copy`, which has a real
  // engine pair (code-tsx-text + the plugin's characters write) when both
  // sides carry concrete strings. Matches always stay in the main section.
  if (row.diff.status !== "drift") return "main";
  if (row.diff.kind === "copy") {
    const codeFlat = flattenDualModeValue(row.diff.codeValue);
    const figmaFlat = flattenDualModeValue(row.diff.figmaValue);
    return codeFlat !== null && figmaFlat !== null ? "main" : "info";
  }
  return "info";
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
 * Per-row reason the row landed in the informational section, with concrete
 * next steps. Each branch points at the actual blocker so the user knows
 * what to change — never a generic "no engine" shrug (P2.3).
 */
export function explainInfo(row: GroupedRow): string {
  if (row.kind === "token") {
    const valueDrift = row.value?.status === "drift";
    const bindingDrift = row.binding?.status === "drift";
    if (valueDrift && row.value?.tokenName == null) {
      return "Value drift, but Figma's side doesn't resolve to a named token — there's no token to promote the code literal to.";
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
  if (d.kind === "structure" || d.kind === "motion") {
    return `\`${d.kind}\` dimension is reserved for a future engine — surfaced for awareness only.`;
  }
  return `No engine for "${d.kind}" dimension yet — fix in code or Figma manually.`;
}
