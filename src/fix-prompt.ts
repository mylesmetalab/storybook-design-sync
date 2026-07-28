import { tokenNameToCssVar } from "@metalab/design-sync-core";
import type { RowFinding } from "./row-triage.js";
import { expectedIdentity, propertyFamily, type PropertyFamily } from "./property-families.js";

/**
 * Pure builder for the "Copy fix prompt" features. Produces fully
 * self-contained prompts a coding agent can act on with NO other context: what
 * drifted, where the code lives (or how to find it), what the current and
 * expected values are, and how to finish the job.
 *
 * Three shapes, one format:
 *
 *  - `buildFixPrompt` — one row. Names the row's **drifted siblings** when the
 *    same design change also hit `padding-right`/`-bottom`/`-left`, because a
 *    lone per-row prompt pasted into a fresh session is exactly how a component
 *    ends up with 6/12/12/12 padding. The information has to travel inside the
 *    prompt; nothing downstream is guaranteed to re-check.
 *  - `buildFixPrompt` with `finding: "unbound-figma-value"` — a Figma value
 *    detached from its variable. Routed to the design side; it must never tell
 *    anyone to hardcode the literal or retune a theme token to match it.
 *  - `buildBulkFixPrompt` — every drifted row in the story as ONE instruction,
 *    with related properties grouped so the agent sees one change instead of
 *    four. Same context/detail wording as the per-row prompt (shared helpers
 *    below), not a second prompt format.
 *
 * Kept free of React/DOM so it is unit-testable; the clipboard interaction
 * lives in manager.tsx.
 */

export interface FixPromptInput {
  storyId: string;
  /** DimensionDiff.kind — e.g. "token-value", "token-binding", "copy". */
  kind: string;
  /** CSS property (or diff property name, e.g. "active-variant"). */
  property: string;
  /** Current code-side value from the drift row. */
  codeValue: unknown;
  /** Expected value from Figma. */
  figmaValue: unknown;
  /** Figma token name backing the expected value, when known (e.g. "space/4"). */
  tokenName?: string | undefined;
  /** CSS selector the story snapshots (parameters.designSync.target). */
  selector?: string | undefined;
  /**
   * The Tailwind utility class the code-side binding came from
   * (`"bg-primary"`), when the scanner derived this property from a utility
   * class rather than a `var(--token)` declaration. When present, the prompt
   * names the class to change — on a shadcn/cva codebase "set background-color
   * to X" is not actionable guidance, "replace `bg-primary` with the utility
   * for X" is.
   */
  codeClassName?: string | undefined;
  /**
   * Consumer-relative file paths the addon is configured to write
   * (config.codeTargets). Best available hint for where the fix lands.
   */
  filePaths?: string[] | undefined;
  /** Figma node id the story is registered against. */
  nodeId?: string | undefined;
  /** Figma file key. */
  fileKey?: string | undefined;
  /** Engine note attached to the row, when present. */
  note?: string | undefined;
  /**
   * What kind of finding this row is (see `row-triage.ts`). Absent behaves
   * exactly like `"value-drift"`, so every existing call site is unchanged.
   * `"unbound-figma-value"` switches the prompt to the design-side variant.
   */
  finding?: RowFinding | undefined;
  /**
   * The panel's advisory for this row (`explainInfo`), when it has one. Carried
   * into the prompt so a judgement-call row arrives with the reason a
   * mechanical fix isn't available, instead of an agent inventing one.
   */
  advisory?: string | undefined;
  /**
   * Sibling properties in the same family that drifted to the SAME expected
   * value on the same element (`driftedSiblings` in `property-families.ts`).
   * Named in the prompt so a per-row copy cannot cause the asymmetric-value
   * outcome on its own.
   */
  siblingProperties?: readonly string[] | undefined;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** "`a`, `b` and `c`" — Oxford-free, matches how the panel's copy reads. */
function codeList(items: readonly string[]): string {
  const ticked = items.map((p) => `\`${p}\``);
  if (ticked.length <= 1) return ticked.join("");
  return `${ticked.slice(0, -1).join(", ")} and ${ticked[ticked.length - 1]}`;
}

/**
 * Best-effort component name from a CSF story id
 * (`atoms-iconbutton--accent` → `iconbutton`). The id's title path is the
 * only component identity the drift report carries; the last title segment
 * is the component. Falls back to the whole id when there's no `--`.
 */
export function componentNameFromStoryId(storyId: string): string {
  const title = storyId.split("--")[0] ?? storyId;
  const segments = title.split("-").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1]! : storyId;
}

