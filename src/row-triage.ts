import type { DimensionDiff } from "./dimensions/types.js";

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
 * Whether a grouped row carries any drift. Drives the per-row
 * "Copy fix prompt" button (shown in both apply modes).
 */
export function rowHasDrift(row: GroupedRow): boolean {
  if (row.kind === "token") {
    return row.value?.status === "drift" || row.binding?.status === "drift";
  }
  return row.diff.status === "drift";
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
        `${what} have no matching modifier class in code (code has ${describeSide(d.codeValue)}). ` +
        `Fix code-side by adding the BEM modifier rule and story, or Figma-side by removing/renaming the variant. ` +
        `No auto-apply: creating an empty CSS rule or deleting a Figma variant would be a guess — see roadmap P3.1 (per-variant-explicit codemod).`
      );
    }
    return (
      `Code declares variant class(es) ${describeSide(d.codeValue)} not in the Figma component set's options ${describeSide(d.figmaValue)}. ` +
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
