import type { DriftReport } from "../dimensions/types.js";

export interface NodeRef {
  fileKey: string;
  nodeId: string;
}

export interface CodeSnapshot {
  /**
   * Computed style values pulled from the rendered story root, keyed by
   * CSS property (e.g. "padding-top", "background-color", "--space-8").
   */
  styles: Record<string, string>;
  /**
   * Variable references the code intends to use, if discoverable from the
   * DOM (e.g. a `data-token` attribute or a CSS custom property indirection).
   * Keyed the same way as `styles`. Values are token names like "space.8".
   */
  bindings?: Record<string, string>;
  /**
   * BEM modifier classes or other variant signals on the story root element.
   * Used by the variant-set diff.
   */
  variantClasses?: string[];
}

export interface CheckDriftInput {
  storyId: string;
  nodeRef: NodeRef;
  /** Optional snapshot of the rendered code-side story. */
  snapshot?: CodeSnapshot;
  /**
   * Active mode name (e.g. "light", "dark") read from the rendered DOM.
   * The engine uses this to pick matching values when resolving Figma
   * variables, so dark-mode comparisons aren't always made against the
   * file's default (Light) mode.
   */
  mode?: string;
}

export interface Engine {
  readonly name: string;
  checkDrift(input: CheckDriftInput): Promise<DriftReport>;
}

export interface EngineContext {
  /** PAT or other secret material; engines must never log this. */
  figmaPat?: string;
}

export type EngineFactory = (ctx: EngineContext) => Engine;
