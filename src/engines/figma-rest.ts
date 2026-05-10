import type {
  CheckDriftInput,
  CodeSnapshot,
  Engine,
  EngineContext,
  EngineFactory,
} from "./types.js";
import type {
  DimensionDiff,
  DriftReport,
  ModeAwareValue,
} from "../dimensions/types.js";
import { PersistentCache } from "../cache.js";

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
  componentPropertyDefinitions?: Record<
    string,
    { type: string; defaultValue: unknown; variantOptions?: string[] }
  >;
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
}

class FigmaRestEngine implements Engine {
  readonly name = "figma-rest";
  private readonly pat: string | undefined;
  /** Cache of `node_id → containing_frame.nodeId` per fileKey. */
  private readonly parentMaps = new Map<string, Map<string, string>>();
  /**
   * Variables are stable for the lifetime of a working session; 5 min TTL
   * is generous and saves ~200ms per drift check during bulk runs.
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

    // Persistent-cache short-circuit. Cheap path: fetch only file metadata
    // (one tiny HTTP call, cached for 60s) and check whether the cached
    // report is still valid for this story + snapshot. Hit → return
    // immediately, no node/variables fetch, no engine work.
    if (this.persistentCache) {
      await this.persistentCache.load();
      const fileLastModified = await this.fetchFileLastModified(fileKey).catch(() => "");
      const cached = this.persistentCache.get(input.storyId, fileLastModified, input.snapshot);
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

    dimensions.push(...this.diffTokenValues(node, snapshot, variables, activeMode));
    dimensions.push(...this.diffTokenBindings(node, snapshot, variables, activeMode));
    dimensions.push(...this.diffVariantSet(node, snapshot));
    dimensions.push(...this.diffCopy(node, snapshot));
    dimensions.push(...this.diffProps(node, input.args));

    // Reserved kinds — engine fills as flag-only placeholders.
    dimensions.push(
      this.placeholder("structure", "story.structure"),
      this.placeholder("motion", "story.motion"),
    );

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

    // Stash for future short-circuits.
    if (this.persistentCache) {
      const fileLastModified = await this.fetchFileLastModified(fileKey).catch(() => "");
      if (fileLastModified) {
        this.persistentCache.set(input.storyId, fileLastModified, input.snapshot, report);
      }
    }

    return report;
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
    const res = await fetch(url, { headers: this.headers() });
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
    const res = await fetch(url, { headers: this.headers() });
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
    const res = await fetch(url, { headers: this.headers() });
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
    const res = await fetch(url, { headers: this.headers() });
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
    if ((codeBg && codeBg !== "rgba(0, 0, 0, 0)") || figmaBg !== undefined) {
      const modes = figmaBg?.modes;
      const figmaValue = figmaBg?.value;
      const status: DimensionDiff["status"] =
        codeBg && figmaValue && normalizeColor(codeBg) === normalizeColor(figmaValue)
          ? "match"
          : "drift";
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
      const collection = variables.meta.variableCollections[v.variableCollectionId];
      if (!collection) continue;
      const figmaPx = resolveNumericForMode(v, collection, activeMode);
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
    if (corners && variables) {
      for (const [figmaKey, cssProp] of radiusKeys) {
        const alias = corners[figmaKey];
        if (!alias) continue;
        const v = variables.meta.variables[alias.id];
        if (!v || v.resolvedType !== "FLOAT") continue;
        const collection = variables.meta.variableCollections[v.variableCollectionId];
        if (!collection) continue;
        const figmaPx = resolveNumericForMode(v, collection, activeMode);
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
          const collection = variables.meta.variableCollections[v.variableCollectionId];
          if (collection) {
            const px = resolveNumericForMode(v, collection, activeMode);
            if (px !== null) figmaGap = { value: px, tokenName: v.name };
          }
        }
      }
      if (!figmaGap && typeof node.itemSpacing === "number") {
        figmaGap = { value: node.itemSpacing as number };
      }
      const codeValue = snapshot.styles["gap"];
      const codePx = parsePx(codeValue);
      if (figmaGap || codePx !== null) {
        const status: DimensionDiff["status"] =
          figmaGap && codePx !== null && Math.abs(codePx - figmaGap.value) < 0.5 ? "match" : "drift";
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

    const codeBorderPx = parsePx(snapshot.styles["border-top-width"]) ?? 0;
    if (figmaHasVisibleStroke || codeBorderPx > 0) {
      const weightAlias = node.boundVariables?.strokeWeight;
      const aliasObj = Array.isArray(weightAlias) ? weightAlias[0] : weightAlias;
      let figmaWeight: { value: number; tokenName?: string } | undefined;
      if (aliasObj && variables) {
        const v = variables.meta.variables[aliasObj.id];
        if (v && v.resolvedType === "FLOAT") {
          const collection = variables.meta.variableCollections[v.variableCollectionId];
          if (collection) {
            const px = resolveNumericForMode(v, collection, activeMode);
            if (px !== null) figmaWeight = { value: px, tokenName: v.name };
          }
        }
      }
      if (!figmaWeight && figmaHasVisibleStroke && typeof node.strokeWeight === "number") {
        figmaWeight = { value: node.strokeWeight as number };
      }
      const codeValue = snapshot.styles["border-top-width"];
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
      const codeValue = snapshot.styles["border-top-color"];
      if (figmaStroke || (codeValue && codeValue !== "rgba(0, 0, 0, 0)")) {
        const status: DimensionDiff["status"] =
          codeValue && figmaStroke && normalizeColor(codeValue) === normalizeColor(figmaStroke.value)
            ? "match"
            : "drift";
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

    // Effects (DROP_SHADOW / INNER_SHADOW → box-shadow). Figma may bind the
    // whole `effects` array to a single variable representing the shadow
    // token (e.g. `shadow/popover`). We can't resolve the variable's value
    // to a CSS string without inspecting its raw value shape (it's stored as
    // an effect object, not a number/color), so we surface the *resolved
    // effect array on the node itself* — Figma's REST node response already
    // includes the resolved effect — and compare to the code's computed
    // `box-shadow`. If both sides have any non-NONE shadow, compare strings
    // after normalization.
    {
      const effects = node.effects as
        | Array<{
            type?: string;
            visible?: boolean;
            offset?: { x: number; y: number };
            radius?: number;
            spread?: number;
            color?: { r: number; g: number; b: number; a?: number };
          }>
        | undefined;
      const codeValue = snapshot.styles["box-shadow"];
      const figmaShadows = (effects ?? [])
        .filter((e) => e.visible !== false && (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW"))
        .map((e) => {
          const inset = e.type === "INNER_SHADOW" ? "inset " : "";
          const x = e.offset?.x ?? 0;
          const y = e.offset?.y ?? 0;
          const blur = e.radius ?? 0;
          const spread = e.spread ?? 0;
          const color = e.color ? rgbaToCss(e.color) : "rgba(0, 0, 0, 0.25)";
          return `${inset}${x}px ${y}px ${blur}px ${spread}px ${color}`;
        });
      // Try to resolve the bound `effects` variable's name for display.
      let tokenName: string | undefined;
      const effectAlias = pickAlias(
        node.boundVariables?.effects as FigmaVariableAlias | FigmaVariableAlias[] | undefined,
      );
      if (effectAlias && variables) {
        const v = variables.meta.variables[effectAlias.id];
        if (v) tokenName = v.name;
      }
      if (figmaShadows.length > 0 || (codeValue && codeValue !== "none")) {
        const figmaShadow = figmaShadows.join(", ");
        const normalize = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
        const status: DimensionDiff["status"] =
          codeValue && figmaShadow && normalize(codeValue) === normalize(figmaShadow)
            ? "match"
            : figmaShadow
              ? "drift"
              : "drift";
        out.push({
          kind: "token-value",
          property: "box-shadow",
          codeValue: codeValue ?? null,
          figmaValue: figmaShadow
            ? tokenName
              ? `${figmaShadow} (token: ${tokenName})`
              : figmaShadow
            : null,
          status,
          ...(tokenName ? { tokenName } : {}),
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
        | {
            fontFamily?: string;
            fontPostScriptName?: string;
            fontWeight?: number;
            fontSize?: number;
            lineHeightPx?: number;
            lineHeightPercent?: number;
            lineHeightUnit?: string;
          }
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
      // line-height — Figma may store as px directly or as a percentage of
      // font size. We normalize to px before comparing.
      let lineHeightPx: number | undefined;
      if (typeof ts?.lineHeightPx === "number" && ts.lineHeightPx > 0) {
        lineHeightPx = ts.lineHeightPx;
      } else if (
        typeof ts?.lineHeightPercent === "number" &&
        ts.lineHeightPercent > 0 &&
        typeof ts.fontSize === "number"
      ) {
        lineHeightPx = (ts.lineHeightPercent / 100) * ts.fontSize;
      }
      pushTypographyNumeric({
        out,
        snapshot,
        variables,
        activeMode,
        cssProp: "line-height",
        rawValue: lineHeightPx,
        alias: pickAlias(bound["lineHeight"]),
      });
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
              const collection = variables.meta.variableCollections[v.variableCollectionId];
              const raw =
                (activeMode && collection
                  ? v.valuesByMode[
                      collection.modes.find((m) => m.name.toLowerCase() === activeMode)?.modeId ?? ""
                    ]
                  : undefined) ??
                v.valuesByMode[collection?.defaultModeId ?? ""];
              if (typeof raw === "string") figmaFamily = raw;
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
          const status: DimensionDiff["status"] =
            codeValue && figmaColor && normalizeColor(codeValue) === normalizeColor(figmaColor.value)
              ? "match"
              : "drift";
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
    }

    return out;
  }

  private diffTokenBindings(
    node: FigmaNode,
    snapshot: CodeSnapshot | undefined,
    variables: FigmaLocalVariablesResponse | null,
    activeMode?: string,
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
      if (!codeValue && !figma) continue;
      if (!codeValue) {
        status = "flag-only";
        note = "Code binding not declared (add a `data-token-*` attribute or `parameters.designSync.tokens` to surface).";
      } else if (!figma) {
        status = "flag-only";
        note = "Figma node has no bound variable for this property.";
      } else {
        // Naming-convention difference is NOT drift. Figma stores tokens as
        // `radius/xl` (group/name); CSS custom properties can't contain
        // slashes so codebases typically use `radius-xl` or `--radius-xl`.
        // Normalize both sides (strip leading dashes, collapse all separators
        // to "-", lowercase) before comparing — anything that resolves to
        // the same conceptual token is a match.
        const sameToken = normalizeTokenName(codeValue) === normalizeTokenName(figma.tokenName);
        status = sameToken ? "match" : "drift";
        if (sameToken && codeValue !== figma.tokenName) {
          note = `Same token, different naming convention (${codeValue} vs ${figma.tokenName}).`;
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
      if (figma?.modes) diff.modes = figma.modes;
      out.push(diff);
    }
    return out;
  }

  private diffVariantSet(node: FigmaNode, snapshot: CodeSnapshot | undefined): DimensionDiff[] {
    // The preview already expands BEM-modifier classes and adjacent classes
    // (.file-item.active style) into a candidate set. Lowercase everything
    // here for case-insensitive matching.
    const codeVariants = new Set(
      (snapshot?.variantClasses ?? []).map((v) => v.toLowerCase()),
    );

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

      for (const [prop, value] of Object.entries(figmaProps)) {
        if (isFalsyVariantValue(value)) {
          skipped.push(`${prop}=${value}`);
          continue;
        }
        if (codeVariants.has(value.toLowerCase())) {
          matched.push(`${prop}=${value}`);
        } else {
          missing.push(`${prop}=${value}`);
        }
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
    if (status === "drift") {
      diff.note = `code variants not declared in Figma: [${unknownInFigma.join(", ")}]`;
    }
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
   * If the registered node isn't a variant (or no args were provided),
   * emits a single flag-only row.
   */
  private diffProps(node: FigmaNode, args: Record<string, unknown> | undefined): DimensionDiff[] {
    if (!args) {
      return [this.placeholder("props", "story.args (no args sent)")];
    }
    if (node.type !== "COMPONENT" || !node.name.includes("=")) {
      return [
        {
          kind: "props",
          property: "story.args",
          codeValue: args,
          figmaValue: null,
          status: "flag-only",
          note: "Registered node has no Figma variant properties to compare against.",
        },
      ];
    }

    const figmaProps = parseVariantName(node.name);
    return Object.entries(figmaProps).map(([prop, value]): DimensionDiff => {
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
    });
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
    const codeTexts = (snapshot?.texts ?? []).map((s) => s.toLowerCase());
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
  return { ...variant, boundVariables: merged };
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
 * Deduplicates and returns trimmed non-empty strings.
 */
function collectFigmaText(node: FigmaNode): string[] {
  const out = new Set<string>();
  function walk(n: FigmaNode): void {
    if (n.type === "TEXT") {
      const chars = (n as unknown as { characters?: string }).characters;
      if (typeof chars === "string") {
        const trimmed = chars.trim();
        if (trimmed) out.add(trimmed);
      }
    }
    for (const child of n.children ?? []) walk(child);
  }
  walk(node);
  return [...out];
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
 * Reduce a token name to a canonical key for "do these mean the same thing"
 * comparisons. Strips a leading `--`, collapses `/` `.` and runs of `-` into
 * a single `-`, lowercases. Examples:
 *   "radius/xl"     → "radius-xl"
 *   "radius-xl"     → "radius-xl"
 *   "--radius-xl"   → "radius-xl"
 *   "Radius/XL"     → "radius-xl"
 *   "color/bg/kbd"  → "color-bg-kbd"
 *
 * Used by the binding diff so that the same token expressed in different
 * naming conventions doesn't produce false-positive drift. Figma uses
 * `group/name`; CSS custom properties can't contain `/` so codebases use
 * `group-name` or `--group-name`.
 */
function normalizeTokenName(name: string | undefined): string {
  if (!name) return "";
  return name
    .replace(/^--/, "")
    .replace(/[\/.]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
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

function normalizeColor(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

interface ResolvedFill {
  value: string;
  modes?: ModeAwareValue;
  tokenName?: string;
}

function resolveFillColor(
  node: FigmaNode,
  variables: FigmaLocalVariablesResponse | null,
  activeMode?: string,
): ResolvedFill | undefined {
  const fill = node.fills?.[0];
  if (!fill) return undefined;
  const alias = fill.boundVariables?.color;
  if (alias && variables) {
    const resolved = resolveColorVariable(alias.id, variables, activeMode);
    if (resolved) {
      const v = variables.meta.variables[alias.id];
      if (v) resolved.tokenName = v.name;
      return resolved;
    }
  }
  if (fill.color) return { value: rgbaToCss(fill.color) };
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

  const findByName = (modeName: string): string | undefined => {
    const mode = collection.modes.find((m) => m.name.toLowerCase() === modeName);
    if (!mode) return undefined;
    const raw = v.valuesByMode[mode.modeId];
    if (raw && typeof raw === "object" && "r" in raw) {
      return rgbaToCss(raw as { r: number; g: number; b: number; a?: number });
    }
    return undefined;
  };

  const light = findByName("light");
  const dark = findByName("dark");

  // The "comparison value" is the active mode if known, else the file default.
  const activeStr = activeMode ? findByName(activeMode) : undefined;
  const defaultRaw = v.valuesByMode[collection.defaultModeId];
  const defaultStr =
    defaultRaw && typeof defaultRaw === "object" && "r" in defaultRaw
      ? rgbaToCss(defaultRaw as { r: number; g: number; b: number; a?: number })
      : v.name;
  const value = activeStr ?? defaultStr;

  if (light && dark) {
    return { value, modes: { light, dark } };
  }
  return { value };
}

/**
 * Pick a numeric (FLOAT) variable's value for the active mode, falling back
 * to the file's default mode if the active one isn't defined.
 */
function resolveNumericForMode(
  v: FigmaVariable,
  collection: FigmaVariableCollection,
  activeMode?: string,
): number | null {
  if (activeMode) {
    const mode = collection.modes.find((m) => m.name.toLowerCase() === activeMode);
    if (mode) {
      const raw = v.valuesByMode[mode.modeId];
      if (typeof raw === "number") return raw;
    }
  }
  const defaultRaw = v.valuesByMode[collection.defaultModeId];
  return typeof defaultRaw === "number" ? defaultRaw : null;
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
 * Walk a Figma node tree depth-first and return the first TEXT node. Used
 * by the typography diffs to source font-size / line-height / family /
 * color from a node that actually has them — most component variants are
 * FRAMEs with a TEXT child rather than text nodes themselves.
 */
function findFirstTextNode(node: FigmaNode): FigmaNode | undefined {
  if (node.type === "TEXT") return node;
  for (const child of node.children ?? []) {
    const found = findFirstTextNode(child);
    if (found) return found;
  }
  return undefined;
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
      const collection = variables.meta.variableCollections[v.variableCollectionId];
      if (collection) {
        const resolved = resolveNumericForMode(v, collection, activeMode);
        if (resolved !== null) {
          figmaValue = resolved;
          tokenName = v.name;
        }
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
