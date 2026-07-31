import { tokenNameToCssVar, type ModeAwareValue } from "@metalab/design-sync-core";
import type { FixLayer, RowFinding } from "./row-triage.js";
import type { DimensionKind } from "./dimensions/types.js";
import type { TokenPresence } from "./token-presence.js";
import type { ContractReference, ContractSibling } from "./contract.js";
import { expectedIdentity, propertyFamily, type PropertyFamily } from "./property-families.js";

/**
 * Pure builder for the "Copy fix prompt" features. Produces fully
 * self-contained prompts a coding agent can act on with NO other context: what
 * drifted, where the code lives (or how to find it), what the current and
 * expected values are, and how to finish the job.
 *
 * ## The rule the whole module answers to
 *
 * In v1 the fix prompt is the product's **only** output: detection ships, and
 * every change that reaches a codebase does so because a human or an agent
 * pasted one of these. So a prompt may only assert a change it has *established*.
 * Before proposing an edit it must be able to answer four questions, and where
 * it cannot answer one it must **say so** rather than emitting a confident
 * instruction (the project's standing rule: correct or absent, never
 * best-effort).
 *
 *  1. **Which layer owns this?** A `copy` row is a product-content decision, not
 *     a code edit (#63). A token the project does not declare cannot be wired in
 *     a component file (#67). A token whose value moved is a token PR (v0.0.38).
 *  2. **What else does it affect?** A variant-scoped edit on code with no variant
 *     seam contradicts every sibling variant (#68). One token driving two slots
 *     is one decision, and the component's contract already records the pair
 *     (#71). Properties in one family move together (v0.0.36).
 *  3. **Is it complete across modes?** A mode-varying colour token has a light
 *     *and* a dark value; a prompt carrying one half-fixes and leaves the other
 *     mode silently wrong (#66).
 *  4. **Is it still true?** A prompt cites a Figma value read at some past
 *     moment. By the time a PR opens the design may have moved — or been
 *     reverted, which is exactly how a faithfully-applied prompt would have
 *     re-introduced the drift it existed to remove (#76). So every prompt is
 *     stamped with the read it came from and instructs the applier to re-verify.
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

/* ------------------------------------------------------------------------- *
 * What the generator establishes before it proposes anything
 * ------------------------------------------------------------------------- */

/**
 * Where a prompt's Figma values came from, and **when** (#76).
 *
 * A fix prompt is asynchronous by design: read now, apply later, review later
 * still. Every hop is a chance for the cited value to move, and a prompt with no
 * timestamp is indistinguishable from a statement about the present. starter PR
 * #5 applied one faithfully and would have re-introduced drift, because the Figma
 * edit it described had been reverted while the PR sat open.
 *
 * Every field is optional and **nothing is ever defaulted to "now"**. A prompt
 * built from a cached report must report the *cache's* read time; a prompt whose
 * read time is unknown must say it is unknown. Stamping `Date.now()` here would
 * turn a stale reading into a fresh-looking assertion, which is the whole bug.
 */
export interface PromptProvenance {
  /**
   * ISO timestamp of the Figma read the values came from. For a report replayed
   * out of `.design-sync/cache.json` this is the ORIGINAL read's time, not the
   * replay's — see `figma-rest.ts`'s cache short-circuit.
   */
  readAt?: string | undefined;
  /** The Figma file's `lastModified` as of that read. */
  fileLastModified?: string | undefined;
  /** The Figma file's `version` as of that read. */
  fileVersion?: string | undefined;
  /** True when the values were replayed from the persistent cache rather than fetched. */
  fromCache?: boolean | undefined;
  /** The addon version that produced the read (pairs with #62's version skew). */
  addonVersion?: string | undefined;
}

/**
 * What the **project's own CSS** says about the token name Figma named (#66/#67).
 *
 * Resolved by `token-presence.ts` (a lookup against the scanned custom
 * properties, never a guess) and re-exported here because the prompt vocabulary
 * is what call sites deal in. See that module for why a converted Figma name must
 * never be presented as this project's variable.
 */
export type { TokenPresence };

/**
 * What the generator established about a variant-scoped edit's **blast radius**
 * (#68).
 *
 * The failure: a prompt for drift on one variant said "keep the change minimal —
 * touch only the declarations for this component/variant" while the code applied
 * the property from a single shared class. Applying it as written would have
 * contradicted Figma on 7 of 8 sibling variants — the report gets worse by
 * obeying its own advice.
 *
 * `comparedStories` is the evidence, and its absence is itself a finding: a
 * single-story check has established nothing about siblings, and the prompt says
 * that instead of calling the edit minimal.
 */
export interface VariantScope {
  /**
   * Other story ids checked in the same run that compared this same element +
   * property. Empty means the run held no sibling to compare against.
   */
  comparedStories: readonly string[];
  /** Those whose expected Figma value DISAGREES with this row's, and what they expect. */
  conflicting: readonly { storyId: string; expected: string }[];
}

/**
 * The component contract's record of everything one token drives (#71).
 *
 * `contracts/<component>.spec.json` is written by the `component-handoff` skill
 * and, until this change, was read by agents and by no tool. It is the missing
 * input for the case where one token drives two slots and only one of them has a
 * registry binding: the report shows one row, fixing it leaves the other consumer
 * on the old value, and the report calls that complete. Read by `contract.ts`.
 */
