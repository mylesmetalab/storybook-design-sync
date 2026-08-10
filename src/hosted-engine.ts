import type { CodeSnapshotPayload } from "./channels.js";
import type { DriftReport } from "./dimensions/types.js";
import { loadConfig } from "./config.js";
import { loadRegistry, lookup, isPending } from "./registry.js";
import type { Engine } from "./engines/types.js";
import type { CheckDriftInput } from "./engines/types.js";
import {
  runModePasses,
  buildChildTargets,
  chooseStateTargets,
  describeModeComparison,
  annotateStateClassHints,
  mergeAutoBindings,
  mergeChildAutoBindings,
  mergeStateAutoBindings,
  annotateClassHints,
  annotateTokenPresence,
  annotateContract,
} from "./server.js";
import { checkTimeoutMessage, explicitBudgetMs } from "./check-budget.js";
import { withBudget } from "./bulk-run.js";

/**
 * Sub-PR 3/3 of the hosted-check plan's second engine host
 * (HOSTED-CHECK-TASKS.md T8): turns one `CodeSnapshotPayload` (sub-PR 2's
 * `driveStorySnapshot`, `preview.ts`'s real reply) into a real `DriftReport`,
 * by calling the engine — the same way `server.ts`'s
 * `channel.on(EVENTS.CodeSnapshot, ...)` handler does, reusing every one of
 * its actual comparison/merge/annotation steps rather than reimplementing
 * any of them.
 *
 * ## What is reused, and what is deliberately NOT
 *
 * Every function this calls — `mergeAutoBindings`, `mergeChildAutoBindings`,
 * `mergeStateAutoBindings`, `buildChildTargets`, `chooseStateTargets`,
 * `runModePasses`, `describeModeComparison`, `annotateClassHints`,
 * `annotateStateClassHints`, `annotateTokenPresence`, `annotateContract` — is
 * the *exact* function the live channel handler calls, exported from
 * `server.ts` rather than duplicated. `mergeAutoBindings` and its siblings
 * read `getAutoScan()`'s module-scoped singleton internally, unchanged; a
 * hosted runner calls `setAutoScan(toAutoScan(loadedArtifact))` once at its
 * own startup (sub-PR 1's `loadScanArtifact`/`toAutoScan`), and every one of
 * these functions then behaves identically to how it behaves inside a live
 * dev server — no signature change, no new code path inside them.
 *
 * What is **not** shared, named as a real, deliberate tradeoff rather than
 * hidden: the *sequence* these calls run in. `server.ts`'s
 * `channel.on(EVENTS.CodeSnapshot, ...)` handler has no dedicated test file
 * of its own (only its already-exported pieces do, in `mode-passes.test.ts`
 * and `modes-x-states.test.ts`), so refactoring it to call one function both
 * paths share would be changing already-shipped, thinly-covered production
 * code under a hosted-mode deadline — exactly the kind of risk this project's
 * own working agreements warn against taking casually. This function mirrors
 * that sequence instead of extracting it. If the two orchestration bodies
 * ever need to change together and don't, that is the one thing this design
 * does not protect against — the honest cost of not touching the live
 * handler, recorded here rather than left for a future reader to discover.
 *
 * ## What this deliberately returns instead of emits
 *
 * The live handler emits `EVENTS.DriftReport` / `EVENTS.DriftError` on a
 * channel; there is no channel here, so this returns a `{ report }` or
 * `{ error }` shape instead — same two outcomes, same wording, adapted to a
 * plain function call.
 */
export interface HostedCodeSnapshotResult {
  report?: DriftReport;
  error?: { message: string; severity?: "info" };
}

