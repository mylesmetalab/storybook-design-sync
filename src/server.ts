import { loadConfig } from "./config.js";
import { loadRegistry, lookup } from "./registry.js";
import { resolveEngine } from "./engines/index.js";
import { EVENTS, type CodeSnapshotPayload } from "./channels.js";

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
  channel.on(EVENTS.CodeSnapshot, async (payload: unknown) => {
    const { storyId, snapshot } = payload as CodeSnapshotPayload;
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

      const ctx: { figmaPat?: string } = {};
      if (process.env.FIGMA_PAT) ctx.figmaPat = process.env.FIGMA_PAT;
      const engine = resolveEngine(config.engine, ctx);

      const report = await engine.checkDrift({
        storyId,
        nodeRef: { fileKey: registry.fileKey || config.fileKey, nodeId: entry.nodeId },
        snapshot,
      });

      channel.emit(EVENTS.DriftReport, { report });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      channel.emit(EVENTS.DriftError, { storyId, message });
    }
  });

  return channel;
}
