import type { CodeSnapshot } from "./engines/types.js";
import type { DriftReport } from "./dimensions/types.js";

export const ADDON_ID = "metalab/design-sync";
export const PANEL_ID = `${ADDON_ID}/panel`;

/** Channel event names. Stable contract — change with care. */
export const EVENTS = {
  /** Manager → preview/server: user clicked Check drift. */
  CheckDriftRequest: "design-sync:checkDriftRequest",
  /** Preview → server: code-side snapshot for the requested story. */
  CodeSnapshot: "design-sync:codeSnapshot",
  /** Server → manager: completed drift report. */
  DriftReport: "design-sync:driftReport",
  /** Server → manager: error during a check. */
  DriftError: "design-sync:driftError",
  /**
   * Sibling addons → this addon. v0 listens & lists read-only.
   * Reserved contract for the inspector ↔ sync handshake in v1.
   */
  ProposedEdit: "design-sync:proposedEdit",
} as const;

export interface CheckDriftRequestPayload {
  storyId: string;
  /** CSS selector for the element the preview should snapshot. */
  target?: string;
  /** Code-side token bindings declared by the story (CSS prop → token name). */
  tokens?: Record<string, string>;
  /** Element attribute (on `<html>`) that carries the active mode name. */
  modeAttribute?: string;
}

export interface CodeSnapshotPayload {
  storyId: string;
  snapshot: CodeSnapshot;
  /**
   * The active mode name as read from the rendered DOM (e.g. "light", "dark").
   * The engine uses this to pick the matching value when resolving Figma
   * variables, instead of always defaulting to the file's default mode.
   */
  mode?: string;
}

export interface DriftReportPayload {
  report: DriftReport;
}

export interface DriftErrorPayload {
  storyId: string;
  message: string;
}

/**
 * Shared contract with `storybook-design-inspector` (and any other producer).
 * v0: addon listens & displays. v1: addon will route these to engines.
 */
export interface ProposedEdit {
  kind: "token-value" | "token-binding" | "component-override" | "copy";
  scope: "global" | "component";
  storyId?: string;
  property: string;
  oldValue: string;
  newValue: string;
  modes?: { light: string; dark: string };
  source: string;
  timestamp: string;
}