/**
 * The `## Context` block: which story, which component, where the code is, and
 * the Figma coordinates. Shared by all three prompt shapes so an agent sees the
 * same orientation regardless of which button was pressed.
 *
 * `includeCodeTargets: false` drops the "the change belongs in one of these
 * files" guidance — used by the design-side variant, where pointing at code
 * files would contradict the instruction not to touch code.
 */
function contextLines(
  input: Pick<
    FixPromptInput,
    "storyId" | "kind" | "selector" | "filePaths" | "nodeId" | "fileKey" | "codeClassName"
  >,
  component: string,
  opts: { includeCodeTargets: boolean; includeKind: boolean },
): string[] {
  const lines: string[] = [];
  lines.push(`## Context`);
  lines.push(`- Storybook story id: \`${input.storyId}\``);
  lines.push(`- Component: ${component}`);
  if (opts.includeKind) lines.push(`- Drift dimension: ${input.kind}`);
  if (input.selector) {
    lines.push(`- CSS selector for the affected element: \`${input.selector}\``);
  }
  if (opts.includeCodeTargets) {
    if (input.filePaths && input.filePaths.length > 0) {
      lines.push(
        `- The change belongs in one of these files (the project's configured code targets):`,
      );
      for (const p of input.filePaths) lines.push(`  - \`${p}\``);
    } else if (input.selector) {
      lines.push(
        `- No code file paths are configured — search the codebase for the rule that styles \`${input.selector}\` and make the change there.`,
      );
    } else {
      lines.push(
        `- No code file paths or selector are available — locate the styles for the "${component}" component (story \`${input.storyId}\`) and make the change there.`,
      );
    }
  }
  if (input.nodeId || input.fileKey) {
    lines.push(
      `- Figma reference (for humans; you don't need Figma access): node \`${input.nodeId ?? "unknown"}\` in file \`${input.fileKey ?? "unknown"}\``,
    );
  }
  if (opts.includeCodeTargets && input.codeClassName) {
    lines.push(
      `- The code sets this property with the Tailwind utility class \`${input.codeClassName}\`, ` +
        `not a CSS declaration. That class is what the fix should change ` +
        `(it may live in a \`cva()\` base array or variant slot).`,
    );
  }
  return lines;
}

/** The sibling sentence — the whole point of item 2, kept in one place. */
function siblingSentence(input: FixPromptInput): string | null {
  const siblings = input.siblingProperties ?? [];
  if (siblings.length === 0) return null;
  const expected = input.tokenName ? input.tokenName : stringify(input.figmaValue);
  const verb = siblings.length === 1 ? "has" : "have";
  return (
    `${codeList(siblings)} ${verb} also drifted to \`${expected}\`. ` +
    `These are one design change — fix them together, or state why you are fixing only this one.`
  );
}

/**
 * The `## The drift` bullets for a single row. Byte-identical to the wording
 * this prompt has always used; the sibling and advisory bullets are additive and
 * only appear when the data is there.
 */
function driftBullets(input: FixPromptInput, opts: { includeSiblings: boolean }): string[] {
  const lines: string[] = [];
  lines.push(`- Property: \`${input.property}\``);
  lines.push(`- Current value in code: \`${stringify(input.codeValue)}\``);
  const figma = stringify(input.figmaValue);
  if (input.tokenName) {
    const cssVar = tokenNameToCssVar(input.tokenName);
    lines.push(
      `- Expected value from Figma: \`${figma}\`, backed by the design token \`${input.tokenName}\` (CSS custom property: \`var(${cssVar})\`)`,
    );
    if (input.codeClassName) {
      // Telling a Tailwind codebase to write `background-color: var(--x)` is
      // advice it cannot take — the whole point of the class is that there is
      // no declaration to edit.
      lines.push(
        `- Prefer wiring the token: swap \`${input.codeClassName}\` for the utility class whose theme variable resolves to \`${cssVar}\`, rather than hardcoding \`${figma}\` or adding an arbitrary value like \`[${figma}]\`. If no utility maps to that token, the gap is in the theme — add the variable to \`@theme\` rather than inlining the value.`,
      );
    } else {
      lines.push(
        `- Prefer wiring the token: set \`${input.property}: var(${cssVar})\` rather than hardcoding \`${figma}\`, so the code follows future token changes.`,
      );
    }
  } else {
    lines.push(`- Expected value from Figma: \`${figma}\``);
  }
  if (opts.includeSiblings) {
    const siblings = siblingSentence(input);
    if (siblings) lines.push(`- Sibling properties drifted the same way: ${siblings}`);
  }
  if (input.note) {
    lines.push(`- Note from the drift engine: ${input.note}`);
  }
  if (input.advisory) {
    lines.push(`- What the addon can tell you about this row: ${input.advisory}`);
  }
  return lines;
}

