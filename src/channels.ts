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
   * Manager → server: list every story registered in .design-sync/registry.json.
   * Used by the bulk-check flow.
   */
  ListRegisteredRequest: "design-sync:listRegisteredRequest",
  /** Server → manager: registered stories with their Figma node ids. */
  RegisteredStories: "design-sync:registeredStories",
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
  /** Storybook story args at request time (used by the props dimension). */
  args?: Record<string, unknown>;
  /**
   * When true, the preview snapshots in both `dualModes[0]` and `dualModes[1]`
   * by toggling the mode attribute, then restoring the original. The server
   * runs the engine per mode and merges into a single report.
   */
  dualMode?: boolean;
  /**
   * The two mode names to snapshot when `dualMode` is true. Defaults to
   * `["light", "dark"]`. Per-story override via `parameters.designSync.modes`.
   */
  dualModes?: [string, string];
}

export interface CodeSnapshotPayload {
  storyId: string;
  snapshot: CodeSnapshot;
  /**
   * The selector the preview used to find the story root. Relayed so the
   * server can look up CSS-derived token bindings for that selector and
   * merge them into `snapshot.bindings` before running the engine. Only
   * present when the story declared `parameters.designSync.target`.
   */
  target?: string;
  /**
   * The active mode name as read from the rendered DOM (e.g. "light", "dark").
   * The engine uses this to pick the matching value when resolving Figma
   * variables, instead of always defaulting to the file's default mode.
   */
  mode?: string;
  /** Storybook story args, relayed from the manager. Used by `props` diff. */
  args?: Record<string, unknown>;
  /**
   * When the preview snapshotted in dual-mode, this carries the second
   * (mode, snapshot) pair. The server runs the engine separately per mode
   * and merges results.
   */
  additionalSnapshots?: Array<{ mode: string; snapshot: CodeSnapshot }>;
}

export interface DriftReportPayload {
  report: DriftReport;
}

export interface DriftErrorPayload {
  storyId: string;
  message: string;
}

export interface RegisteredStoryEntry {
  storyId: string;
  nodeId: string;
}

export interface RegisteredStoriesPayload {
  stories: RegisteredStoryEntry[];
  fileKey: string;
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
