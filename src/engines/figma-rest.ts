import type {
  CheckDriftInput,
  ChildTarget,
  CodeSnapshot,
  Engine,
  EngineContext,
  EngineFactory,
} from "./types.js";
import type {
  ChildBindingReport,
  DimensionDiff,
  DriftReport,
  ModeAwareValue,
  NameDivergenceKind,
} from "../dimensions/types.js";
import { formatChildProblem } from "../child-bindings.js";
import { matchTokenNames, aliasSignature, type TokenAliasMap } from "../token-aliases.js";
import { divergenceNote, nameDivergenceStatus } from "../binding-divergence.js";
import { variantSetRowApplicable } from "../row-triage.js";
import { PersistentCache } from "../cache.js";
import { isTransparentColor, normalizeColor } from "./color-normalize.js";
import {
  figmaEffectsToShadows,
  formatShadows,
  parseCssBoxShadow,
  shadowsEqual,
  type FigmaEffect,
} from "./box-shadow.js";
import { layoutRows } from "./layout.js";
import { textStyleRows, type FigmaTypeStyle } from "./text-style-map.js";
import {
  componentPropertyRows,
  type FigmaComponentPropertyDefinition,
  type FigmaComponentPropertyValue,
} from "./component-properties.js";

const FIGMA_API = "https://api.figma.com/v1";

interface FigmaNodesResponse {
  nodes: Record<string, { document: FigmaNode } | null>;
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  boundVariables?: Record<string, FigmaVariableAlias | FigmaVariableAlias[]>;
  fills?: FigmaPaint[];
  // Variant info shows up on COMPONENT (instance variant props) or COMPONENT_SET.
  componentPropertyDefinitions?: Record<string, FigmaComponentPropertyDefinition>;
  /** Actual property values — INSTANCE nodes only. */
  componentProperties?: Record<string, FigmaComponentPropertyValue>;
  variantProperties?: Record<string, string>;
  children?: FigmaNode[];
  [key: string]: unknown;
}

interface FigmaPaint {
  type: string;
  color?: { r: number; g: number; b: number; a?: number };
  opacity?: number;
  boundVariables?: Record<string, FigmaVariableAlias>;
}

interface FigmaVariableAlias {
  type: "VARIABLE_ALIAS";
  id: string;
}

interface FigmaLocalVariablesResponse {
  meta: {
    variables: Record<string, FigmaVariable>;
    variableCollections: Record<string, FigmaVariableCollection>;
  };
}

interface FigmaVariable {
  id: string;
  name: string;
  resolvedType: "FLOAT" | "COLOR" | "STRING" | "BOOLEAN";
  variableCollectionId: string;
  valuesByMode: Record<string, unknown>;
}

interface FigmaVariableCollection {
  id: string;
  name: string;
  modes: { modeId: string; name: string }[];
  defaultModeId: string;
}

/**
 * Tiny TTL cache. Process-lifetime by default; entries expire after `ttlMs`.
 * Used to amortize Figma REST calls across a bulk drift check (86 stories
 * pointing at the same Figma file should not re-fetch variables 86 times).
 */
class TtlCache<V> {
  private readonly store = new Map<string, { value: V; expires: number }>();
  hits = 0;
  misses = 0;
  constructor(private readonly ttlMs: number) {}
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry || entry.expires < Date.now()) {
      if (entry) this.store.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    return entry.value;
  }
  set(key: string, value: V): void {
    this.store.set(key, { value, expires: Date.now() + this.ttlMs });
  }
  /**
   * Drop an entry. Deliberately NOT a counter event: the next `get` records the
   * miss and the fetch that follows records itself, so the panel's hit/miss
   * numbers keep describing real HTTP traffic. Those counters were the
   * diagnostic that made the stale-`match` bug findable.
   */
  delete(key: string): void {
    this.store.delete(key);
  }
  /** Drop every entry whose key matches — node keys are `${fileKey}:${nodeId}`. */
  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.store.keys()]) {
      if (predicate(key)) this.store.delete(key);
    }
  }
}

/**
 * Bounded-concurrency + 429-aware fetcher. A bulk Check-all run fires
 * one node request per (story × mode), which on a 64-story file is
 * 128 parallel `GET /files/.../nodes?ids=` — well past Figma's
 * rate ceiling. Without throttling, half the report comes back as
 * 429s instead of drift.
 *
 * Strategy:
 *   - Cap in-flight requests at MAX_CONCURRENT (4).
 *   - On 429 or 5xx, honor `Retry-After` (or fall back to a capped
 *     exponential backoff with jitter), retry up to MAX_RETRIES (3).
 *   - Token-bucket-style: a global rate-limited gate also throttles
 *     to RPS_LIMIT to avoid bursting even within the concurrency cap.
 */
const MAX_CONCURRENT = 4;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

let inflight = 0;
const waiters: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (inflight < MAX_CONCURRENT) {
    inflight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    waiters.push(() => {
      inflight++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  inflight--;
  const next = waiters.shift();
  if (next) next();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttledFetch(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await acquireSlot();
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      releaseSlot();
      if (attempt === MAX_RETRIES) throw err;
      await sleep(backoffMs(attempt));
      continue;
    }
    releaseSlot();

    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      if (attempt === MAX_RETRIES) return res;
      const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
      const wait = retryAfter ?? backoffMs(attempt);
      await sleep(wait);
      continue;
    }

    return res;
  }
  // unreachable — loop returns or throws first
  throw new Error("throttledFetch exhausted retries");
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.min(seconds * 1000, RETRY_MAX_MS);
  }
  // HTTP-date form — uncommon from Figma but spec-correct.
  const ts = Date.parse(header);
  if (Number.isFinite(ts)) {
    return Math.min(Math.max(ts - Date.now(), 0), RETRY_MAX_MS);
  }
  return null;
}

function backoffMs(attempt: number): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
  const jitter = Math.random() * base * 0.25;
  return base + jitter;
}

class FigmaRestEngine implements Engine {
  readonly name = "figma-rest";
  private readonly pat: string | undefined;
  /** Cache of `node_id → containing_frame.nodeId` per fileKey. */
  private readonly parentMaps = new Map<string, Map<string, string>>();
  /**
   * Variables, cached for 5 min. The TTL exists for **bulk** runs, where one
   * fetch serving ~90 stories is the difference between a working Check-all and
   * a wall of 429s.
   *
   * It is NOT a claim that variables are stable: this comment used to read
   * "variables are stable for the lifetime of a working session", and a designer
   * changing a token value mid-session is precisely what this tool exists to
   * detect. Combined with the engine memoization added in v0.0.28 (which turned
   * these per-check caches into cross-check ones), that premise gave the panel a
   * five-minute window in which it confidently reported `match` against values
   * that had changed. An explicit Check drift now drops this entry before
   * reading — see `revalidateBeforeExplicitCheck`.
   */
  private readonly variablesCache = new TtlCache<FigmaLocalVariablesResponse>(5 * 60_000);
  /**
   * Per-node fetches are cached for 30s — long enough that a bulk run
   * fully benefits, short enough that single-story checks against a node
   * the user just modified pick up the change.
   */
  private readonly nodeCache = new TtlCache<FigmaNode>(30_000);
  /** File metadata (lastModified) — 60s TTL. Used for cross-restart cache invalidation. */
  private readonly fileMetaCache = new TtlCache<string>(60_000);
  /**
   * The `lastModified` we last saw per fileKey. When it moves, every artefact
   * cached for that file is suspect and gets dropped — a cheap truth signal is a
   * better invalidator than a timer.
   */
  private readonly lastSeenModified = new Map<string, string>();
  /** The user action whose explicit revalidation we already performed. */
  private lastRevalidatedCheckId: string | undefined;
  /** Persistent on-disk cache (gitignored sidecar). Optional. */
  private readonly persistentCache: PersistentCache | null;

  constructor(ctx: EngineContext) {
    this.pat = ctx.figmaPat;
    this.persistentCache = ctx.cachePath ? new PersistentCache(ctx.cachePath) : null;
  }

  async checkDrift(input: CheckDriftInput): Promise<DriftReport> {
    if (!this.pat) {
      throw new Error(
        "[design-sync] FIGMA_PAT env var is not set; cannot call Figma REST.",
      );
    }
    const { fileKey, nodeId } = input.nodeRef;
    const startedAt = Date.now();
    const hitsBefore = this.variablesCache.hits + this.nodeCache.hits;
    const missesBefore = this.variablesCache.misses + this.nodeCache.misses;

    // A deliberate Check drift is a request for the truth, so it never reads
    // Figma out of a timer-backed cache. A bulk run keeps its caches — that is
    // what makes ~90 stories affordable.
    const explicit = input.trigger !== "bulk";
    if (explicit) {
      await this.revalidateBeforeExplicitCheck(fileKey, input.checkId);
    } else {
      await this.dropCachesIfFileChanged(fileKey);
    }

    // Persistent-cache short-circuit. Cheap path: fetch only file metadata
    // (one tiny HTTP call, cached for 60s) and check whether the cached
    // report is still valid for this story + snapshot. Hit → return
    // immediately, no node/variables fetch, no engine work.
    //
    // Skipped for an explicit check: the entry is keyed on the file's
    // `lastModified`, so it can only be trusted to the same degree that signal
    // can, and the whole point of the click is not to trust a timestamp. Bulk
    // runs (and cold starts after a restart) still get the full benefit, and an
    // explicit check still *writes* the cache below.
    // Loaded either way: an explicit check skips the *read* but still writes,
    // and writing without having loaded would drop every other story's entry.
    // The alias map is part of what produced a report's verdicts, so it is part
    // of the cache identity: adding the alias that turns 89 false drift rows into
    // advisories must not leave a bulk run replaying the pre-alias report.
    const aliases: TokenAliasMap = input.tokenAliases ?? {};
    const aliasKey = aliasSignature(aliases);

    if (this.persistentCache) await this.persistentCache.load();
    if (this.persistentCache && !explicit) {
      const fileLastModified = await this.fetchFileLastModified(fileKey).catch(() => "");
      const cached = this.persistentCache.get(
        input.storyId,
        fileLastModified,
        input.snapshot,
        input.children,
        aliasKey,
      );
      if (cached) {
        return {
          ...cached,
          generatedAt: new Date().toISOString(),
          timing: {
            totalMs: Date.now() - startedAt,
            figmaFetchMs: 0,
            cacheHits: 1,
            cacheMisses: 0,
          },
        };
      }
    }

    const figmaT0 = Date.now();
    const node = await this.fetchNodeWithInheritedBindings(fileKey, nodeId);
    const variables = await this.fetchLocalVariables(fileKey).catch(() => null);
    const figmaFetchMs = Date.now() - figmaT0;

    const dimensions: DimensionDiff[] = [];
    const snapshot = input.snapshot;
    const activeMode = input.mode;

    // props runs first so the variant-set check can see whether the same axes
    // were already compared against the story args (in which case its own,
    // weaker class-based comparison has nothing to add). Push order below is
    // unchanged — the panel's row order is not affected.
    const propsDiffs = this.diffProps(node, input.args);

    // Values first, and kept: the binding diff needs them to tell a name-only
    // divergence (advisory) from a genuine defect (drift). See issue #57.
    const valueDiffs = this.diffTokenValues(node, snapshot, variables, activeMode);
    dimensions.push(...valueDiffs);
    dimensions.push(
      ...this.diffTokenBindings(node, snapshot, variables, activeMode, { aliases, valueDiffs }),
    );
    dimensions.push(...this.diffVariantSet(node, snapshot, input.storyId, propsDiffs));
    dimensions.push(...this.diffCopy(node, snapshot));
    dimensions.push(...propsDiffs);
    // `structure` — Figma auto-layout vs computed CSS layout. Emits nothing
    // unless BOTH sides are laying out children (see `layout.ts`), which is why
    // it can be shown at all.
    dimensions.push(...layoutRows(node, snapshot?.styles));

    // Declared child bindings. Nothing runs — and no `children` field appears on
    // the report — when the registry entry has no `children` key, which is what
    // keeps legacy entries byte-identical.
    let childReports: ChildBindingReport[] | undefined;
    if (input.children && input.children.length > 0) {
      const outcome = await this.diffChildren(
        {
          fileKey,
          storyId: input.storyId,
          registryPath: input.registryPath ?? ".design-sync/registry.json",
        },
        input.children,
        variables,
        activeMode,
        aliases,
      );
      dimensions.push(...outcome.dimensions);
      childReports = outcome.reports;
    }

    // Reserved kinds — engine fills as flag-only placeholders. `structure` left
    // this list in v0.0.39: it now emits real comparisons (see `layoutRows`
    // above), and a placeholder alongside them would be a row claiming the
    // dimension does nothing.
    dimensions.push(this.placeholder("motion", "story.motion"));

    const report: DriftReport = {
      storyId: input.storyId,
      nodeId,
      dimensions,
      generatedAt: new Date().toISOString(),
      timing: {
        totalMs: Date.now() - startedAt,
        figmaFetchMs,
        cacheHits: this.variablesCache.hits + this.nodeCache.hits - hitsBefore,
        cacheMisses: this.variablesCache.misses + this.nodeCache.misses - missesBefore,
      },
    };
    if (activeMode) report.mode = activeMode;
    if (childReports) report.children = childReports;

    // Stash for future short-circuits.
    if (this.persistentCache) {
      const fileLastModified = await this.fetchFileLastModified(fileKey).catch(() => "");
      if (fileLastModified) {
        this.persistentCache.set(
          input.storyId,
          fileLastModified,
          input.snapshot,
          report,
          input.children,
          aliasKey,
        );
      }
    }

    return report;
  }

