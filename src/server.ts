import { loadConfig } from "./config.js";
import { loadRegistry, lookup, isPending } from "./registry.js";
import { resolveEngine, type Engine, type EngineContext } from "./engines/index.js";
import {
  EVENTS,
  type ChildBindingsInfoPayload,
  type ChildBindingsRequestPayload,
  type ChildSnapshotEntry,
  type CodeSnapshotPayload,
  type ApplyCodeRequestPayload,
  type ConfigInfoPayload,
} from "./channels.js";
import {
  formatChildProblem,
  validateChildBindings,
  type ChildBindingDeclaration,
} from "./child-bindings.js";
import type { ChildTarget } from "./engines/types.js";
import { applyCodeEdit } from "./apply-code.js";
import type { DimensionDiff, DriftReport } from "./dimensions/types.js";
import { getAutoScan, getAutoTokenMap } from "./auto-tokens.js";
import { lookupBindings } from "./scan-css.js";
import { resolveComponentBindings } from "./tailwind-components.js";
import { componentNameFromStoryId } from "./fix-prompt.js";

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

/**
 * Memoized engine instance, keyed by the config identity that feeds it.
 * `resolveEngine` constructs a fresh engine per call, which threw away the
 * FigmaRestEngine's per-instance TTL caches (variables, nodes, parent maps,
 * file metadata) on every drift check. One engine per (engine name, fileKey,
 * cache path, PAT) preserves those caches across checks with the same
 * semantics a single instance always had; any config change mints a new
 * instance so stale settings never leak.
 */
let engineMemo: { key: string; engine: Engine } | null = null;

function getEngine(name: string, fileKey: string, ctx: EngineContext): Engine {
  const key = [name, fileKey, ctx.cachePath ?? "", ctx.figmaPat ?? ""].join("\0");
  if (engineMemo && engineMemo.key === key) return engineMemo.engine;
  const engine = resolveEngine(name, ctx);
  engineMemo = { key, engine };
  return engine;
}