export function buildFixPrompt(input: FixPromptInput): string {
  if (input.finding === "unbound-figma-value") return buildUnboundFigmaValuePrompt(input);

  const component = componentNameFromStoryId(input.storyId);
  const lines: string[] = [];

  lines.push(
    `Fix a design-system drift found by storybook-design-sync: the code and the Figma design disagree on \`${input.property}\` for the "${component}" component.`,
  );
  lines.push("");
  lines.push(...contextLines(input, component, { includeCodeTargets: true, includeKind: true }));
  lines.push("");
  lines.push(`## The drift`);
  lines.push(...driftBullets(input, { includeSiblings: true }));
  lines.push("");
  lines.push(`## Instructions`);
  const steps: string[] = [];
  steps.push(
    input.codeClassName
      ? `Make this change so the code matches the Figma value above. Keep the change minimal — change only the \`${input.codeClassName}\` class on this component/variant, and leave every other utility class alone.`
      : `Make this change so the code matches the Figma value above. Keep the change minimal — touch only the declaration(s) responsible for this property on this component/variant.`,
  );
  const siblings = input.siblingProperties ?? [];
  if (siblings.length > 0) {
    steps.push(
      `Apply the same value to the sibling properties named above (${codeList(siblings)}) in the same edit — they drifted to the same expected value and are one design change. ` +
        `Changing only \`${input.property}\` leaves the component in a state nobody designed (one padding changed out of four); if you deliberately fix only this one, say so in your summary.`,
    );
  }
  steps.push(`Do not reformat unrelated code or rename anything.`);
  steps.push(
    `Run the project's typecheck and test commands and make sure both pass before finishing.`,
  );
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));

  return lines.join("\n");
}

/**
 * The design-side prompt: Figma's value here is a literal with no variable
 * behind it, so there is no token for code to follow.
 *
 * Deliberately NOT a code-fix prompt. Telling an agent to write the literal into
 * code (or to retune a theme token so the code matches) would bake the detached
 * value into the codebase and destroy the evidence — the drift row would go
 * green while the design-system violation stayed. The work belongs to whoever
 * owns the Figma file.
 */
function buildUnboundFigmaValuePrompt(input: FixPromptInput): string {
  const component = componentNameFromStoryId(input.storyId);
  const figma = stringify(input.figmaValue);
  const lines: string[] = [];

  lines.push(
    `Route a design-system violation found by storybook-design-sync back to design: in Figma, \`${input.property}\` on the "${component}" component is set to a literal value that is NOT bound to a variable, so the design names no token for the code to follow. This is a Figma fix, not a code fix.`,
  );
  lines.push("");
  lines.push(...contextLines(input, component, { includeCodeTargets: false, includeKind: true }));
  lines.push("");
  lines.push(`## What was found`);
  lines.push(`- Property: \`${input.property}\``);
  lines.push(`- Current value in code: \`${stringify(input.codeValue)}\``);
  lines.push(
    `- Value in Figma: \`${figma}\` — a literal typed into the design, NOT bound to a variable.`,
  );
  lines.push(
    `- There is therefore no design token naming the expected value, and nothing for the code to point at.`,
  );
  const siblings = siblingSentence(input);
  if (siblings) lines.push(`- Sibling properties in the same state: ${siblings}`);
  if (input.note) lines.push(`- Note from the drift engine: ${input.note}`);
  lines.push("");
  lines.push(`## What to do`);
  lines.push(
    `1. Hand this to whoever owns the Figma file: in Figma, bind \`${input.property}\` on node \`${input.nodeId ?? "unknown"}\` (file \`${input.fileKey ?? "unknown"}\`) to the variable it should use. If which token is correct isn't obvious, the design-system owner decides — do not guess.`,
  );
  lines.push(
    `2. Do NOT hardcode Figma's literal \`${figma}\` in code, and do NOT add or change a theme token so the code matches that literal. Either would bake a detached value into the codebase and hide the violation while turning this row green.`,
  );
  lines.push(
    `3. Change no code for this row. If you were asked to fix it in code, report back that the Figma value has to be re-bound to a variable first.`,
  );
  lines.push(
    `4. Once it is re-bound, re-run "Check drift". If code and the now-named token still disagree, that is ordinary value drift and gets fixed in code then.`,
  );

  return lines.join("\n");
}

