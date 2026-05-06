import type { Engine, EngineContext, EngineFactory } from "./types.js";
import { createFigmaRestEngine } from "./figma-rest.js";

const REGISTRY: Record<string, EngineFactory> = {
  "figma-rest": createFigmaRestEngine,
};

export function resolveEngine(name: string, ctx: EngineContext): Engine {
  const factory = REGISTRY[name];
  if (!factory) {
    throw new Error(
      `[design-sync] Unknown engine "${name}". Known: ${Object.keys(REGISTRY).join(", ")}.`,
    );
  }
  return factory(ctx);
}

export type { Engine, EngineContext, EngineFactory } from "./types.js";