export async function registerServerChannel(channel: ChannelLike): Promise<ChannelLike> {
  channel.on(EVENTS.ConfigRequest, async () => {
    try {
      const config = await loadConfig();
      const payload: ConfigInfoPayload = {
        apply: config.apply,
        fileKey: config.fileKey,
        // Read the normalized paths off the config; do NOT re-derive them here.
        // `config.codeTargets.map((t) => t.path)` used to live at this line and
        // produced `[undefined]` for every consumer using the documented
        // glob-string shorthand, which then shipped into fix prompts as a file
        // named `undefined`. See `config.ts`.
        codeTargetPaths: config.codeTargetPaths,
      };
      channel.emit(EVENTS.ConfigInfo, payload);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const payload: ConfigInfoPayload = {
        apply: "off",
        fileKey: "",
        codeTargetPaths: [],
        error: message,
      };
      channel.emit(EVENTS.ConfigInfo, payload);
    }
  });

  channel.on(EVENTS.ListRegisteredRequest, async () => {
    try {
      const config = await loadConfig();
      const registry = await loadRegistry(config.registryPath);
      const stories = Object.entries(registry.stories)
        .filter(([, entry]) => !isPending(entry))
        .map(([storyId, entry]) => ({
          storyId,
          nodeId: entry.nodeId!,
        }));
      channel.emit(EVENTS.RegisteredStories, {
        stories,
        fileKey: registry.fileKey || config.fileKey,
      });
    } catch (err: unknown) {
      // Don't swallow load/parse failures into an empty list — that reads
      // as "no stories registered" and hides real breakage. Relay the
      // message so the manager can render an error banner.
      const message = err instanceof Error ? err.message : String(err);
      channel.emit(EVENTS.RegisteredStories, { stories: [], fileKey: "", error: message });
    }
  });

  /**
   * The preview asks (before snapshotting) which child elements this story
   * binds. Only the well-formed declarations go back — malformed ones can't be
   * resolved against the DOM anyway, and they are reported separately from the
   * CodeSnapshot handler, which is the one path that always runs.
   *
   * Always replies, including with an empty list, so the preview never waits out
   * its timeout on a legacy story.
   */
  channel.on(EVENTS.ChildBindingsRequest, async (payload: unknown) => {
    const { storyId } = (payload ?? {}) as ChildBindingsRequestPayload;
    const reply: ChildBindingsInfoPayload = { storyId, children: [] };
    try {
      const config = await loadConfig();
      const registry = await loadRegistry(config.registryPath);
      const entry = lookup(registry, storyId);
      if (entry && !isPending(entry)) {
        reply.children = validateChildBindings(entry.children).declarations;
      }
    } catch {
      // Config/registry failures are reported by the CodeSnapshot handler with
      // the full message; swallowing here only means "no children to snapshot".
    }
    channel.emit(EVENTS.ChildBindingsInfo, reply);
  });

  channel.on(EVENTS.ApplyCodeRequest, async (payload: unknown) => {
    const { edit } = payload as ApplyCodeRequestPayload;
    try {
      const config = await loadConfig();
      const result = await applyCodeEdit(edit, process.cwd(), config.codeTargets);
      channel.emit(EVENTS.ApplyCodeResult, { result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      channel.emit(EVENTS.ApplyCodeResult, {
        result: { id: edit.id, status: "error", engine: "addon-apply-code", message },
      });
    }
  });

  channel.on(EVENTS.CodeSnapshot, async (payload: unknown) => {
    const { storyId, snapshot, mode, args, additionalSnapshots, target, childSnapshots } =
      payload as CodeSnapshotPayload;
    try {
      // Each snapshot carries its own mode, so each gets its own resolution —
      // a `dark:` class applies in the dark pass and not the light one.
      const autoBindings = mergeAutoBindings(storyId, target, snapshot, args, mode);
      if (additionalSnapshots) {
        for (const extra of additionalSnapshots) {
          mergeAutoBindings(storyId, target, extra.snapshot, args, extra.mode);
        }
      }
      mergeChildAutoBindings(childSnapshots);
      const config = await loadConfig();
      const registry = await loadRegistry(config.registryPath);
      const entry = lookup(registry, storyId);

      if (!entry) {
        channel.emit(EVENTS.DriftError, {
          storyId,
          message:
            `Not registered. Add "${storyId}" to ${config.registryPath}. ` +
            `Run \`design-sync audit\` to list every story missing from the registry. ` +
            `(id format: sanitize(title) + "--" + sanitize(storyNameFromExport(exportName)))`,
        });
        return;
      }

      if (isPending(entry)) {
        // Not a failure: a pending stub is the registry deliberately recording
        // "this story exists, its Figma counterpart doesn't yet". Flagged as
        // informational so the panel doesn't paint it as an error.
        channel.emit(EVENTS.DriftError, {
          storyId,
          severity: "info",
          message:
            `Pending — Figma binding not assigned. ` +
            `Set "nodeId" for "${storyId}" in ${config.registryPath} once the variant exists.`,
        });
        return;
      }

      const fileKey = registry.fileKey || config.fileKey;
      if (!fileKey) {
        channel.emit(EVENTS.DriftError, {
          storyId,
          message:
            `No fileKey configured — add "fileKey": "<your Figma file key>" to ` +
            `design-sync.config.json (or to ${config.registryPath}). ` +
            `Without it every Figma request 404s.`,
        });
        return;
      }

      const { resolve: resolvePath } = await import("node:path");
      const ctx: { figmaPat?: string; cachePath?: string } = {
        cachePath: resolvePath(process.cwd(), ".design-sync/cache.json"),
      };
      if (process.env.FIGMA_PAT) ctx.figmaPat = process.env.FIGMA_PAT;
      const engine = getEngine(config.engine, fileKey, ctx);

      const baseInput: import("./engines/types.js").CheckDriftInput = {
        storyId,
        nodeRef: { fileKey, nodeId: entry.nodeId! },
        registryPath: config.registryPath,
      };
      if (snapshot) baseInput.snapshot = snapshot;
      if (mode) baseInput.mode = mode;
      if (args) baseInput.args = args;

      // Declared child bindings. The registry is authoritative here: every
      // declaration it carries gets a target, even when the preview reported
      // nothing for it — so a lost or refused child can never turn into silence.
      const childTargets = buildChildTargets({
        storyId,
        registryPath: config.registryPath,
        declared: entry.children,
        received: childSnapshots,
      });
      if (childTargets.length > 0) baseInput.children = childTargets;

      let report: DriftReport;
      if (additionalSnapshots && additionalSnapshots.length > 0) {
        const reports: Array<{ mode: string; report: DriftReport }> = [];
        const primary = await engine.checkDrift(baseInput);
        reports.push({ mode: mode ?? "primary", report: primary });
        for (const extra of additionalSnapshots) {
          const extraInput: import("./engines/types.js").CheckDriftInput = {
            ...baseInput,
            snapshot: extra.snapshot,
            mode: extra.mode,
          };
          if (childTargets.length > 0) {
            extraInput.children = childTargetsForMode(childTargets, childSnapshots, extra.mode);
          }
          reports.push({ mode: extra.mode, report: await engine.checkDrift(extraInput) });
        }
        report = mergeReports(reports);
      } else {
        report = await engine.checkDrift(baseInput);
      }

      annotateClassHints(report, autoBindings.classes);
      if (autoBindings.advisory) {
        // eslint-disable-next-line no-console
        console.warn(`[design-sync] ${storyId}: ${autoBindings.advisory}`);
        report.scanAdvisory = autoBindings.advisory;
      }

      channel.emit(EVENTS.DriftReport, { report });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      channel.emit(EVENTS.DriftError, { storyId, message });
    }
  });

  return channel;
}

/* ------------------------------------------------------------------------- *
 * Declared child bindings
 * ------------------------------------------------------------------------- */

/**
 * Turn the registry's `children` map plus the preview's per-selector results
 * into one `ChildTarget` per declaration.
 *
 * The registry is the authority on *what was declared*; the preview is only the
 * authority on *what resolved*. Iterating the registry (not the received list)
 * is what guarantees requirement 4: a declaration whose selector matched
 * nothing, matched several things, is invalid CSS, is malformed in the registry,
 * or that the preview never reported at all, still becomes a target carrying its
 * reason — so it reaches the panel as a visible row instead of disappearing.
 */
export function buildChildTargets(opts: {
  storyId: string;
  registryPath: string;
  declared: Record<string, string> | undefined;
  received: ChildSnapshotEntry[] | undefined;
}): ChildTarget[] {
  const { declarations, malformed, fatal } = validateChildBindings(opts.declared);
  const targets: ChildTarget[] = [];

  if (fatal) {
    return [
      {
        selector: "children",
        nodeId: "",
        problem: {
          status: "binding-malformed",
          message: formatChildProblem({
            status: "binding-malformed",
            selector: "children",
            storyId: opts.storyId,
            registryPath: opts.registryPath,
            detail: fatal,
          }),
        },
      },
    ];
  }

  const bySelector = new Map((opts.received ?? []).map((e) => [e.selector, e]));

  for (const decl of declarations) {
    const received = bySelector.get(decl.selector);
    if (!received) {
      targets.push(problemTarget(decl, "snapshot-missing", opts, undefined));
      continue;
    }
    if (received.kind === "found" && received.snapshot) {
      targets.push({ selector: decl.selector, nodeId: decl.nodeId, snapshot: received.snapshot });
      continue;
    }
    if (received.kind === "ambiguous") {
      targets.push(
        problemTarget(decl, "selector-ambiguous", opts, undefined, received.candidates),
      );
      continue;
    }
    if (received.kind === "invalid") {
      targets.push(problemTarget(decl, "selector-invalid", opts, received.detail));
      continue;
    }
    if (received.kind === "not-found") {
      targets.push(
        problemTarget(decl, "selector-not-found", opts, undefined, undefined, received.rootMatches),
      );
      continue;
    }
    // `kind: "found"` with no snapshot — shouldn't happen, but the honest read
    // is "we have no measurement", not "it matched".
    targets.push(problemTarget(decl, "snapshot-missing", opts, undefined));
  }

  for (const m of malformed) {
    targets.push({
      selector: m.selector,
      nodeId: "",
      problem: {
        status: "binding-malformed",
        message: formatChildProblem({
          status: "binding-malformed",
          selector: m.selector,
          storyId: opts.storyId,
          registryPath: opts.registryPath,
          detail: m.detail,
        }),
      },
    });
  }

  return targets;
}

function problemTarget(
  decl: ChildBindingDeclaration,
  status: "snapshot-missing" | "selector-ambiguous" | "selector-invalid" | "selector-not-found",
  opts: { storyId: string; registryPath: string },
  detail: string | undefined,
  candidates?: string[] | undefined,
  rootMatches?: boolean | undefined,
): ChildTarget {
  return {
    selector: decl.selector,
    nodeId: decl.nodeId,
    problem: {
      status,
      message: formatChildProblem({
        status,
        selector: decl.selector,
        storyId: opts.storyId,
        registryPath: opts.registryPath,
        nodeId: decl.nodeId,
        detail,
        candidates,
        rootMatches,
      }),
    },
  };
}

/**
 * Swap each child's snapshot for the one captured in `mode` during a dual-mode
 * run. A child whose second-mode snapshot is missing becomes
 * `snapshot-missing` for that pass rather than silently re-using the first
 * mode's measurement — comparing a light-mode snapshot against dark-mode Figma
 * values is exactly the kind of real-but-wrong number this addon must not print.
 */
export function childTargetsForMode(
  base: readonly ChildTarget[],
  received: ChildSnapshotEntry[] | undefined,
  mode: string,
): ChildTarget[] {
  const bySelector = new Map((received ?? []).map((e) => [e.selector, e]));
  return base.map((target): ChildTarget => {
    if (!target.snapshot) return target;
    const extra = bySelector
      .get(target.selector)
      ?.additionalSnapshots?.find((s) => s.mode === mode);
    if (extra) return { ...target, snapshot: extra.snapshot };
    const { snapshot: _unused, ...rest } = target;
    return {
      ...rest,
      problem: {
        status: "snapshot-missing",
        message:
          `Not compared in mode "${mode}" — the preview captured no snapshot of ` +
          `\`${target.selector}\` in that mode.`,
      },
    };
  });
}

/**
 * Merge scanner-derived bindings into the snapshot. Two independent sources:
 *
 *  1. **Selector-keyed** bindings from the CSS/TSX scanners, looked up by the
 *     story's `parameters.designSync.target` with cascade fallback. Requires a
 *     target selector — without one there is nothing to key on.
 *  2. **Tailwind `cva()` components**, resolved by the story id's component
 *     segment plus the story's args. Needs no target selector, because a
 *     Tailwind component has no stable class to point at: the utilities *are*
 *     the styling. This is the path that makes shadcn/cva consumers work.
 *
 * Both take precedence over story-param `tokens` and per-element
 * `data-token-*` attrs for any property they resolved. Properties neither saw
 * fall through to whatever the snapshot already carried.
 *
 * Returns the class attribution for the properties it resolved (property → the
 * utility class a fix should change) plus any advisory the caller should
 * surface, so the report can name the class instead of only the property.
 */
interface AutoBindingOutcome {
  classes: Record<string, string>;
  /** Human-readable note when resolution was refused rather than empty. */
  advisory?: string;
}

function mergeAutoBindings(
  storyId: string,
  target: string | undefined,
  snapshot: import("./engines/types.js").CodeSnapshot | undefined,
  args: Record<string, unknown> | undefined,
  mode: string | undefined,
): AutoBindingOutcome {
  if (!snapshot) return { classes: {} };
  const scan = getAutoScan();
  const bindings: Record<string, string> = {};
  const classes: Record<string, string> = {};
  let advisory: string | undefined;

  if (target) {
    Object.assign(bindings, lookupBindings(getAutoTokenMap(), target));
    for (const key of Object.keys(bindings)) {
      const hint = scan.classHints[target]?.[key];
      if (hint) classes[key] = hint;
    }
  }

  if (scan.components.length > 0) {
    const resolution = resolveComponentBindings(
      scan.components,
      componentNameFromStoryId(storyId),
      args,
      scan.themeVars,
      mode,
    );
    if (resolution.kind === "resolved") {
      Object.assign(bindings, resolution.bindings);
      Object.assign(classes, resolution.classes);
    } else if (resolution.kind === "ambiguous") {
      // Two scanned components answer to the same name. Picking one would
      // produce authoritative-looking bindings from the wrong file.
      advisory =
        `Tailwind bindings not derived: ${resolution.files.length} scanned components ` +
        `answer to "${resolution.component}" (${resolution.files.join(", ")}). ` +
        `Rename one, or narrow \`tsxEntries\` in design-sync.config.json.`;
    }
  }

  if (Object.keys(bindings).length > 0) {
    snapshot.bindings = { ...(snapshot.bindings ?? {}), ...bindings };
  }
  return advisory === undefined ? { classes } : { classes, advisory };
}

/**
 * Attach the utility class that produced each code-side binding to the matching
 * drift rows, so the fix prompt can say "change `bg-primary`" rather than only
 * "background-color drifted". Purely additive annotation — no diff's status,
 * values, or partitioning depend on it.
 */
function annotateClassHints(
  report: DriftReport,
  classes: Record<string, string>,
): void {
  if (Object.keys(classes).length === 0) return;
  for (const dim of report.dimensions) {
    // Root rows only. The hints are resolved from the story's own target
    // selector / cva component, so pinning one onto a child's row would tell
    // the user to edit a class that doesn't style that element.
    if (dim.childSelector !== undefined) continue;
    const cls = classes[dim.property];
    if (cls) dim.codeClassName = cls;
  }
}

/**
 * Give each bound child the CSS-scanner bindings registered for *its own*
 * selector, the same selector-keyed lookup the story root gets.
 *
 * Deliberately does NOT run the Tailwind `cva()` resolution: that is keyed by the
 * story's component name, so its bindings describe the component's root, and
 * attributing them to a child would put an authoritative-looking token name on
 * an element it doesn't style.
 */
function mergeChildAutoBindings(childSnapshots: ChildSnapshotEntry[] | undefined): void {
  if (!childSnapshots) return;
  for (const child of childSnapshots) {
    if (child.kind !== "found" || !child.snapshot) continue;
    const bindings = lookupBindings(getAutoTokenMap(), child.selector);
    if (Object.keys(bindings).length === 0) continue;
    child.snapshot.bindings = { ...(child.snapshot.bindings ?? {}), ...bindings };
    for (const extra of child.additionalSnapshots ?? []) {
      extra.snapshot.bindings = { ...(extra.snapshot.bindings ?? {}), ...bindings };
    }
  }
}

/**
 * Merge per-mode `children` arrays. Declaration order comes from the first
 * report (identical across modes — resolution doesn't depend on the theme).
 * Status is worst-of: a child that failed to compare in *either* mode is
 * reported as not compared, because "compared" would otherwise claim coverage
 * for a mode that has none.
 */
function mergeChildReports(
  entries: Array<{ report: DriftReport }>,
): ChildBindingReportList | undefined {
  const withChildren = entries.filter((e) => e.report.children);
  if (withChildren.length === 0) return undefined;
  const order = withChildren[0]!.report.children!.map((c) => c.selector);
  const merged: ChildBindingReportList = [];
  for (const selector of order) {
    const all = withChildren
      .map((e) => e.report.children!.find((c) => c.selector === selector))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    if (all.length === 0) continue;
    const failed = all.find((c) => c.status !== "compared");
    const base = failed ?? all[0]!;
    const out: ChildBindingReportList[number] = {
      selector,
      nodeId: base.nodeId,
      status: base.status,
      rowCount: Math.max(...all.map((c) => c.rowCount ?? 0)),
    };
    const named = all.find((c) => c.nodeName);
    if (named?.nodeName) out.nodeName = named.nodeName;
    if (base.message) out.message = base.message;
    merged.push(out);
  }
  return merged;
}

type ChildBindingReportList = NonNullable<DriftReport["children"]>;

/**
 * Merge per-mode DriftReports into a single report. For each unique
 * (kind, property, childSelector) triple across all reports:
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
      // `childSelector` is part of the identity: the root and a bound child both
      // report `padding-top`, and collapsing them would merge two different
      // elements' values into one row.
      const key = `${dim.kind}|${dim.property}|${dim.childSelector ?? ""}`;
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
    const childSelector = list[0]!.dim.childSelector;
    if (childSelector !== undefined) out.childSelector = childSelector;
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
  const children = mergeChildReports(entries);
  if (children) result.children = children;
  return result;
}