export async function runHostedCodeSnapshot(opts: {
  payload: CodeSnapshotPayload;
  cwd: string;
  engine: Pick<Engine, "checkDrift">;
}): Promise<HostedCodeSnapshotResult> {
  const { payload, cwd, engine } = opts;
  const {
    storyId,
    snapshot,
    mode,
    args,
    additionalSnapshots,
    target,
    childSnapshots,
    stateSnapshots,
    stylesheetMissing,
    bulk,
    modeSwitch,
    compareCopy,
  } = payload;

  try {
    // Each snapshot carries its own mode, so each gets its own resolution —
    // same reasoning as the live handler (mergeAutoBindings's own doc comment).
    const autoBindings = mergeAutoBindings(storyId, target, snapshot, args, mode);
    if (additionalSnapshots) {
      for (const extra of additionalSnapshots) {
        mergeAutoBindings(storyId, target, extra.snapshot, args, extra.mode);
      }
    }
    mergeChildAutoBindings(childSnapshots);
    const stateClasses = mergeStateAutoBindings(storyId, target, stateSnapshots, args, mode);
    const config = await loadConfig(cwd);

    // #96 — refuse BEFORE the engine runs, not after. Same as the live handler.
    if (stylesheetMissing) {
      return {
        report: {
          storyId,
          nodeId: "",
          generatedAt: new Date().toISOString(),
          dimensions: [],
          incomplete: {
            reason: stylesheetMissing.reason,
            targets: ["root"],
            detail: stylesheetMissing.detail,
          },
        },
      };
    }

    // Explicit `cwd`, unlike the live handler's `loadRegistry(config.registryPath)`
    // — that is safe there only because a dev server's `process.cwd()` naturally
    // IS the consumer's root. A hosted runner must not depend on that ambient
    // fact holding true in whatever process happens to host it.
    const registry = await loadRegistry(config.registryPath, cwd);
    const entry = lookup(registry, storyId);

    if (!entry) {
      return {
        error: {
          message:
            `Not registered. Add "${storyId}" to ${config.registryPath}. ` +
            `Run \`design-sync audit\` to list every story missing from the registry. ` +
            `(id format: sanitize(title) + "--" + sanitize(storyNameFromExport(exportName)))`,
        },
      };
    }

    if (isPending(entry)) {
      return {
        error: {
          severity: "info",
          message:
            `Pending — Figma binding not assigned. ` +
            `Set "nodeId" for "${storyId}" in ${config.registryPath} once the variant exists.`,
        },
      };
    }

    const fileKey = registry.fileKey || config.fileKey;
    if (!fileKey) {
      return {
        error: {
          message:
            `No fileKey configured — add "fileKey": "<your Figma file key>" to ` +
            `design-sync.config.json (or to ${config.registryPath}). ` +
            `Without it every Figma request 404s.`,
        },
      };
    }

    const baseInput: CheckDriftInput = {
      storyId,
      nodeRef: { fileKey, nodeId: entry.nodeId! },
      registryPath: config.registryPath,
      trigger: bulk ? "bulk" : "explicit",
      checkId: `${storyId}:${Date.now()}`,
    };
    if (Object.keys(config.tokenAliases).length > 0) {
      baseInput.tokenAliases = config.tokenAliases;
    }
    if (config.copy === "off" || compareCopy === false) baseInput.compareCopy = false;
    if (snapshot) baseInput.snapshot = snapshot;
    if (mode) baseInput.mode = mode;
    if (args) baseInput.args = args;

    const childTargets = buildChildTargets({
      storyId,
      registryPath: config.registryPath,
      declared: entry.children,
      received: childSnapshots,
    });
    const dualMode = Boolean(additionalSnapshots && additionalSnapshots.length > 0);
    const stateTargets = chooseStateTargets({
      dualMode,
      storyId,
      registryPath: config.registryPath,
      declared: entry.states,
      received: stateSnapshots,
    });
    const allTargets = [...childTargets, ...stateTargets];
    if (allTargets.length > 0) baseInput.children = allTargets;

    const runCheck = (): Promise<DriftReport> =>
      runModePasses({
        engine,
        baseInput,
        mode,
        additionalSnapshots,
        childTargets,
        childSnapshots,
        stateTargets,
        stateSnapshots,
      });

    let report: DriftReport;
    if (bulk) {
      report = await runCheck();
    } else {
      const budgetMs = explicitBudgetMs(dualMode);
      report = await withBudget(runCheck(), {
        budgetMs,
        message: checkTimeoutMessage(budgetMs),
      });
    }

    const modeComparison = describeModeComparison(modeSwitch, dualMode);
    if (modeComparison) report.modeComparison = modeComparison;

    annotateClassHints(report, autoBindings.classes);
    annotateStateClassHints(report, stateClasses);
    annotateTokenPresence(report);
    await annotateContract(report, storyId, target);
    if (autoBindings.advisory) report.scanAdvisory = autoBindings.advisory;

    return { report };
  } catch (err: unknown) {
    return { error: { message: err instanceof Error ? err.message : String(err) } };
  }
}
