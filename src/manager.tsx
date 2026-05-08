import React, { useEffect, useState, useCallback, useRef } from "react";
import { addons, types, useArgs, useChannel, useParameter, useStorybookApi, useStorybookState } from "storybook/manager-api";
import {
  ADDON_ID,
  PANEL_ID,
  EVENTS,
  type CheckDriftRequestPayload,
  type DriftReportPayload,
  type DriftErrorPayload,
  type ProposedEdit,
  type RegisteredStoriesPayload,
  type RegisteredStoryEntry,
} from "./channels.js";
import type { DriftReport, DimensionDiff } from "./dimensions/types.js";

const STORY_RENDERED_EVENT = "storyRendered";

interface PanelState {
  loading: boolean;
  report: DriftReport | null;
  error: string | null;
}

interface BulkRow {
  storyId: string;
  status: "pending" | "running" | "done" | "error";
  match: number;
  drift: number;
  flagOnly: number;
  durationMs: number;
  error?: string;
}

interface BulkState {
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  rows: BulkRow[];
}

interface ApplyResult {
  status: "applied" | "rejected" | "needs_review" | "error" | "no_op" | "loading" | "undone";
  message?: string;
  diff?: string;
  /**
   * On a successful apply, we stash the inverse edit (oldValue ⇄ newValue
   * swapped) so we can offer a one-click Undo. Cleared once the user clicks
   * undo (status → "undone") or after a manual Check drift refreshes the
   * row.
   */
  inverse?: Record<string, unknown>;
}

const PIPELINE_DEFAULT_URL = "http://127.0.0.1:7099";

/**
 * POST a single drift row to the design-sync-pipeline. Returns an
 * ApplyResult that the panel renders inline. Errors (including the pipeline
 * not running) become `status: "error"` with a human-readable message.
 */
