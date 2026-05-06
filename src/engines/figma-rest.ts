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

class FigmaRestEngine implements Engine {
  readonly name = "figma-rest";
  private readonly pat: string | undefined;

  constructor(ctx: EngineContext) {
    this.pat = ctx.figmaPat;
  }

  async checkDrift(input: CheckDriftInput): Promise<DriftReport> {
    if (!this.pat) {
      throw new Error(
        "[design-sync] FIGMA_PAT env var is not set; cannot call Figma REST.",
      );
    }
    const { fileKey, nodeId } = input.nodeRef;
    const node = await this.fetchNode(fileKey, nodeId);
    const variables = await this.fetchLocalVariables(fileKey).catch(() => null);

    const dimensions: DimensionDiff[] = [];
    const snapshot = input.snapshot;

    dimensions.push(...this.diffTokenValues(node, snapshot, variables));
    dimensions.push(...this.diffTokenBindings(node, snapshot, variables));
    dimensions.push(...this.diffVariantSet(node, snapshot));

    // Reserved kinds — engine fills as flag-only placeholders for v0.
    dimensions.push(
      this.placeholder("copy", "story.copy"),
      this.placeholder("props", "story.props"),
      this.placeholder("structure", "story.structure"),
      this.placeholder("motion", "story.motion"),
    );

    return {
      storyId: input.storyId,
      nodeId,
      dimensions,
      generatedAt: new Date().toISOString(),
    };
  }

  // ---- HTTP ---------------------------------------------------------------

  private async fetchNode(fileKey: string, nodeId: string): Promise<FigmaNode> {
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
    return entry.document;
  }

  private async fetchLocalVariables(fileKey: string): Promise<FigmaLocalVariablesResponse | null> {
    const url = `${FIGMA_API}/files/${encodeURIComponent(fileKey)}/variables/local`;
    const res = await fetch(url, { headers: this.headers() });
    if (res.status === 404 || res.status === 403) return null; // not enterprise / no access
    if (!res.ok) {
      throw new Error(`[design-sync] Figma variables ${res.status} for ${fileKey}.`);
    }
    return (await res.json()) as FigmaLocalVariablesResponse;
  }

  private headers(): Record<string, string> {
    return { "X-Figma-Token": this.pat ?? "" };
  }

  // ---- Diff logic ---------------------------------------------------------

  private diffTokenValues(
    node: FigmaNode,
    snapshot: CodeSnapshot | undefined,
    variables: FigmaLocalVariablesResponse | null,
  ): DimensionDiff[] {
    const out: DimensionDiff[] = [];
    if (!snapshot) return out;

    // Background color: code "background-color" vs Figma fills[0] (resolved).
    const codeBg = snapshot.styles["background-color"];
    const figmaBg = resolveFillColor(node, variables);
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
      const defaultRaw = v.valuesByMode[collection.defaultModeId];
      if (typeof defaultRaw !== "number") continue;
      const codeValue = snapshot.styles[cssProp];
      const codePx = parsePx(codeValue);
      const status: DimensionDiff["status"] =
        codePx !== null && Math.abs(codePx - defaultRaw) < 0.5 ? "match" : "drift";
      out.push({
        kind: "token-value",
        property: cssProp,
        codeValue: codeValue ?? null,
        figmaValue: `${defaultRaw}px (token: ${v.name})`,
        status,
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
        const defaultRaw = v.valuesByMode[collection.defaultModeId];
        if (typeof defaultRaw !== "number") continue;
        const codeValue = snapshot.styles[cssProp];
        const codePx = parsePx(codeValue);
        const status: DimensionDiff["status"] =
          codePx !== null && Math.abs(codePx - defaultRaw) < 0.5 ? "match" : "drift";
        out.push({
          kind: "token-value",
          property: cssProp,
          codeValue: codeValue ?? null,
          figmaValue: `${defaultRaw}px (token: ${v.name})`,
          status,
        });
      }
    }

    return out;
  }

