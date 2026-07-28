// ModeAwareValue is part of the shared wire contract; source it from core.
// Core declares `light?`/`dark?` as optional — call sites must tolerate
// either field being absent. Imported here and re-exported so existing
// `import { ModeAwareValue } from ".../dimensions/types.js"` sites (incl.
// the package's public `index.ts`) keep resolving.
import type { ModeAwareValue } from "@metalab/design-sync-core";
export type { ModeAwareValue };
import type { ChildBindingStatus } from "../child-bindings.js";

export type DimensionKind =
  | "token-value"
  | "token-binding"
  | "variant-set"
  | "copy"
  | "props"
  | "structure"
  | "motion";

/**
 * Verdict for one comparison.
 *
 * - `match` — both sides carry a concrete value and they agree.
 * - `drift` — both sides carry a concrete value and they disagree. Only this
 *   status may render red, offer a fix prompt, or feed an Apply.
 * - `flag-only` — one side has no opinion (no declared binding, no value).
 *   Surfaced for awareness; not an accusation.
 * - `unresolved` — the addon could not produce a comparable value for the
 *   Figma side at all (e.g. a variable whose alias chain dead-ends), so **no
 *   comparison happened**. Distinct from `flag-only` because Figma *does* have
 *   an opinion here — we just couldn't read it — and the row must say what
 *   couldn't be resolved and why (`note`). Never drift: reporting drift on a
 *   comparison that never ran is the false positive the honesty invariant
 *   forbids, and there is no fix to offer for it.
 *
 * NOTE: addon-local, not part of the `@metalab/design-sync-core` wire
 * contract, so extending it doesn't require a core version bump. Consumers
 * reading a `.design-sync/cache.json` written by an older addon simply never
 * see `unresolved`.
 */
export type DimensionStatus = "match" | "drift" | "flag-only" | "unresolved";

export interface DimensionDiff {
  kind: DimensionKind;
  property: string;
  codeValue: unknown;
  figmaValue: unknown;
  status: DimensionStatus;
  /** Present for color tokens; carries Light/Dark end-to-end. */
  modes?: ModeAwareValue;
  /** Optional human-readable note (e.g. "variable not found in file"). */
  note?: string;
  /**
   * For `token-value` rows where the Figma side resolves through a named
   * variable, the bare token name (e.g. `"space/4"`). Used by the value-
   * drift Apply path to construct a `var(--token)` rewrite in code.
   */
  tokenName?: string;
  /**
   * The utility class the code-side binding came from (`"bg-primary"`), when
   * the scanner derived this property from Tailwind rather than from a
   * `var(--token)` declaration. Attribution only: it lets the fix prompt name
   * the class to change instead of only describing the property. Nothing about
   * a row's status, values, or partitioning depends on it.
   */
  codeClassName?: string;
  /**
   * The declared child binding this row belongs to (the CSS selector, exactly
   * as written in the registry's `children` map). **Absent means the story
   * root** — every row produced before declared child bindings existed, and
   * every row for a story with no `children` key, has no `childSelector` and is
   * byte-identical to what it was.
   *
   * The panel groups rows by this field and labels each group, because a flat
   * table where a child's `padding-top` is indistinguishable from the root's
   * would be worse than no feature.
   */
  childSelector?: string;
}

export interface DriftTiming {
  /** Total wall time the engine spent on this report. */
  totalMs: number;
  /** Figma REST fetch time (excludes any cache hits). */
  figmaFetchMs: number;
  /** Number of cache hits during this check (variables, nodes, components). */
  cacheHits: number;
  /** Number of cache misses (i.e. real HTTP fetches that happened). */
  cacheMisses: number;
}

/**
 * Per-declared-child outcome. One entry for **every** binding in the registry's
 * `children` map, in registry order, whether or not it produced rows — that is
 * what makes a failure impossible to miss and impossible to drop.
 *
 * `status: "compared"` means rows exist with this `selector` as their
 * `childSelector`. Anything else means no comparison ran, and `message` says
 * why and what to do (worded in `child-bindings.ts`).
 */
export interface ChildBindingReport {
  /** CSS selector exactly as declared in the registry. */
  selector: string;
  /** Figma node id declared for it. Empty string when the binding is malformed. */
  nodeId: string;
  /** Figma node's own name, when the node was read successfully. */
  nodeName?: string;
  status: ChildBindingStatus;
  /** Present whenever `status !== "compared"`. Actionable, names the selector. */
  message?: string;
  /** How many rows this child contributed (0 when not compared). */
  rowCount?: number;
}

export interface DriftReport {
  storyId: string;
  nodeId: string;
  dimensions: DimensionDiff[];
  generatedAt: string;
  /**
   * Present only when the registry entry declared `children`. Absent for every
   * legacy entry, so nothing downstream changes for them.
   */
  children?: ChildBindingReport[];
  /** Active mode name used for comparison (e.g. "light", "dark"). */
  mode?: string;
  /** Timing + cache stats — shown in the panel for visibility into perf. */
  timing?: DriftTiming;
  /**
   * Set when the startup scanner refused to derive bindings for this story and
   * the reason is actionable — currently only "two scanned components answer to
   * the same name". Surfaced so an empty binding column reads as "we declined
   * to guess" rather than "your code declares nothing".
   */
  scanAdvisory?: string;
}