async function postEdit(
  pipelineUrl: string,
  payload: Record<string, unknown>,
): Promise<ApplyResult> {
  try {
    const res = await fetch(`${pipelineUrl}/edits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { status: "error", message: `Pipeline returned ${res.status}` };
    }
    const data = (await res.json()) as ApplyResult;
    return data;
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      message: `Pipeline unreachable (${m}). Is it running on ${pipelineUrl}?`,
    };
  }
}

type ApplyScope = "code" | "figma";

/**
 * Build a pipeline Edit from a drift row + story context. The scope
 * decides which side wins on this drift:
 *
 *   - scope=code   → "code is wrong, change code to match Figma" (oldValue=code, newValue=figma)
 *   - scope=figma  → "Figma is wrong, change Figma to match code" (oldValue=figma, newValue=code).
 *                    Requires `nodeId` (passed in) and is processed by the
 *                    Figma plugin worker via the pipeline's queue.
 *
 * Returns null if the row isn't fixable in the requested direction.
 */
function buildEdit(
  d: DimensionDiff,
  storyId: string,
  selector: string | undefined,
  scope: ApplyScope,
  nodeId: string | undefined,
): Record<string, unknown> | null {
  if (d.kind !== "token-binding") return null;
  if (typeof d.codeValue !== "string" || typeof d.figmaValue !== "string") return null;
  if (scope === "code" && !selector) return null;
  if (scope === "figma" && !nodeId) return null;

  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${storyId}-${d.property}-${Date.now()}`;

  if (scope === "code") {
    return {
      id,
      kind: "token-binding",
      scope: "code",
      target: { selector, property: d.property, storyId },
      oldValue: d.codeValue,
      newValue: d.figmaValue,
      source: "storybook-design-sync",
      timestamp: new Date().toISOString(),
    };
  }
  // figma scope: swap old/new — Figma is being asked to match code.
  return {
    id,
    kind: "token-binding",
    scope: "figma",
    target: { nodeId, property: d.property, storyId },
    oldValue: d.figmaValue,
    newValue: d.codeValue,
    source: "storybook-design-sync",
    timestamp: new Date().toISOString(),
  };
}

const initialState: PanelState = { loading: false, report: null, error: null };

const Panel: React.FC<{ active: boolean }> = ({ active }) => {
  const [state, setState] = useState<PanelState>(initialState);
  const [edits, setEdits] = useState<ProposedEdit[]>([]);
  const [dualMode, setDualMode] = useState(false);
  const sb = useStorybookState();
  const storyId = sb.storyId;
  const designSync = useParameter<{
    target?: string;
    tokens?: Record<string, string>;
    modeAttribute?: string;
    pipelineUrl?: string;
  }>("designSync", {}) ?? {};
  const [args] = useArgs();
  const [applyResults, setApplyResults] = useState<Record<string, ApplyResult>>({});
  const [bulk, setBulk] = useState<BulkState | null>(null);
  const sbApi = useStorybookApi();
  const pendingResolversRef = useRef<{
    resolve: (report: DriftReport) => void;
    reject: (err: string) => void;
    storyId: string;
  } | null>(null);

  const emit = useChannel({
    [EVENTS.DriftReport]: (payload: DriftReportPayload) => {
      const pending = pendingResolversRef.current;
      if (pending && pending.storyId === payload.report.storyId) {
        pending.resolve(payload.report);
        pendingResolversRef.current = null;
        return;
      }
      setState({ loading: false, report: payload.report, error: null });
    },
    [EVENTS.DriftError]: (payload: DriftErrorPayload) => {
      const pending = pendingResolversRef.current;
      if (pending && pending.storyId === payload.storyId) {
        pending.reject(payload.message);
        pendingResolversRef.current = null;
        return;
      }
      setState({ loading: false, report: null, error: payload.message });
    },
    [EVENTS.ProposedEdit]: (edit: ProposedEdit) => {
      setEdits((prev) => [edit, ...prev].slice(0, 50));
    },
    [EVENTS.RegisteredStories]: (payload: RegisteredStoriesPayload) => {
      void runBulk(payload.stories);
    },
    // Bridge: storybook-design-inspector emits its own STYLE_UPDATE events
    // when a user live-tweaks a token. Normalize → ProposedEdit and surface
    // in our Staged edits panel for review/push.
    "storybook/design-inspector/style-update": (raw: unknown) => {
      const edit = normalizeInspectorPayload(raw, storyId);
      if (edit) setEdits((prev) => [edit, ...prev].slice(0, 50));
    },
  });

  // Reset when the story changes.
  useEffect(() => {
    setState(initialState);
  }, [storyId]);

  const onCheck = useCallback(() => {
    if (!storyId) return;
    setState({ loading: true, report: null, error: null });
    const payload: CheckDriftRequestPayload = { storyId };
    if (designSync.target) payload.target = designSync.target;
    if (designSync.tokens) payload.tokens = designSync.tokens;
    if (designSync.modeAttribute) payload.modeAttribute = designSync.modeAttribute;
    if (args && Object.keys(args).length > 0) payload.args = args as Record<string, unknown>;
    if (dualMode) payload.dualMode = true;
    emit(EVENTS.CheckDriftRequest, payload);
  }, [emit, storyId, designSync.target, designSync.tokens, designSync.modeAttribute, args, dualMode]);

  /**
   * Bulk Check drift — iterates every registered story, navigates Storybook
   * to each, waits for STORY_RENDERED, fires the existing single-story
   * Check drift, aggregates results into a summary table.
   *
   * Per-story timeout: 8s (gives slow stories room without hanging the loop).
   * Errors don't abort — they just mark that row as `error` and continue.
   */
  const runBulk = useCallback(async (stories: RegisteredStoryEntry[]) => {
    if (stories.length === 0) {
      setBulk({ running: false, startedAt: Date.now(), finishedAt: Date.now(), rows: [] });
      return;
    }
    const startedAt = Date.now();
    setBulk({
      running: true,
      startedAt,
      rows: stories.map((s) => ({
        storyId: s.storyId,
        status: "pending",
        match: 0,
        drift: 0,
        flagOnly: 0,
        durationMs: 0,
      })),
    });

    for (let i = 0; i < stories.length; i++) {
      const entry = stories[i]!;
      setBulk((prev) =>
        prev ? { ...prev, rows: prev.rows.map((r, j) => (j === i ? { ...r, status: "running" } : r)) } : prev,
      );

      const t0 = Date.now();
      try {
        const report = await checkOneStory(entry.storyId, sbApi, emit, pendingResolversRef);
        const counts = countRows(report);
        const durationMs = Date.now() - t0;
        setBulk((prev) =>
          prev
            ? {
                ...prev,
                rows: prev.rows.map((r, j) =>
                  j === i
                    ? { ...r, status: "done", durationMs, match: counts.match, drift: counts.drift, flagOnly: counts.flagOnly }
                    : r,
                ),
              }
            : prev,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - t0;
        setBulk((prev) =>
          prev
            ? {
                ...prev,
                rows: prev.rows.map((r, j) =>
                  j === i ? { ...r, status: "error", durationMs, error: message } : r,
                ),
              }
            : prev,
        );
      }
    }

    setBulk((prev) => (prev ? { ...prev, running: false, finishedAt: Date.now() } : prev));
  }, [emit, sbApi]);

  const onCheckAll = useCallback(() => {
    setBulk(null);
    emit(EVENTS.ListRegisteredRequest);
  }, [emit]);

  if (!active) return null;

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <button style={styles.button} onClick={onCheck} disabled={!storyId || state.loading}>
          {state.loading ? "Checking…" : "Check drift"}
        </button>
        <button
          style={styles.button}
          onClick={onCheckAll}
          disabled={bulk?.running ?? false}
          title="Iterate every registered story and produce a summary"
        >
          {bulk?.running ? "Running…" : "Check all"}
        </button>
        <label style={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={dualMode}
            onChange={(e) => setDualMode(e.currentTarget.checked)}
          />
          Both modes
        </label>
        {storyId && <span style={styles.storyId}>{storyId}</span>}
      </div>

      {bulk && <BulkSummary bulk={bulk} onSelect={(id) => sbApi?.selectStory(id)} />}

      {state.error && <div style={styles.error}>{state.error}</div>}

      {state.report && (
        <DiffTable
          report={state.report}
          applyResults={applyResults}
          onApply={async (d, key, scope) => {
            const edit = buildEdit(
              d,
              storyId ?? "",
              designSync.target,
              scope,
              state.report?.nodeId,
            );
            if (!edit) {
              setApplyResults((prev) => ({
                ...prev,
                [key + ":" + scope]: {
                  status: "rejected",
                  message:
                    scope === "code"
                      ? "Row not auto-fixable: need token-binding + selector."
                      : "Row not auto-fixable: need token-binding + figma nodeId.",
                },
              }));
              return;
            }
            setApplyResults((prev) => ({ ...prev, [key + ":" + scope]: { status: "loading" } }));
            const result = await postEdit(
              designSync.pipelineUrl ?? PIPELINE_DEFAULT_URL,
              edit,
            );
            // On success, stash the inverse edit so the row can offer Undo.
            if (result.status === "applied") {
              result.inverse = inverseEdit(edit);
            }
            setApplyResults((prev) => ({ ...prev, [key + ":" + scope]: result }));
          }}
          onUndo={async (key, scope, inverse) => {
            setApplyResults((prev) => ({ ...prev, [key + ":" + scope]: { status: "loading" } }));
            const result = await postEdit(
              designSync.pipelineUrl ?? PIPELINE_DEFAULT_URL,
              inverse,
            );
            // After undo, the row is back to its original drift state.
            // Reflect that as `undone` so users see the action took effect.
            setApplyResults((prev) => ({
              ...prev,
              [key + ":" + scope]:
                result.status === "applied" || result.status === "no_op"
                  ? { status: "undone", message: "Reverted." }
                  : result,
            }));
          }}
        />
      )}

      <StagedEdits
        edits={edits}
        applyResults={applyResults}
        pipelineUrl={designSync.pipelineUrl ?? PIPELINE_DEFAULT_URL}
        target={designSync.target}
        onResult={(key, result) =>
          setApplyResults((prev) => ({ ...prev, [key]: result }))
        }
      />
    </div>
  );
};

interface DiffTableProps {
  report: DriftReport;
  applyResults: Record<string, ApplyResult>;
  onApply: (d: DimensionDiff, key: string, scope: ApplyScope) => void;
  onUndo: (key: string, scope: ApplyScope, inverse: Record<string, unknown>) => void;
}

const DiffTable: React.FC<DiffTableProps> = ({ report, applyResults, onApply, onUndo }) => (
  <div style={styles.section}>
    <h3 style={styles.h3}>
      Drift report{" "}
      <span style={styles.muted}>
        — node {report.nodeId}
        {report.mode ? ` · mode: ${report.mode}` : ""} · {new Date(report.generatedAt).toLocaleTimeString()}
        {report.timing && (
          <> · {report.timing.totalMs}ms (fetch {report.timing.figmaFetchMs}ms · {report.timing.cacheHits} cache hits / {report.timing.cacheMisses} misses)</>
        )}
      </span>
    </h3>
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Dimension</th>
          <th style={styles.th}>Property</th>
          <th style={styles.th}>Code</th>
          <th style={styles.th}>Figma</th>
          <th style={styles.th}>Status</th>
          <th style={styles.th}>Apply</th>
        </tr>
      </thead>
      <tbody>
        {report.dimensions.map((d, i) => {
          const key = `${d.kind}-${d.property}-${i}`;
          return (
            <Row
              key={key}
              d={d}
              codeResult={applyResults[`${key}:code`]}
              figmaResult={applyResults[`${key}:figma`]}
              onApply={(scope) => onApply(d, key, scope)}
              onUndo={(scope, inverse) => onUndo(key, scope, inverse)}
            />
          );
        })}
      </tbody>
    </table>
  </div>
);

interface RowProps {
  d: DimensionDiff;
  codeResult: ApplyResult | undefined;
  figmaResult: ApplyResult | undefined;
  onApply: (scope: ApplyScope) => void;
  onUndo: (scope: ApplyScope, inverse: Record<string, unknown>) => void;
}

const Row: React.FC<RowProps> = ({ d, codeResult, figmaResult, onApply, onUndo }) => {
  const fixable =
    d.kind === "token-binding" &&
    d.status === "drift" &&
    typeof d.codeValue === "string" &&
    typeof d.figmaValue === "string";
  return (
    <tr>
      <td style={styles.td}>{d.kind}</td>
      <td style={styles.td}>{d.property}</td>
      <td style={styles.td}>
        <ValueCell value={d.codeValue} />
      </td>
      <td style={styles.td}>
        <ValueCell value={d.figmaValue} />
        {d.modes && (
          <div style={styles.modes}>
            light: {d.modes.light} · dark: {d.modes.dark}
          </div>
        )}
      </td>
      <td style={{ ...styles.td, ...statusStyle(d.status) }}>
        {d.status}
        {d.note && <div style={styles.muted}>{d.note}</div>}
      </td>
      <td style={styles.td}>
        {fixable ? (
          <div style={styles.applyButtons}>
            <ApplyButton
              label="Update code"
              scope="code"
              result={codeResult}
              onClick={() => onApply("code")}
              onUndo={(inverse) => onUndo("code", inverse)}
              title={`Write ${stringifyValue(d.figmaValue)} to code (Figma value wins)`}
            />
            <ApplyButton
              label="Update Figma"
              scope="figma"
              result={figmaResult}
              onClick={() => onApply("figma")}
              onUndo={(inverse) => onUndo("figma", inverse)}
              title={`Write ${stringifyValue(d.codeValue)} to Figma (code value wins)`}
            />
          </div>
        ) : (
          <span style={styles.muted}>—</span>
        )}
      </td>
    </tr>
  );
};

interface ApplyButtonProps {
  label: string;
  scope: ApplyScope;
  result: ApplyResult | undefined;
  onClick: () => void;
  onUndo?: (inverse: Record<string, unknown>) => void;
  title: string;
}

const ApplyButton: React.FC<ApplyButtonProps> = ({ label, scope, result, onClick, onUndo, title }) => {
  const loading = result?.status === "loading";
  const applied = result?.status === "applied";
  const undone = result?.status === "undone";
  const text = loading
    ? "…"
    : applied
    ? `✓ ${label}`
    : undone
    ? `↶ ${label}`
    : label;
  const buttonStyle = {
    ...styles.applyButton,
    ...(applied ? styles.applyButtonApplied : {}),
    ...(undone ? styles.applyButtonUndone : {}),
  };
  return (
    <div style={styles.applyButtonGroup}>
      <button style={buttonStyle} onClick={onClick} disabled={loading} title={title}>
        {text}
      </button>
      {applied && result?.inverse && onUndo && (
        <button
          style={styles.undoButton}
          onClick={() => onUndo(result.inverse!)}
          title="Revert this change"
        >
          ↶ undo
        </button>
      )}
      {result && !loading && !applied && !undone && (
        <div style={styles.applyMessage}>
          <code>{result.status}</code>
          {result.message && <div>{result.message}</div>}
        </div>
      )}
    </div>
  );
};

/**
 * Build the inverse of an Edit by swapping oldValue and newValue.
 * Generates a fresh id so the pipeline treats it as a separate operation
 * (preserves engine idempotency and audit trails).
 */
function inverseEdit(edit: Record<string, unknown>): Record<string, unknown> {
  const newId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${edit.id}-undo-${Date.now()}`;
  return {
    ...edit,
    id: newId,
    oldValue: edit.newValue,
    newValue: edit.oldValue,
    timestamp: new Date().toISOString(),
    source: `${edit.source ?? "design-sync"}:undo`,
  };
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "(empty)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Normalize a `storybook/design-inspector/style-update` payload into our
 * ProposedEdit shape. The inspector's payload structure isn't strictly
 * typed (different sections of the inspector emit slightly different
 * shapes), so we duck-type — pull out whatever fields we can find, fall
 * back to "unknown" for the rest. Better to surface a partial edit the
 * user can review than to drop it because of a missing field.
 */
function normalizeInspectorPayload(raw: unknown, storyId: string | undefined): ProposedEdit | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const property =
    (typeof r.property === "string" && r.property) ||
    (typeof r.cssProperty === "string" && r.cssProperty) ||
    (typeof r.name === "string" && r.name) ||
    null;
  if (!property) return null;

  const newValue =
    (typeof r.value === "string" && r.value) ||
    (typeof r.newValue === "string" && r.newValue) ||
    (typeof r.token === "string" && r.token) ||
    "";
  const oldValue =
    (typeof r.previousValue === "string" && r.previousValue) ||
    (typeof r.oldValue === "string" && r.oldValue) ||
    "";

  const kind: ProposedEdit["kind"] =
    typeof r.token === "string" || /color|size|space|radius|font/i.test(property)
      ? "token-value"
      : "token-value";

  const edit: ProposedEdit = {
    kind,
    scope: "component",
    property,
    oldValue,
    newValue,
    source: "design-inspector",
    timestamp: new Date().toISOString(),
  };
  if (storyId) edit.storyId = storyId;
  return edit;
}

/**
 * Navigate Storybook to a story, wait for it to render, then fire a
 * single Check drift and resolve when the report comes back. Used by
 * the bulk-check loop. 8-second timeout per story.
 */
function checkOneStory(
  storyId: string,
  sbApi: { selectStory: (id: string) => void } | undefined,
  emit: (event: string, ...args: unknown[]) => void,
  pendingRef: React.MutableRefObject<{
    resolve: (report: DriftReport) => void;
    reject: (err: string) => void;
    storyId: string;
  } | null>,
): Promise<DriftReport> {
  return new Promise<DriftReport>((resolve, reject) => {
    if (!sbApi) {
      reject("Storybook API unavailable");
      return;
    }
    const timeout = setTimeout(() => {
      pendingRef.current = null;
      reject(`Timed out (>8s) on ${storyId}`);
    }, 8000);

    pendingRef.current = {
      storyId,
      resolve: (r) => {
        clearTimeout(timeout);
        resolve(r);
      },
      reject: (e) => {
        clearTimeout(timeout);
        reject(e);
      },
    };

    // Storybook will fire STORY_RENDERED once the new story is up. We
    // listen via the addons channel.
    const channel = addons.getChannel();
    const onRendered = (renderedId: string): void => {
      if (renderedId !== storyId) return;
      channel.off(STORY_RENDERED_EVENT, onRendered);
      // Emit the request — the snapshot will come from this freshly-rendered
      // story. parameters.designSync.target/tokens are read by the preview
      // from the active story's parameters, so we don't need to pass them.
      const payload: CheckDriftRequestPayload = { storyId };
      emit(EVENTS.CheckDriftRequest, payload);
    };
    channel.on(STORY_RENDERED_EVENT, onRendered);

    sbApi.selectStory(storyId);
  });
}

function countRows(report: DriftReport): { match: number; drift: number; flagOnly: number } {
  const counts = { match: 0, drift: 0, flagOnly: 0 };
  for (const d of report.dimensions) {
    if (d.status === "match") counts.match++;
    else if (d.status === "drift") counts.drift++;
    else if (d.status === "flag-only") counts.flagOnly++;
  }
  return counts;
}

const ValueCell: React.FC<{ value: unknown }> = ({ value }) => {
  if (value === null || value === undefined) return <span style={styles.muted}>—</span>;
  if (typeof value === "string") return <code>{value}</code>;
  return <code>{JSON.stringify(value)}</code>;
};

interface StagedEditsProps {
  edits: ProposedEdit[];
  applyResults: Record<string, ApplyResult>;
  pipelineUrl: string;
  target: string | undefined;
  onResult: (key: string, result: ApplyResult) => void;
}

const StagedEdits: React.FC<StagedEditsProps> = ({ edits, applyResults, pipelineUrl, target, onResult }) => {
  const apply = useCallback(
    async (e: ProposedEdit, i: number, scope: ApplyScope) => {
      const key = `staged-${i}-${scope}`;
      onResult(key, { status: "loading" });
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `staged-${i}-${Date.now()}`;
      const payload: Record<string, unknown> = {
        id,
        kind: e.kind,
        scope,
        target: scope === "code"
          ? { selector: target, property: e.property, storyId: e.storyId }
          : { property: e.property, storyId: e.storyId },
        oldValue: e.oldValue,
        newValue: e.newValue,
        source: e.source,
        timestamp: new Date().toISOString(),
      };
      const result = await postEdit(pipelineUrl, payload);
      onResult(key, result);
    },
    [onResult, pipelineUrl, target],
  );

  return (
    <div style={styles.section}>
      <h3 style={styles.h3}>
        Staged edits{" "}
        <span style={styles.muted} title="Edits proposed by sibling addons (e.g. design-inspector live tweaks). Apply to either side via the pipeline.">
          ⓘ
        </span>
      </h3>
      {edits.length === 0 ? (
        <div style={styles.muted}>
          No proposed edits yet — try editing a token in the Design Inspector panel.
        </div>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Source</th>
              <th style={styles.th}>Property</th>
              <th style={styles.th}>Old → New</th>
              <th style={styles.th}>When</th>
              <th style={styles.th}>Apply</th>
            </tr>
          </thead>
          <tbody>
            {edits.map((e, i) => (
              <tr key={i}>
                <td style={styles.td}>{e.source}</td>
                <td style={styles.td}>
                  <code>{e.property}</code>
                </td>
                <td style={styles.td}>
                  <code>{e.oldValue || "—"}</code> → <code>{e.newValue || "—"}</code>
                  {e.modes && (
                    <div style={styles.modes}>
                      light: {e.modes.light} · dark: {e.modes.dark}
                    </div>
                  )}
                </td>
                <td style={styles.td}>{new Date(e.timestamp).toLocaleTimeString()}</td>
                <td style={styles.td}>
                  <div style={styles.applyButtons}>
                    <ApplyButton
                      label="Update code"
                      scope="code"
                      result={applyResults[`staged-${i}-code`]}
                      onClick={() => apply(e, i, "code")}
                      title={`Write ${e.newValue} to code`}
                    />
                    <ApplyButton
                      label="Update Figma"
                      scope="figma"
                      result={applyResults[`staged-${i}-figma`]}
                      onClick={() => apply(e, i, "figma")}
                      title={`Write ${e.newValue} to Figma`}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

interface BulkSummaryProps {
  bulk: BulkState;
  onSelect: (storyId: string) => void;
}

const BulkSummary: React.FC<BulkSummaryProps> = ({ bulk, onSelect }) => {
  const total = bulk.rows.reduce(
    (acc, r) => ({
      match: acc.match + r.match,
      drift: acc.drift + r.drift,
      flagOnly: acc.flagOnly + r.flagOnly,
      totalEngineMs: acc.totalEngineMs + r.durationMs,
    }),
    { match: 0, drift: 0, flagOnly: 0, totalEngineMs: 0 },
  );
  const completed = bulk.rows.filter((r) => r.status === "done").length;
  const avgMs = completed > 0 ? Math.round(total.totalEngineMs / completed) : 0;
  const done = bulk.rows.filter((r) => r.status === "done" || r.status === "error").length;
  const elapsed = (bulk.finishedAt ?? Date.now()) - bulk.startedAt;

  return (
    <div style={styles.section}>
      <h3 style={styles.h3}>
        Bulk check{" "}
        <span style={styles.muted}>
          — {done}/{bulk.rows.length} stories · {(elapsed / 1000).toFixed(1)}s
          {avgMs > 0 ? ` · avg ${avgMs}ms/story` : ""} ·{" "}
          <span style={{ color: "#0a7d3e" }}>{total.match} match</span>{" "}
          · <span style={{ color: "#b91c1c" }}>{total.drift} drift</span>{" "}
          · {total.flagOnly} flag-only
        </span>
      </h3>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Story</th>
            <th style={styles.th}>Match</th>
            <th style={styles.th}>Drift</th>
            <th style={styles.th}>Flag-only</th>
            <th style={styles.th}>Time</th>
            <th style={styles.th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {bulk.rows.map((r) => (
            <tr key={r.storyId}>
              <td style={styles.td}>
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onSelect(r.storyId);
                  }}
                  style={styles.storyLink}
                >
                  <code>{r.storyId}</code>
                </a>
              </td>
              <td style={{ ...styles.td, color: "#0a7d3e" }}>{r.match || "—"}</td>
              <td style={{ ...styles.td, color: r.drift > 0 ? "#b91c1c" : "#7a7a7a", fontWeight: r.drift > 0 ? 600 : 400 }}>
                {r.drift || "—"}
              </td>
              <td style={{ ...styles.td, color: "#7a7a7a" }}>{r.flagOnly || "—"}</td>
              <td style={styles.td}>{r.durationMs ? `${r.durationMs}ms` : "—"}</td>
              <td style={styles.td}>
                {r.status === "pending" && <span style={styles.muted}>queued</span>}
                {r.status === "running" && <span>running…</span>}
                {r.status === "done" && <span style={{ color: "#0a7d3e" }}>✓</span>}
                {r.status === "error" && (
                  <span style={{ color: "#b91c1c" }} title={r.error}>
                    ✕ {r.error?.slice(0, 40)}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

function statusStyle(status: DimensionDiff["status"]): React.CSSProperties {
  switch (status) {
    case "match":
      return { color: "#0a7d3e", fontWeight: 600 };
    case "drift":
      return { color: "#b91c1c", fontWeight: 600 };
    case "flag-only":
      return { color: "#7a7a7a" };
  }
}

const styles: Record<string, React.CSSProperties> = {
  root: { padding: "12px 16px", fontFamily: "system-ui, sans-serif", fontSize: 13 },
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 12 },
  button: {
    padding: "6px 12px",
    borderRadius: 4,
    border: "1px solid #d4d4d4",
    background: "#fff",
    cursor: "pointer",
  },
  storyId: { color: "#7a7a7a", fontFamily: "monospace" },
  storyLink: { color: "#1f2937", textDecoration: "none" },
  checkboxLabel: { display: "flex", alignItems: "center", gap: 4, color: "#525252", fontSize: 12 },
  applyButtons: { display: "flex", flexDirection: "column", gap: 4 },
  applyButtonGroup: { display: "flex", flexDirection: "column", gap: 2 },
  applyButton: {
    padding: "3px 10px",
    fontSize: 11,
    borderRadius: 3,
    border: "1px solid #d4d4d4",
    background: "#fff",
    cursor: "pointer",
    minWidth: 100,
    textAlign: "left" as const,
    whiteSpace: "nowrap" as const,
  },
  applyButtonApplied: {
    background: "#e6f4ea",
    borderColor: "#86c79a",
    color: "#0a7d3e",
  },
  applyButtonUndone: {
    background: "#fff8e6",
    borderColor: "#e0c178",
    color: "#856404",
  },
  undoButton: {
    padding: "1px 6px",
    fontSize: 10,
    borderRadius: 3,
    border: "1px dashed #d4d4d4",
    background: "transparent",
    color: "#7a7a7a",
    cursor: "pointer",
    marginTop: 2,
  },
  applyMessage: { color: "#7a7a7a", fontSize: 11, marginTop: 2 },
  error: {
    padding: 8,
    borderRadius: 4,
    background: "#fef2f2",
    color: "#b91c1c",
    marginBottom: 12,
    whiteSpace: "pre-wrap",
  },
  section: { marginTop: 16 },
  h3: { fontSize: 13, margin: "0 0 8px", fontWeight: 600 },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    textAlign: "left",
    padding: "6px 8px",
    borderBottom: "1px solid #e5e5e5",
    fontWeight: 600,
    color: "#525252",
  },
  td: { padding: "6px 8px", borderBottom: "1px solid #f0f0f0", verticalAlign: "top" },
  muted: { color: "#7a7a7a", fontSize: 12 },
  modes: { color: "#7a7a7a", fontSize: 11, marginTop: 2 },
};

addons.register(ADDON_ID, () => {
  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: "Sync",
    match: ({ viewMode }) => viewMode === "story",
    render: ({ active }) => <Panel active={!!active} />,
  });
});
