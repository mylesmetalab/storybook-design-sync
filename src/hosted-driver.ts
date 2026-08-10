import { EVENTS, type CodeSnapshotPayload } from "./channels.js";
import { SET_CURRENT_STORY, STORY_PREPARED, STORY_RENDERED } from "./storybook-events.js";
import { requestStoryCheck } from "./check-request.js";
import { HeadlessChannel, preparedId, preparedReader, renderFailure } from "./headless-check.js";

/**
 * Drives ONE story's real, unmodified `preview.ts` snapshot logic against an
 * arbitrary deployed Storybook URL — sub-PR 2/3 of the hosted-check plan's
 * second engine host (HOSTED-CHECK-TASKS.md T8).
 *
 * ## What this reuses, and why nothing here re-measures anything
 *
 * A static `storybook build` bundles every registered addon's preview entry
 * exactly as a dev build does — Storybook's own auto-discovery
 * (`preset.ts`'s header comment) has nothing to do with whether the *server*
 * half of the addon is running. So `preview.ts`'s real story-root resolution,
 * mode switching, child/state binding resolution and `getComputedStyle`
 * snapshotting are already present and listening for
 * `EVENTS.CheckDriftRequest` in a deployed build's JS, dormant, waiting for
 * that event to arrive on the page's own channel object.
 *
 * `headless-check.ts` already proved the mechanism for the *local* `check`
 * command: install a bridge that traps `globalThis.__STORYBOOK_ADDONS_CHANNEL__`
 * before `preview.ts`'s own code runs, so the bridge's `emit`/`drain` talk to
 * the SAME in-page channel object `preview.ts` listens on — no websocket, no
 * cross-process transport, just two listeners on one object in one page. That
 * is exactly as true against a static build as a dev server; the only reason
 * `check` requires `storybook dev` is that its *reply* comes from `server.ts`,
 * a Node process a static build has none of.
 *
 * So the split is precise: everything up to and including the DOM snapshot is
 * reused here byte-for-byte (same `requestStoryCheck`/`buildCheckDriftRequest`
 * construction site as the local check and the panel, same bridge machinery).
 * What differs is only the reply this module waits for — `EVENTS.CodeSnapshot`
 * itself, `preview.ts`'s real answer, rather than `EVENTS.DriftReport`, which
 * nothing in this process has yet produced. Turning a `CodeSnapshotPayload`
 * into a `DriftReport` is a separate, Node-side piece (comparing against
 * Figma), deliberately not this module's job.
 */
export async function driveStorySnapshot(opts: {
  channel: HeadlessChannel;
  storyId: string;
  dualMode: boolean;
  /** `"explicit"` (a designer's on-demand ask) or `"bulk"` (a sweep — on-merge/nightly/webhook). */
  trigger: "explicit" | "bulk";
  /** Set when the page was loaded on this story, so it needs no navigation. */
  alreadyCurrent?: boolean;
  /** Ceiling on the render step alone. */
  renderTimeoutMs?: number;
  /** Ceiling on waiting for the preview's snapshot reply. */
  snapshotTimeoutMs?: number;
}): Promise<CodeSnapshotPayload> {
  const { channel, storyId, dualMode, trigger } = opts;
  const renderTimeoutMs = opts.renderTimeoutMs ?? 20_000;
  const snapshotTimeoutMs = opts.snapshotTimeoutMs ?? 30_000;

  if (!opts.alreadyCurrent) {
    await channel.emit(SET_CURRENT_STORY, { storyId, viewMode: "story" });
  }
  await channel.waitFor({
    match: (e) => e.type === STORY_RENDERED && e.args[0] === storyId,
    reject: (e) => renderFailure(e, storyId),
    timeoutMs: renderTimeoutMs,
    describe: `story "${storyId}" to render`,
  });

  const prepared = await channel.waitFor({
    match: (e) => e.type === STORY_PREPARED && preparedId(e) === storyId,
    timeoutMs: renderTimeoutMs,
    describe: `story "${storyId}" to report its parameters`,
  });

  // Captured rather than emitted inline, for the same reason `checkStoryHeadless`
  // does this: `requestStoryCheck` is synchronous and sending it is a round trip
  // to the page, so a fire-and-forget call here would surface a failed emit as an
  // unhandled rejection and a bare timeout instead of the real cause.
  let sent: { event: string; payload: unknown } | undefined;
  requestStoryCheck(
    (event: string, ...args: unknown[]) => {
      sent = { event, payload: args[0] };
    },
    preparedReader(storyId, prepared.args[0]),
    storyId,
    { dualMode, trigger },
  );
  if (!sent) {
    throw new Error("requestStoryCheck emitted nothing — the check request was never sent.");
  }
  await channel.emit(sent.event, sent.payload);

  const reply = await channel.waitFor({
    match: (e) => e.type === EVENTS.CodeSnapshot && codeSnapshotStoryId(e) === storyId,
    timeoutMs: snapshotTimeoutMs,
    describe: `a code snapshot for "${storyId}"`,
  });
  return reply.args[0] as CodeSnapshotPayload;
}

function codeSnapshotStoryId(event: { args: unknown[] }): string | undefined {
  const payload = event.args[0] as { storyId?: string } | undefined;
  return payload?.storyId;
}
