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
  type ApplyCodeResultPayload,
  type ConfigInfoPayload,
} from "./channels.js";
import type { DriftReport, DimensionDiff } from "./dimensions/types.js";
import {
  type GroupedRow,
  flattenDualModeValue,
  tokenRowFixability,
  partitionRow,
  explainInfo,
  applyControlsEnabled,
  rowHasDrift,
  stagedEditsVisible,
  rowHasAnyValue,
} from "./row-triage.js";
import { buildFixPrompt } from "./fix-prompt.js";

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
  /** Full drift report from the engine — kept so the bulk Export action
   *  can build a per-property markdown / JSON dump without re-running. */
  report?: DriftReport;
}

interface BulkState {
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  rows: BulkRow[];
  apply?: BulkApplyState;
}

/** Live state for an "Apply all fixable" run launched from the bulk summary. */
interface BulkApplyState {
  running: boolean;
  /** True when the run is in preview mode (pipeline returns diffs, doesn't
   *  write). First-touch is always dry-run; "Apply for real" sets this false. */
  dryRun: boolean;
  total: number;
  applied: number;
  /** Pipeline returned no_op (already-applied or refused-as-safe). */
  skipped: number;
  /** The drift row exists but the addon can't build an Edit for it (variant-set,
   *  copy, props, etc. — kinds outside `token-binding`/`token-value`). Counted
   *  separately so users see how much of the "fix" actually fixes. */
  notFixable: number;
  errored: number;
  /** storyId currently being processed (for inline progress UI). */
  current?: string;
  finishedAt?: number;
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
 * One-time-per-story deprecation warning for the legacy
 * `parameters.designSync.tokens` story param. Token bindings are now
 * derived from CSS by the preset's scanner; the param is kept as a
 * fallback for a single release before removal.
 */
const tokensDeprecationWarned = new Set<string>();
function warnTokensDeprecated(storyId: string): void {
  if (tokensDeprecationWarned.has(storyId)) return;
  tokensDeprecationWarned.add(storyId);
  // eslint-disable-next-line no-console
  console.warn(
    `[design-sync] ${storyId}: parameters.designSync.tokens is deprecated. ` +
      "Bindings are now derived from your CSS — you can remove the `tokens` " +
      "block. CSS-derived bindings take precedence where they exist.",
  );
}

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

// flattenDualModeValue / tokenRowFixability / partitionRow / explainInfo
// live in ./row-triage.ts (pure, unit-tested) — imported above.

/**
 * Build a pipeline Edit from a drift row + story context. The scope
 * decides which side wins on this drift:
 *
 *   - scope=code   → "code is wrong, change code to match Figma" (oldValue=code, newValue=figma)
 *   - scope=figma  → "Figma is wrong, change Figma to match code" (oldValue=figma, newValue=code).
 *                    Requires `nodeId` (passed in) and is processed by the
 *                    Figma plugin worker via the pipeline's queue.
 *
 * Dual-mode rows (codeValue/figmaValue are `{light, dark}` maps) are
 * flattened when both modes agree on each side. If they disagree, the
 * row needs per-mode handling which is deferred to a future PR; we
 * return null with a sentinel that the caller surfaces as a message.
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
  if (d.kind !== "token-binding" && d.kind !== "token-value" && d.kind !== "copy") return null;
  const codeFlat = flattenDualModeValue(d.codeValue);
  const figmaFlat = flattenDualModeValue(d.figmaValue);

  // Copy edits don't go through the selector → property → token machinery;
  // they target the JSX text child (code) or the TEXT descendant
  // (figma) directly. Handled with its own envelope: storyId routes the
  // code engine, nodeId routes the plugin.
  if (d.kind === "copy") {
    if (codeFlat === null || figmaFlat === null) return null;
    if (scope === "figma" && !nodeId) return null;
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${storyId}-copy-${Date.now()}`;
    const base = {
      id,
      kind: "copy" as const,
      source: "storybook-design-sync",
      timestamp: new Date().toISOString(),
    };
    if (scope === "code") {
      return {
        ...base,
        scope: "code",
        target: { property: "text", storyId },
        oldValue: codeFlat,
        newValue: figmaFlat,
      };
    }
    return {
      ...base,
      scope: "figma",
      target: { nodeId, property: "text", storyId },
      oldValue: figmaFlat,
      newValue: codeFlat,
      confirm: true,
    };
  }
  // `selector` is required by the pipeline's `code-css-postcss` engine
  // (it scopes the rewrite to a CSS rule). The `code-tsx-inline` engine
  // doesn't need it — it walks `codeTargets` and matches JSX attribute
  // name + property. We let the edit through either way and let the
  // pipeline's engines decide; engines that need a selector and don't
  // get one will reject with a clear message, which is more useful than
  // the addon silently classifying every inline-styled story as
  // "not auto-fixable."
  if (scope === "figma" && !nodeId) return null;

  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${storyId}-${d.property}-${Date.now()}`;

  // token-value, code: rewrite the raw literal in CSS to `var(--token)` using
  // the Figma-side token name from the diff. The engine's swap looks for
  // <property>: <oldValue>; in the rule body and replaces with
  // <property>: var(--<token>);. Skip if we don't have a token name.
  if (d.kind === "token-value" && scope === "code") {
    if (!d.tokenName || codeFlat === null) return null;
    return {
      id,
      kind: "token-value",
      scope: "code",
      target: { selector, property: d.property, storyId },
      oldValue: codeFlat,
      newValue: d.tokenName,
      source: "storybook-design-sync",
      timestamp: new Date().toISOString(),
    };
  }

  if (codeFlat === null || figmaFlat === null) return null;

  if (scope === "code") {
    return {
      id,
      kind: d.kind,
      scope: "code",
      target: { selector, property: d.property, storyId },
      oldValue: codeFlat,
      newValue: figmaFlat,
      source: "storybook-design-sync",
      timestamp: new Date().toISOString(),
    };
  }
  return {
    id,
    kind: d.kind,
    scope: "figma",
    target: { nodeId, property: d.property, storyId },
    oldValue: figmaFlat,
    newValue: codeFlat,
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
  // Addon config surface (apply gating, fileKey, codeTarget paths) relayed
  // by the server on mount. Null until the reply lands — treated as
  // apply:"off" (read-only) so write controls never flash on before the
  // config is known.
  const [configInfo, setConfigInfo] = useState<ConfigInfoPayload | null>(null);
  // Registry load/parse failure from a Check-all — rendered as a banner
  // instead of pretending the registry is empty.
  const [registryError, setRegistryError] = useState<string | null>(null);
  const sbApi = useStorybookApi();
  const pendingResolversRef = useRef<{
    resolve: (report: DriftReport) => void;
    reject: (err: string) => void;
    storyId: string;
  } | null>(null);
  // Code-scope applies are async channel round-trips to the addon server
  // (P1.4); correlate each reply to its request by edit id.
  const pendingApplyRef = useRef<Map<string, (r: ApplyResult) => void>>(new Map());

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
    [EVENTS.ApplyCodeResult]: (payload: ApplyCodeResultPayload) => {
      const { result } = payload;
      const resolve = pendingApplyRef.current.get(result.id);
      if (resolve) {
        pendingApplyRef.current.delete(result.id);
        const mapped: ApplyResult = { status: result.status };
        if (result.message !== undefined) mapped.message = result.message;
        if (result.diff !== undefined) mapped.diff = result.diff;
        resolve(mapped);
      }
    },
    [EVENTS.ProposedEdit]: (edit: ProposedEdit) => {
      setEdits((prev) => [edit, ...prev].slice(0, 50));
    },
    [EVENTS.ConfigInfo]: (payload: ConfigInfoPayload) => {
      setConfigInfo(payload);
    },
    [EVENTS.RegisteredStories]: (payload: RegisteredStoriesPayload) => {
      if (payload.error) {
        setRegistryError(payload.error);
        setBulk(null);
        return;
      }
      setRegistryError(null);
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

  // Route an edit to the right applier: code-scope goes in-process to the
  // addon server over the channel (P1.4 — no pipeline binary needed);
  // figma-scope still POSTs to the pipeline (Variables REST write + plugin
  // queue). Both resolve to an ApplyResult the panel renders inline.
  const applyEdit = useCallback(
    (edit: Record<string, unknown>): Promise<ApplyResult> => {
      if (edit.scope === "code") {
        const id = typeof edit.id === "string" ? edit.id : crypto.randomUUID();
        edit.id = id;
        return new Promise<ApplyResult>((resolve) => {
          const timer = setTimeout(() => {
            pendingApplyRef.current.delete(id);
            resolve({
              status: "error",
              message:
                "Timed out waiting for the addon server to apply the edit. Is Storybook's dev server running?",
            });
          }, 15000);
          pendingApplyRef.current.set(id, (r) => {
            clearTimeout(timer);
            resolve(r);
          });
          emit(EVENTS.ApplyCodeRequest, { edit });
        });
      }
      return postEdit(designSync.pipelineUrl ?? PIPELINE_DEFAULT_URL, edit);
    },
    [emit, designSync.pipelineUrl],
  );

  // Reset when the story changes.
  useEffect(() => {
    setState(initialState);
  }, [storyId]);

  // Ask the server for the config surface (apply gating, fileKey,
  // codeTarget paths) once the channel is up.
  useEffect(() => {
    emit(EVENTS.ConfigRequest);
  }, [emit]);

  const applyEnabled = applyControlsEnabled(configInfo?.apply);

  const onCheck = useCallback(() => {
    if (!storyId) return;
    setState({ loading: true, report: null, error: null });
    const payload: CheckDriftRequestPayload = { storyId };
    if (designSync.target) payload.target = designSync.target;
    if (designSync.tokens) {
      payload.tokens = designSync.tokens;
      warnTokensDeprecated(storyId);
    }
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
        const report = await checkOneStory(entry.storyId, sbApi, emit, pendingResolversRef, { dualMode });
        const counts = countRows(report);
        const durationMs = Date.now() - t0;
        setBulk((prev) =>
          prev
            ? {
                ...prev,
                rows: prev.rows.map((r, j) =>
                  j === i
                    ? { ...r, status: "done", durationMs, match: counts.match, drift: counts.drift, flagOnly: counts.flagOnly, report }
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
  }, [emit, sbApi, dualMode]);

  const onCheckAll = useCallback(() => {
    setBulk(null);
    setRegistryError(null);
    emit(EVENTS.ListRegisteredRequest);
  }, [emit]);

  /**
   * Apply every fixable code-side drift across the bulk run. Iterates each
   * row's report, builds a `code` edit per drift dimension via the same
   * `buildEdit` path the per-row Apply buttons use, and posts through the
   * pipeline so it goes through the addon's tested PostCSS write engine
   * (token-name normalization, undo-stack, etc.).
   *
   * Code-side only by default — Figma is shared state; users opt into
   * Figma writes per-row.
   *
   * Each story's `designSync.target` selector is read from
   * `sbApi.getStoryData(storyId)?.parameters` — populated because bulk
   * Check all navigated to every story before snapshotting.
   */
  const onApplyAll = useCallback(async (opts: { dryRun: boolean }) => {
    setBulk((prev) => {
      if (!prev) return prev;
      const drifted = prev.rows.filter((r) => r.report && r.drift > 0);
      const total = drifted.reduce(
        (acc, r) => acc + (r.report?.dimensions.filter((d) => d.status === "drift").length ?? 0),
        0,
      );
      return {
        ...prev,
        apply: {
          running: true,
          dryRun: opts.dryRun,
          total,
          applied: 0,
          skipped: 0,
          notFixable: 0,
          errored: 0,
        },
      };
    });

    // Snapshot the rows we want to act on so subsequent setBulk calls
    // (which run in event-loop order) don't race the apply loop.
    const rows = (bulk?.rows ?? []).filter((r) => r.report && r.drift > 0);

    for (const row of rows) {
      const report = row.report!;
      const storyData = sbApi?.getStoryData?.(row.storyId);
      const storyParams =
        (storyData?.parameters as { designSync?: { target?: string; pipelineUrl?: string } } | undefined)
          ?.designSync ?? {};
      const selector = storyParams.target;
      const pipelineUrl = storyParams.pipelineUrl ?? PIPELINE_DEFAULT_URL;

      for (const d of visibleDimensions(report)) {
        if (d.status !== "drift") continue;
        setBulk((prev) => (prev?.apply ? { ...prev, apply: { ...prev.apply, current: row.storyId } } : prev));

        const edit = buildEdit(d, row.storyId, selector, "code", report.nodeId);
        if (!edit) {
          // Row exists but addon has no Edit-shape for this dimension kind
          // (variant-set, copy, props, etc.). Surface separately so the
          // summary tells the user how much of the drift was actually
          // addressable, not just lump it into "skipped".
          setBulk((prev) =>
            prev?.apply ? { ...prev, apply: { ...prev.apply, notFixable: prev.apply.notFixable + 1 } } : prev,
          );
          continue;
        }
        if (opts.dryRun) edit.dryRun = true;
        try {
          const result = await postEdit(pipelineUrl, edit);
          if (result.status === "applied") {
            setBulk((prev) =>
              prev?.apply ? { ...prev, apply: { ...prev.apply, applied: prev.apply.applied + 1 } } : prev,
            );
          } else if (result.status === "no_op") {
            setBulk((prev) =>
              prev?.apply ? { ...prev, apply: { ...prev.apply, skipped: prev.apply.skipped + 1 } } : prev,
            );
          } else {
            setBulk((prev) =>
              prev?.apply ? { ...prev, apply: { ...prev.apply, errored: prev.apply.errored + 1 } } : prev,
            );
          }
        } catch {
          setBulk((prev) =>
            prev?.apply ? { ...prev, apply: { ...prev.apply, errored: prev.apply.errored + 1 } } : prev,
          );
        }
      }
    }

    setBulk((prev) => {
      if (!prev?.apply) return prev;
      const { current: _drop, ...rest } = prev.apply;
      void _drop;
      return { ...prev, apply: { ...rest, running: false, finishedAt: Date.now() } };
    });
  }, [bulk, sbApi]);

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