export type { ContractReference, ContractSibling };

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
  /**
   * The Figma variable's per-mode values, when it varies by mode (#66).
   *
   * Threaded into the prompt because a colour prompt carrying only the light
   * value half-fixes: applying it leaves dark wrong and nothing says so until the
   * next check. Dual mode has worked since v0.0.41, so the data is there — the
   * prompt builder simply never read it.
   */
  modes?: ModeAwareValue | undefined;
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
   * Which layer this row's fix belongs to (`row-triage.ts`'s `fixLayer`).
   * Absent behaves like `"component"`, so every pre-v0.0.38 call site is
   * unchanged.
   *
   * `"token"` is the one that changes the prompt's *shape*: the code already
   * binds the token Figma binds and only its value moved, so there is no
   * component edit to make and proposing one would hide a token change inside a
   * single component.
   */
  layer?: FixLayer | undefined;
  /**
   * The **code-side** token name the property is bound to (`"primary"`), from the
   * `token-binding` comparison. Distinct from `tokenName`, which is Figma's name
   * for the same slot (`"color/background/brand/default"`).
   *
   * Both names exist here because conflating them shipped an impossible
   * instruction: a prompt told an agent to swap `bg-primary` for "the utility
   * class whose theme variable resolves to `--background-brand-default`" — a
   * CSS variable derived from the *Figma* name, which no theme defines and none
   * should. A Figma variable name must never be presented as a code-side target.
   */
  codeTokenName?: string | undefined;
  /**
   * Sibling properties in the same family that drifted to the SAME expected
   * value on the same element (`driftedSiblings` in `property-families.ts`).
   * Named in the prompt so a per-row copy cannot cause the asymmetric-value
   * outcome on its own.
   */
  siblingProperties?: readonly string[] | undefined;
  /** What the project's own CSS says about `tokenName` (#66/#67). */
  tokenPresence?: TokenPresence | undefined;
  /** What the run established about sibling variants (#68). */
  variantScope?: VariantScope | undefined;
  /** The component contract's record of what else this token drives (#71). */
  contract?: ContractReference | undefined;
  /** When and from where the Figma values were read (#76). */
  provenance?: PromptProvenance | undefined;
}

/**
 * Which section of a bulk prompt a dimension's rows belong in.
 *
 *  - `code` — a mechanical code edit.
 *  - `copy` — product content. Never a code edit: see {@link PROMPT_SECTION_BY_KIND}.
 *  - `design` — the fix is in Figma.
 *  - `judgement` — the two models disagree structurally; a human routes it.
 */
export type PromptSection = "code" | "copy" | "design" | "judgement";

/**
 * The routing table, exhaustive over `DimensionKind` **on purpose**.
 *
 * A new dimension cannot be added to the union without deciding, here, whether
 * its rows are a code edit — which is the decision #63 was made silently and
 * wrongly. The `copy` entry is the one that issue turned on: a story that
 * deliberately renders "Cancel" is not drift against a Figma placeholder reading
 * "Button", and routing that row under "What to change in code" instructed agents
 * to rewrite the story's `args` and destroy the story's purpose.
 *
 * `design`/`judgement` are decided per row by its `finding` (a detached Figma
 * value can occur in any kind), so this table only says where a row goes when its
 * finding does not already claim it.
 */
export const PROMPT_SECTION_BY_KIND: Record<DimensionKind, PromptSection> = {
  "token-value": "code",
  "token-binding": "code",
  copy: "copy",
  // Structural comparisons. No engine can honour an Apply for them and no prompt
  // can name a mechanical edit, so they are listed for a human to route.
  "variant-set": "judgement",
  props: "judgement",
  structure: "judgement",
  motion: "judgement",
};

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (typeof value === "string") return value;
  // A dual-mode cell whose modes AGREE carries one value, and printing it as
  // `{"light":"Cancel","dark":"Cancel"}` is pure noise in an instruction — the live
  // panel produced exactly that. Modes that DISAGREE keep the full map: the
  // difference is the information, and `modeLines` spells it out alongside.
  const agreed = singleModeValue(value);
  if (agreed !== null) return agreed;
  return JSON.stringify(value);
}

/**
 * The one value behind a `{ light, dark }` cell when every mode holds the same
 * thing, else null. Deliberately does NOT collapse a disagreement to either side.
 */
function singleModeValue(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length < 2) return null;
  if (!entries.every(([, v]) => typeof v === "string")) return null;
  const first = entries[0]![1] as string;
  return entries.every(([, v]) => v === first) ? first : null;
}

/**
 * A stable, machine-comparable rendering of a timestamp that reached us over the
 * Storybook channel.
 *
 * Typed `string` and sent as an ISO string, but the channel's serializer (telejson)
 * **revives ISO-looking strings into `Date` objects**, so the panel receives a Date
 * and template interpolation renders `Fri Jul 31 2026 10:40:42 GMT+0100 (British
 * Summer Time)`. That was live in the first build of this change. A locale- and
 * timezone-dependent stamp is close to useless in an artefact whose whole job is to
 * be compared against a Figma timestamp later, possibly by someone else's machine.
 */
function isoStamp(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  // Unparseable strings are passed through rather than dropped: Figma's
  // `lastModified` is its value to define, and quoting it verbatim is honest.
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString();
}

/** "`a`, `b` and `c`" — Oxford-free, matches how the panel's copy reads. */
function codeList(items: readonly string[]): string {
  const ticked = items.map((p) => `\`${p}\``);
  if (ticked.length <= 1) return ticked.join("");
  return `${ticked.slice(0, -1).join(", ")} and ${ticked[ticked.length - 1]}`;
}

/** Plain list, no backticks — for prose that already quotes its items. */
function plainList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
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

/* ------------------------------------------------------------------------- *
 * #76 — provenance: what this prompt is a reading OF, and when
 * ------------------------------------------------------------------------- */

/**
 * The `## Provenance` block. Present on every prompt shape, including the
 * design-side and judgement ones — "is this still true?" is not a question only
 * code fixes have to answer.
 *
 * Never invents a timestamp. An unknown read time is stated as unknown, because a
 * prompt that says "read just now" when it does not know is worse than one that
 * admits it: the applier's re-verification is the only remaining safeguard, and it
 * has to know how much to distrust the numbers.
 */
function provenanceLines(input: Pick<FixPromptInput, "provenance" | "nodeId" | "fileKey">): string[] {
  const p = input.provenance;
  const readAt = isoStamp(p?.readAt);
  const lastModified = isoStamp(p?.fileLastModified);
  const lines: string[] = [];
  lines.push(`## Provenance — this is a point-in-time reading, not a statement about now`);
  if (readAt) {
    lines.push(
      `- Figma read at: \`${readAt}\`${p?.fromCache ? " — replayed from the addon's on-disk cache (`.design-sync/cache.json`), so this is when Figma was ACTUALLY read, not when the prompt was copied" : ""}`,
    );
  } else {
    lines.push(
      `- Figma read at: **the read time is unknown** — this report carries no read timestamp (it predates the addon version that records one, or was produced without one). Treat every Figma value below as unverified until you re-check it.`,
    );
  }
  if (p?.fileVersion) lines.push(`- Figma file version at that read: \`${p.fileVersion}\``);
  if (lastModified) {
    lines.push(`- Figma file \`lastModified\` at that read: \`${lastModified}\``);
  }
  if (!p?.fileVersion && !lastModified) {
    lines.push(
      `- Figma file version / \`lastModified\`: not recorded for this report, so there is no cheap way to tell whether the file has moved since. Re-read the node.`,
    );
  }
  lines.push(
    `- Figma node: \`${input.nodeId ?? "unknown"}\`${input.fileKey ? ` in file \`${input.fileKey}\`` : ""}`,
  );
  lines.push(
    `- Produced by storybook-design-sync \`${p?.addonVersion ?? "unknown version"}\``,
  );
  return lines;
}

