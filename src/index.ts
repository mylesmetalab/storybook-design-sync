export type {
  DimensionDiff,
  DimensionKind,
  DimensionStatus,
  DriftReport,
  ModeAwareValue,
} from "./dimensions/types.js";

export type {
  Engine,
  EngineContext,
  EngineFactory,
  CheckDriftInput,
  CodeSnapshot,
  NodeRef,
} from "./engines/types.js";

export {
  ADDON_ID,
  PANEL_ID,
  EVENTS,
  type CheckDriftRequestPayload,
  type CodeSnapshotPayload,
  type DriftReportPayload,
  type DriftErrorPayload,
  type ProposedEdit,
} from "./channels.js";