      {configInfo?.error && (
        <div style={styles.error}>
          Configuration error: {configInfo.error}
        </div>
      )}
      {registryError && (
        <div style={styles.error}>
          Registry error: {registryError}
        </div>
      )}

      {bulk && (
        <BulkSummary
          bulk={bulk}
          applyEnabled={applyEnabled}
          onSelect={(id) => sbApi?.selectStory(id)}
          onPreviewAll={() => onApplyAll({ dryRun: true })}
          onApplyAllForReal={() => onApplyAll({ dryRun: false })}
        />
      )}

      {state.error && <div style={styles.error}>{state.error}</div>}

      {state.report && (
        <DiffTable
          report={state.report}
          applyEnabled={applyEnabled}
          fixContext={{
            selector: designSync.target,
            filePaths: configInfo?.codeTargetPaths,
            fileKey: configInfo?.fileKey,
          }}
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
            const result = await applyEdit(edit);
            // On success, stash the inverse edit so the row can offer Undo.
            if (result.status === "applied") {
              result.inverse = inverseEdit(edit);
            }
            setApplyResults((prev) => ({ ...prev, [key + ":" + scope]: result }));

            // Auto-recheck after a successful write — the drift snapshot is
            // a moment-in-time read, and the side we just modified is now
            // ahead of it. Re-running puts the panel back in sync with the
            // file and Figma, so subsequent Update <other side> clicks
            // operate on fresh data instead of stale token names.
            //
            // Code-side edits race Vite's HMR: pipeline writes the file,
            // but the iframe hasn't yet been pushed the new module + re-
            // rendered when we snapshot. Wait a beat so the DOM reflects
            // the write. Figma-side edits skip the wait — the next REST
            // fetch reads the latest directly. 800ms is empirically enough
            // for a single-file rewrite + React re-render; we deliberately
            // don't try to listen for an HMR signal (would require Vite-
            // specific plumbing across the addon/preview boundary).
            if (result.status === "applied") {
              if (scope === "code") {
                setTimeout(() => onCheck(), 800);
              } else {
                onCheck();
              }
            }
          }}
          onUndo={async (key, scope, inverse) => {
            setApplyResults((prev) => ({ ...prev, [key + ":" + scope]: { status: "loading" } }));
            const result = await applyEdit(inverse);
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

      {/* Staged edits are the write surface for sibling-addon proposals —
          hidden entirely (not just their buttons) unless writes are
          explicitly enabled. Gating logic lives in row-triage.ts so it's
          unit-testable. */}
      {stagedEditsVisible(configInfo?.apply) && (
        <StagedEdits
          edits={edits}
          applyEnabled={applyEnabled}
          applyResults={applyResults}
          pipelineUrl={designSync.pipelineUrl ?? PIPELINE_DEFAULT_URL}
          target={designSync.target}
          onResult={(key, result) =>
            setApplyResults((prev) => ({ ...prev, [key]: result }))
          }
        />
      )}
    </div>
  );
};

/** Context threaded into per-row fix prompts (see fix-prompt.ts). */
interface FixContext {
  selector?: string | undefined;
  filePaths?: string[] | undefined;
  fileKey?: string | undefined;
}

interface DiffTableProps {
  report: DriftReport;
  /** v1 write gating — when false, no Apply buttons render anywhere. */
  applyEnabled: boolean;
  fixContext: FixContext;
  applyResults: Record<string, ApplyResult>;
  onApply: (d: DimensionDiff, key: string, scope: ApplyScope) => void;
  onUndo: (key: string, scope: ApplyScope, inverse: Record<string, unknown>) => void;
}

/**
 * Dimensions the diff engine still emits as placeholders but the UI
 * deliberately hides — they have no payload, no engine, and no near-term
 * roadmap engine. Kept in the engine so future work has a single place
 * to wire real comparison logic into; removed from this set the moment
 * an engine starts producing meaningful data. Don't delete the engine
 * code that emits these; just edit this set.
 */
const HIDDEN_DIMENSION_KINDS = new Set<DimensionDiff["kind"]>([
  "structure",
  "motion",
]);

/**
 * Apply the hidden-kinds filter at every consumer of `report.dimensions`
 * (table render, bulk apply, summary counts, markdown/json exports). Going
 * through this one helper means turning a dimension back on is a one-line
 * change to `HIDDEN_DIMENSION_KINDS` rather than a hunt across the file.
 */
function visibleDimensions(report: DriftReport): DimensionDiff[] {
  return report.dimensions.filter((d) => !HIDDEN_DIMENSION_KINDS.has(d.kind));
}

const DiffTable: React.FC<DiffTableProps> = ({ report, applyEnabled, fixContext, applyResults, onApply, onUndo }) => {
  // Rows with neither a code value nor a Figma value carry no information
  // (all em-dashes) — drop them from the table entirely.
  const grouped = groupDimensions(visibleDimensions(report)).filter(rowHasAnyValue);
  const mainRows = grouped.filter((r) => partitionRow(r) === "main");
  const infoRows = grouped.filter((r) => partitionRow(r) === "info");

  // Build the self-contained fix prompt for a drift row. Shared by both
  // apply modes — auditing without writes still hands you the fix.
  const promptFor = (d: DimensionDiff): string =>
    buildFixPrompt({
      storyId: report.storyId,
      kind: d.kind,
      property: d.property,
      codeValue: d.codeValue,
      figmaValue: d.figmaValue,
      tokenName: d.tokenName,
      selector: fixContext.selector,
      filePaths: fixContext.filePaths,
      nodeId: report.nodeId,
      fileKey: fixContext.fileKey,
      note: d.note,
    });

  const renderRow = (row: GroupedRow, i: number, fixable: boolean) => {
    if (row.kind === "token") {
      const key = `token-${row.property}-${i}`;
      return (
        <TokenRow
          key={key}
          rowKey={key}
          property={row.property}
          value={row.value}
          binding={row.binding}
          applyEnabled={applyEnabled}
          promptFor={promptFor}
          applyResults={applyResults}
          onApply={onApply}
          onUndo={onUndo}
        />
      );
    }
    const d = row.diff;
    const key = `${d.kind}-${d.property}-${i}`;
    return (
      <OtherRow
        key={key}
        d={d}
        fixable={fixable}
        applyEnabled={applyEnabled}
        {...(fixable ? {} : { infoNote: explainInfo(row) })}
        promptFor={promptFor}
        codeResult={applyResults[`${key}:code`]}
        figmaResult={applyResults[`${key}:figma`]}
        onApply={(scope) => onApply(d, key, scope)}
        onUndo={(scope, inverse) => onUndo(key, scope, inverse)}
      />
    );
  };

  return (
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
      <div style={styles.legend}>
        <span>
          <strong>Value</strong> — does it look right today (px, color match)?
        </span>
      </div>

      {mainRows.length > 0 && (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Property</th>
              <th style={styles.th}>Code</th>
              <th style={styles.th}>Figma</th>
              <th style={styles.th}>Value</th>
              <th style={styles.th}>
                {applyEnabled ? (
                  <>
                    Apply <span style={styles.experimentalBadge}>experimental</span>
                  </>
                ) : (
                  "Fix"
                )}
              </th>
            </tr>
          </thead>
          <tbody>{mainRows.map((row, i) => renderRow(row, i, true))}</tbody>
        </table>
      )}

      {infoRows.length > 0 && (
        <details style={styles.infoDetails}>
          <summary style={styles.infoSummary}>
            Detected drift — manual fix ({infoRows.length})
            <span style={styles.muted}>
              {" "}— shown for context; the addon has no automated apply path for these.
            </span>
          </summary>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Property</th>
                <th style={styles.th}>Code</th>
                <th style={styles.th}>Figma</th>
                <th style={styles.th}>Value</th>
                <th style={styles.th}>{applyEnabled ? "Why no Apply" : "Notes"}</th>
              </tr>
            </thead>
            <tbody>{infoRows.map((row, i) => renderRow(row, i, false))}</tbody>
          </table>
        </details>
      )}
    </div>
  );
};

function groupDimensions(diffs: DimensionDiff[]): GroupedRow[] {
  const indexByProp = new Map<string, number>();
  const rows: GroupedRow[] = [];
  for (const d of diffs) {
    if (d.kind === "token-value" || d.kind === "token-binding") {
      let idx = indexByProp.get(d.property);
      if (idx === undefined) {
        idx = rows.length;
        indexByProp.set(d.property, idx);
        rows.push({ kind: "token", property: d.property });
      }
      const row = rows[idx] as Extract<GroupedRow, { kind: "token" }>;
      if (d.kind === "token-value") row.value = d;
      else row.binding = d;
    } else {
      rows.push({ kind: "other", diff: d });
    }
  }
  return rows;
}

const STATUS_LABEL: Record<DimensionDiff["status"], string> = {
  match: "match",
  drift: "drift",
  "flag-only": "needs setup",
};

const StatusPill: React.FC<{ status: DimensionDiff["status"] | undefined; title: string | undefined }> = ({ status, title }) => {
  if (!status) return <span style={styles.muted}>—</span>;
  const props: { title?: string } = {};
  if (title) props.title = title;
  return (
    <span style={{ ...styles.pill, ...statusStyle(status) }} {...props}>
      {STATUS_LABEL[status]}
    </span>
  );
};

interface TokenRowProps {
  rowKey: string;
  property: string;
  value: DimensionDiff | undefined;
  binding: DimensionDiff | undefined;
  applyEnabled: boolean;
  promptFor: (d: DimensionDiff) => string;
  applyResults: Record<string, ApplyResult>;
  onApply: (d: DimensionDiff, key: string, scope: ApplyScope) => void;
  onUndo: (key: string, scope: ApplyScope, inverse: Record<string, unknown>) => void;
}

const TokenRow: React.FC<TokenRowProps> = ({ rowKey, property, value, binding, applyEnabled, promptFor, applyResults, onApply, onUndo }) => {
  // Prefer value diff for the Code/Figma cells (concrete px/rgb is more
  // useful than a token name); fall back to binding if value is absent.
  const display = value ?? binding;
  const codeShown = display?.codeValue ?? null;
  const figmaShown = display?.figmaValue ?? null;
  const modes = display?.modes;

  const { bindingFixable, valueFixable } = tokenRowFixability(value, binding);
  const valueTokenName = value?.tokenName ?? null;

  const valueTitle = value
    ? value.status === "match"
      ? `Code and Figma both resolve to ${stringifyValue(value.figmaValue)}.`
      : value.status === "drift"
      ? `Code resolves to ${stringifyValue(value.codeValue)}, Figma to ${stringifyValue(value.figmaValue)}.`
      : value.note
    : undefined;

  return (
    <tr>
      <td style={styles.td}>{property}</td>
      <td style={styles.td}>
        <ValueCell value={codeShown} />
      </td>
      <td style={styles.td}>
        <ValueCell value={figmaShown} />
        {modes && (
          <div style={styles.modes}>
            light: {modes.light} · dark: {modes.dark}
          </div>
        )}
      </td>
      <td style={styles.td}>
        <StatusPill status={value?.status} title={valueTitle} />
      </td>
      <td style={styles.td}>
        {applyEnabled && bindingFixable && binding ? (
          <div style={styles.applyButtons}>
            <ApplyButton
              label="Update code"
              scope="code"
              result={applyResults[`${rowKey}:code`]}
              onClick={() => onApply(binding, rowKey, "code")}
              onUndo={(inverse) => onUndo(rowKey, "code", inverse)}
              title={`Write ${stringifyValue(binding.figmaValue)} to code (Figma value wins)`}
            />
            <ApplyButton
              label="Update Figma"
              scope="figma"
              result={applyResults[`${rowKey}:figma`]}
              onClick={() => onApply(binding, rowKey, "figma")}
              onUndo={(inverse) => onUndo(rowKey, "figma", inverse)}
              title={`Write ${stringifyValue(binding.codeValue)} to Figma (code value wins)`}
            />
          </div>
        ) : applyEnabled && valueFixable && value ? (
          <div style={styles.applyButtons}>
            <ApplyButton
              label="Use token"
              scope="code"
              result={applyResults[`${rowKey}:code`]}
              onClick={() => onApply(value, rowKey, "code")}
              onUndo={(inverse) => onUndo(rowKey, "code", inverse)}
              title={`Replace ${stringifyValue(value.codeValue)} with var(--${valueTokenName}) in CSS`}
            />
          </div>
        ) : null}
        {rowHasDrift({ kind: "token", property, ...(value !== undefined ? { value } : {}), ...(binding !== undefined ? { binding } : {}) }) ? (
          // Prefer the drifted value diff (it carries tokenName); fall back
          // to the binding diff. `display` is never undefined here — drift
          // implies at least one of the two exists.
          <CopyFixPromptButton
            getText={() => promptFor(value?.status === "drift" ? value : (binding ?? value)!)}
          />
        ) : (
          <span style={styles.muted}>—</span>
        )}
      </td>
    </tr>
  );
};

interface OtherRowProps {
  d: DimensionDiff;
  /**
   * Whether the addon's Apply path can act on this diff. When false, the
   * Apply column renders an explanatory note instead of buttons that
   * would always reject (see CLAUDE.md anti-pattern #3 / "honest Apply").
   */
  fixable: boolean;
  /** v1 write gating — when false, no Apply buttons render even on fixable rows. */
  applyEnabled: boolean;
  /** Human-readable reason shown in the Apply column when `fixable` is false. */
  infoNote?: string;
  promptFor: (d: DimensionDiff) => string;
  codeResult: ApplyResult | undefined;
  figmaResult: ApplyResult | undefined;
  onApply: (scope: ApplyScope) => void;
  onUndo: (scope: ApplyScope, inverse: Record<string, unknown>) => void;
}

const OtherRow: React.FC<OtherRowProps> = ({ d, fixable, applyEnabled, infoNote, promptFor, codeResult, figmaResult, onApply, onUndo }) => {
  return (
    <tr>
      <td style={styles.td}>
        {d.property}
        <div style={styles.muted}>{d.kind}</div>
      </td>
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
      <td style={styles.td}>
        <StatusPill status={d.status} title={d.note} />
        {d.note && <div style={styles.muted}>{d.note}</div>}
      </td>
      <td style={styles.td}>
        {fixable && applyEnabled && (
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
        )}
        {!fixable && (
          <div style={styles.muted} title={infoNote}>{infoNote ?? "Manual fix only."}</div>
        )}
        {d.status === "drift" && <CopyFixPromptButton getText={() => promptFor(d)} />}
        {fixable && !applyEnabled && d.status !== "drift" && <span style={styles.muted}>—</span>}
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
 * Copy text to the clipboard: async Clipboard API first, hidden-textarea
 * `document.execCommand("copy")` fallback for restricted contexts (the
 * manager iframe doesn't always get clipboard-write permission).
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Per-row "Copy fix prompt" — copies a self-contained prompt (see
 * fix-prompt.ts) that a coding agent can act on without any other context.
 * Rendered on every drift row in BOTH apply modes: it's the audit-only
 * story's path from "found it" to "fixed it".
 */
const CopyFixPromptButton: React.FC<{ getText: () => string }> = ({ getText }) => {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const onClick = async (): Promise<void> => {
    const ok = await copyTextToClipboard(getText());
    setStatus(ok ? "copied" : "failed");
    setTimeout(() => setStatus("idle"), 2000);
  };
  return (
    <button
      style={{ ...styles.copyPromptButton, ...(status === "copied" ? styles.applyButtonApplied : {}) }}
      onClick={() => void onClick()}
      title="Copy a self-contained prompt describing this drift, ready to paste to a coding agent"
    >
      {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : "Copy fix prompt"}
    </button>
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
  opts: { dualMode?: boolean } = {},
): Promise<DriftReport> {
  return new Promise<DriftReport>((resolve, reject) => {
    if (!sbApi) {
      reject("Storybook API unavailable");
      return;
    }
    // Dual-mode runs take ~2× as long (two snapshots + two engine passes).
    // Bump the per-story timeout so bulk dual-mode runs don't false-time-out.
    const timeoutMs = opts.dualMode ? 16000 : 8000;
    const timeout = setTimeout(() => {
      pendingRef.current = null;
      reject(`Timed out (>${Math.round(timeoutMs / 1000)}s) on ${storyId}`);
    }, timeoutMs);

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
      if (opts.dualMode) payload.dualMode = true;
      emit(EVENTS.CheckDriftRequest, payload);
    };
    channel.on(STORY_RENDERED_EVENT, onRendered);

    sbApi.selectStory(storyId);
  });
}

function countRows(report: DriftReport): { match: number; drift: number; flagOnly: number } {
  const counts = { match: 0, drift: 0, flagOnly: 0 };
  for (const d of visibleDimensions(report)) {
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
  /** v1 write gating — when false, staged edits are display-only. */
  applyEnabled: boolean;
  applyResults: Record<string, ApplyResult>;
  pipelineUrl: string;
  target: string | undefined;
  onResult: (key: string, result: ApplyResult) => void;
}

const StagedEdits: React.FC<StagedEditsProps> = ({ edits, applyEnabled, applyResults, pipelineUrl, target, onResult }) => {
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
                  {applyEnabled ? (
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
                  ) : (
                    <span
                      style={styles.muted}
                      title='Writes are disabled (apply: "off" — the v1 default). Set apply: "experimental" in design-sync.config.json to enable.'
                    >
                      apply off
                    </span>
                  )}
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
  /** v1 write gating — when false, Preview-all / Apply-for-real are hidden. */
  applyEnabled: boolean;
  onSelect: (storyId: string) => void;
  /** First-touch: dry-run only. Pipeline returns diffs without writing. */
  onPreviewAll: () => void;
  /** Real writes. Should only be offered after a successful preview run. */
  onApplyAllForReal: () => void;
}

const BulkSummary: React.FC<BulkSummaryProps> = ({
  bulk,
  applyEnabled,
  onSelect,
  onPreviewAll,
  onApplyAllForReal,
}) => {
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
  const exportable = bulk.rows.some((r) => r.report);
  const exportDisabled = bulk.running || !exportable;
  const [copied, setCopied] = React.useState<"markdown" | "json" | null>(null);

  const onExport = async (format: "markdown" | "json"): Promise<void> => {
    const payload =
      format === "markdown" ? buildMarkdownReport(bulk) : buildJsonReport(bulk);
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(format);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard write can fail in restricted contexts; fall back to a
      // download so the user still gets the artifact.
      const blob = new Blob([payload], {
        type: format === "markdown" ? "text/markdown" : "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `drift-report-${new Date().toISOString().replace(/[:.]/g, "-")}.${
        format === "markdown" ? "md" : "json"
      }`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

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
        <span style={{ marginLeft: 12, display: "inline-flex", gap: 6 }}>
          <button
            style={styles.button}
            disabled={exportDisabled}
            onClick={() => onExport("markdown")}
            title="Copy a Markdown drift summary for sharing or review"
          >
            {copied === "markdown" ? "Copied!" : "Export markdown"}
          </button>
          <button
            style={styles.button}
            disabled={exportDisabled}
            onClick={() => onExport("json")}
            title="Copy the full DriftReport JSON for tooling / automation"
          >
            {copied === "json" ? "Copied!" : "Export JSON"}
          </button>
          {/* Bulk write controls are gated behind `apply: "experimental"`
              (v1 is audit-only by default). */}
          {applyEnabled && (
            <>
              <button
                style={styles.button}
                disabled={
                  bulk.running ||
                  bulk.apply?.running ||
                  !bulk.rows.some((r) => r.drift > 0)
                }
                onClick={onPreviewAll}
                title="Run every fixable code-side drift through the pipeline in dry-run — no files are written"
              >
                {bulk.apply?.running && bulk.apply.dryRun
                  ? `Previewing… (${bulk.apply.applied + bulk.apply.skipped + bulk.apply.notFixable + bulk.apply.errored}/${bulk.apply.total})`
                  : "Preview all (dry-run)"}
              </button>
              {/* Apply for real only appears after a successful preview, mirroring
                  the project's read-only-by-default principle (pipeline and
                  figma-plugin both default to dry-run). Disabled while another
                  run is in flight. */}
              {bulk.apply && !bulk.apply.running && bulk.apply.dryRun && bulk.apply.applied > 0 && (
                <button
                  style={{ ...styles.button, borderColor: "#b91c1c", color: "#b91c1c" }}
                  onClick={onApplyAllForReal}
                  title="Run for real — files will be written through the pipeline"
                >
                  Apply for real ({bulk.apply.applied})
                </button>
              )}
              {bulk.apply?.running && !bulk.apply.dryRun && (
                <button style={styles.button} disabled>
                  Applying… ({bulk.apply.applied + bulk.apply.skipped + bulk.apply.notFixable + bulk.apply.errored}/{bulk.apply.total})
                </button>
              )}
              <span style={styles.experimentalBadge}>experimental</span>
            </>
          )}
        </span>
      </h3>
      {bulk.apply && !bulk.apply.running && bulk.apply.finishedAt && (
        <div style={{ ...styles.muted, marginBottom: 8 }}>
          {bulk.apply.dryRun ? "Dry-run finished" : "Apply finished"} —{" "}
          <span style={{ color: "#0a7d3e" }}>
            {bulk.apply.applied} {bulk.apply.dryRun ? "would change" : "applied"}
          </span>
          {" · "}
          <span style={{ color: "#7a7a7a" }}>{bulk.apply.skipped} no-op</span>
          {" · "}
          <span style={{ color: "#7a7a7a" }}>{bulk.apply.notFixable} not auto-fixable</span>
          {" · "}
          <span style={{ color: bulk.apply.errored > 0 ? "#b91c1c" : "#7a7a7a" }}>
            {bulk.apply.errored} errored
          </span>
          {!bulk.apply.dryRun && bulk.apply.applied > 0 && " · Re-run Check all to refresh the summary."}
        </div>
      )}
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

/**
 * Build a Markdown drift report for a bulk-check run. Skips `match` rows
 * (they're noise), groups by story, and highlights drift before flag-only.
 *
 * Format chosen so the artifact reads cleanly in a PR description, can be
 * pasted into a chat, and remains greppable.
 */
function buildMarkdownReport(bulk: BulkState): string {
  const lines: string[] = [];
  const generated = new Date(bulk.startedAt).toISOString();
  const totals = bulk.rows.reduce(
    (acc, r) => ({
      match: acc.match + r.match,
      drift: acc.drift + r.drift,
      flagOnly: acc.flagOnly + r.flagOnly,
    }),
    { match: 0, drift: 0, flagOnly: 0 },
  );
  lines.push(`# Design-sync drift report`);
  lines.push("");
  lines.push(`Generated: ${generated}`);
  lines.push(
    `Stories: ${bulk.rows.length} · Drift: ${totals.drift} · Flag-only: ${totals.flagOnly} · Match: ${totals.match}`,
  );
  lines.push("");

  const driftedStories = bulk.rows.filter((r) => r.drift > 0);
  const flaggedStories = bulk.rows.filter((r) => r.drift === 0 && r.flagOnly > 0);
  const errorStories = bulk.rows.filter((r) => r.status === "error");

  if (driftedStories.length === 0 && flaggedStories.length === 0 && errorStories.length === 0) {
    lines.push(`No drift detected.`);
    return lines.join("\n");
  }

  if (driftedStories.length > 0) {
    lines.push(`## Drift`);
    lines.push("");
    for (const row of driftedStories) {
      renderStorySection(lines, row, ["drift"]);
    }
  }
  if (flaggedStories.length > 0) {
    lines.push(`## Flag-only (review)`);
    lines.push("");
    for (const row of flaggedStories) {
      renderStorySection(lines, row, ["flag-only"]);
    }
  }
  if (errorStories.length > 0) {
    lines.push(`## Errors`);
    lines.push("");
    for (const row of errorStories) {
      lines.push(`- \`${row.storyId}\` — ${row.error ?? "unknown"}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderStorySection(
  lines: string[],
  row: BulkRow,
  include: DimensionDiff["status"][],
): void {
  const report = row.report;
  if (!report) return;
  const rows = visibleDimensions(report).filter((d) => include.includes(d.status));
  if (rows.length === 0) return;
  lines.push(`### \`${row.storyId}\` — node ${report.nodeId}`);
  lines.push("");
  lines.push(`| Kind | Property | Code | Figma | Note |`);
  lines.push(`| --- | --- | --- | --- | --- |`);
  for (const d of rows) {
    lines.push(
      `| ${d.kind} | ${d.property} | ${cellValue(d.codeValue)} | ${cellValue(d.figmaValue)} | ${escapeCell(d.note ?? "")} |`,
    );
  }
  lines.push("");
}

function cellValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return escapeCell(v);
  return escapeCell(JSON.stringify(v));
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function buildJsonReport(bulk: BulkState): string {
  return JSON.stringify(
    {
      generatedAt: new Date(bulk.startedAt).toISOString(),
      finishedAt: bulk.finishedAt ? new Date(bulk.finishedAt).toISOString() : null,
      stories: bulk.rows.map((r) => ({
        storyId: r.storyId,
        status: r.status,
        match: r.match,
        drift: r.drift,
        flagOnly: r.flagOnly,
        durationMs: r.durationMs,
        error: r.error ?? null,
        report: r.report ?? null,
      })),
    },
    null,
    2,
  );
}

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
  root: {
    padding: "12px 16px",
    fontFamily: "system-ui, sans-serif",
    fontSize: 13,
    boxSizing: "border-box",
  },
  pill: {
    display: "inline-block",
    padding: "1px 8px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    border: "1px solid currentColor",
    lineHeight: "16px",
  },
  legend: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
    color: "#525252",
    fontSize: 11,
    background: "#fafafa",
    border: "1px solid #eee",
    borderRadius: 4,
    padding: "6px 10px",
    marginBottom: 8,
    lineHeight: 1.4,
  },
  legendDivider: { color: "#c4c4c4" },
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
  copyPromptButton: {
    padding: "3px 10px",
    fontSize: 11,
    borderRadius: 3,
    border: "1px dashed #d4d4d4",
    background: "#fff",
    color: "#525252",
    cursor: "pointer",
    minWidth: 100,
    textAlign: "left" as const,
    whiteSpace: "nowrap" as const,
    marginTop: 4,
  },
  experimentalBadge: {
    display: "inline-block",
    padding: "0 6px",
    borderRadius: 999,
    fontSize: 10,
    fontWeight: 600,
    color: "#92400e",
    background: "#fef3c7",
    border: "1px solid #fcd34d",
    textTransform: "lowercase" as const,
    verticalAlign: "middle",
    marginLeft: 4,
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
  infoDetails: {
    marginTop: 16,
    border: "1px solid #e5e5e5",
    borderRadius: 4,
    background: "#fafafa",
  },
  infoSummary: {
    cursor: "pointer",
    padding: "8px 12px",
    fontWeight: 600,
    fontSize: 12,
    color: "#525252",
    userSelect: "none" as const,
  },
};

addons.register(ADDON_ID, () => {
  // Storybook 10's tabpanel container has `overflow-y: hidden`, which clips
  // our content when it exceeds the panel height. Inject a global style
  // scoped to our panel id (the tabpanel element gets an id that ends with
  // PANEL_ID, e.g. `react-aria…:tabpanel-metalab/design-sync/panel`) to
  // force the wrapper to scroll. CSS attribute selector handles the slashes
  // fine.
  if (typeof document !== "undefined" && !document.getElementById("design-sync-scroll-fix")) {
    const style = document.createElement("style");
    style.id = "design-sync-scroll-fix";
    style.textContent = `[id$="${PANEL_ID}"][role="tabpanel"]{overflow-y:auto !important;}`;
    document.head.appendChild(style);
  }

  addons.add(PANEL_ID, {
    type: types.PANEL,
    title: "Sync",
    match: ({ viewMode }) => viewMode === "story",
    render: ({ active }) => <Panel active={!!active} />,
  });
});
