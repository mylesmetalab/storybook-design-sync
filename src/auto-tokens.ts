import type { TailwindThemeVars } from "@metalab/design-sync-core";
import type { AutoTokenMap } from "./scan-css.js";
import type { TsxClassHintMap } from "./scan-tsx.js";
import type { TailwindComponentScan } from "./tailwind-components.js";
import type { CustomPropertyIndex } from "./token-presence.js";

/**
 * Process-wide singleton holding everything the startup scan derived:
 *
 *  - the CSS/TSX selector → token map,
 *  - the Tailwind `@theme` variables (needed to resolve utility classes),
 *  - the per-component `cva()` layers (resolved per story, since which variant
 *    slots apply depends on the story's args),
 *  - class attribution, so a fix prompt can name the utility class to change.
 *
 * Populated by the preset at Storybook startup; read by the server channel
 * when merging bindings into a code snapshot before running the engine.
 *
 * Why not pass it explicitly? The preset and server channel are registered
 * separately by Storybook (separate entry points), so they don't share a
 * closure. A module singleton is the simplest seam.
 */
export interface AutoScan {
  map: AutoTokenMap;
  themeVars: TailwindThemeVars;
  components: TailwindComponentScan[];
  classHints: TsxClassHintMap;
  /**
   * Every custom property the scanned CSS declares → the files declaring it.
   * Read by `token-presence.ts` so a fix prompt can tell "this project spells the
   * token like this" from "this project has no such token" (issues #66/#67)
   * instead of presenting a converted Figma name as if it existed.
   */
  customProperties: CustomPropertyIndex;
}

function emptyScan(): AutoScan {
  return { map: {}, themeVars: {}, components: [], classHints: {}, customProperties: {} };
}

let cached: AutoScan = emptyScan();
let initialized = false;

/**
 * Store the full scan result. Kept alongside `setAutoTokenMap` (below) rather
 * than replacing it so nothing that only cares about the selector map has to
 * change.
 */
export function setAutoScan(scan: AutoScan): void {
  cached = scan;
  initialized = true;
}

export function getAutoScan(): AutoScan {
  return cached;
}

/**
 * Map-only setter, retained for callers (and tests) that have no Tailwind data
 * to contribute. Resets the Tailwind side to empty so a stale theme can never
 * outlive the map it was scanned with.
 */
export function setAutoTokenMap(map: AutoTokenMap): void {
  setAutoScan({ ...emptyScan(), map });
}

export function getAutoTokenMap(): AutoTokenMap {
  return cached.map;
}

export function autoTokenMapReady(): boolean {
  return initialized;
}
