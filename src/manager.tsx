import React, { useEffect, useState, useCallback } from "react";
import { addons, types, useArgs, useChannel, useParameter, useStorybookState } from "storybook/manager-api";
import {
  ADDON_ID,
  PANEL_ID,
  EVENTS,
  type CheckDriftRequestPayload,
  type DriftReportPayload,
  type DriftErrorPayload,
  type ProposedEdit,
} from "./channels.js";
import type { DriftReport, DimensionDiff } from "./dimensions/types.js";

interface PanelState {
  loading: boolean;
  report: DriftReport | null;
  error: string | null;
}

interface ApplyResult {
  status: "applied" | "rejected" | "needs_review" | "error" | "no_op" | "loading";
  message?: string;
  diff?: string;
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

/**
 * Build a pipeline Edit from a drift row + story context. Returns null if
 * the row isn't fixable via the pipeline today (e.g. dual-mode rows with
 * map-shaped values, or non-token-binding rows).
 */
function buildEdit(
  d: DimensionDiff,
  storyId: string,
  selector: string | undefined,
): Record<string, unknown> | null {
  if (d.kind !== "token-binding") return null;
  if (typeof d.codeValue !== "string" || typeof d.figmaValue !== "string") return null;
  if (!selector) return null;
  return {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${storyId}-${d.property}-${Date.now()}`,
    kind: "token-binding",
    scope: "code",
    target: { selector, property: d.property, storyId },
    oldValue: d.codeValue,
    newValue: d.figmaValue,
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

  const emit = useChannel({
    [EVENTS.DriftReport]: (payload: DriftReportPayload) => {
      setState({ loading: false, report: payload.report, error: null });
    },
    [EVENTS.DriftError]: (payload: DriftErrorPayload) => {
      setState({ loading: false, report: null, error: payload.message });
    },
    [EVENTS.ProposedEdit]: (edit: ProposedEdit) => {
      setEdits((prev) => [edit, ...prev].slice(0, 50));
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

  if (!active) return null;

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <button style={styles.button} onClick={onCheck} disabled={!storyId || state.loading}>
          {state.loading ? "Checking…" : "Check drift"}
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

      {state.error && <div style={styles.error}>{state.error}</div>}

      {state.report && (
        <DiffTable
          report={state.report}
          applyResults={applyResults}
          onApply={async (d, key) => {
            const edit = buildEdit(d, storyId ?? "", designSync.target);
            if (!edit) {
              setApplyResults((prev) => ({
                ...prev,
                [key]: { status: "rejected", message: "Row not auto-fixable (need token-binding + selector)." },
              }));
              return;
            }
            setApplyResults((prev) => ({ ...prev, [key]: { status: "loading" } }));
            const result = await postEdit(
              designSync.pipelineUrl ?? PIPELINE_DEFAULT_URL,
              edit,
            );
            setApplyResults((prev) => ({ ...prev, [key]: result }));
          }}
        />
      )}

      <StagedEdits edits={edits} />
    </div>
  );
};

interface DiffTableProps {
  report: DriftReport;
  applyResults: Record<string, ApplyResult>;
  onApply: (d: DimensionDiff, key: string) => void;
}

const DiffTable: React.FC<DiffTableProps> = ({ report, applyResults, onApply }) => (
  <div style={styles.section}>
    <h3 style={styles.h3}>
      Drift report{" "}
      <span style={styles.muted}>
        — node {report.nodeId}
        {report.mode ? ` · mode: ${report.mode}` : ""} · {new Date(report.generatedAt).toLocaleTimeString()}
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
              applyResult={applyResults[key]}
              onApply={() => onApply(d, key)}
            />
          );
        })}
      </tbody>
    </table>
  </div>
);

interface RowProps {
  d: DimensionDiff;
  applyResult: ApplyResult | undefined;
  onApply: () => void;
}

const Row: React.FC<RowProps> = ({ d, applyResult, onApply }) => {
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
          <button
            style={styles.applyButton}
            onClick={onApply}
            disabled={applyResult?.status === "loading"}
          >
            {applyResult?.status === "loading" ? "…" : applyResult?.status === "applied" ? "✓ applied" : "Apply"}
          </button>
        ) : (
          <span style={styles.muted}>—</span>
        )}
        {applyResult && applyResult.status !== "loading" && applyResult.status !== "applied" && (
          <div style={styles.applyMessage}>
            <code>{applyResult.status}</code>
            {applyResult.message && <div>{applyResult.message}</div>}
          </div>
        )}
      </td>
    </tr>
  );
};

const ValueCell: React.FC<{ value: unknown }> = ({ value }) => {
  if (value === null || value === undefined) return <span style={styles.muted}>—</span>;
  if (typeof value === "string") return <code>{value}</code>;
  return <code>{JSON.stringify(value)}</code>;
};

const StagedEdits: React.FC<{ edits: ProposedEdit[] }> = ({ edits }) => (
  <div style={styles.section}>
    <h3 style={styles.h3}>
      Staged edits (v1){" "}
      <span style={styles.muted} title="Subscribed to design-sync:proposedEdit. Read-only in v0; v1 will route these to engines.">
        ⓘ
      </span>
    </h3>
    {edits.length === 0 ? (
      <div style={styles.muted}>No proposed edits received on this channel yet.</div>
    ) : (
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Source</th>
            <th style={styles.th}>Kind</th>
            <th style={styles.th}>Scope</th>
            <th style={styles.th}>Property</th>
            <th style={styles.th}>Old → New</th>
            <th style={styles.th}>When</th>
          </tr>
        </thead>
        <tbody>
          {edits.map((e, i) => (
            <tr key={i}>
              <td style={styles.td}>{e.source}</td>
              <td style={styles.td}>{e.kind}</td>
              <td style={styles.td}>{e.scope}</td>
              <td style={styles.td}>
                <code>{e.property}</code>
              </td>
              <td style={styles.td}>
                <code>{e.oldValue}</code> → <code>{e.newValue}</code>
                {e.modes && (
                  <div style={styles.modes}>
                    light: {e.modes.light} · dark: {e.modes.dark}
                  </div>
                )}
              </td>
              <td style={styles.td}>{new Date(e.timestamp).toLocaleTimeString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
);

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
  checkboxLabel: { display: "flex", alignItems: "center", gap: 4, color: "#525252", fontSize: 12 },
  applyButton: {
    padding: "2px 8px",
    fontSize: 11,
    borderRadius: 3,
    border: "1px solid #d4d4d4",
    background: "#fff",
    cursor: "pointer",
  },
  applyMessage: { color: "#7a7a7a", fontSize: 11, marginTop: 4 },
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