/* ------------------------------------------------------------------------- *
 * bulk prompt — every drifted row in the story, as one instruction
 * ------------------------------------------------------------------------- */

export interface BulkFixPromptInput {
  storyId: string;
  /** Story-level context (the story root's selector, code targets, Figma file). */
  context: Pick<FixPromptInput, "selector" | "filePaths" | "fileKey" | "nodeId">;
  /**
   * One entry per drifted row, in table order — exactly the inputs the per-row
   * buttons would build. Rows that aren't drift must not be passed.
   */
  rows: readonly FixPromptInput[];
}

interface BulkGroup {
  family: PropertyFamily | undefined;
  /** The row's own selector; differs from the story root's for child bindings. */
  element: string | undefined;
  rows: FixPromptInput[];
}

function groupKey(row: FixPromptInput): string {
  const family = propertyFamily(row.property);
  const expected = expectedIdentity(row) ?? "no-expected-value";
  // Family + element + expected value: three rows of one family that drifted to
  // three DIFFERENT values are three decisions, and must not be presented as
  // one.
  return [row.selector ?? "", family ? `family:${family.label}` : `solo:${row.property}`, expected].join(
    "|",
  );
}

function groupRows(rows: readonly FixPromptInput[]): BulkGroup[] {
  const groups: BulkGroup[] = [];
  const byKey = new Map<string, BulkGroup>();
  for (const row of rows) {
    const key = groupKey(row);
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    const group: BulkGroup = {
      family: propertyFamily(row.property),
      element: row.selector,
      rows: [row],
    };
    byKey.set(key, group);
    groups.push(group);
  }
  return groups;
}

/** Heading for one group of mechanical fixes. */
function groupHeading(group: BulkGroup, rootSelector: string | undefined): string {
  const properties = group.rows.map((r) => r.property);
  const where =
    group.element !== undefined && group.element !== rootSelector
      ? ` on \`${group.element}\``
      : "";
  if (group.rows.length === 1) return `### \`${properties[0]}\`${where}`;
  const label = group.family?.label ?? properties[0];
  return `### ${label}${where} — ${group.rows.length} properties, ONE design change`;
}

function multiPropertyBullets(group: BulkGroup): string[] {
  const lines: string[] = [];
  const rows = group.rows;
  const n = rows.length;
  const properties = rows.map((r) => r.property);
  const first = rows[0]!;
  const figma = stringify(first.figmaValue);

  lines.push(`- Properties: ${codeList(properties)}`);
  lines.push(
    `- Current values in code: ${rows
      .map(
        (r) =>
          `\`${r.property}\` = \`${stringify(r.codeValue)}\`${r.codeClassName ? ` (utility class \`${r.codeClassName}\`)` : ""}`,
      )
      .join("; ")}`,
  );
  if (first.tokenName) {
    const cssVar = tokenNameToCssVar(first.tokenName);
    lines.push(
      `- Expected value from Figma for all ${n}: \`${figma}\`, backed by the design token \`${first.tokenName}\` (CSS custom property: \`var(${cssVar})\`)`,
    );
    const classes = rows.map((r) => r.codeClassName).filter((c): c is string => !!c);
    if (classes.length > 0) {
      lines.push(
        `- Prefer wiring the token: swap ${codeList(classes)} for the utility class(es) whose theme variable resolves to \`${cssVar}\`, rather than hardcoding \`${figma}\` or using arbitrary values. If no utility maps to that token, the gap is in the theme — add the variable to \`@theme\` rather than inlining the value.`,
      );
    } else {
      lines.push(
        `- Prefer wiring the token: set each of them to \`var(${cssVar})\` rather than hardcoding \`${figma}\`, so the code follows future token changes.`,
      );
    }
  } else {
    lines.push(`- Expected value from Figma for all ${n}: \`${figma}\``);
  }
  lines.push(
    `- All ${n} move together: change them in the same edit. Changing some and not the others is the failure this prompt exists to prevent.`,
  );
  const notes = rows.filter((r) => r.note);
  for (const r of notes) {
    lines.push(`- Note from the drift engine on \`${r.property}\`: ${r.note}`);
  }
  return lines;
}