  private diffTokenBindings(
    node: FigmaNode,
    snapshot: CodeSnapshot | undefined,
    variables: FigmaLocalVariablesResponse | null,
  ): DimensionDiff[] {
    const out: DimensionDiff[] = [];
    const bindings = snapshot?.bindings ?? {};
    const figmaBindings = collectFigmaBindings(node, variables);

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
        status = codeValue === figma.tokenName ? "match" : "drift";
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
    // Strip any "<component>--" prefix from BEM-modifier classes so we
    // compare just the variant value (e.g. "icon-button--accent" → "accent").
    const codeVariants = new Set(
      (snapshot?.variantClasses ?? [])
        .map((c) => {
          const dashIdx = c.indexOf("--");
          return dashIdx === -1 ? c : c.slice(dashIdx + 2);
        })
        .map((v) => v.toLowerCase()),
    );

    // If this node is a single COMPONENT (a variant in a set), Figma encodes
    // the active variant as the node name "Property=Value, Other=Value".
    // Compare those values to the code-side variant classes.
    if (node.type === "COMPONENT" && node.name.includes("=")) {
      const figmaActive = new Set(
        node.name
          .split(",")
          .map((s) => s.trim().split("=")[1])
          .filter((s): s is string => !!s)
          .map((s) => s.toLowerCase()),
      );

      // "Default" is conventionally not emitted as a BEM modifier in code —
      // a story `--default` is just the base class. Filter it out so we don't
      // flag "Figma says Default, code has no modifier" as drift.
      figmaActive.delete("default");

      const onlyCode = [...codeVariants].filter((v) => !figmaActive.has(v));
      const onlyFigma = [...figmaActive].filter((v) => !codeVariants.has(v));
      const status: DimensionDiff["status"] =
        onlyCode.length === 0 && onlyFigma.length === 0 ? "match" : "drift";
      const diff: DimensionDiff = {
        kind: "variant-set",
        property: "active-variant",
        codeValue: [...codeVariants],
        figmaValue: [...figmaActive],
        status,
      };
      if (status === "drift") {
        diff.note = `code-only: [${onlyCode.join(", ")}], figma-only: [${onlyFigma.join(", ")}]`;
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
}

function resolveFillColor(
  node: FigmaNode,
  variables: FigmaLocalVariablesResponse | null,
): ResolvedFill | undefined {
  const fill = node.fills?.[0];
  if (!fill) return undefined;
  const alias = fill.boundVariables?.color;
  if (alias && variables) {
    const resolved = resolveColorVariable(alias.id, variables);
    if (resolved) return resolved;
  }
  if (fill.color) return { value: rgbaToCss(fill.color) };
  return undefined;
}

function resolveColorVariable(
  variableId: string,
  variables: FigmaLocalVariablesResponse,
): ResolvedFill | undefined {
  const v = variables.meta.variables[variableId];
  if (!v || v.resolvedType !== "COLOR") return undefined;
  const collection = variables.meta.variableCollections[v.variableCollectionId];
  if (!collection) return undefined;

  const find = (modeName: string): string | undefined => {
    const mode = collection.modes.find((m) => m.name.toLowerCase() === modeName);
    if (!mode) return undefined;
    const raw = v.valuesByMode[mode.modeId];
    if (raw && typeof raw === "object" && "r" in raw) {
      return rgbaToCss(raw as { r: number; g: number; b: number; a?: number });
    }
    return undefined;
  };

  const light = find("light");
  const dark = find("dark");
  const defaultRaw = v.valuesByMode[collection.defaultModeId];
  const defaultStr =
    defaultRaw && typeof defaultRaw === "object" && "r" in defaultRaw
      ? rgbaToCss(defaultRaw as { r: number; g: number; b: number; a?: number })
      : v.name;

  if (light && dark) {
    return { value: defaultStr, modes: { light, dark } };
  }
  return { value: defaultStr };
}

interface FigmaBinding {
  tokenName: string;
  modes?: ModeAwareValue;
}

function collectFigmaBindings(
  node: FigmaNode,
  variables: FigmaLocalVariablesResponse | null,
): Record<string, FigmaBinding> {
  const out: Record<string, FigmaBinding> = {};
  const raw = node.boundVariables ?? {};
  for (const [property, alias] of Object.entries(raw)) {
    const aliases = Array.isArray(alias) ? alias : [alias];
    const first = aliases[0];
    if (!first) continue;
    const v = variables?.meta.variables[first.id];
    if (!v) {
      out[property] = { tokenName: first.id };
      continue;
    }
    const resolved =
      v.resolvedType === "COLOR" ? resolveColorVariable(first.id, variables!) : undefined;
    const binding: FigmaBinding = { tokenName: v.name };
    if (resolved?.modes) binding.modes = resolved.modes;
    out[property] = binding;
  }
  // Also surface fill-bound variables under "background-color".
  const fillAlias = node.fills?.[0]?.boundVariables?.color;
  if (fillAlias && variables) {
    const v = variables.meta.variables[fillAlias.id];
    if (v) {
      const resolved = resolveColorVariable(fillAlias.id, variables);
      const binding: FigmaBinding = { tokenName: v.name };
      if (resolved?.modes) binding.modes = resolved.modes;
      out["background-color"] = binding;
    }
  }
  return out;
}

export const createFigmaRestEngine: EngineFactory = (ctx) => new FigmaRestEngine(ctx);