/**
 * The re-verify instruction. Wording is shared so the workflow skills can rely on
 * it existing rather than each restating it.
 *
 * This is the step that would have stopped starter PR #5: the prompt was applied
 * correctly, the code was verified against the *prompt*, and the Figma value it
 * cited had been reverted in the meantime.
 */
function reverifyStep(input: Pick<FixPromptInput, "provenance">): string {
  const readAt = isoStamp(input.provenance?.readAt);
  return (
    `**Re-verify before you commit.** Every Figma value above was read ${
      readAt ? `at \`${readAt}\`` : `at an unrecorded time`
    } and may have changed or been reverted since — that has happened, and a faithfully-applied prompt re-introduced the drift it existed to remove. ` +
    `Before committing, confirm the Figma side still reads as stated (re-run **Check drift** on this story, or read the node directly). ` +
    `If it does not match, **stop**: do not commit, and report what Figma says now instead of what this prompt says.`
  );
}

/* ------------------------------------------------------------------------- *
 * #66 — mode completeness
 * ------------------------------------------------------------------------- */

/** The two mode values, when the token has two and they differ. */
function modeValues(
  modes: ModeAwareValue | undefined,
): { light: string; dark: string } | null {
  const light = modes?.light;
  const dark = modes?.dark;
  if (typeof light !== "string" || typeof dark !== "string") return null;
  if (light.trim() === "" || dark.trim() === "") return null;
  if (light === dark) return null;
  return { light, dark };
}

/**
 * The mode-completeness bullet (#66).
 *
 * Emitted whenever the Figma variable resolves to different values in light and
 * dark, for any dimension. A single expected value in that case is not a smaller
 * truth, it is a half-instruction: the applier sets one mode, the panel goes
 * green on the mode it happened to check, and the other stays wrong.
 */
function modeLines(input: FixPromptInput): string[] {
  const pair = modeValues(input.modes);
  if (!pair) return [];
  const token = input.tokenName ? `\`${input.tokenName}\`` : "this value";
  return [
    `- **Mode-varying token — the change is not complete until both modes are covered.** ` +
      `${token} resolves to \`${pair.light}\` in light and \`${pair.dark}\` in dark. ` +
      `Setting only one leaves the other mode wrong, and a check run in the mode you fixed will report green. ` +
      `Cover both modes in the same edit (in a Tailwind/shadcn project that usually means the \`:root\` and \`.dark\` blocks, or a \`dark:\` utility), or state explicitly which mode you did not fix and why.`,
  ];
}

/* ------------------------------------------------------------------------- *
 * #68 — blast radius
 * ------------------------------------------------------------------------- */

/**
 * What this prompt knows about the edit's reach across sibling variants.
 *
 * Three answers, and the third is the important one:
 *
 *  - **conflicting siblings** — other checked stories expect a DIFFERENT value for
 *    the same element + property. Applying a variant-scoped edit would contradict
 *    Figma on them, so the prompt names them, says a variant seam is required, and
 *    the caller drops "keep the change minimal".
 *  - **agreeing siblings** — the run compared siblings and they agree; the edit is
 *    genuinely component-wide and safe to make as one.
 *  - **nothing compared** — the run held one story. The prompt says the blast
 *    radius has NOT been established rather than implying it has.
 */
function blastRadiusLines(input: FixPromptInput): string[] {
  const scope = input.variantScope;
  const where = input.selector ? `\`${input.selector}\`` : `this element`;
  if (!scope || scope.comparedStories.length === 0) {
    return [
      `- **Blast radius: the addon has not established it.** This report covers the single story ` +
        `\`${input.storyId}\`, so nothing here says whether the code applies \`${input.property}\` per variant ` +
        `or from one declaration shared by every variant. If it is shared, this edit changes every sibling ` +
        `variant too — and any sibling Figma expects to keep the current value will start drifting. ` +
        `Before editing: find the declaration, check whether it sits behind a variant seam, and run ` +
        `**Check all** if you need the sibling stories' expected values. If you cannot establish it, say so ` +
        `rather than guessing.`,
    ];
  }
  const others = scope.comparedStories.length;
  if (scope.conflicting.length === 0) {
    return [
      `- **Blast radius: checked.** ${others} other checked stor${others === 1 ? "y" : "ies"} ` +
        `(${plainList(scope.comparedStories.map((s) => `\`${s}\``))}) compare \`${input.property}\` on ` +
        `${where} and agree with the expected value above. A single shared declaration is therefore fine to ` +
        `change as one edit.`,
    ];
  }
  const n = scope.conflicting.length;
  const detail = scope.conflicting
    .map((c) => `\`${c.storyId}\` expects \`${c.expected}\``)
    .join("; ");
  return [
    `- **Blast radius: THIS EDIT CONFLICTS WITH SIBLING VARIANTS — do not apply it as a minimal change.** ` +
      `${n} of ${others} other checked stories disagree with the expected value above for \`${input.property}\` ` +
      `on ${where}: ${detail}. ` +
      `If the code applies this property from one declaration shared across variants, changing it to satisfy ` +
      `\`${input.storyId}\` puts those ${n} previously-clean stor${n === 1 ? "y" : "ies"} into drift — the report ` +
      `gets worse by obeying its own advice. ` +
      `So this is not a value edit: either the code needs a **variant seam** for \`${input.property}\` (a new ` +
      `variant axis, which is a component API change), or Figma's variants disagree with each other and design ` +
      `decides. Do not pick one silently — report both sides and stop.`,
  ];
}

/** Whether the prompt is allowed to call its own edit minimal. */
function editHasConflict(input: FixPromptInput): boolean {
  return (input.variantScope?.conflicting.length ?? 0) > 0;
}

/* ------------------------------------------------------------------------- *
 * #71 — the contract's record of what else the token drives
 * ------------------------------------------------------------------------- */