/**
 * One prompt covering every drifted row in the story. Returns null when nothing
 * drifted — there is no honest bulk prompt for an empty finding set, and the
 * panel uses null to decide the button doesn't render.
 */
export function buildBulkFixPrompt(input: BulkFixPromptInput): string | null {
  if (input.rows.length === 0) return null;
  const component = componentNameFromStoryId(input.storyId);
  const rootSelector = input.context.selector;

  const unbound = input.rows.filter((r) => r.finding === "unbound-figma-value");
  const judgement = input.rows.filter((r) => r.finding === "judgement");
  const mechanical = input.rows.filter(
    (r) => r.finding !== "unbound-figma-value" && r.finding !== "judgement",
  );

  const lines: string[] = [];
  lines.push(
    `Fix the design-system drift storybook-design-sync found in the "${component}" component: ${input.rows.length} drifted row${input.rows.length === 1 ? "" : "s"}, all of them below. Treat this as ONE change set, not ${input.rows.length} unrelated fixes.`,
  );
  lines.push("");
  lines.push(
    `Several properties move together — each group below says which, and how many. Fixing one property of a group and leaving its siblings behind produces a component nobody designed (one of four paddings changed, giving 6px/12px/12px/12px). That is the specific failure this prompt exists to prevent.`,
  );
  lines.push("");
  lines.push(
    ...contextLines(
      { storyId: input.storyId, kind: "", ...input.context },
      component,
      { includeCodeTargets: true, includeKind: false },
    ),
  );

  lines.push("");
  lines.push(`## What to change in code`);
  if (mechanical.length === 0) {
    lines.push("");
    lines.push(
      `Nothing here is a mechanical code fix — see the sections below, and report back rather than changing code.`,
    );
  } else {
    for (const group of groupRows(mechanical)) {
      lines.push("");
      lines.push(groupHeading(group, rootSelector));
      if (group.rows.length === 1) {
        lines.push(...driftBullets(group.rows[0]!, { includeSiblings: false }));
      } else {
        lines.push(...multiPropertyBullets(group));
      }
    }
  }

  if (unbound.length > 0) {
    lines.push("");
    lines.push(`## Figma-side findings — value not bound to a variable (do NOT fix in code)`);
    lines.push("");
    for (const row of unbound) {
      const where =
        row.selector !== undefined && row.selector !== rootSelector ? ` on \`${row.selector}\`` : "";
      lines.push(
        `- \`${row.property}\`${where}: Figma's value is \`${stringify(row.figmaValue)}\`, a literal with NO variable behind it, so the design names no token. Code currently has \`${stringify(row.codeValue)}\`. The fix is in Figma — re-bind the property to the variable it should use. Do NOT hardcode Figma's literal in code and do NOT add or change a theme token to match it.`,
      );
    }
  }

  if (judgement.length > 0) {
    lines.push("");
    lines.push(`## Needs a judgement call — not a mechanical fix`);
    lines.push("");
    for (const row of judgement) {
      const where =
        row.selector !== undefined && row.selector !== rootSelector ? ` on \`${row.selector}\`` : "";
      const detail = row.advisory ?? row.note ?? "The two models disagree structurally.";
      lines.push(`- \`${row.property}\` (${row.kind})${where}: ${detail}`);
    }
  }

  lines.push("");
  lines.push(`## Instructions`);
  const steps: string[] = [];
  steps.push(
    `Make every change under "What to change in code" in one pass, as a single reviewable diff.`,
  );
  steps.push(
    `Where a group lists several properties with one expected value, they are a single design change: change all of them or none. Do not leave a group half-applied.`,
  );
  steps.push(
    `Keep the change minimal — touch only the declarations (or utility classes) responsible for these properties on this component/variant. Do not reformat unrelated code or rename anything.`,
  );
  if (unbound.length > 0 || judgement.length > 0) {
    steps.push(
      `Do not act on the ${[
        unbound.length > 0 ? `"Figma-side findings"` : null,
        judgement.length > 0 ? `"Needs a judgement call"` : null,
      ]
        .filter(Boolean)
        .join(" or ")} section${unbound.length > 0 && judgement.length > 0 ? "s" : ""}: those are not code edits. List them back to whoever asked for this fix so a human can route them.`,
    );
  }
  steps.push(
    `Run the project's typecheck and test commands and make sure both pass before finishing.`,
  );
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));

  return lines.join("\n");
}
