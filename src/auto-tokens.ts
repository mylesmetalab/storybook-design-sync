import type { AutoTokenMap } from "./scan-css.js";

/**
 * Process-wide singleton holding the CSS-derived selector → token map.
 * Populated by the preset at Storybook startup; read by the server
 * channel when merging bindings into a code snapshot before running
 * the engine.
 *
 * Why not pass it explicitly? The preset and server channel are
 * registered separately by Storybook (separate entry points), so they
 * don't share a closure. A module singleton is the simplest seam.
 */
let cached: AutoTokenMap = {};
let initialized = false;

export function setAutoTokenMap(map: AutoTokenMap): void {
  cached = map;
  initialized = true;
}

export function getAutoTokenMap(): AutoTokenMap {
  return cached;
}

export function autoTokenMapReady(): boolean {
  return initialized;
}