/**
 * Name the other slots the component's contract binds to the same token.
 *
 * The first tool-time use of `contracts/*.spec.json`. It earns its place here
 * because the comparison cannot reach these slots — an unbound slot has no
 * registry binding, so no row exists for it — and the contract is the only place
 * that records the pair. Without it, the report shows one row for a decision that
 * has two consumers and calls fixing one of them complete.
 */
function contractLines(input: FixPromptInput): string[] {
  const contract = input.contract;
  if (!contract || contract.siblings.length === 0) return [];
  const uncompared = contract.siblings.filter((s) => !s.compared);
  const described = contract.siblings
    .map(
      (s) =>
        `\`${s.slot}\` → \`${s.property}\`${s.utility ? ` (\`${s.utility}\`)` : ""}${s.compared ? "" : " — NOT compared in this report"}`,
    )
    .join("; ");
  const lines = [
    `- **This token drives more than this row.** \`${contract.path}\` declares ` +
      `\`${contract.figmaToken}\` against ${contract.siblings.length + 1} places on this component; besides ` +
      `the one above: ${described}. The contract records them as **one design decision**, so changing this ` +
      `row alone splits a declared token binding and leaves the other consumer on the old value.`,
  ];
  if (uncompared.length > 0) {
    lines.push(
      `- ${uncompared.length} of those ${uncompared.length === 1 ? "was" : "were"} **not compared** in ` +
        `this report — no row here covers ${uncompared.length === 1 ? "it" : "them"}, either because no ` +
        `registry binding reaches that element or because it belongs to a variant this story does not render. ` +
        `So ${uncompared.length === 1 ? "its" : "their"} absence from the table is not evidence ` +
        `that ${uncompared.length === 1 ? "it is" : "they are"} correct. Apply the same change to ` +
        `${plainList(uncompared.map((s) => `\`${s.slot}\`'s \`${s.property}\`${s.utility ? ` (\`${s.utility}\`)` : ""}`))} ` +
        `in the same edit, or say why the pair should be split.`,
    );
  }
  return lines;
}

/* ------------------------------------------------------------------------- *
 * #66/#67 — the token name, resolved against the project's own CSS
 * ------------------------------------------------------------------------- */

/**
 * The CSS custom property this prompt may name for a Figma token — the project's
 * own spelling when we found it, the convention-converted one otherwise.
 *
 * Never used for a token the scan proved absent: `wiringBullets` routes that case
 * to {@link absentTokenBullets}, which names no candidate variable at all.
 */
function cssVarFor(input: FixPromptInput): string {
  const presence = input.tokenPresence;
  if (presence?.kind === "declared") return presence.cssVar;
  return tokenNameToCssVar(input.tokenName ?? "");
}

/* ------------------------------------------------------------------------- *
 * shared blocks
 * ------------------------------------------------------------------------- */

/**
 * The `## Context` block: which story, which component, where the code is, and
 * the Figma coordinates. Shared by all prompt shapes so an agent sees the
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
 * The `## The drift` bullets for a single row.
 *
 * The token branch **triages the layer** rather than guessing at an edit
 * (v0.0.38). Three shapes, and which one you get is decided by data the panel
 * already holds — whether Figma's value is bound, whether the code binds a token,
 * and whether the two names were reconciled:
 *
 *  - `layer: "token"` — the code binds the same token Figma does and only its
 *    *value* moved. States that plainly, names both sides, and says a token PR
 *    needs sign-off. Emits NO class-swap and NO literal.
 *  - `layer: "component"` with an unreconciled code binding — says the addon could
 *    not reconcile the two names and therefore cannot name a code-side target.
 *    Never derives one from Figma's variable name.
 *  - no code binding at all — the pre-existing wording (a literal in CSS or a
 *    class with no token behind it), plus a caveat that the token name quoted is
 *    Figma's spelling.
 */
function driftBullets(input: FixPromptInput, opts: { includeSiblings: boolean }): string[] {
  const lines: string[] = [];
  lines.push(`- Property: \`${input.property}\``);
  lines.push(`- Current value in code: \`${stringify(input.codeValue)}\``);
  const figma = stringify(input.figmaValue);
  if (input.tokenName) {
    const cssVar = cssVarFor(input);
    lines.push(
      `- Expected value from Figma: \`${figma}\`, backed by the design token \`${input.tokenName}\` (CSS custom property: \`var(${cssVar})\`)`,
    );
    lines.push(...modeLines(input));
    lines.push(...wiringBullets(input, figma, cssVar));
  } else {
    lines.push(`- Expected value from Figma: \`${figma}\``);
    lines.push(...modeLines(input));
  }
  if (opts.includeSiblings) {
    const siblings = siblingSentence(input);
    if (siblings) lines.push(`- Sibling properties drifted the same way: ${siblings}`);
  }
  lines.push(...contractLines(input));
  if (input.note) {
    lines.push(`- Note from the drift engine: ${input.note}`);
  }
  if (input.advisory) {
    lines.push(`- What the addon can tell you about this row: ${input.advisory}`);
  }
  return lines;
}

/**
 * Whether this row is a token-layer finding: the code points at the right design
 * decision and the decision's value moved. `fixLayer` decides it; the prompt only
 * needs a code-side token name to talk about.
 */
function isTokenLayer(input: FixPromptInput): boolean {
  return input.layer === "token" && !!input.codeTokenName;
}

/**
 * The "how to wire this" bullets — the part that used to invent a code-side
 * target. Every branch obeys one rule: **never name a Figma-side variable as if
 * it were a code-side token, class or CSS custom property.**
 */