  /**
   * Pre-fetch everything a **Check all** run shares: the file's `lastModified`
   * (one tiny request, and the invalidator every story's cache lookup consults)
   * and the file's local variables (the big one — every resolved token value in
   * every story comes out of it).
   *
   * Issue #56: on a cold run this work happened inside the *first story's* 8s
   * budget. Live numbers: `ui-button--primary` 8016ms ✗ timed out, then
   * `ui-button--primary-small` 1959ms ✓, `ui-button--primary-disabled` 1130ms ✓.
   * The first story wasn't slow — it was paying for the other nine. Hoisted here,
   * it is charged to the run, and each story's budget covers only its own work.
   *
   * Never throws. A warm-up that fails (no PAT, 403, network) leaves the caches
   * cold and the per-story path fetches exactly as it did before; the run is
   * slower, not wrong.
   */
  async warm(fileKey: string): Promise<void> {
    if (!this.pat) return;
    await this.dropCachesIfFileChanged(fileKey).catch(() => undefined);
    await this.fetchLocalVariables(fileKey).catch(() => null);
  }

  /* ---- cache freshness ---------------------------------------------------- *
   *
   * Two mechanisms, and both are needed:
   *
   *  (a) **Revalidate on a cheap truth signal.** The file's `lastModified` is one
   *      small request. When it moves, everything cached for that file is
   *      suspect and gets dropped. This is strictly better than a timer, and it
   *      is what keeps a long bulk run honest without re-fetching per story.
   *
   *  (b) **Bypass on an explicit check.** (a) is only as good as its signal, and
   *      we have NOT verified against live Figma that editing a *variable value*
   *      (as opposed to a node) bumps the consuming file's `lastModified` — a
   *      published-library value in particular may not, until the update is
   *      accepted in the file. So an explicit Check drift drops this file's
   *      variables and nodes unconditionally rather than asking a timestamp for
   *      permission. This is the mechanism the correctness guarantee rests on;
   *      (a) is the optimisation that extends some of it to bulk runs.
   */

  /** Drop every in-memory artefact cached for one file. */
  private invalidateFile(fileKey: string): void {
    this.variablesCache.delete(fileKey);
    this.nodeCache.deleteWhere((key) => key.startsWith(`${fileKey}:`));
    this.parentMaps.delete(fileKey);
  }

  /**
   * (a) — compare the file's `lastModified` against the last one we saw and drop
   * this file's caches when it moved. Uses the 60s-cached metadata value, so a
   * bulk run pays at most one extra request per minute and still shares a single
   * variables fetch for the run.
   */
  private async dropCachesIfFileChanged(fileKey: string): Promise<void> {
    const current = await this.fetchFileLastModified(fileKey).catch(() => "");
    if (!current) return;
    const previous = this.lastSeenModified.get(fileKey);
    this.lastSeenModified.set(fileKey, current);
    if (previous !== undefined && previous !== current) this.invalidateFile(fileKey);
  }

  /**
   * (b) — prepare for a user-initiated check: re-read `lastModified` with its own
   * cache bypassed, then drop this file's variables and nodes regardless of what
   * it says.
   *
   * Runs **once per user action**: a dual-mode check calls `checkDrift` twice for
   * one press, and invalidating between the two passes would double the request
   * count for no gain (nothing can have changed between them). Callers that pass
   * no `checkId` are treated as a fresh action — correctness over speed.
   */
  private async revalidateBeforeExplicitCheck(
    fileKey: string,
    checkId: string | undefined,
  ): Promise<void> {
    if (checkId !== undefined && checkId === this.lastRevalidatedCheckId) return;
    this.lastRevalidatedCheckId = checkId;
    this.fileMetaCache.delete(fileKey);
    await this.dropCachesIfFileChanged(fileKey);
    this.invalidateFile(fileKey);
  }

  /**
   * Fetch the file's `lastModified` timestamp via the lightest possible
   * call. `depth=1` keeps the response small; only the top-level metadata
   * is needed. Cached in-process for 60s — bulk runs share one fetch.
   */
  private async fetchFileLastModified(fileKey: string): Promise<string> {
    const cached = this.fileMetaCache.get(fileKey);
    if (cached) return cached;
    const url = `${FIGMA_API}/files/${encodeURIComponent(fileKey)}?depth=1`;
    const res = await throttledFetch(url, { headers: this.headers() });
    if (!res.ok) {
      // Swallow — without a metadata fetch we just skip the persistent cache.
      return "";
    }
    const data = (await res.json()) as { lastModified?: string };
    const value = data.lastModified ?? "";
    if (value) this.fileMetaCache.set(fileKey, value);
    return value;
  }

  // ---- HTTP ---------------------------------------------------------------

  /**
   * Fetch the registered node and, if it is a COMPONENT inside a COMPONENT_SET,
   * merge the parent's `boundVariables` underneath the variant's so inherited
   * padding/radius bindings don't read as `flag-only`. Variant overrides win.
   */
  private async fetchNodeWithInheritedBindings(
    fileKey: string,
    nodeId: string,
  ): Promise<FigmaNode> {
    const node = await this.fetchNode(fileKey, nodeId);
    if (node.type !== "COMPONENT") return node;

    const parents = await this.fetchComponentParentsMap(fileKey).catch(() => null);
    const parentId = parents?.get(nodeId);
    if (!parentId) return node;

    const parent = await this.fetchNode(fileKey, parentId).catch(() => null);
    if (!parent || parent.type !== "COMPONENT_SET") return node;

    return mergeInheritedBindings(node, parent);
  }

