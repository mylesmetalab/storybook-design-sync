import { tokenNameToCssVar } from "@metalab/design-sync-core";

/**
 * Pure builder for the per-row "Copy fix prompt" feature. Produces a
 * fully self-contained prompt a coding agent can act on with NO other
 * context: what drifted, where the code lives (or how to find it), what
 * the current and expected values are, and how to finish the job.
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
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
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

export function buildFixPrompt(input: FixPromptInput): string {
  const component = componentNameFromStoryId(input.storyId);
  const lines: string[] = [];

  lines.push(
    `Fix a design-system drift found by storybook-design-sync: the code and the Figma design disagree on \`${input.property}\` for the "${component}" component.`,
  );
  lines.push("");
  lines.push(`## Context`);
  lines.push(`- Storybook story id: \`${input.storyId}\``);
  lines.push(`- Component: ${component}`);
  lines.push(`- Drift dimension: ${input.kind}`);
  if (input.selector) {
    lines.push(`- CSS selector for the affected element: \`${input.selector}\``);
  }
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
  if (input.nodeId || input.fileKey) {
    lines.push(
      `- Figma reference (for humans; you don't need Figma access): node \`${input.nodeId ?? "unknown"}\` in file \`${input.fileKey ?? "unknown"}\``,
    );
  }
  if (input.codeClassName) {
    lines.push(
      `- The code sets this property with the Tailwind utility class \`${input.codeClassName}\`, ` +
        `not a CSS declaration. That class is what the fix should change ` +
        `(it may live in a \`cva()\` base array or variant slot).`,
    );
  }
  lines.push("");
  lines.push(`## The drift`);
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
  if (input.note) {
    lines.push(`- Note from the drift engine: ${input.note}`);
  }
  lines.push("");
  lines.push(`## Instructions`);
  lines.push(
    input.codeClassName
      ? `1. Make this change so the code matches the Figma value above. Keep the change minimal — change only the \`${input.codeClassName}\` class on this component/variant, and leave every other utility class alone.`
      : `1. Make this change so the code matches the Figma value above. Keep the change minimal — touch only the declaration(s) responsible for this property on this component/variant.`,
  );
  lines.push(`2. Do not reformat unrelated code or rename anything.`);
  lines.push(
    `3. Run the project's typecheck and test commands and make sure both pass before finishing.`,
  );

  return lines.join("\n");
}
