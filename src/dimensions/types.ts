// ModeAwareValue is part of the shared wire contract; source it from core.
// Core declares `light?`/`dark?` as optional — call sites must tolerate
// either field being absent. Imported here and re-exported so existing
// `import { ModeAwareValue } from ".../dimensions/types.js"` sites (incl.
// the package's public `index.ts`) keep resolving.
import type { ModeAwareValue } from "@metalab/design-sync-core";
export type { ModeAwareValue };
import type { ChildBindingStatus } from "../child-bindings.js";
import type { TokenPresence } from "../token-presence.js";
import type { ContractReference } from "../contract.js";

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
 * - `advisory` — real information, no accusation. Currently produced by exactly
 *   one comparison: a `token-binding` row whose two sides name the token
 *   differently and where that difference is **not** evidence of a defect
 *   (v0.0.38, issue #57). Code binds `primary`, the Figma library calls the same
 *   decision `color/background/brand/default`, and the resolved values match —
 *   the component renders what the design specifies, the two systems just spell
 *   the token differently. Counted and styled separately from drift: a first run
 *   reporting 89 problems where a human sees one is a run nobody repeats. The
 *   row stays visible, carries the two names, and suggests the `tokenAliases`
 *   entry that would state the equivalence outright. Never red, never offers a
 *   fix prompt, never feeds an Apply.
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
export type DimensionStatus = "match" | "drift" | "advisory" | "flag-only" | "unresolved";

/**
 * Why a `token-binding` row is an `advisory` rather than drift or a match.
 *
 *  - `"value-matched"` — the paired `token-value` comparison for the same
 *    property (and the same element) reported `match`. The names differ, the
 *    rendered value is right. Not a defect.
 *  - `"unverified"` — the names differ and there was **no value comparison** to
 *    fall back on (no `token-value` row for this property, or one that was
 *    itself `flag-only`/`unresolved`). We cannot say the render is right, so this
 *    is explicitly NOT a match; we also cannot say it is wrong, since token-name
 *    matching is heuristic unless `tokenAliases` says otherwise. It is reported,
 *    tallied under its own count, and labelled "unverified" in the panel —
 *    never folded into match, never dropped.
 */
export type NameDivergenceKind = "value-matched" | "unverified";

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
   * Present on a `token-binding` row whose two sides name the token differently.
   * Says how much the divergence is worth (see {@link NameDivergenceKind}).
   * Always accompanies `status: "advisory"`.
   */
  nameDivergence?: NameDivergenceKind;
  /**
   * On a `token-binding` row whose names **were** reconciled: which mechanism did
   * it. `"alias"` = an explicit `tokenAliases` entry (declared by the project, so
   * trustworthy); `"heuristic"` = the two spellings collapse to the same
   * canonical form via `normalizeTokenName` (a guess, and a good one, but still a
   * guess). Surfaced in the panel so a reader knows which they are looking at.
   */
  nameResolvedBy?: "alias" | "heuristic";
  /**
   * The utility class the code-side binding came from (`"bg-primary"`), when
   * the scanner derived this property from Tailwind rather than from a
   * `var(--token)` declaration. Attribution only: it lets the fix prompt name
   * the class to change instead of only describing the property. Nothing about
   * a row's status, values, or partitioning depends on it.
   */
  codeClassName?: string;
  /**
   * Something true about **where the Figma side's value came from** that is not a
   * verdict on the row: the shared paint style that delivers the fill, or the
   * fact that the bound variable is a single-mode palette primitive in a file
   * that themes its colours elsewhere (so this fill cannot follow the theme).
   *
   * Kept out of `status` on purpose. It never accuses, never suppresses, and is
   * shown on `match` rows too — a fill that matches today and cannot theme
   * tomorrow is exactly the case a status-carrying signal would hide.
   */
  sourceAdvisory?: string;
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
  /**
   * Whether the project's own CSS declares a custom property for this row's
   * `tokenName` — resolved by `token-presence.ts` against the startup scan and
   * attached by the server *after* the engine (so it is never cached and never
   * stale relative to the CSS).
   *
   * **Annotation, not a verdict.** Nothing about a row's status, values or
   * partitioning depends on it. It exists so a fix prompt can tell "this project
   * spells the token `--color-x`" from "this project has no such token" instead of
   * presenting a convention-converted Figma name as though it existed (#66/#67).
   */
  tokenPresence?: TokenPresence;
  /**
   * What `contracts/<component>.spec.json` records about the other slots this
   * row's token drives (#71). Attached by the server when a contract exists.
   *
   * **Annotation, not a verdict**, for the same reason as above and one more: the
   * contract is validated by nothing, so it may inform a human and must never
   * overrule either side of a comparison.
   */
  contract?: ContractReference;
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

/**
 * Set when part of what this report claims to cover **could not be read from
 * Figma** — a rate limit, a network failure, an HTTP error on the nodes or
 * variables endpoint. Its presence means the report is not a verdict: absence of
 * drift here is absence of evidence (issue #73).
 *
 * Deliberately NOT used for a comparison that legitimately did not apply, or for
 * a declared child whose selector matched nothing: those are findings about the
 * consumer's code or registry, they are stable across runs, and they are already
 * reported per child. This field is only for "we could not look".
 *
 * Consequences wherever it is set, all of them load-bearing:
 *   - the report is **never persisted** to `.design-sync/cache.json`, so the next
 *     run retries instead of replaying (`cache.ts`);
 *   - the bulk row's terminal state is `incomplete`, not `done`, and the summary
 *     counts it separately from checked (`bulk-summary.ts`);
 *   - the panel says so above the table.
 */
export interface ReportIncomplete {
  /** Short, human phrase for a header or a table cell. */
  reason: string;
  /**
   * What could not be read — `"root"`, `"file variables"`, or a declared child's
   * CSS selector. Never empty when `incomplete` is present.
   */
  targets: string[];
  /** Longest `Retry-After` Figma asked for, when it supplied one. */
  retryAfterMs?: number;
  /** The full failure text, including the retry advice. */
  detail: string;
}

/**
 * Whether the two-mode comparison the user asked for actually happened.
 *
 * Present only on a report produced with **Both modes** ticked. `performed:
 * false` means the preview could not make the rendered story change appearance
 * between the two modes, so there was one rendered state, not two — issue #69,
 * where an attribute-based switch on a class-themed project produced two
 * byte-identical passes and a run that reported a completed two-mode comparison.
 *
 * A single-mode report carries no `modeComparison` at all: the field says
 * something about a *request* for two modes, and inventing one for every check
 * would make "not performed" the normal state.
 */
export interface ModeComparison {
  performed: boolean;
  /** The two modes requested, in order. */
  requested: [string, string];
  /** How the preview switched theme, e.g. "class `.dark` on <html>". */
  mechanism?: string;
  /** Why the comparison did not happen. Always set when `performed` is false. */
  reason?: string;
}

/** What the persistent cache did, surfaced so silence isn't mistaken for a cold run. */
export interface CacheStatus {
  /**
   * Entries found on disk and discarded because an older addon wrote them
   * (`CACHE_VERSION` mismatch). Silence here is indistinguishable from a clean
   * cold start, which is what cost a wrong baseline in issue #62.
   */
  discardedByVersion?: number;
  /** Set when this report was deliberately not written to the cache, and why. */
  notPersisted?: string;
}

/**
 * **When** the Figma values in this report were read, and from what (issue #76).
 *
 * `generatedAt` says when the report object was assembled, which for a cache hit is
 * *now*. That is the right answer for the panel's "last checked" line and the wrong
 * one for a fix prompt: a prompt is applied later and reviewed later still, and
 * without the read's own timestamp it is indistinguishable from a statement about
 * the present. starter PR #5 applied one faithfully and would have re-introduced
 * drift, because the Figma edit it cited had been reverted while the PR sat open.
 *
 * So this field is the *read's* identity, and the one rule that makes it worth
 * anything: **a cache hit must carry the cached read's `readAt`, never a fresh
 * one.** Restamping it would turn a two-day-old reading into a confident statement
 * about now, which is the bug rather than the fix.
 */
export interface FigmaReadSource {
  /** ISO timestamp of the Figma read the values came from. */
  readAt: string;
  /** The file's `lastModified` as of that read, when it could be read. */
  fileLastModified?: string;
  /** The file's `version` as of that read, when it could be read. */
  fileVersion?: string;
  /** True when this report was replayed from `.design-sync/cache.json`. */
  fromCache?: boolean;
}

export interface DriftReport {
  storyId: string;
  nodeId: string;
  dimensions: DimensionDiff[];
  generatedAt: string;
  /**
   * Provenance of the Figma read behind these values — see {@link FigmaReadSource}.
   * Optional because a report replayed from a cache written by an older addon has
   * none, and an unknown read time must be reported as unknown rather than
   * defaulted to now.
   */
  source?: FigmaReadSource;
  /** Present when something this report covers could not be read from Figma. */
  incomplete?: ReportIncomplete;
  /** Present only when the check was asked for two modes. */
  modeComparison?: ModeComparison;
  /** Persistent-cache bookkeeping worth showing (discards, refusals). */
  cacheStatus?: CacheStatus;
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