function wiringBullets(input: FixPromptInput, figma: string, cssVar: string): string[] {
  const lines: string[] = [];
  const via = input.codeClassName ? ` (via the utility class \`${input.codeClassName}\`)` : "";

  if (isTokenLayer(input)) {
    const codeToken = input.codeTokenName!;
    const codeVar = tokenNameToCssVar(codeToken);
    lines.push(
      `- **This is a token-layer change, not a component change.** The code already binds \`${input.property}\` to the design token \`${codeToken}\`${via}, and the addon reconciled that with Figma's variable \`${input.tokenName}\` — the same decision, spelled differently. What moved is the decision's VALUE.`,
    );
    lines.push(
      `- The change belongs on the token: the value of \`${codeToken}\` (CSS custom property \`var(${codeVar})\`) needs to become \`${figma}\`. Do NOT swap ${input.codeClassName ? `\`${input.codeClassName}\` for another utility class` : `the declaration for another token`}, do NOT add an arbitrary value${input.codeClassName ? ` like \`[${figma}]\`` : ""}, and do NOT hardcode \`${figma}\` on this component — each of those hides a token-layer change inside one component while every other consumer of \`${codeToken}\` stays wrong.`,
    );
    lines.push(
      `- A token value affects every consumer of \`${codeToken}\`, so this is a design-token PR and needs design-system sign-off. If you were asked to fix this component, report back that the fix is at the token layer instead of editing the component.`,
    );
    return lines;
  }

  if (input.codeTokenName) {
    // The code binds a token, but its name and Figma's did NOT reconcile. We do
    // not know this project's name for Figma's token, so we must not name one:
    // the live failure was exactly this — a prompt asking for "the utility class
    // whose theme variable resolves to `--background-brand-default`", which is
    // Figma's variable name and matches nothing in any theme.
    lines.push(
      `- The code binds \`${input.property}\` to the design token \`${input.codeTokenName}\`${via}, which the addon could NOT reconcile with Figma's variable \`${input.tokenName}\`. So treat \`${cssVar}\` as Figma's spelling only — do NOT assume a utility class, theme variable or CSS custom property of that name exists in this project, and do not create one from the Figma name.`,
    );
    lines.push(
      `- Two possibilities, and they have different fixes. (a) \`${input.codeTokenName}\` and \`${input.tokenName}\` are the SAME decision under two names: then this is a naming mismatch, not a value fix — add \`"${input.tokenName}": "${input.codeTokenName}"\` to \`tokenAliases\` in \`design-sync.config.json\`, re-run the check, and fix whatever remains. (b) They are different decisions: then find the token in THIS codebase whose value is \`${figma}\` and bind \`${input.property}\` to that${input.codeClassName ? ` by changing \`${input.codeClassName}\`` : ""}. If you cannot tell which, say so and stop rather than guessing.`,
    );
    return lines;
  }

  const presence = input.tokenPresence;
  // The scan PROVED there is no such custom property. So the prompt must not name
  // one — not as a declaration to write, not as a utility to look for, and not with
  // the old "if your theme names it differently" caveat, which presupposes it
  // exists (#66/#67). What replaces it is the absence itself, plus where the token
  // would have to be declared before any component can point at it.
  if (presence?.kind === "absent") {
    lines.push(...absentTokenBullets(input, presence, figma));
    return lines;
  }

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
  // Where the scan CONFIRMED the custom property exists we say so, because the
  // pre-existing caveat ("we cannot confirm this project spells it that way")
  // is then false and reads as an invitation to invent an alternative.
  if (presence?.kind === "declared") {
    lines.push(
      `- \`${cssVar}\` is this project's own custom property — the addon found it declared in ` +
        `${plainList(presence.files.map((f) => `\`${f}\``))}, so it is the right code-side name for Figma's \`${input.tokenName}\`. Use it as written.`,
    );
  } else {
    lines.push(
      `- \`${cssVar}\` is Figma's token name converted by convention; the addon found no token binding on the code side, so it cannot confirm this project spells it that way. If your theme names the same token differently, use the project's name.`,
    );
  }
  return lines;
}

/**
 * What to say when the project declares no custom property for Figma's variable
 * (#67), as **bullets inside the ordinary prompt** rather than a prompt of its own.
 *
 * The first build of this change made absence its own prompt shape, and the live
 * panel showed why that was wrong twice over. On a Tailwind spacing row (`p-3`,
 * Figma `Space/300`) it announced "this project declares no token for it — adding
 * one is a token-layer change needing design-lead sign-off", which is technically
 * true and inapplicable: the project expresses spacing through Tailwind's
 * `--spacing` scale, not one custom property per step, so there is nothing for a
 * design lead to sign off. And because it replaced the whole prompt it **displaced
 * the blast-radius bullet**, losing #68 on exactly the rows most likely to need it.
 *
 * So these bullets state the absence, forbid inventing the name, and name the
 * token-layer route as the possibility it is — leaving the ordinary prompt's
 * siblings, blast radius, contract and provenance in place around them.
 */
function absentTokenBullets(
  input: FixPromptInput,
  presence: Extract<TokenPresence, { kind: "absent" }>,
  figma: string,
): string[] {
  const lines: string[] = [];
  const target = input.codeClassName
    ? `the utility class \`${input.codeClassName}\``
    : `the declaration for \`${input.property}\``;
  lines.push(
    `- By convention Figma's \`${input.tokenName}\` converts to \`${presence.converted}\`, and that custom ` +
      `property is **not declared anywhere in this project's scanned CSS** — ${presence.declaredCount} custom ` +
      `propert${presence.declaredCount === 1 ? "y was" : "ies were"} scanned and none of them is it (the addon ` +
      `also tried this project's own namespaces before saying so). So do NOT write ` +
      `\`var(${presence.converted})\`: it would resolve to nothing. And do NOT hardcode \`${figma}\` into ` +
      `${target} either — that buries an unnamed value in a component and turns this row green while the ` +
      `design system stays incomplete.`,
  );
  if (presence.namespaceNote) lines.push(`- ${presence.namespaceNote}`);
  lines.push(
    `- Find what this project already uses to express this decision — an existing token under a different ` +
      `name, or the scale a utility resolves through — and use that. If one exists, also add ` +
      `\`"${input.tokenName}": "<project token>"\` to \`tokenAliases\` in \`design-sync.config.json\` so the ` +
      `addon stops reporting the name divergence.`,
  );
  lines.push(
    `- **If nothing in this project expresses it, this change cannot be completed in the component files ` +
      `named above.** A custom property has to be declared before a component can point at it, and ` +
      `${presence.themeFiles.length > 0 ? `this project declares its custom properties in ${plainList(presence.themeFiles.map((f) => `\`${f}\``))}` : `no file in the scan declares custom properties, so where a new one belongs is not established`} ` +
      `— not in a component file. Adding one is a **token-layer** change affecting every future consumer and ` +
      `needs design-lead sign-off, so report it back rather than inventing the token here.`,
  );
  return lines;
}

