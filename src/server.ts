import { loadConfig } from "./config.js";
import { loadRegistry, lookup } from "./registry.js";
import { resolveEngine } from "./engines/index.js";
import { EVENTS, type CodeSnapshotPayload } from "./channels.js";
import type { DimensionDiff, DriftReport } from "./dimensions/types.js";

/**
 * Storybook 10 server channel. Registered via the addon's preset.
 * `channel` is the Storybook event channel; we listen for code snapshots
 * (sent by the preview after the manager requests a check) and reply with
 * a typed DriftReport or DriftError.
 */
interface ChannelLike {
  on(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

export async function registerServerChannel(channel: ChannelLike): Promise<ChannelLike> {
  channel.on(EVENTS.ListRegisteredRequest, async () => {
    try {
      const config = await loadConfig();
      const registry = await loadRegistry(config.registryPath);
      const stories = Object.entries(registry.stories).map(([storyId, entry]) => ({
        storyId,
        nodeId: entry.nodeId,
      }));
      channel.emit(EVENTS.RegisteredStories, {
        stories,
        fileKey: registry.fileKey || config.fileKey,
      });
    } catch (err: unknown) {
      // Emit an empty list rather than failing silently — the manager UI
      // can render "no stories registered" sensibly.
      channel.emit(EVENTS.RegisteredStories, { stories: [], fileKey: "" });
    }
  });

  channel.on(EVENTS.CodeSnapshot, async (payload: unknown) => {
    const { storyId, snapshot, mode, args, additionalSnapshots } = payload as CodeSnapshotPayload;
    try {
      const config = await loadConfig();
      const registry = await loadRegistry(config.registryPath);
      const entry = lookup(registry, storyId);

      if (!entry) {
        channel.emit(EVENTS.DriftError, {
          storyId,
          message: `Not registered. Add "${storyId}" to ${config.registryPath}.`,
        });
        return;
      }

      const { resolve: resolvePath } = await import("node:path");
      const ctx: { figmaPat?: string; cachePath?: string } = {
        cachePath: resolvePath(process.cwd(), ".design-sync/cache.json"),
      };
      if (process.env.FIGMA_PAT) ctx.figmaPat = process.env.FIGMA_PAT;
      const engine = resolveEngine(config.engine, ctx);

      const baseInput: import("./engines/types.js").CheckDriftInput = {
        storyId,
        nodeRef: { fileKey: registry.fileKey || config.fileKey, nodeId: entry.nodeId },
      };
      if (snapshot) baseInput.snapshot = snapshot;
      if (mode) baseInput.mode = mode;
      if (args) baseInput.args = args;

      let report: DriftReport;
      if (additionalSnapshots && additionalSnapshots.length > 0) {
        const reports: Array<{ mode: string; report: DriftReport }> = [];
        const primary = await engine.checkDrift(baseInput);
        reports.push({ mode: mode ?? "primary", report: primary });
        for (const extra of additionalSnapshots) {
          const extraInput = { ...baseInput, snapshot: extra.snapshot, mode: extra.mode };
          reports.push({ mode: extra.mode, report: await engine.checkDrift(extraInput) });
        }
        report = mergeReports(reports);
      } else {
        report = await engine.checkDrift(baseInput);
      }

      channel.emit(EVENTS.DriftReport, { report });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      channel.emit(EVENTS.DriftError, { storyId, message });
    }
  });

  return channel;
}

/**
 * Merge per-mode DriftReports into a single report. For each unique
 * (kind, property) pair across all reports:
 *   - codeValue / figmaValue become {modeName: value} maps
 *   - status is the worst-of (drift > flag-only > match)
 *   - note lists which modes drifted, when applicable
 *
 * The merged report's `mode` field is the joined list of modes ("light+dark").
 */
function mergeReports(entries: Array<{ mode: string; report: DriftReport }>): DriftReport {
  if (entries.length === 0) {
    throw new Error("[design-sync] mergeReports called with no entries");
  }
  if (entries.length === 1) return entries[0]!.report;

  const groups = new Map<string, Array<{ mode: string; dim: DimensionDiff }>>();
  for (const { mode, report } of entries) {
    for (const dim of report.dimensions) {
      const key = `${dim.kind}|${dim.property}`;
      const list = groups.get(key) ?? [];
      list.push({ mode, dim });
      groups.set(key, list);
    }
  }

  const merged: DimensionDiff[] = [];
  for (const list of groups.values()) {
    if (list.length === 1) {
      merged.push(list[0]!.dim);
      continue;
    }
    const codeByMode: Record<string, unknown> = {};
    const figmaByMode: Record<string, unknown> = {};
    const statuses: DimensionDiff["status"][] = [];
    const driftedModes: string[] = [];
    for (const { mode, dim } of list) {
      codeByMode[mode] = dim.codeValue;
      figmaByMode[mode] = dim.figmaValue;
      statuses.push(dim.status);
      if (dim.status === "drift") driftedModes.push(mode);
    }
    const status: DimensionDiff["status"] =
      statuses.includes("drift") ? "drift" :
      statuses.every((s) => s === "match") ? "match" : "flag-only";
    const out: DimensionDiff = {
      kind: list[0]!.dim.kind,
      property: list[0]!.dim.property,
      codeValue: codeByMode,
      figmaValue: figmaByMode,
      status,
    };
    if (driftedModes.length > 0) {
      out.note = `Drift in: ${driftedModes.join(", ")}`;
    }
    merged.push(out);
  }

  const first = entries[0]!.report;
  const result: DriftReport = {
    storyId: first.storyId,
    nodeId: first.nodeId,
    dimensions: merged,
    generatedAt: new Date().toISOString(),
    mode: entries.map((e) => e.mode).join("+"),
  };
  return result;
}
