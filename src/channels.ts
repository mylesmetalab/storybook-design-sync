import type { CodeSnapshot } from "./engines/types.js";
import type { DriftReport } from "./dimensions/types.js";
import type { Edit, EditResult } from "@metalab/design-sync-core";

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
  /**
   * Manager → server: apply a code-scope Edit in-process (P1.4). The server
   * writes the file with the CSS engine directly — no pipeline binary. The
   * manager correlates the reply by `edit.id`. Figma-scope edits do NOT use
   * this path; they still POST to the pipeline over HTTP.
   */
  ApplyCodeRequest: "design-sync:applyCodeRequest",
  /** Server → manager: result of an in-process code-scope apply. */
  ApplyCodeResult: "design-sync:applyCodeResult",
  /**
   * Manager → server: request the addon config surface the panel needs
   * (apply gating mode, fileKey, code-target paths). Sent once when the
   * panel mounts.
   */
  ConfigRequest: "design-sync:configRequest",
  /** Server → manager: reply to ConfigRequest (or a config load error). */
  ConfigInfo: "design-sync:configInfo",
  /**
   * Preview → server: "what child bindings does the registry declare for this
   * story?". Asked by the preview *before* it snapshots, so the child elements
   * are captured in the same pass as the root (and in the same mode, during a
   * dual-mode run). The registry lives on disk on the Node side, so the preview
   * can't read it directly.
   */
  ChildBindingsRequest: "design-sync:childBindingsRequest",
  /** Server → preview: reply to ChildBindingsRequest. */
  ChildBindingsInfo: "design-sync:childBindingsInfo",
  /**
   * Manager → server: pre-fetch the artefacts a **Check all** run shares (Figma
   * variables + file metadata) BEFORE the per-story loop starts, so the first
   * story isn't charged for warming the cache every other story reads (#56).
   */
  WarmCacheRequest: "design-sync:warmCacheRequest",
  /** Server → manager: warm-up finished (or declined). Never an error path. */
  WarmCacheDone: "design-sync:warmCacheDone",
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
  /**
   * Set only by a **Check all** run. It tells the engine that caching is
   * wanted here: one variables fetch serving every story is what keeps a
   * ~90-story run under Figma's rate limits.
   *
   * Absent — a human pressed Check drift on this story — means the engine must
   * revalidate against Figma instead of answering from a timer-backed cache. A
   * deliberate re-check is a request for the truth. See `CheckDriftInput.trigger`.
   */
  bulk?: boolean;
}

export interface ChildBindingsRequestPayload {
  storyId: string;
}

export interface ChildBindingsInfoPayload {
  storyId: string;
  /**
   * Well-formed declarations, in registry order. Empty for a legacy entry, an
   * unregistered story, or when the registry couldn't be read — in all of those
   * cases the server's own CodeSnapshot handling reports the real problem, so
   * the preview simply snapshots the root as before.
   */
  children: Array<{ selector: string; nodeId: string }>;
}

/**
 * Per-child result of the preview's DOM resolution. One entry for every
 * declaration the preview was told about; `kind` other than "found" means the
 * preview refused to snapshot (nothing matched, or more than one thing did).
 */
export interface ChildSnapshotEntry {
  selector: string;
  nodeId: string;
  kind: "found" | "not-found" | "ambiguous" | "invalid";
  /** Present only when `kind === "found"`. */
  snapshot?: CodeSnapshot;
  /** Second-mode snapshot during a dual-mode run. */
  additionalSnapshots?: Array<{ mode: string; snapshot: CodeSnapshot }>;
  /** Element descriptions when `kind === "ambiguous"`. */
  candidates?: string[];
  /** Parser message when `kind === "invalid"`. */
  detail?: string;
  /** True when a not-found selector would have matched the story root itself. */
  rootMatches?: boolean;
}

export interface CodeSnapshotPayload {
  storyId: string;
  snapshot: CodeSnapshot;
  /**
   * Declared child bindings the preview attempted, in the order the server sent
   * them. Absent for a story with no `children` in the registry — which keeps
   * the payload (and therefore the cache hash) byte-identical for legacy
   * entries. A declaration the server knows about but that is missing here is
   * reported as `snapshot-missing`, never ignored.
   */
  childSnapshots?: ChildSnapshotEntry[];
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
  /**
   * Relayed straight from the `CheckDriftRequest` that produced this snapshot,
   * so the server can tell a bulk run's story from a deliberate single check
   * and set `CheckDriftInput.trigger` accordingly. Absent = explicit.
   */
  bulk?: boolean;
}

/**
 * Outcome of the pre-loop shared fetch. `ms` is what the run paid for it — the
 * cost that used to land on the first story's 8s budget. `error` is present when
 * the warm-up couldn't run or failed; the run continues either way (each story
 * still fetches what it needs), so the panel reports it rather than aborting.
 */
export interface WarmCacheDonePayload {
  ms: number;
  /** True when an engine actually pre-fetched something. */
  warmed: boolean;
  error?: string;
}

export interface DriftReportPayload {
  report: DriftReport;
}

export interface ApplyCodeRequestPayload {
  edit: Edit;
}

export interface ApplyCodeResultPayload {
  result: EditResult;
}

export interface DriftErrorPayload {
  storyId: string;
  message: string;
  /**
   * How the panel should present `message`. Defaults to `"error"` when absent
   * (every genuine failure). `"info"` marks a correct, expected state that
   * merely has no report to show — currently only a `pending` registry stub —
   * so it renders as a neutral notice instead of in error red.
   */
  severity?: "error" | "info";
}

export interface RegisteredStoryEntry {
  storyId: string;
  nodeId: string;
}

export interface RegisteredStoriesPayload {
  stories: RegisteredStoryEntry[];
  fileKey: string;
  /**
   * Present when the registry (or config) could not be loaded. The manager
   * renders this as an error banner instead of treating the empty story
   * list as "nothing registered".
   */
  error?: string;
}

/**
 * Config surface the manager panel needs, relayed by the server on
 * ConfigRequest. Deliberately minimal — no secrets, no absolute paths
 * beyond the consumer-relative codeTarget paths.
 */
export interface ConfigInfoPayload {
  /** Write gating mode. `"off"` = audit-only panel (v1 default). */
  apply: "off" | "experimental";
  fileKey: string;
  /** Consumer-relative paths of configured codeTargets (for fix prompts). */
  codeTargetPaths: string[];
  /** Present when design-sync.config.json failed to load or validate. */
  error?: string;
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