export function buildFixPrompt(input: FixPromptInput): string {
  // Order matters: each guard is a claim about which LAYER owns the change, and
  // the more specific claim wins. Copy is first because it is never a code edit
  // in any of the other shapes' senses.
  if (input.kind === "copy") return buildCopyPrompt(input);
  if (input.finding === "unbound-figma-value") return buildUnboundFigmaValuePrompt(input);
  if (isTokenLayer(input)) return buildTokenLayerPrompt(input);

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
  lines.push(...blastRadiusLines(input));
  lines.push("");
  lines.push(...provenanceLines(input));
  lines.push("");
  lines.push(`## Instructions`);
  const steps: string[] = [];
  if (editHasConflict(input)) {
    // A conflict means there is no minimal edit to make, so the prompt must not
    // open by asking for one. #68: applying it as written contradicted Figma on
    // 7 of 8 sibling variants.
    steps.push(
      `Do NOT make this change as a value edit yet. The blast-radius bullet above names sibling stories that ` +
        `expect a different value for \`${input.property}\`, so satisfying this story would break them. ` +
        `Establish first whether the code has a variant seam for this property.`,
    );
    steps.push(
      `If it does, scope the change to this variant only and leave the siblings untouched. If it does not, ` +
        `report the conflict back — adding a variant axis is a component API change, and Figma's variants ` +
        `disagreeing with each other is a design decision. Either way, do not silently pick a side.`,
    );
  } else {
    steps.push(
      input.codeClassName
        ? `Make this change so the code matches the Figma value above. Keep the change minimal — change only the \`${input.codeClassName}\` class on this component/variant, and leave every other utility class alone.`
        : `Make this change so the code matches the Figma value above. Keep the change minimal — touch only the declaration(s) responsible for this property on this component/variant.`,
    );
  }
  const siblings = input.siblingProperties ?? [];
  if (siblings.length > 0) {
    steps.push(
      `Apply the same value to the sibling properties named above (${codeList(siblings)}) in the same edit — they drifted to the same expected value and are one design change. ` +
        `Changing only \`${input.property}\` leaves the component in a state nobody designed (one padding changed out of four); if you deliberately fix only this one, say so in your summary.`,
    );
  }
  if (modeValues(input.modes)) {
    steps.push(
      `Cover BOTH mode values named above in the same edit. A change that fixes light and leaves dark (or the reverse) is half-applied, and the next single-mode check will report it clean.`,
    );
  }
  if ((input.contract?.siblings.length ?? 0) > 0) {
    steps.push(
      `Apply the change to every slot the contract names for this token, including the ones this report could not compare. Splitting a declared token pair is the failure that bullet exists to prevent.`,
    );
  }
  steps.push(`Do not reformat unrelated code or rename anything.`);
  steps.push(reverifyStep(input));
  steps.push(
    `Run the project's typecheck and test commands and make sure both pass before finishing.`,
  );
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));

  return lines.join("\n");
}

/* ------------------------------------------------------------------------- *
 * #63 — copy
 * ------------------------------------------------------------------------- */

/**
 * The copy prompt: a string difference between the rendered story and a Figma
 * TEXT node.
 *
 * Deliberately NOT a code-fix prompt, and this is the whole of #63. Figma has no
 * way to express "this text is a placeholder", while the `component-handoff` skill
 * mandates realistic content in stories — so the two sides were frequently never
 * meant to match, and the tool was comparing a deliberate code decision against a
 * deliberate design placeholder and calling the difference a defect. On the SDS
 * Card that was 16 of 20 remaining rows, permanently.
 *
 * The active harm was in the bulk prompt: copy rows appeared under "What to change
 * in code", which instructs an agent to rewrite the story's `args`. A story
 * deliberately showing "Cancel" exists to show "Cancel"; rewriting it to a Figma
 * placeholder reading "Button" destroys the story's purpose and the reviewer sees
 * a plausible diff.
 *
 * So this prompt states the difference, says who decides, and names the switches
 * that stop the question being asked. It never proposes an edit.
 */
function buildCopyPrompt(input: FixPromptInput): string {
  const component = componentNameFromStoryId(input.storyId);
  const code = stringify(input.codeValue);
  const figma = stringify(input.figmaValue);
  const lines: string[] = [];

  lines.push(
    `Route a COPY difference found by storybook-design-sync: the rendered "${component}" story and its Figma node hold different text. This is a product-content decision, not a code fix — do not change any code or story args for it.`,
  );
  lines.push("");
  lines.push(...contextLines(input, component, { includeCodeTargets: false, includeKind: true }));
  lines.push("");
  lines.push(`## What was found`);
  lines.push(`- Text rendered by the story: \`${code}\``);
  lines.push(`- Text in the Figma node: \`${figma}\``);
  lines.push(
    `- **The addon cannot tell whether these were ever meant to match.** Figma has no way to mark a string as ` +
      `placeholder text, and a Storybook story is expected to render realistic product content. So a difference ` +
      `here is just as likely to be a Figma placeholder (lorem, "Button", "Title") against deliberate story copy ` +
      `as it is to be a real defect. A button labelled \`Save\` in Figma genuinely should say Save; a card whose ` +
      `Figma title reads "Title" almost certainly should not rename the story's title.`,
  );
  // A copy row does not carry a mode-varying token today. The bullet is emitted
  // anyway because the invariant it satisfies is what a future dimension gets
  // measured against: any prompt whose value varies by mode states BOTH values.
  lines.push(...modeLines(input));
  if (input.note) lines.push(`- Note from the drift engine: ${input.note}`);
  if (input.advisory) lines.push(`- What the addon can tell you about this row: ${input.advisory}`);
  lines.push("");
  lines.push(...provenanceLines(input));
  lines.push("");
  lines.push(`## What to do`);
  lines.push(
    `1. Change no code. In particular **do not rewrite the story's \`args\`, props or JSX text** to match Figma. ` +
      `A story that deliberately renders \`${code}\` exists in order to render it, and replacing that with ` +
      `Figma's \`${figma}\` produces a plausible-looking diff that destroys what the story was for.`,
  );
  lines.push(
    `2. Hand the difference to whoever owns the copy — a designer, a writer, or the component's owner. They decide ` +
      `which string is right, and the fix lands in Figma or in the product content, not as a drift fix.`,
  );
  lines.push(
    `3. If this component's Figma text is placeholder content, stop the addon asking: set ` +
      `\`parameters.designSync.compareCopy: false\` on the affected stories, or \`"copy": "off"\` in ` +
      `\`design-sync.config.json\` to turn the dimension off for the whole project. Both are documented in the ` +
      `addon README's "Coverage and limits".`,
  );
  lines.push(`4. ${reverifyStep(input)}`);

  return lines.join("\n");
}