  private async fetchNode(fileKey: string, nodeId: string): Promise<FigmaNode> {
    const cacheKey = `${fileKey}:${nodeId}`;
    const cached = this.nodeCache.get(cacheKey);
    if (cached) return cached;

    const url = `${FIGMA_API}/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`;
    const res = await throttledFetch(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`[design-sync] Figma REST ${res.status} for node ${nodeId}.`);
    }
    const data = (await res.json()) as FigmaNodesResponse;
    const entry = data.nodes[nodeId];
    if (!entry) {
      throw new Error(`[design-sync] Figma node ${nodeId} not found in ${fileKey}.`);
    }
    this.nodeCache.set(cacheKey, entry.document);
    return entry.document;
  }

  /**
   * Fetch several nodes in **one** request. `GET /files/:key/nodes` takes a
   * comma-separated `ids` list, so a 3-child component costs exactly one HTTP
   * call, not three — and zero calls when the 30s node cache already holds them
   * (a bulk run re-checking the same story). Goes through `throttledFetch` like
   * every other call, so the concurrency gate and 429 backoff apply unchanged.
   *
   * Ids the response doesn't contain are reported back as unreachable rather
   * than thrown: one bad child binding must not abort the whole report, and it
   * must not vanish either.
   */
  private async fetchNodesBatch(
    fileKey: string,
    nodeIds: readonly string[],
  ): Promise<{ nodes: Map<string, FigmaNode>; unreachable: Map<string, string> }> {
    const nodes = new Map<string, FigmaNode>();
    const unreachable = new Map<string, string>();
    const misses: string[] = [];
    for (const id of new Set(nodeIds)) {
      const cached = this.nodeCache.get(`${fileKey}:${id}`);
      if (cached) nodes.set(id, cached);
      else misses.push(id);
    }
    if (misses.length === 0) return { nodes, unreachable };

    const ids = misses.map((id) => encodeURIComponent(id)).join(",");
    const url = `${FIGMA_API}/files/${encodeURIComponent(fileKey)}/nodes?ids=${ids}`;
    let res: Response;
    try {
      res = await throttledFetch(url, { headers: this.headers() });
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      for (const id of misses) unreachable.set(id, detail);
      return { nodes, unreachable };
    }
    if (!res.ok) {
      for (const id of misses) unreachable.set(id, `Figma REST ${res.status}`);
      return { nodes, unreachable };
    }
    const data = (await res.json()) as FigmaNodesResponse;
    for (const id of misses) {
      const entry = data.nodes?.[id];
      if (entry?.document) {
        this.nodeCache.set(`${fileKey}:${id}`, entry.document);
        nodes.set(id, entry.document);
      } else {
        unreachable.set(id, `no node with that id in file ${fileKey}`);
      }
    }
    return { nodes, unreachable };
  }

  /**
   * Compare each declared child element against its own Figma node, through the
   * same diff methods the root uses — so every CSS property the root supports
   * (padding, radii, borders, gap, the full typography set, shadows, colours)
   * works for a child with no per-property wiring.
   *
   * Two root-only dimensions are deliberately **not** run for children:
   *
   *  - `variant-set` compares Figma variant values against modifier classes.
   *    A child element is not a variant of anything; the check's premise is
   *    structurally false there, and on a child with any class at all it would
   *    emit "code variants not declared in Figma" — a confident signal that
   *    doesn't apply.
   *  - `props` compares Figma component properties against the **story's** args.
   *    Those args describe the component, not its header; matching them against
   *    a child node's (usually absent) properties can only produce noise.
   *
   * Both are reported once, for the root, where they mean something.
   */
  private async diffChildren(
    ctx: { fileKey: string; storyId: string; registryPath: string },
    children: readonly ChildTarget[],
    variables: FigmaLocalVariablesResponse | null,
    activeMode: string | undefined,
    aliases: TokenAliasMap,
  ): Promise<{ dimensions: DimensionDiff[]; reports: ChildBindingReport[] }> {
    const { fileKey } = ctx;
    const dimensions: DimensionDiff[] = [];
    const reports: ChildBindingReport[] = [];

    const comparable = children.filter((c) => !c.problem && c.snapshot && c.nodeId);
    const { nodes, unreachable } =
      comparable.length > 0
        ? await this.fetchNodesBatch(
            fileKey,
            comparable.map((c) => c.nodeId),
          )
        : { nodes: new Map<string, FigmaNode>(), unreachable: new Map<string, string>() };

    for (const child of children) {
      // Resolution already failed upstream (bad selector, no/ambiguous match,
      // malformed registry value). Pass the reason through untouched.
      if (child.problem || !child.snapshot || !child.nodeId) {
        reports.push({
          selector: child.selector,
          nodeId: child.nodeId,
          status: child.problem?.status ?? "snapshot-missing",
          message: child.problem?.message ?? "",
          rowCount: 0,
        });
        continue;
      }
      let node = nodes.get(child.nodeId);
      // A child bound to a nested COMPONENT (an instance of another library
      // component) gets the same COMPONENT_SET inheritance merge the root does,
      // so bindings declared on the parent set don't read as "Figma declares
      // nothing". Costs no extra node request: the batch already warmed the
      // cache `fetchNode` reads from.
      if (node?.type === "COMPONENT") {
        node = await this.fetchNodeWithInheritedBindings(fileKey, child.nodeId).catch(() => node!);
      }
      if (!node) {
        reports.push({
          selector: child.selector,
          nodeId: child.nodeId,
          status: "node-unreachable",
          message: formatChildProblem({
            status: "node-unreachable",
            selector: child.selector,
            storyId: ctx.storyId,
            registryPath: ctx.registryPath,
            nodeId: child.nodeId,
            detail: unreachable.get(child.nodeId),
          }),
          rowCount: 0,
        });
        continue;
      }

      // Per element, exactly as for the root: this child's own value diffs are
      // what its binding rows are triaged against.
      const childValueDiffs = this.diffTokenValues(node, child.snapshot, variables, activeMode);
      const rows = [
        ...childValueDiffs,
        ...this.diffTokenBindings(node, child.snapshot, variables, activeMode, {
          aliases,
          valueDiffs: childValueDiffs,
        }),
        ...this.diffCopy(node, child.snapshot),
        // A declared child is very often the flex container that matters (a
        // Card's header row), so it gets the same layout comparison as the root
        // — and the same applicability guard.
        ...layoutRows(node, child.snapshot.styles),
      ];
      for (const row of rows) row.childSelector = child.selector;
      dimensions.push(...rows);
      const report: ChildBindingReport = {
        selector: child.selector,
        nodeId: child.nodeId,
        status: "compared",
        rowCount: rows.length,
      };
      if (node.name) report.nodeName = node.name;
      reports.push(report);
    }

    return { dimensions, reports };
  }

  /**
   * Build a `componentNodeId → containing_frame.nodeId` map from the file's
   * components endpoint. Cached per fileKey.
   *
   * Returns an empty map on 403/404 (e.g. PAT scope insufficient) — callers
   * fall back to no inheritance, which matches v0 behavior.
   */
  private async fetchComponentParentsMap(fileKey: string): Promise<Map<string, string>> {
    const cached = this.parentMaps.get(fileKey);
    if (cached) return cached;
    const url = `${FIGMA_API}/files/${encodeURIComponent(fileKey)}/components`;
    const res = await throttledFetch(url, { headers: this.headers() });
    if (!res.ok) {
      const empty = new Map<string, string>();
      this.parentMaps.set(fileKey, empty);
      return empty;
    }
    const data = (await res.json()) as {
      meta?: { components?: Array<{ node_id: string; containing_frame?: { nodeId?: string } }> };
    };
    const map = new Map<string, string>();
    for (const c of data.meta?.components ?? []) {
      const parent = c.containing_frame?.nodeId;
      if (parent) map.set(c.node_id, parent);
    }
    this.parentMaps.set(fileKey, map);
    return map;
  }

  private async fetchLocalVariables(fileKey: string): Promise<FigmaLocalVariablesResponse | null> {
    const cached = this.variablesCache.get(fileKey);
    if (cached) return cached;

    const url = `${FIGMA_API}/files/${encodeURIComponent(fileKey)}/variables/local`;
    const res = await throttledFetch(url, { headers: this.headers() });
    if (res.status === 404 || res.status === 403) return null; // not enterprise / no access
    if (!res.ok) {
      throw new Error(`[design-sync] Figma variables ${res.status} for ${fileKey}.`);
    }
    const data = (await res.json()) as FigmaLocalVariablesResponse;
    this.variablesCache.set(fileKey, data);
    return data;
  }

  private headers(): Record<string, string> {
    return { "X-Figma-Token": this.pat ?? "" };
  }

  // ---- Diff logic ---------------------------------------------------------

  private diffTokenValues(
    node: FigmaNode,
    snapshot: CodeSnapshot | undefined,
    variables: FigmaLocalVariablesResponse | null,
    activeMode?: string,
  ): DimensionDiff[] {
    const out: DimensionDiff[] = [];
    if (!snapshot) return out;

    // Background color: code "background-color" vs Figma fills[0] (resolved).
    const codeBg = snapshot.styles["background-color"];
    const figmaBg = resolveFillColor(node, variables, activeMode);
    if (!isTransparentColor(codeBg) || figmaBg !== undefined) {
      const modes = figmaBg?.modes;
      const figmaValue = figmaBg?.value;
      const status = colorRowStatus(codeBg, figmaValue);
      const diff: DimensionDiff = {
        kind: "token-value",
        property: "background-color",
        codeValue: codeBg ?? null,
        figmaValue: figmaValue ?? null,
        status,
      };
      if (modes) diff.modes = modes;
      if (figmaBg?.tokenName) diff.tokenName = figmaBg.tokenName;
      out.push(diff);
    }

    // Numeric Figma boundVariables → resolved float, compared to computed CSS px.
    const numericMap: Array<[string, string]> = [
      ["paddingTop", "padding-top"],
      ["paddingRight", "padding-right"],
      ["paddingBottom", "padding-bottom"],
      ["paddingLeft", "padding-left"],
    ];
    for (const [figmaKey, cssProp] of numericMap) {
      const alias = node.boundVariables?.[figmaKey];
      const aliasObj = Array.isArray(alias) ? alias[0] : alias;
      if (!aliasObj || !variables) continue;
      const v = variables.meta.variables[aliasObj.id];
      if (!v || v.resolvedType !== "FLOAT") continue;
      const figmaPx = resolveNumericForMode(v, variables, activeMode);
      if (figmaPx === null) continue;
      const codeValue = snapshot.styles[cssProp];
      const codePx = parsePx(codeValue);
      const status: DimensionDiff["status"] =
        codePx !== null && Math.abs(codePx - figmaPx) < 0.5 ? "match" : "drift";
      out.push({
        kind: "token-value",
        property: cssProp,
        codeValue: codeValue ?? null,
        figmaValue: `${figmaPx}px (token: ${v.name})`,
        status,
        tokenName: v.name,
      });
    }

    // Border radius: Figma stores per-corner aliases.
    const radiusKeys: Array<[string, string]> = [
      ["RECTANGLE_TOP_LEFT_CORNER_RADIUS", "border-top-left-radius"],
      ["RECTANGLE_TOP_RIGHT_CORNER_RADIUS", "border-top-right-radius"],
      ["RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS", "border-bottom-left-radius"],
      ["RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS", "border-bottom-right-radius"],
    ];
    const corners = node.boundVariables?.rectangleCornerRadii as
      | Record<string, FigmaVariableAlias>
      | undefined;
    // Map cssProp → raw-node-field for the fallback path. Figma surfaces
    // per-corner raw radii under `topLeftRadius` etc. when the node has
    // explicit values, plus the shorthand `cornerRadius` when all four
    // corners share a value. We use these when no variable binding exists.
    const rawCornerFields: Record<string, string> = {
      "border-top-left-radius": "topLeftRadius",
      "border-top-right-radius": "topRightRadius",
      "border-bottom-left-radius": "bottomLeftRadius",
      "border-bottom-right-radius": "bottomRightRadius",
    };

    for (const [figmaKey, cssProp] of radiusKeys) {
      let figmaPx: number | null = null;
      let tokenName: string | undefined;

      // Path 1: variable-bound corner — same as before, carries tokenName
      // so the value-drift Apply path can promote a code literal to var().
      const alias = corners?.[figmaKey];
      if (alias && variables) {
        const v = variables.meta.variables[alias.id];
        if (v && v.resolvedType === "FLOAT") {
          const resolved = resolveNumericForMode(v, variables, activeMode);
          if (resolved !== null) {
            figmaPx = resolved;
            tokenName = v.name;
          }
        }
      }

      // Path 2: raw px — Figma's UI lets you type a value without binding
      // it to a token. Previously we emitted no row in this case, which
      // hid real drift. Now we surface it with the raw figmaValue so the
      // user at least sees the divergence; the row lands in the
      // informational section because there's no token name to promote
      // the code literal to.
      if (figmaPx === null) {
        const rawField = rawCornerFields[cssProp];
        if (rawField) {
          const raw = (node as Record<string, unknown>)[rawField];
          if (typeof raw === "number") {
            figmaPx = raw;
          } else if (raw === undefined) {
            // Fallback to the shorthand `cornerRadius` when corners are
            // uniform — Figma sometimes only sets the shorthand.
            const uniform = (node as Record<string, unknown>).cornerRadius;
            if (typeof uniform === "number") figmaPx = uniform;
          }
        }
      }

      if (figmaPx === null) continue;
      const codeValue = snapshot.styles[cssProp];
      const codePx = parsePx(codeValue);
      const status: DimensionDiff["status"] =
        codePx !== null && Math.abs(codePx - figmaPx) < 0.5 ? "match" : "drift";
      const dim: DimensionDiff = {
        kind: "token-value",
        property: cssProp,
        codeValue: codeValue ?? null,
        figmaValue: tokenName ? `${figmaPx}px (token: ${tokenName})` : `${figmaPx}px`,
        status,
      };
      if (tokenName) dim.tokenName = tokenName;
      else if (status === "drift") {
        dim.note =
          "Figma corner has no variable binding; bind it to a radius token in Figma to enable auto-apply.";
      }
      out.push(dim);
    }

    // Gap — frames carry `itemSpacing` either bound to a variable or as a
    // raw number on `node.itemSpacing`. Match-on-px first, then fall back
    // to raw.
    {
      const gapAlias = node.boundVariables?.itemSpacing;
      const aliasObj = Array.isArray(gapAlias) ? gapAlias[0] : gapAlias;
      let figmaGap: { value: number; tokenName?: string } | undefined;
      if (aliasObj && variables) {
        const v = variables.meta.variables[aliasObj.id];
        if (v && v.resolvedType === "FLOAT") {
          const px = resolveNumericForMode(v, variables, activeMode);
          if (px !== null) figmaGap = { value: px, tokenName: v.name };
        }
      }
      if (!figmaGap && typeof node.itemSpacing === "number") {
        figmaGap = { value: node.itemSpacing as number };
      }
      const codeValue = snapshot.styles["gap"];
      const codePx = parsePx(codeValue);
      // `getComputedStyle().gap` returns the keyword `"normal"` when no
      // gap is set on a non-flex/non-grid element — code has no opinion
      // there. Treat as flag-only when Figma has a value, otherwise skip.
      const codeHasNoOpinion = codeValue === "normal" || codeValue === undefined || codeValue === "";
      if (figmaGap || codePx !== null) {
        let status: DimensionDiff["status"];
        if (codeHasNoOpinion && figmaGap) status = "flag-only";
        else if (figmaGap && codePx !== null && Math.abs(codePx - figmaGap.value) < 0.5) status = "match";
        else status = "drift";
        out.push({
          kind: "token-value",
          property: "gap",
          codeValue: codeValue ?? null,
          figmaValue: figmaGap
            ? figmaGap.tokenName
              ? `${figmaGap.value}px (token: ${figmaGap.tokenName})`
              : `${figmaGap.value}px`
            : null,
          status,
          ...(figmaGap?.tokenName ? { tokenName: figmaGap.tokenName } : {}),
          ...(codeHasNoOpinion && figmaGap
            ? { note: "Code has no `gap` declared (default `normal`); Figma specifies a value." }
            : {}),
        });
      }
    }

    // Border width & color — only report when Figma actually has a visible
    // border (non-empty `strokes` array OR a bound stroke variable). Figma's
    // `strokeWeight` defaults to 1 on every variant template even when no
    // stroke is drawn, so guarding on `strokeWeight > 0` alone produces
    // false-positive rows for icon-only / borderless components.
    const figmaHasVisibleStroke =
      Array.isArray(node.strokes) && (node.strokes as FigmaPaint[]).length > 0;

    // The element may draw its border on any single edge (commonly
    // border-bottom for separator rows) rather than uniformly. Pick
    // whichever edge actually has a non-zero width so the comparison
    // matches reality. Falls back to the top edge when none drawn.
    const codeBorderEdge = pickBorderEdge(snapshot.styles);
    const codeBorderPx = parsePx(snapshot.styles[`border-${codeBorderEdge}-width`]) ?? 0;
    if (figmaHasVisibleStroke || codeBorderPx > 0) {
      const weightAlias = node.boundVariables?.strokeWeight;
      const aliasObj = Array.isArray(weightAlias) ? weightAlias[0] : weightAlias;
      let figmaWeight: { value: number; tokenName?: string } | undefined;
      if (aliasObj && variables) {
        const v = variables.meta.variables[aliasObj.id];
        if (v && v.resolvedType === "FLOAT") {
          const px = resolveNumericForMode(v, variables, activeMode);
          if (px !== null) figmaWeight = { value: px, tokenName: v.name };
        }
      }
      if (!figmaWeight && figmaHasVisibleStroke && typeof node.strokeWeight === "number") {
        figmaWeight = { value: node.strokeWeight as number };
      }
      const codeValue = snapshot.styles[`border-${codeBorderEdge}-width`];
      const codePx = parsePx(codeValue);
      if (figmaWeight || (codePx !== null && codePx > 0)) {
        const status: DimensionDiff["status"] =
          figmaWeight && codePx !== null && Math.abs(codePx - figmaWeight.value) < 0.5 ? "match" : "drift";
        out.push({
          kind: "token-value",
          property: "border-width",
          codeValue: codeValue ?? null,
          figmaValue: figmaWeight
            ? figmaWeight.tokenName
              ? `${figmaWeight.value}px (token: ${figmaWeight.tokenName})`
              : `${figmaWeight.value}px`
            : null,
          status,
          ...(figmaWeight?.tokenName ? { tokenName: figmaWeight.tokenName } : {}),
        });
      }
    }

    // Border color — same guard. `strokes[0]` mirrors `fills[0]` shape.
    if (figmaHasVisibleStroke) {
      const stroke = (node.strokes as FigmaPaint[])?.[0];
      let figmaStroke: ResolvedFill | undefined;
      let strokeTokenName: string | undefined;
      if (stroke) {
        const alias = stroke.boundVariables?.color;
        if (alias && variables) {
          figmaStroke = resolveColorVariable(alias.id, variables, activeMode);
          const v = variables.meta.variables[alias.id];
          if (v) strokeTokenName = v.name;
        }
        if (!figmaStroke && stroke.color) {
          figmaStroke = { value: rgbaToCss(stroke.color) };
        }
      }
      const codeValue = snapshot.styles[`border-${codeBorderEdge}-color`];
      if (figmaStroke || !isTransparentColor(codeValue)) {
        const status = colorRowStatus(codeValue, figmaStroke?.value);
        const diff: DimensionDiff = {
          kind: "token-value",
          property: "border-color",
          codeValue: codeValue ?? null,
          figmaValue: figmaStroke?.value ?? null,
          status,
        };
        if (figmaStroke?.modes) diff.modes = figmaStroke.modes;
        if (strokeTokenName) diff.tokenName = strokeTokenName;
        out.push(diff);
      }
    }

    // Effects (DROP_SHADOW / INNER_SHADOW → box-shadow). Figma's REST node
    // response carries the *resolved* effect array, so that — not the
    // `effects` variable binding, whose value is an effect object rather than
    // a number/colour — is what gets compared. Both sides are parsed into
    // structured shadows before comparison: the computed CSS string puts the
    // colour first and `inset` last, so no string compare could ever match
    // Figma's field order (`box-shadow.ts` has the details, including which
    // effect shapes are excluded outright).
    {
      const effects = node.effects as FigmaEffect[] | undefined;
      const codeValue = snapshot.styles["box-shadow"];
      const resolveEffectColor = (effect: FigmaEffect): string | undefined => {
        const alias = pickAlias(
          (effect as { boundVariables?: Record<string, FigmaVariableAlias | FigmaVariableAlias[]> })
            .boundVariables?.["color"],
        );
        if (alias && variables) {
          const resolved = resolveColorVariable(alias.id, variables, activeMode);
          if (resolved) return resolved.value;
        }
        return effect.color ? rgbaToCss(effect.color) : undefined;
      };
      const figma = figmaEffectsToShadows(effects, resolveEffectColor);
      const code = parseCssBoxShadow(codeValue);
      // Any excluded effect shape, an unreadable Figma side, or an unparseable
      // code side means there is no faithful comparison to make — emit nothing
      // rather than a verdict about a shadow we only partly understand. Both
      // sides at "no shadow" carries no information either.
      if (
        figma !== null &&
        figma.excluded.length === 0 &&
        code !== null &&
        !(figma.shadows.length === 0 && code.length === 0)
      ) {
        // The bound `effects` variable's name, for display only.
        let tokenName: string | undefined;
        const effectAlias = pickAlias(
          node.boundVariables?.effects as FigmaVariableAlias | FigmaVariableAlias[] | undefined,
        );
        if (effectAlias && variables) {
          const v = variables.meta.variables[effectAlias.id];
          if (v) tokenName = v.name;
        }
        const figmaShadow = formatShadows(figma.shadows);
        const status: DimensionDiff["status"] = shadowsEqual(figma.shadows, code)
          ? "match"
          : "drift";
        out.push({
          kind: "token-value",
          property: "box-shadow",
          codeValue: codeValue ?? null,
          figmaValue: tokenName ? `${figmaShadow} (token: ${tokenName})` : figmaShadow,
          status,
          ...(tokenName ? { tokenName } : {}),
        });
      }
    }

    // Opacity — `node.opacity` against computed `opacity`. Directly
    // comparable: Figma's node opacity and CSS `opacity` both scale the whole
    // element including its children, on the same 0..1 scale, so this needs no
    // unit conversion and no heuristics.
    //
    // Three shapes, and the distinction between them is the whole honesty of
    // the row:
    //   - The snapshot has no `opacity` key at all (a preview bundle older than
    //     the property). No comparison is possible — emit nothing rather than
    //     read a missing value as 0 or 1.
    //   - Figma omits `opacity` (the common case: it is only serialized when
    //     it isn't 1) AND the code computes 1. Both sides are at the default and
    //     neither said anything — no row, same rule the box-shadow comparison
    //     uses for "no shadow on either side".
    //   - Otherwise compare. When Figma's side is the implicit default, the note
    //     says so, so a drift row can't be misread as "the designer set 1 here".
    {
      const rawCode = snapshot.styles["opacity"];
      const figmaRaw = (node as Record<string, unknown>)["opacity"];
      const figmaExplicit = typeof figmaRaw === "number" && Number.isFinite(figmaRaw);
      const figmaOpacity = figmaExplicit ? (figmaRaw as number) : 1;
      const codeOpacity = rawCode === undefined ? null : Number.parseFloat(rawCode);
      const codeUsable = codeOpacity !== null && Number.isFinite(codeOpacity);
      const bothDefault = !figmaExplicit && codeUsable && Math.abs(codeOpacity! - 1) < 0.001;
      if (rawCode !== undefined && !bothDefault) {
        // A bound variable gives the row a token name, so a drifted literal can
        // be promoted to `var(--token)` the same way padding is.
        let tokenName: string | undefined;
        const alias = pickAlias(node.boundVariables?.["opacity"]);
        if (alias && variables) {
          const v = variables.meta.variables[alias.id];
          if (v && v.resolvedType === "FLOAT") tokenName = v.name;
        }
        const status: DimensionDiff["status"] = !codeUsable
          ? "flag-only"
          : Math.abs(codeOpacity! - figmaOpacity) < 0.001
            ? "match"
            : "drift";
        const notes: string[] = [];
        if (!figmaExplicit) {
          notes.push("Figma's node has no explicit opacity, which means 1.");
        }
        if (!codeUsable) {
          notes.push(`Computed \`opacity: ${rawCode}\` is not a number, so no comparison was made.`);
        }
        out.push({
          kind: "token-value",
          property: "opacity",
          codeValue: rawCode,
          figmaValue: tokenName ? `${figmaOpacity} (token: ${tokenName})` : String(figmaOpacity),
          status,
          ...(tokenName ? { tokenName } : {}),
          ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
        });
      }
    }

    // Typography — find the first TEXT descendant (or the node itself if it's
    // TEXT) and read its style + first fill. Inherited values resolve on the
    // code side via getComputedStyle even when the snapshot target isn't a
    // text element, so this gives consistent comparisons for buttons, tabs,
    // menu items, etc.
    const textNode = findFirstTextNode(node);
    if (textNode) {
      const ts = textNode.style as
        | (FigmaTypeStyle & {
            fontFamily?: string;
            fontPostScriptName?: string;
            fontWeight?: number;
            lineHeightPx?: number;
            lineHeightPercent?: number;
            lineHeightUnit?: string;
          })
        | undefined;
      const bound = textNode.boundVariables ?? {};

      // font-size
      pushTypographyNumeric({
        out,
        snapshot,
        variables,
        activeMode,
        cssProp: "font-size",
        rawValue: ts?.fontSize,
        alias: pickAlias(bound["fontSize"]),
      });
      // font-weight
      pushTypographyNumeric({
        out,
        snapshot,
        variables,
        activeMode,
        cssProp: "font-weight",
        rawValue: ts?.fontWeight,
        alias: pickAlias(bound["fontWeight"]),
        // weights aren't pixel values; compare as plain numbers
        unitless: true,
      });
      // line-height — Figma may store as px directly, percent of font size,
      // or `AUTO` / `INTRINSIC_%` (let the font metrics decide). The browser's
      // `line-height: normal` also resolves to a font-metric-derived px, so
      // when Figma is on auto we can't meaningfully compare against the
      // computed code value — both sides are "no opinion". Skip the row in
      // that case rather than reporting a guaranteed-drift number.
      const lineHeightUnit = (ts as { lineHeightUnit?: string } | undefined)?.lineHeightUnit;
      const figmaLineHeightIsAuto = lineHeightUnit === "AUTO" || lineHeightUnit === "INTRINSIC_%";
      let lineHeightPx: number | undefined;
      if (!figmaLineHeightIsAuto) {
        if (typeof ts?.lineHeightPx === "number" && ts.lineHeightPx > 0) {
          lineHeightPx = ts.lineHeightPx;
        } else if (
          typeof ts?.lineHeightPercent === "number" &&
          ts.lineHeightPercent > 0 &&
          typeof ts.fontSize === "number"
        ) {
          lineHeightPx = (ts.lineHeightPercent / 100) * ts.fontSize;
        }
      }
      // Only emit a row when Figma has an explicit opinion. When AUTO, both
      // sides are font-metric-driven — comparing px to px would always drift.
      if (!figmaLineHeightIsAuto) {
        pushTypographyNumeric({
          out,
          snapshot,
          variables,
          activeMode,
          cssProp: "line-height",
          rawValue: lineHeightPx,
          alias: pickAlias(bound["lineHeight"]),
        });
      }
      // font-family — string compare. Figma gives the display name; CSS
      // computed font-family returns a quoted, possibly multi-fallback string
      // (e.g. `"Nunito Sans", system-ui`). Match if Figma's value appears as
      // a substring of code's value (case-insensitive).
      {
        const codeValue = snapshot.styles["font-family"];
        let figmaFamily: string | undefined = ts?.fontFamily;
        let tokenName: string | undefined;
        const familyAlias = pickAlias(bound["fontFamily"]);
        if (familyAlias && variables) {
          const v = variables.meta.variables[familyAlias.id];
          if (v) {
            tokenName = v.name;
            if (v.resolvedType === "STRING") {
              const raw = resolveStringForMode(v, variables, activeMode);
              if (raw !== null) figmaFamily = raw;
            }
          }
        }
        if (figmaFamily || codeValue) {
          const codeNorm = (codeValue ?? "").toLowerCase().replace(/['"]/g, "");
          const figmaNorm = (figmaFamily ?? "").toLowerCase();
          const status: DimensionDiff["status"] =
            figmaFamily && codeNorm.includes(figmaNorm) ? "match" : "drift";
          out.push({
            kind: "token-value",
            property: "font-family",
            codeValue: codeValue ?? null,
            figmaValue: figmaFamily
              ? tokenName
                ? `${figmaFamily} (token: ${tokenName})`
                : figmaFamily
              : null,
            status,
            ...(tokenName ? { tokenName } : {}),
          });
        }
      }

      // color — text node's first fill (color or alias to color variable).
      {
        const codeValue = snapshot.styles["color"];
        let figmaColor: ResolvedFill | undefined;
        let colorTokenName: string | undefined;
        const fill = textNode.fills?.[0];
        if (fill) {
          const alias = fill.boundVariables?.color;
          if (alias && variables) {
            figmaColor = resolveColorVariable(alias.id, variables, activeMode);
            const v = variables.meta.variables[alias.id];
            if (v) colorTokenName = v.name;
          }
          if (!figmaColor && fill.color) figmaColor = { value: rgbaToCss(fill.color) };
        }
        if (codeValue || figmaColor) {
          const status = colorRowStatus(codeValue, figmaColor?.value);
          const diff: DimensionDiff = {
            kind: "token-value",
            property: "color",
            codeValue: codeValue ?? null,
            figmaValue: figmaColor?.value ?? null,
            status,
          };
          if (figmaColor?.modes) diff.modes = figmaColor.modes;
          if (colorTokenName) diff.tokenName = colorTokenName;
          out.push(diff);
        }
      }

      // letter-spacing / text-align / text-transform / text-decoration-line /
      // font-style. Gated on `ts` existing: without a `style` object we cannot
      // tell "not italic" from "this response carries no typography", and a
      // fabricated `normal` would be exactly the confident-but-inapplicable
      // signal these rows exist to avoid. See `text-style-map.ts` for the
      // per-property mapping and every case that deliberately emits no row.
      if (ts) {
        const letterSpacingAlias = pickAlias(bound["letterSpacing"]);
        let letterSpacingTokenName: string | undefined;
        if (letterSpacingAlias && variables) {
          const v = variables.meta.variables[letterSpacingAlias.id];
          if (v && v.resolvedType === "FLOAT") letterSpacingTokenName = v.name;
        }
        out.push(
          ...textStyleRows({
            style: ts,
            codeStyles: snapshot.styles,
            figmaChars: (textNode as { characters?: string }).characters,
            letterSpacingTokenName,
          }),
        );
      }
    }

    return out;
  }

  /**
   * The `token-binding` dimension: does the code bind the same design token the
   * Figma node does?
   *
   * `valueDiffs` is the `token-value` output for the SAME element, computed just
   * before this call. It is what lets a name divergence be triaged honestly
   * instead of being reported as drift on the strength of a name comparison
   * alone — see `nameDivergenceStatus` below and issue #57.
   */
  private diffTokenBindings(
    node: FigmaNode,
    snapshot: CodeSnapshot | undefined,
    variables: FigmaLocalVariablesResponse | null,
    activeMode: string | undefined,
    opts: { aliases: TokenAliasMap; valueDiffs: readonly DimensionDiff[] } = {
      aliases: {},
      valueDiffs: [],
    },
  ): DimensionDiff[] {
    const out: DimensionDiff[] = [];
    const bindings = snapshot?.bindings ?? {};
    const figmaBindings = collectFigmaBindings(node, variables, activeMode);

    const keys = new Set([...Object.keys(bindings), ...Object.keys(figmaBindings)]);
    for (const key of keys) {
      const codeValue = bindings[key];
      const figma = figmaBindings[key];
      // If either side has no declared binding, we don't actually know whether
      // there is drift — the token may be applied via CSS variables that this
      // engine can't see. Mark as flag-only rather than crying wolf.
      let status: DimensionDiff["status"];
      let note: string | undefined;
      let nameDivergence: NameDivergenceKind | undefined;
      let nameResolvedBy: "alias" | "heuristic" | undefined;
      if (!codeValue && !figma) continue;
      if (!codeValue) {
        status = "flag-only";
        note = "Code binding not declared (add a `data-token-*` attribute or `parameters.designSync.tokens` to surface).";
      } else if (!figma) {
        status = "flag-only";
        note = "Figma node has no bound variable for this property.";
      } else {
        // Two mechanisms, alias first. `tokenAliases` is the project stating that
        // two names are one decision; the heuristic collapses spellings
        // (`radius/xl` ≡ `radius-xl` ≡ `--radius-xl`) and can do no more than
        // that. Which one answered is recorded on the row.
        const match = matchTokenNames(codeValue, figma.tokenName, opts.aliases);
        if (match.same) {
          status = "match";
          nameResolvedBy = match.via;
          if (codeValue !== figma.tokenName) {
            note =
              match.via === "alias"
                ? `Same token by \`tokenAliases\` (${codeValue} ⇄ ${figma.tokenName}).`
                : `Same token, different naming convention (${codeValue} vs ${figma.tokenName}).`;
          }
        } else {
          // The names diverge. Whether that is a DEFECT depends entirely on the
          // value comparison, which is the whole of issue #57: a Tailwind
          // consumer binding `primary` against a library naming the same
          // decision `color/background/brand/default` produced ~10 "drift" rows
          // per story whose values matched exactly.
          const verdict = nameDivergenceStatus(key, opts.valueDiffs);
          if (verdict === "drift") {
            status = "drift";
            note = divergenceNote({
              codeValue,
              figmaName: figma.tokenName,
              kind: "drift",
              aliasExpected: match.aliasExpected,
            });
          } else {
            status = "advisory";
            nameDivergence = verdict;
            note = divergenceNote({
              codeValue,
              figmaName: figma.tokenName,
              kind: verdict,
              aliasExpected: match.aliasExpected,
            });
          }
        }
      }
      const diff: DimensionDiff = {
        kind: "token-binding",
        property: key,
        codeValue: codeValue ?? null,
        figmaValue: figma?.tokenName ?? null,
        status,
      };
      if (note) diff.note = note;
      if (nameDivergence) diff.nameDivergence = nameDivergence;
      if (nameResolvedBy) diff.nameResolvedBy = nameResolvedBy;
      if (figma?.modes) diff.modes = figma.modes;
      out.push(diff);
    }
    return out;
  }

  private diffVariantSet(
    node: FigmaNode,
    snapshot: CodeSnapshot | undefined,
    storyId: string,
    propsDiffs: DimensionDiff[] = [],
  ): DimensionDiff[] {
    // The preview already expands BEM-modifier classes and adjacent classes
    // (.file-item.active style) into a candidate set. Lowercase everything
    // here for case-insensitive matching.
    const codeVariants = new Set(
      (snapshot?.variantClasses ?? []).map((v) => v.toLowerCase()),
    );

    // Storybook stories don't emit class-based variant modifiers like
    // `.row--state-hover`, so without help we'd flag drift on every
    // variant story. Infer the variant from the story id suffix
    // (`molecules-rowboolean--checked-true-state-hover` →
    // `{Checked: "true", State: "Hover"}`) using Figma's prop names as
    // the parsing dictionary — that way `--state-picker-open` correctly
    // resolves to `{State: "PickerOpen"}` and not `{State: "picker",
    // open: ""}`.
    const figmaPropKeys =
      node.type === "COMPONENT" && node.name.includes("=")
        ? Object.keys(parseVariantName(node.name))
        : [];
    const inferredVariant = parseStoryVariantSuffix(storyId, figmaPropKeys);
    for (const v of Object.values(inferredVariant)) {
      codeVariants.add(v.toLowerCase());
    }

    // If this node is a single COMPONENT (a variant in a set), Figma encodes
    // the active variant as the node name "Property=Value, Other=Value".
    // Parse it as a structured Record<property, value> and compare each
    // property independently against code modifiers. This lets us:
    //   - skip falsy/default values (no modifier expected in code)
    //   - report per-property drift instead of collapsing to a string set
    //     where "false" looks identical to a real variant value
    if (node.type === "COMPONENT" && node.name.includes("=")) {
      const figmaProps = parseVariantName(node.name);
      const missing: string[] = [];
      const matched: string[] = [];
      const skipped: string[] = [];
      const evaluatedAxes: string[] = [];

      for (const [prop, value] of Object.entries(figmaProps)) {
        if (isFalsyVariantValue(value)) {
          skipped.push(`${prop}=${value}`);
          continue;
        }
        evaluatedAxes.push(prop);
        if (codeVariants.has(value.toLowerCase())) {
          matched.push(`${prop}=${value}`);
        } else {
          missing.push(`${prop}=${value}`);
        }
      }

      // Inapplicable (no modifier-class convention to reason about) or
      // redundant (props already confirmed every axis)? Then this row is a
      // confident signal that doesn't apply — emit nothing at all.
      if (
        !variantSetRowApplicable({
          rootClasses: snapshot?.rootClasses,
          evaluatedAxes,
          propsStatuses: propsStatusesByAxis(propsDiffs),
        })
      ) {
        return [];
      }

      const status: DimensionDiff["status"] = missing.length === 0 ? "match" : "drift";
      const diff: DimensionDiff = {
        kind: "variant-set",
        property: "active-variant",
        codeValue: [...codeVariants],
        figmaValue: figmaProps,
        status,
      };
      if (status === "drift") {
        diff.note = `Figma variants not present in code: [${missing.join(", ")}]`;
      } else if (skipped.length > 0) {
        diff.note = `Falsy/default skipped: [${skipped.join(", ")}]`;
      }
      return [diff];
    }

    // COMPONENT_SET: compare code-side variant classes to the option list.
    const figmaOptions = new Set<string>();
    if (node.componentPropertyDefinitions) {
      for (const def of Object.values(node.componentPropertyDefinitions)) {
        for (const opt of def.variantOptions ?? []) figmaOptions.add(opt.toLowerCase());
      }
    }
    if (codeVariants.size === 0 && figmaOptions.size === 0) return [];

    // Same premise, same suppression: comparing a utility class list against a
    // Figma component set's variant options is not a comparison. (No per-axis
    // `props` rows exist for a COMPONENT_SET, so only the evidence rule can
    // fire here.)
    if (!variantSetRowApplicable({ rootClasses: snapshot?.rootClasses })) return [];

    // Drift only if the code variant isn't a known Figma option.
    const unknownInFigma = [...codeVariants].filter((v) => !figmaOptions.has(v));
    const status: DimensionDiff["status"] = unknownInFigma.length === 0 ? "match" : "drift";
    const diff: DimensionDiff = {
      kind: "variant-set",
      property: "variant-options",
      codeValue: [...codeVariants],
      figmaValue: [...figmaOptions],
      status,
    };

    // Coverage warning: when the story registers against the SET rather than
    // a specific variant, value/binding diffs run against the set's root
    // node (typically inheriting from the first child). Surface that fact
    // so users know to pin to a variant for exact comparison.
    const notes: string[] = [];
    if (node.type === "COMPONENT_SET") {
      const firstVariant = node.children?.find((c) => c.type === "COMPONENT");
      if (firstVariant) {
        notes.push(
          `Registered node is the COMPONENT_SET. Value/binding diffs use the set root; ` +
            `first variant "${firstVariant.name}" → ${firstVariant.id}. ` +
            `Pin the registry to a specific variant node for exact comparison.`,
        );
      }
    }
    if (status === "drift") {
      notes.push(`code variants not declared in Figma: [${unknownInFigma.join(", ")}]`);
    }
    if (notes.length > 0) diff.note = notes.join(" ");
    return [diff];
  }

  /**
   * Compare Figma's variant properties (parsed from the registered variant
   * node's name) against Storybook story args. One row per Figma property.
   *
   * Matching strategy:
   *   - Falsy/default Figma values (false/default/off/no/none) → match by
   *     absence (no arg expected to carry that value)
   *   - "True" → look for an arg whose name resembles the Figma property
   *     (with `is`/`has` prefixes stripped) and is truthy
   *   - Anything else → look for any arg whose stringified value equals
   *     the Figma value (case-insensitive)
   *
   * Then, independently of the variant axes, Figma's **component properties**
   * (BOOLEAN / TEXT / INSTANCE_SWAP) are compared against the same args — see
   * `component-properties.ts` for the name-matching rule and its refusals.
   *
   * If the registered node has neither variant axes nor comparable component
   * properties (or no args were provided), emits a single flag-only row.
   */
  private diffProps(node: FigmaNode, args: Record<string, unknown> | undefined): DimensionDiff[] {
    if (!args) {
      return [this.placeholder("props", "story.args (no args sent)")];
    }

    const isVariant = node.type === "COMPONENT" && node.name.includes("=");
    const variantRows: DimensionDiff[] = isVariant
      ? Object.entries(parseVariantName(node.name)).map(([prop, value]): DimensionDiff => {
          if (isFalsyVariantValue(value)) {
            return {
              kind: "props",
              property: prop,
              codeValue: null,
              figmaValue: value,
              status: "match",
              note: "Falsy/default — no arg expected.",
            };
          }
          const matchingArg = findMatchingArg(args, prop, value);
          return {
            kind: "props",
            property: prop,
            codeValue: matchingArg ? { [matchingArg[0]]: matchingArg[1] } : null,
            figmaValue: value,
            status: matchingArg ? "match" : "drift",
          };
        })
      : [];

    // Figma *component* properties (BOOLEAN / TEXT / INSTANCE_SWAP) — distinct
    // from variant axes, and until now read only for their `variantOptions`.
    // `figmaTexts` lets a TEXT property defer to the `copy` dimension instead
    // of reporting the same string twice.
    const propertyRows = componentPropertyRows({
      node,
      args,
      figmaTexts: collectFigmaText(node),
    });

    if (variantRows.length === 0 && propertyRows.length === 0) {
      return [
        {
          kind: "props",
          property: "story.args",
          codeValue: args,
          figmaValue: null,
          status: "flag-only",
          note: "Registered node has no Figma variant or component properties to compare against.",
        },
      ];
    }
    return [...variantRows, ...propertyRows];
  }

  /**
   * Compare each Figma TEXT-node's `characters` against visible text in the
   * rendered story. We allow case-insensitive substring containment (a
   * Figma label "Send" still matches a code button reading "Send →").
   *
   * Single row per Figma string. Strings present in code = match; absent =
   * drift. If neither side has any text, no row is emitted.
   */
  private diffCopy(node: FigmaNode, snapshot: CodeSnapshot | undefined): DimensionDiff[] {
    const figmaStrings = collectFigmaText(node);
    const codeStringsRaw = snapshot?.texts ?? [];
    const codeTexts = codeStringsRaw.map((s) => s.toLowerCase());
    if (figmaStrings.length === 0 && codeTexts.length === 0) return [];

    if (figmaStrings.length === 0) {
      // Figma has no text but code does — surface as flag-only so it's
      // visible without crying drift; the user may have added a label that
      // belongs in design too.
      return [
        {
          kind: "copy",
          property: "text",
          codeValue: snapshot?.texts ?? [],
          figmaValue: [],
          status: "flag-only",
          note: "Code has visible text; Figma node has no TEXT children.",
        },
      ];
    }

    // 1:1 pairing — when the component has exactly one visible text on
    // each side, we know which Figma node pairs with which code string
    // without ambiguity. Emit a single row that carries both concrete
    // values, so Apply works in either direction (code-tsx-text rewrites
    // the JSX literal; the plugin's characters writer pushes to Figma).
    // Asymmetric cases (multi-text, or Figma-only) fall through to the
    // legacy per-Figma-string iteration below.
    if (figmaStrings.length === 1 && codeStringsRaw.length === 1) {
      const figmaText = figmaStrings[0]!;
      const codeText = codeStringsRaw[0]!;
      const match =
        codeText.toLowerCase() === figmaText.toLowerCase() ||
        codeText.toLowerCase().includes(figmaText.toLowerCase()) ||
        figmaText.toLowerCase().includes(codeText.toLowerCase());
      return [
        {
          kind: "copy",
          property: "text",
          codeValue: codeText,
          figmaValue: figmaText,
          status: match ? "match" : "drift",
        },
      ];
    }

    return figmaStrings.map((figmaText): DimensionDiff => {
      const lower = figmaText.toLowerCase();
      const present = codeTexts.some((c) => c.includes(lower) || lower.includes(c));
      return {
        kind: "copy",
        property: "text",
        codeValue: present ? figmaText : null,
        figmaValue: figmaText,
        status: present ? "match" : "drift",
      };
    });
  }

  private placeholder(
    kind: DimensionDiff["kind"],
    property: string,
  ): DimensionDiff {
    return {
      kind,
      property,
      codeValue: null,
      figmaValue: null,
      status: "flag-only",
      note: "Reserved for a future engine.",
    };
  }
}

// ---- helpers --------------------------------------------------------------

/**
 * Merge a parent COMPONENT_SET's boundVariables underneath the variant's,
 * so any padding/radius/etc. binding declared on the parent shows up when
 * the variant doesn't override it. Variant wins on conflicts.
 *
 * `rectangleCornerRadii` is a nested map keyed by corner; merge per-corner
 * rather than wholesale-replacing.
 *
 * `componentPropertyDefinitions` is inherited the same way and for the same
 * reason: Figma declares BOOLEAN/TEXT/INSTANCE_SWAP properties on the
 * COMPONENT_SET, not on each variant, so a registry pinned to a variant node
 * (the normal case) would otherwise see none of them.
 */
function mergeInheritedBindings(variant: FigmaNode, parent: FigmaNode): FigmaNode {
  const parentBV = parent.boundVariables ?? {};
  const variantBV = variant.boundVariables ?? {};
  const merged: Record<string, FigmaVariableAlias | FigmaVariableAlias[]> = { ...parentBV };
  for (const [k, v] of Object.entries(variantBV)) {
    if (k === "rectangleCornerRadii") {
      const parentCorners = (parentBV.rectangleCornerRadii ?? {}) as Record<string, FigmaVariableAlias>;
      const variantCorners = v as unknown as Record<string, FigmaVariableAlias>;
      merged.rectangleCornerRadii = { ...parentCorners, ...variantCorners } as unknown as FigmaVariableAlias;
    } else {
      merged[k] = v;
    }
  }
  // Inherit only the non-VARIANT definitions. A variant's own axes come from
  // its name (`Size=Large`), and handing the parent's VARIANT entries to a
  // variant node would hand `diffVariantSet` a second, weaker view of axes it
  // already compares — the exact redundancy v0.0.34 removed.
  const definitions =
    variant.componentPropertyDefinitions ??
    pickNonVariantDefinitions(parent.componentPropertyDefinitions);
  return {
    ...variant,
    boundVariables: merged,
    ...(definitions ? { componentPropertyDefinitions: definitions } : {}),
  };
}

function pickNonVariantDefinitions(
  defs: Record<string, FigmaComponentPropertyDefinition> | undefined,
): Record<string, FigmaComponentPropertyDefinition> | undefined {
  if (!defs) return undefined;
  const out: Record<string, FigmaComponentPropertyDefinition> = {};
  for (const [key, def] of Object.entries(defs)) {
    if (def?.type !== "VARIANT") out[key] = def;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Find a Storybook arg that matches a Figma variant property using three
 * strategies, in priority order:
 *   1. Direct value match — any arg whose stringified value equals the
 *      Figma value (case-insensitive). Catches "variant: 'accent'" → "Accent".
 *   2. Property-name match for booleans — when Figma value is "True", any
 *      arg whose name matches the Figma property name (with optional
 *      is/has prefix) and is truthy. Catches "isDirty: true" → IsDirty=True.
 *   3. Value-as-name match for boolean states — any arg whose name (with
 *      is/has prefix stripped) equals the Figma value, and is truthy.
 *      Catches "isActive: true" → State=Active.
 *
 * Returns the matching [key, value] tuple or null.
 */
function findMatchingArg(
  args: Record<string, unknown>,
  figmaProp: string,
  figmaValue: string,
): [string, unknown] | null {
  const lowerValue = figmaValue.toLowerCase();
  const isBoolish = lowerValue === "true" || lowerValue === "false";
  const propClean = figmaProp.toLowerCase().replace(/[-_]/g, "");
  const propStripped = propClean.replace(/^(is|has)/, "");

  // For boolean Figma values, strategy 2 (property-name) runs first because
  // strategy 1 would match the FIRST truthy arg regardless of whose property
  // it represents. For non-boolean values, strategy 1 (direct value match) is
  // the most specific signal.
  if (isBoolish) {
    if (lowerValue === "true") {
      for (const [k, v] of Object.entries(args)) {
        if (!v) continue;
        const kClean = k.toLowerCase().replace(/[-_]/g, "");
        if (kClean === propClean || kClean === propStripped) return [k, v];
      }
    }
  } else {
    for (const [k, v] of Object.entries(args)) {
      if (String(v).toLowerCase() === lowerValue) return [k, v];
    }
  }

  // Strategy 3: value-as-name (Figma "Active" → code `isActive: true`)
  for (const [k, v] of Object.entries(args)) {
    if (!v) continue;
    const kClean = k.toLowerCase().replace(/[-_]/g, "").replace(/^(is|has)/, "");
    if (kClean === lowerValue) return [k, v];
  }
  return null;
}

/**
 * Walk the Figma node tree and collect all TEXT-node `characters` values.
 *
 * Two stop conditions prevent a layout container (Panel rendering nested
 * Folder/Row instances) from flooding the report with every label inside
 * every nested instance — those nested components have their own stories
 * with their own copy diff, and double-counting their text turns the
 * parent's `copy` rows into noise drowning out real drift.
 *
 * Stops:
 *   1. INSTANCE boundary — don't recurse into nested component references.
 *      Their text is owned by their own story.
 *   2. Hard depth cap (8 levels) — backstop for deeply nested layouts that
 *      use raw frames instead of instances.
 *
 * Deduplicates and returns trimmed non-empty strings.
 */
const COPY_SCAN_MAX_DEPTH = 8;

function collectFigmaText(node: FigmaNode): string[] {
  const out = new Set<string>();
  function walk(n: FigmaNode, depth: number): void {
    if (n.type === "TEXT") {
      const chars = (n as unknown as { characters?: string }).characters;
      if (typeof chars === "string") {
        const trimmed = chars.trim();
        if (trimmed) out.add(trimmed);
      }
    }
    if (depth >= COPY_SCAN_MAX_DEPTH) return;
    for (const child of n.children ?? []) {
      // Stop at nested instances — their text belongs to another story.
      // The root node itself can be an INSTANCE; only skip *descendant*
      // instances (i.e. depth > 0).
      if (child.type === "INSTANCE" && depth > 0) continue;
      walk(child, depth + 1);
    }
  }
  walk(node, 0);
  return [...out];
}

/**
 * Parse a Storybook story id's variant suffix into a structured
 * `{ Property: "Value" }` map, using Figma's known property names as
 * the parsing dictionary.
 *
 * Examples (figmaKeys = ["State", "Checked"]):
 *   "molecules-rowboolean--checked-true-state-hover" → { Checked: "true", State: "Hover" }
 *   "molecules-rowassetpicker--state-picker-open"    → { State: "PickerOpen" }
 *   "molecules-rowbutton--default"                   → { }   (no recognized keys)
 *
 * Algorithm:
 *   1. Take the suffix after the last `--` and split on `-`.
 *   2. Walk tokens; when a token matches a known Figma prop name
 *      (case-insensitive), open a new property. Accumulate following
 *      tokens as the value until the next prop match or end-of-suffix.
 *   3. Camel-case the accumulated value tokens so multi-word values
 *      (`picker-open` → `PickerOpen`) match Figma's variant names.
 *
 * If `figmaKeys` is empty, returns an empty map — without a dictionary
 * we can't tell which tokens are keys vs values, and over-eager
 * inference would produce more noise than it clears.
 */
function parseStoryVariantSuffix(
  storyId: string,
  figmaKeys: string[],
): Record<string, string> {
  if (figmaKeys.length === 0) return {};
  const suffix = storyId.split("--").pop() ?? "";
  if (!suffix || suffix === "default") return {};
  const keyByLower = new Map(figmaKeys.map((k) => [k.toLowerCase(), k]));
  const tokens = suffix.split("-").filter(Boolean);
  const out: Record<string, string[]> = {};
  let currentKey: string | null = null;
  for (const tok of tokens) {
    const matchedKey = keyByLower.get(tok.toLowerCase());
    if (matchedKey) {
      currentKey = matchedKey;
      out[currentKey] = [];
    } else if (currentKey) {
      out[currentKey]!.push(tok);
    }
    // Tokens before the first recognized key (e.g. accidental prefix)
    // are dropped — they're not part of the variant.
  }
  const result: Record<string, string> = {};
  for (const [key, valueTokens] of Object.entries(out)) {
    if (valueTokens.length === 0) continue;
    // Camel-case `picker-open` → `PickerOpen`; preserve `true`/`false`
    // as-is for boolean variants (Figma encodes them lowercase).
    const joined = valueTokens
      .map((t) => (t === "true" || t === "false" ? t : t[0]!.toUpperCase() + t.slice(1)))
      .join("");
    // Boolean variants stay lowercase — that's how Figma stores them.
    result[key] = joined === "True" ? "true" : joined === "False" ? "false" : joined;
  }
  return result;
}

/**
 * Parse a Figma variant name like "State=Active, IsDirty=False" into a
 * structured `{ State: "Active", IsDirty: "False" }`. Tolerates trailing
 * spaces and missing values.
 */
function parseVariantName(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of name.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

/**
 * Index the `props` rows by the Figma variant axis they compared, so the
 * variant-set check can ask "was this axis already confirmed against the story
 * args?". `diffProps` emits one row per axis, keyed by the axis name.
 */
function propsStatusesByAxis(propsDiffs: DimensionDiff[]): Record<string, DimensionDiff["status"]> {
  const out: Record<string, DimensionDiff["status"]> = {};
  for (const d of propsDiffs) {
    if (d.kind === "props") out[d.property] = d.status;
  }
  return out;
}

/**
 * Variant values that conventionally mean "no modifier in code" — typically
 * the absence-state of a boolean variant or the unmodified default.
 *
 * Code-side BEM rarely emits `.foo--false` or `.foo--default`; the absence
 * of a modifier IS the falsy state. Treat these as match-by-skip rather
 * than flagging false-positive drift.
 */
function isFalsyVariantValue(value: string): boolean {
  const v = value.toLowerCase();
  return v === "false" || v === "default" || v === "off" || v === "no" || v === "none";
}

/**
 * Pick the border edge to compare against the Figma stroke. Rows that
 * draw only a `border-bottom` would otherwise read zero from
 * `border-top-width` and falsely report drift. Falls back to "top" when
 * no edge has a non-zero width — keeps prior behavior for components
 * that genuinely have no border.
 */
function pickBorderEdge(styles: Record<string, string>): "top" | "right" | "bottom" | "left" {
  for (const edge of ["bottom", "top", "left", "right"] as const) {
    if ((parsePx(styles[`border-${edge}-width`]) ?? 0) > 0) return edge;
  }
  return "top";
}

function parsePx(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^(-?\d+(?:\.\d+)?)\s*px$/.exec(value);
  return m && m[1] ? Number(m[1]) : null;
}

function rgbaToCss(c: { r: number; g: number; b: number; a?: number }): string {
  const r = Math.round(c.r * 255);
  const g = Math.round(c.g * 255);
  const b = Math.round(c.b * 255);
  const a = c.a ?? 1;
  return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}

interface ResolvedFill {
  value: string;
  modes?: ModeAwareValue;
  tokenName?: string;
}

/**
 * Verdict for a colour comparison. `drift` requires a concrete value on both
 * sides — with only one side present there is nothing to compare, and calling
 * that drift is the exact false positive the honesty invariant forbids. The
 * row still renders with whatever detail exists; it just doesn't accuse.
 */
function colorRowStatus(
  codeValue: string | undefined,
  figmaValue: string | undefined,
): DimensionDiff["status"] {
  if (!codeValue || !figmaValue) return "flag-only";
  return normalizeColor(codeValue) === normalizeColor(figmaValue) ? "match" : "drift";
}

function resolveFillColor(
  node: FigmaNode,
  variables: FigmaLocalVariablesResponse | null,
  activeMode?: string,
): ResolvedFill | undefined {
  const fill = node.fills?.[0];
  if (!fill) return undefined;
  const alias = fill.boundVariables?.color;
  const tokenName = alias && variables ? variables.meta.variables[alias.id]?.name : undefined;
  if (alias && variables) {
    const resolved = resolveColorVariable(alias.id, variables, activeMode);
    if (resolved) {
      if (tokenName) resolved.tokenName = tokenName;
      return resolved;
    }
  }
  // The variable didn't resolve, but Figma also hands back the paint's own
  // resolved colour — use it, and keep the token name so the row still
  // knows which token it is nominally bound to.
  if (fill.color) {
    return { value: rgbaToCss(fill.color), ...(tokenName ? { tokenName } : {}) };
  }
  return undefined;
}

/**
 * A raw `valuesByMode` entry that points at another variable rather than
 * holding a literal. Figma's REST shape for semantic tokens: `Border/Neutral/
 * Secondary` doesn't store a colour, it stores an alias to `Slate/600`.
 */
function asVariableAlias(raw: unknown): FigmaVariableAlias | undefined {
  if (raw && typeof raw === "object" && (raw as { type?: string }).type === "VARIABLE_ALIAS") {
    return raw as FigmaVariableAlias;
  }
  return undefined;
}

/**
 * Match a collection mode by name. Exact (case-insensitive) first, then as a
 * whole word inside the mode name — real files prefix their modes with the
 * system name (SDS ships `"SDS Light"` / `"SDS Dark"`, not `"Light"` /
 * `"Dark"`), and an exact-only match silently sent every dark-mode
 * comparison to the file's default mode.
 */
function findModeId(collection: FigmaVariableCollection, modeName: string): string | undefined {
  const target = modeName.trim().toLowerCase();
  if (!target) return undefined;
  const exact = collection.modes.find((m) => m.name.trim().toLowerCase() === target);
  if (exact) return exact.modeId;
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = new RegExp(`\\b${escaped}\\b`, "i");
  return collection.modes.find((m) => word.test(m.name))?.modeId;
}

/** How many alias hops to follow before giving up. Real chains are 1-2 deep. */
const MAX_ALIAS_DEPTH = 8;

/** Why an alias chain produced no literal. Drives the row's honest message. */
type UnresolvedReason =
  | "variable-missing"
  | "collection-missing"
  | "no-value"
  | "wrong-type"
  | "cycle"
  | "depth";

type LiteralResolution =
  | { ok: true; value: unknown; chain: string[] }
  | { ok: false; reason: UnresolvedReason; chain: string[] };

type UnresolvedLiteral = Extract<LiteralResolution, { ok: false }>;

/**
 * Read a variable's literal value for `modeName`, following `VARIABLE_ALIAS`
 * indirection to whatever variable actually holds the literal.
 *
 * Each hop re-resolves the mode against the *target's own* collection, which
 * matters because aliases routinely cross collections with unrelated mode
 * sets — `Color` has `SDS Light`/`SDS Dark`, while the `Color Primitives` it
 * points into has a single `Value` mode. Falls back to the collection's
 * default mode whenever `modeName` doesn't name one of its modes.
 *
 * Type-agnostic on purpose: COLOR (`{r,g,b,a}`), FLOAT (`number`), STRING and
 * BOOLEAN variables all alias the same way, so every reader goes through here.
 *
 * Never returns a partially-resolved stand-in (a variable *name* is not a
 * value). On failure it returns the reason plus the chain walked so the caller
 * can tell the user exactly what couldn't be resolved.
 */
function resolveVariableLiteral(
  variableId: string,
  variables: FigmaLocalVariablesResponse,
  modeName: string | undefined,
  seen: Set<string> = new Set(),
  depth = 0,
  chain: string[] = [],
): LiteralResolution {
  const v = variables.meta.variables[variableId];
  // Label hops by name where we have one; the raw id is all we can say about
  // a variable that isn't in the response (typically a library reference).
  const walked = [...chain, v?.name ?? variableId];

  // Cycle before depth: a self-referential chain should say "loops", not
  // "too deep", even though both guards would stop it.
  if (seen.has(variableId)) return { ok: false, reason: "cycle", chain: walked };
  if (depth > MAX_ALIAS_DEPTH) return { ok: false, reason: "depth", chain: walked };
  seen.add(variableId);

  if (!v) return { ok: false, reason: "variable-missing", chain: walked };
  const collection = variables.meta.variableCollections[v.variableCollectionId];
  if (!collection) return { ok: false, reason: "collection-missing", chain: walked };

  // Prefer the named mode; fall back to the collection's default when this
  // collection doesn't name it (every hop past the first, since aliases cross
  // into collections with unrelated mode sets) or defines no value for it.
  const namedModeId = modeName ? findModeId(collection, modeName) : undefined;
  const raw =
    (namedModeId ? v.valuesByMode[namedModeId] : undefined) ??
    v.valuesByMode[collection.defaultModeId];
  if (raw === undefined) return { ok: false, reason: "no-value", chain: walked };

  const alias = asVariableAlias(raw);
  if (alias) return resolveVariableLiteral(alias.id, variables, modeName, seen, depth + 1, walked);
  return { ok: true, value: raw, chain: walked };
}

/**
 * The honest message for a row whose Figma side couldn't be read. Names the
 * token, what was expected, why the read failed, and states plainly that no
 * comparison happened — so a reader never mistakes it for a verdict.
 */
function describeUnresolvedVariable(
  res: UnresolvedLiteral,
  tokenName: string,
  expected: string,
  modeName?: string,
): string {
  const chain = res.chain.join(" → ");
  const forMode = modeName ? ` for mode "${modeName}"` : "";
  let why: string;
  switch (res.reason) {
    case "cycle":
      why = `its alias chain loops back on itself (${chain})`;
      break;
    case "depth":
      why = `its alias chain is more than ${MAX_ALIAS_DEPTH} hops deep (${chain})`;
      break;
    case "variable-missing":
      why =
        `its alias points at a variable that isn't in this file's local variables (${chain}) — ` +
        `it likely lives in a library this token can't reach`;
      break;
    case "collection-missing":
      why = `its variable collection is missing from the file's variables response (${chain})`;
      break;
    case "no-value":
      why = `it defines no value${forMode}, nor for its collection's default mode (${chain})`;
      break;
    case "wrong-type":
      why = `its alias chain ends at a value that isn't ${expected} (${chain})`;
      break;
  }
  return (
    `Figma value unresolved — no comparison was made. The variable "${tokenName}" ` +
    `could not be resolved to ${expected}: ${why}. "${tokenName}" is a token NAME shown ` +
    `for context, not a value.`
  );
}

/** Narrow a resolved literal to Figma's `{r,g,b,a}` colour shape (floats 0..1). */
/**
 * The literal at the end of an alias chain, or `undefined` when the chain
 * couldn't be walked. Callers that only need the value use this; callers that
 * need to explain a failure keep the full `LiteralResolution` and hand it to
 * `describeUnresolvedVariable`.
 */
function literalValue(res: LiteralResolution): unknown {
  return res.ok ? res.value : undefined;
}

function asFigmaColor(raw: unknown): { r: number; g: number; b: number; a?: number } | undefined {
  if (raw && typeof raw === "object" && "r" in raw && "g" in raw && "b" in raw) {
    return raw as { r: number; g: number; b: number; a?: number };
  }
  return undefined;
}

function resolveColorVariable(
  variableId: string,
  variables: FigmaLocalVariablesResponse,
  activeMode?: string,
): ResolvedFill | undefined {
  const v = variables.meta.variables[variableId];
  if (!v || v.resolvedType !== "COLOR") return undefined;
  const collection = variables.meta.variableCollections[v.variableCollectionId];
  if (!collection) return undefined;

  /**
   * Resolve for a named mode, but only when THIS variable's collection
   * actually has that mode. Without the guard, a single-mode collection would
   * answer every mode name with its default value and we'd emit a
   * `{light, dark}` map for a token that has no such thing. Alias hops deeper
   * in the chain are free to fall back — that's `resolveVariableLiteral`'s job.
   */
  const findByName = (modeName: string): string | undefined => {
    if (!findModeId(collection, modeName)) return undefined;
    const color = asFigmaColor(literalValue(resolveVariableLiteral(variableId, variables, modeName)));
    return color ? rgbaToCss(color) : undefined;
  };

  const light = findByName("light");
  const dark = findByName("dark");

  // The "comparison value" is the active mode if known, else the file default.
  const activeStr = activeMode ? findByName(activeMode) : undefined;
  const defaultColor = asFigmaColor(
    literalValue(resolveVariableLiteral(variableId, variables, undefined)),
  );
  const value = activeStr ?? (defaultColor ? rgbaToCss(defaultColor) : undefined);
  // A variable name is not a colour. Returning one here used to poison the
  // caller's raw-paint fallback and guarantee `drift` on every colour row
  // whose token aliases another token — report "unresolved" instead.
  if (value === undefined) return undefined;

  if (light && dark) {
    return { value, modes: { light, dark } };
  }
  return { value };
}

/**
 * Pick a numeric (FLOAT) variable's value for the active mode, falling back
 * to the file's default mode if the active one isn't defined. Follows alias
 * indirection — without it, an aliasing numeric token resolved to `null` and
 * the row was dropped from the report entirely.
 */
function resolveNumericForMode(
  v: FigmaVariable,
  variables: FigmaLocalVariablesResponse,
  activeMode?: string,
): number | null {
  const raw = literalValue(resolveVariableLiteral(v.id, variables, activeMode));
  return typeof raw === "number" ? raw : null;
}

/** Same, for STRING variables (font-family). */
function resolveStringForMode(
  v: FigmaVariable,
  variables: FigmaLocalVariablesResponse,
  activeMode?: string,
): string | null {
  const raw = literalValue(resolveVariableLiteral(v.id, variables, activeMode));
  return typeof raw === "string" ? raw : null;
}

interface FigmaBinding {
  tokenName: string;
  modes?: ModeAwareValue;
}

/**
 * Map Figma's camelCase boundVariable keys to the CSS-property keys the
 * snapshot collects, so the diff joins instead of producing two rows.
 *
 * `rectangleCornerRadii` is a nested map and is expanded separately below.
 */
const FIGMA_KEY_TO_CSS: Record<string, string> = {
  paddingTop: "padding-top",
  paddingRight: "padding-right",
  paddingBottom: "padding-bottom",
  paddingLeft: "padding-left",
  itemSpacing: "gap",
  fills: "background-color",
  strokeWeight: "border-width",
  strokes: "border-color",
  effects: "box-shadow",
  // Typography — surface from either the variant root or its TEXT
  // descendants (the latter via `collectFigmaBindings`' tree walk).
  fontFamily: "font-family",
  fontSize: "font-size",
  fontWeight: "font-weight",
  // Binding (token-name) comparison only. A Figma `fontStyle` variable holds a
  // font *style name* ("Italic", "Semi Bold Italic") — a weight+slant compound
  // — so it must never be read as a CSS `font-style` *value*. The value side
  // reads `TypeStyle.italic`; see `text-style-map.ts`.
  fontStyle: "font-style",
  lineHeight: "line-height",
  letterSpacing: "letter-spacing",
  textCase: "text-transform",
  textDecoration: "text-decoration-line",
  textAlignHorizontal: "text-align",
};

/** Figma's TEXT-node binding keys that should bubble up to the parent FRAME
 *  for wiring purposes, since the snapshot target is usually the FRAME-level
 *  element in code (e.g. `.text-button`) which receives the cascaded text
 *  styles. The string values are the CSS-prop keys the story tokens use. */
const TEXT_CHILD_BUBBLE: Record<string, string> = {
  fills: "color",
  fontFamily: "font-family",
  fontSize: "font-size",
  fontWeight: "font-weight",
  fontStyle: "font-style",
  lineHeight: "line-height",
  letterSpacing: "letter-spacing",
  textCase: "text-transform",
  textDecoration: "text-decoration-line",
  textAlignHorizontal: "text-align",
};

const FIGMA_CORNER_TO_CSS: Record<string, string> = {
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: "border-top-left-radius",
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: "border-top-right-radius",
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: "border-bottom-left-radius",
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: "border-bottom-right-radius",
};

function collectFigmaBindings(
  node: FigmaNode,
  variables: FigmaLocalVariablesResponse | null,
  activeMode?: string,
): Record<string, FigmaBinding> {
  const out: Record<string, FigmaBinding> = {};
  const raw = node.boundVariables ?? {};

  const setBinding = (property: string, alias: FigmaVariableAlias): void => {
    const v = variables?.meta.variables[alias.id];
    if (!v) {
      out[property] = { tokenName: alias.id };
      return;
    }
    const resolved =
      v.resolvedType === "COLOR" ? resolveColorVariable(alias.id, variables!, activeMode) : undefined;
    const binding: FigmaBinding = { tokenName: v.name };
    if (resolved?.modes) binding.modes = resolved.modes;
    out[property] = binding;
  };

  for (const [figmaKey, alias] of Object.entries(raw)) {
    if (figmaKey === "rectangleCornerRadii") {
      // Expand the nested per-corner map into individual CSS-prop keys.
      const corners = alias as unknown as Record<string, FigmaVariableAlias>;
      for (const [cornerKey, cornerAlias] of Object.entries(corners)) {
        const cssProp = FIGMA_CORNER_TO_CSS[cornerKey];
        if (cssProp && cornerAlias) setBinding(cssProp, cornerAlias);
      }
      continue;
    }
    const aliases = Array.isArray(alias) ? alias : [alias];
    const first = aliases[0];
    if (!first) continue;
    const cssProp = FIGMA_KEY_TO_CSS[figmaKey] ?? figmaKey;
    setBinding(cssProp, first);
  }

  // Fall back to fills[0].boundVariables.color when the node has no top-level
  // `fills` boundVariable (some shapes carry it on the paint instead).
  if (!out["background-color"]) {
    const fillAlias = node.fills?.[0]?.boundVariables?.color;
    if (fillAlias) setBinding("background-color", fillAlias);
  }

  // Bubble TEXT-descendant bindings up to the variant root. Designers
  // typically bind typography vars on the inner TEXT layer; consumers
  // declare those same tokens on the FRAME-level element (e.g. `color`
  // and `font-size` on `.text-button`). Without this bubbling, the Wiring
  // column would falsely say "Figma has no bound variable for this
  // property" for color/font-* even though the design clearly does.
  const textNode = findFirstTextNode(node);
  if (textNode) {
    const textBound = textNode.boundVariables ?? {};
    for (const [figmaKey, cssProp] of Object.entries(TEXT_CHILD_BUBBLE)) {
      if (out[cssProp]) continue; // root-level binding wins
      const alias = pickAlias(textBound[figmaKey]);
      if (alias) {
        setBinding(cssProp, alias);
        continue;
      }
      // `fills` on TEXT is the color paint — try fills[0].boundVariables.color.
      if (figmaKey === "fills" && !out["color"]) {
        const fillAlias = textNode.fills?.[0]?.boundVariables?.color;
        if (fillAlias) setBinding("color", fillAlias);
      }
    }
  }

  return out;
}

/**
 * Pick the "primary" TEXT descendant for typography comparison.
 *
 * Naïve depth-first picks whichever TEXT node happens to come first in the
 * tree, which is often a single-character glyph like "▾" / "▼" / "✓" — that
 * glyph runs in a different style (`chrome/glyph/*`) from the row's actual
 * label, so the diff reads the wrong typography. We instead score every
 * TEXT descendant and prefer ones that look like real labels:
 *
 *   - more characters wins
 *   - alphanumeric content wins over pure-symbol content
 *   - if a node IS itself a TEXT node, return it (preserves trivial case)
 *
 * Falls back to the first descendant when no candidate stands out (e.g.
 * single-glyph atoms like the Caret).
 */
function findFirstTextNode(node: FigmaNode): FigmaNode | undefined {
  if (node.type === "TEXT") return node;
  const all: FigmaNode[] = [];
  const walk = (n: FigmaNode): void => {
    if (n.type === "TEXT") all.push(n);
    for (const child of n.children ?? []) walk(child);
  };
  walk(node);
  if (all.length === 0) return undefined;
  if (all.length === 1) return all[0];

  // Score each candidate; higher is better.
  const score = (n: FigmaNode): number => {
    const chars = (n as unknown as { characters?: string }).characters ?? "";
    let s = chars.length;
    if (/[a-zA-Z0-9]/.test(chars)) s += 100;
    return s;
  };
  let best = all[0]!;
  let bestScore = score(best);
  for (let i = 1; i < all.length; i++) {
    const cand = all[i]!;
    const cs = score(cand);
    if (cs > bestScore) {
      best = cand;
      bestScore = cs;
    }
  }
  return best;
}

function pickAlias(value: FigmaVariableAlias | FigmaVariableAlias[] | undefined): FigmaVariableAlias | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Compare a numeric Figma value against the code-side CSS for `cssProp`.
 * Pushes a `token-value` row if either side has data. When `alias` is set
 * (Figma variable bound), the resolved variable value wins over the raw
 * one and its name appears in the figma cell as "(token: …)".
 */
function pushTypographyNumeric(opts: {
  out: DimensionDiff[];
  snapshot: CodeSnapshot;
  variables: FigmaLocalVariablesResponse | null;
  activeMode: string | undefined;
  cssProp: string;
  rawValue: number | undefined;
  alias: FigmaVariableAlias | undefined;
  /** Skip the "px" suffix in the figma cell — useful for unitless props
   *  like font-weight. CSS comparison is on the parsed number either way. */
  unitless?: boolean;
}): void {
  const { out, snapshot, variables, activeMode, cssProp, rawValue, alias, unitless } = opts;
  let figmaValue: number | undefined = rawValue;
  let tokenName: string | undefined;
  if (alias && variables) {
    const v = variables.meta.variables[alias.id];
    if (v && v.resolvedType === "FLOAT") {
      const resolved = resolveNumericForMode(v, variables, activeMode);
      if (resolved !== null) {
        figmaValue = resolved;
        tokenName = v.name;
      }
    }
  }
  const codeValue = snapshot.styles[cssProp];
  // For font-weight, computed style can be "400" (unitless). parsePx will
  // return null. Fall back to parseFloat for unitless cases.
  const codeNum = unitless
    ? codeValue
      ? Number(codeValue)
      : null
    : parsePx(codeValue);
  if (figmaValue === undefined && codeNum === null) return;
  const status: DimensionDiff["status"] =
    figmaValue !== undefined && codeNum !== null && Math.abs(codeNum - figmaValue) < 0.5
      ? "match"
      : "drift";
  out.push({
    kind: "token-value",
    property: cssProp,
    codeValue: codeValue ?? null,
    figmaValue:
      figmaValue !== undefined
        ? tokenName
          ? `${figmaValue}${unitless ? "" : "px"} (token: ${tokenName})`
          : `${figmaValue}${unitless ? "" : "px"}`
        : null,
    status,
    ...(tokenName ? { tokenName } : {}),
  });
}

export const createFigmaRestEngine: EngineFactory = (ctx) => new FigmaRestEngine(ctx);
