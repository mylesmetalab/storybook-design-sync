// ModeAwareValue is part of the shared wire contract; source it from core.
// Core declares `light?`/`dark?` as optional — call sites must tolerate
// either field being absent. Imported here and re-exported so existing
// `import { ModeAwareValue } from ".../dimensions/types.js"` sites (incl.
// the package's public `index.ts`) keep resolving.
import type { ModeAwareValue } from "@metalab/design-sync-core";
export type { ModeAwareValue };

export type DimensionKind =
  | "token-value"
  | "token-binding"
  | "variant-set"
  | "copy"
  | "props"
  | "structure"
  | "motion";

export type DimensionStatus = "match" | "drift" | "flag-only";

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

export interface DriftReport {
  storyId: string;
  nodeId: string;
  dimensions: DimensionDiff[];
  generatedAt: string;
  /** Active mode name used for comparison (e.g. "light", "dark"). */
  mode?: string;
  /** Timing + cache stats — shown in the panel for visibility into perf. */
  timing?: DriftTiming;
}