/* ------------------------------------------------------------------------- *
 * #67 — a token this project does not have
 * ------------------------------------------------------------------------- */

/**
 * The token-layer prompt: the component is already wired to the right design
 * decision, and the decision's **value** moved.
 *
 * Deliberately not a component-fix prompt. The live failure this replaces asked
 * an agent to swap `bg-primary` for "the utility class whose theme variable
 * resolves to `--background-brand-default`" — a Figma variable name presented as
 * a code-side target. No such utility exists or should: the component was
 * correct, and the only honest instruction is "the token's value has to move, and
 * that needs sign-off".
 */
function buildTokenLayerPrompt(input: FixPromptInput): string {
  const component = componentNameFromStoryId(input.storyId);
  const codeToken = input.codeTokenName!;
  const codeVar = tokenNameToCssVar(codeToken);
  const figma = stringify(input.figmaValue);
  const lines: string[] = [];

  lines.push(
    `Route a token-layer change found by storybook-design-sync: the "${component}" component correctly binds \`${input.property}\` to the design token \`${codeToken}\`, and it is the TOKEN'S VALUE that no longer matches Figma. This is a token-layer change, not a component change — do not edit the component.`,
  );
  lines.push("");
  lines.push(...contextLines(input, component, { includeCodeTargets: false, includeKind: true }));
  lines.push("");
  lines.push(`## What was found`);
  lines.push(`- Property: \`${input.property}\``);
  lines.push(
    `- Code binds the design token \`${codeToken}\` (CSS custom property \`var(${codeVar})\`)${input.codeClassName ? `, applied via the utility class \`${input.codeClassName}\`` : ""}, which currently resolves to \`${stringify(input.codeValue)}\`.`,
  );
  lines.push(
    `- Figma binds the same decision as the variable \`${input.tokenName}\`, which resolves to \`${figma}\`.`,
  );
  lines.push(
    `- The two sides name the same token (reconciled by the addon), so the component's wiring is correct. Only the value differs.`,
  );
  lines.push(...modeLines(input));
  const siblings = siblingSentence(input);
  if (siblings) lines.push(`- Sibling properties in the same state: ${siblings}`);
  lines.push(...contractLines(input));
  if (input.note) lines.push(`- Note from the drift engine: ${input.note}`);
  lines.push("");
  lines.push(...provenanceLines(input));
  lines.push("");
  lines.push(`## What to do`);
  lines.push(
    `1. Change no code on the "${component}" component. Its class/declaration for \`${input.property}\` is already pointing at the right token; swapping it for another utility, adding an arbitrary value, or hardcoding \`${figma}\` would hide this change inside one component while every other consumer of \`${codeToken}\` stayed wrong.`,
  );
  lines.push(
    `2. Locate where this project *defines* \`${codeToken}\` — a Tailwind \`@theme\` block, a token CSS file, or a design-token source — and identify the change needed: \`var(${codeVar})\` must resolve to \`${figma}\`${modeValues(input.modes) ? ` in light and \`${modeValues(input.modes)!.dark}\` in dark` : ""}.`,
  );
  lines.push(
    `3. Do not land that change as part of a component fix. A token value affects every consumer, so it goes up as its own design-token PR with design-system sign-off. Report the required change (token, current value, new value) back to whoever asked for this fix.`,
  );
  lines.push(
    `4. If you believe the CODE token is right and Figma's variable \`${input.tokenName}\` is the side that moved by mistake, say so explicitly — that is a Figma fix, and re-tuning the code token to match would be wrong.`,
  );
  lines.push(`5. ${reverifyStep(input)}`);

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
  lines.push(...modeLines(input));
  const siblings = siblingSentence(input);
  if (siblings) lines.push(`- Sibling properties in the same state: ${siblings}`);
  lines.push(...contractLines(input));
  if (input.note) lines.push(`- Note from the drift engine: ${input.note}`);
  lines.push("");
  lines.push(...provenanceLines(input));
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
  lines.push(`5. ${reverifyStep(input)}`);

  return lines.join("\n");
}

/* ------------------------------------------------------------------------- *
 * bulk prompt — every drifted row in the story, as one instruction
 * ------------------------------------------------------------------------- */

export interface BulkFixPromptInput {
  storyId: string;
  /** Story-level context (the story root's selector, code targets, Figma file). */
  context: Pick<FixPromptInput, "selector" | "filePaths" | "fileKey" | "nodeId" | "provenance">;
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
    const cssVar = cssVarFor(first);
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
  lines.push(...modeLines(first));
  lines.push(
    `- All ${n} move together: change them in the same edit. Changing some and not the others is the failure this prompt exists to prevent.`,
  );
  lines.push(...contractLines(first));
  const notes = rows.filter((r) => r.note);
  for (const r of notes) {
    lines.push(`- Note from the drift engine on \`${r.property}\`: ${r.note}`);
  }
  return lines;
}

/**
 * Which bulk section a row belongs to.
 *
 * The row's `finding` claims it first (a detached Figma value or a structural
 * disagreement can occur in any dimension), then the token-layer test, and only
 * then the dimension's own routing. Nothing falls through to "code" by default:
 * an unrecognised `kind` — a dimension added without touching
 * {@link PROMPT_SECTION_BY_KIND} — is routed to `judgement`, because "we don't
 * know how to fix this" must never render as "here is the code edit".
 */
type BulkSection = PromptSection | "token";

function bulkSection(row: FixPromptInput): BulkSection {
  if (row.finding === "unbound-figma-value") return "design";
  if (row.finding === "judgement") return "judgement";
  const byKind = PROMPT_SECTION_BY_KIND[row.kind as DimensionKind];
  if (byKind !== undefined && byKind !== "code") return byKind;
  if (byKind === undefined) return "judgement";
  // A token the project does not declare is NOT its own section: on a Tailwind
  // spacing row it would escalate a `p-3` swap to a design-token PR. It stays a code
  // row and carries the absence in its bullets (`absentTokenBullets`).
  if (isTokenLayer(row)) return "token";
  return "code";
}

/**
 * One prompt covering every drifted row in the story, related properties
 * grouped. Returns null when nothing drifted — there is no honest bulk prompt for
 * an empty finding set, and the panel uses null to decide the button doesn't
 * render.
 */
export function buildBulkFixPrompt(input: BulkFixPromptInput): string | null {
  if (input.rows.length === 0) return null;
  const component = componentNameFromStoryId(input.storyId);
  const rootSelector = input.context.selector;

  const sections = new Map<BulkSection, FixPromptInput[]>();
  for (const row of input.rows) {
    const key = bulkSection(row);
    sections.set(key, [...(sections.get(key) ?? []), row]);
  }
  const mechanical = sections.get("code") ?? [];
  const tokenLayer = sections.get("token") ?? [];
  const unbound = sections.get("design") ?? [];
  const judgement = sections.get("judgement") ?? [];
  const copyRows = sections.get("copy") ?? [];
  // Rows whose edit conflicts with a sibling variant. Collected across the whole
  // run so the instruction list can refuse to call the change set minimal.
  const conflicted = input.rows.filter((r) => editHasConflict(r));

  const lines: string[] = [];
  lines.push(
    input.rows.length === 1
      ? `Fix the design-system drift storybook-design-sync found in the "${component}" component: 1 drifted row, below.`
      : `Fix the design-system drift storybook-design-sync found in the "${component}" component: ${input.rows.length} drifted rows, all of them below. Treat this as ONE change set, not ${input.rows.length} unrelated fixes.`,
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
        lines.push(...blastRadiusLines(group.rows[0]!));
      } else {
        lines.push(...multiPropertyBullets(group));
        lines.push(...blastRadiusLines(group.rows[0]!));
      }
    }
  }

  if (tokenLayer.length > 0) {
    lines.push("");
    lines.push(
      `## Token-layer findings — the token, not this component (do NOT edit this component)`,
    );
    lines.push("");
    for (const row of tokenLayer) {
      const where =
        row.selector !== undefined && row.selector !== rootSelector ? ` on \`${row.selector}\`` : "";
      const codeToken = row.codeTokenName!;
      const both = modeValues(row.modes);
      lines.push(
        `- \`${row.property}\`${where}: the code already binds the design token \`${codeToken}\` (\`var(${tokenNameToCssVar(codeToken)})\`)${row.codeClassName ? ` via \`${row.codeClassName}\`` : ""}, which the addon reconciled with Figma's variable \`${row.tokenName}\`. The wiring is correct; the token's VALUE has to move from \`${stringify(row.codeValue)}\` to \`${stringify(row.figmaValue)}\`${both ? ` in light and to \`${both.dark}\` in dark — both modes, or the change is half-applied` : ""}. That affects every consumer of \`${codeToken}\`, so it is a design-token PR needing design-system sign-off — not a class swap, not an arbitrary value, and not a hardcoded literal on this component.`,
      );
    }
  }

  if (copyRows.length > 0) {
    lines.push("");
    lines.push(`## Copy findings — product content, NOT a code edit`);
    lines.push("");
    lines.push(
      `The addon cannot tell whether a Figma string and a story's text were ever meant to match: Figma has no way ` +
        `to mark text as a placeholder, and stories are expected to carry realistic product copy. **Do not rewrite ` +
        `story args, props or JSX text to match Figma** — a story deliberately rendering "Cancel" exists to render ` +
        `it. Route these to whoever owns the copy, and set \`parameters.designSync.compareCopy: false\` (or ` +
        `\`"copy": "off"\` in \`design-sync.config.json\`) if this component's Figma text is placeholder content.`,
    );
    lines.push("");
    for (const row of copyRows) {
      const where =
        row.selector !== undefined && row.selector !== rootSelector ? ` on \`${row.selector}\`` : "";
      lines.push(
        `- \`${row.property}\`${where}: the story renders \`${stringify(row.codeValue)}\`; Figma holds \`${stringify(row.figmaValue)}\`.`,
      );
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
  lines.push(...provenanceLines({ ...input.context, nodeId: input.context.nodeId }));

  lines.push("");
  lines.push(`## Instructions`);
  const steps: string[] = [];
  steps.push(
    `Make every change under "What to change in code" in one pass, as a single reviewable diff.`,
  );
  steps.push(
    `Where a group lists several properties with one expected value, they are a single design change: change all of them or none. Do not leave a group half-applied.`,
  );
  if (conflicted.length > 0) {
    // #68: "keep the change minimal" and "make the code match Figma" are in
    // direct conflict when the code has no variant seam, and the prompt must not
    // pretend otherwise.
    steps.push(
      `Do NOT treat the conflicted rows as minimal edits. ${conflicted.length} row${conflicted.length === 1 ? "" : "s"} ` +
        `above carr${conflicted.length === 1 ? "ies" : "y"} a blast-radius warning naming sibling stories that expect a ` +
        `different value. For those, establish whether the code has a variant seam for the property before touching ` +
        `it; if it does not, report the conflict and leave it alone rather than putting the siblings into drift.`,
    );
  } else {
    steps.push(
      `Keep the change minimal — touch only the declarations (or utility classes) responsible for these properties on this component/variant, and only after reading each row's blast-radius bullet. Do not reformat unrelated code or rename anything.`,
    );
  }
  if (input.rows.some((r) => modeValues(r.modes))) {
    steps.push(
      `Where a row names two mode values, cover both in the same edit. Fixing light and leaving dark (or the reverse) is half-applied, and a single-mode check will report it clean.`,
    );
  }
  // Wording for the pre-existing sections is byte-identical to what it has always
  // been; the token-layer sentence is additive and only appears when such a row
  // exists.
  if (unbound.length > 0 || judgement.length > 0 || copyRows.length > 0) {
    steps.push(
      `Do not act on the ${[
        unbound.length > 0 ? `"Figma-side findings"` : null,
        judgement.length > 0 ? `"Needs a judgement call"` : null,
        copyRows.length > 0 ? `"Copy findings"` : null,
      ]
        .filter(Boolean)
        .join(" or ")} section${[unbound.length > 0, judgement.length > 0, copyRows.length > 0].filter(Boolean).length > 1 ? "s" : ""}: those are not code edits. List them back to whoever asked for this fix so a human can route them.`,
    );
  }
  if (tokenLayer.length > 0) {
    steps.push(
      `Do not act on the "Token-layer findings" section by editing this component: either its wiring is already correct, or the token it needs does not exist yet. Report the token change each row names, and route it as a design-token PR with design-system sign-off.`,
    );
  }
  steps.push(reverifyStep(input.context));
  steps.push(
    `Run the project's typecheck and test commands and make sure both pass before finishing.`,
  );
  steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));

  return lines.join("\n");
}
