/**
 * Resolving `variables/local` into per-mode values (v0.0.66).
 *
 * Exists for one consumer: `verify`'s shared-value re-check, which must answer
 * "do these variables still resolve to the same value, mode by mode". In a real
 * file that means following aliases — SDS's semantic `Color` variables alias a
 * single-mode `Color Primitives` collection — with Figma's own fallback rule:
 * when the alias target's collection lacks the current mode, the target's
 * DEFAULT mode value applies.
 *
 * Pure: JSON in, resolved values out. The fetch lives in `verify-command.ts`.
 *
 * ## Honesty rules
 *
 * - `null` on an unreadable shape, never an empty result — an empty result reads
 *   as "the file has no variables", which would falsify every claim.
 * - A mode whose alias chain cannot be resolved (cycle, missing target) is listed
 *   in `unresolved`, never silently dropped and never guessed: the consumer must
 *   treat it as a failed read for that comparison, not as agreement.
 */

export interface ResolvedVariable {
  name: string;
  collectionId: string;
  collectionName: string;
  /** Mode NAME → normalized value string. A mode absent here failed to resolve. */
  resolvedByMode: Record<string, string>;
  /** Mode names whose value could not be resolved (alias cycle, missing target). */
  unresolved: string[];
}

export interface ResolvedVariablesLocal {
  collections: Array<{ id: string; name: string; modes: string[] }>;
  variables: ResolvedVariable[];
}

interface RawCollection {
  id: string;
  name: string;
  defaultModeId?: string;
  modes: Array<{ modeId: string; name: string }>;
}

interface RawVariable {
  id: string;
  name: string;
  variableCollectionId: string;
  valuesByMode: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rawCollections(meta: Record<string, unknown>): Map<string, RawCollection> | null {
  const raw = asRecord(meta["variableCollections"]);
  if (!raw) return null;
  const out = new Map<string, RawCollection>();
  for (const entry of Object.values(raw)) {
    const c = asRecord(entry);
    if (!c || typeof c["id"] !== "string" || typeof c["name"] !== "string") continue;
    const modes = (Array.isArray(c["modes"]) ? c["modes"] : [])
      .map((m) => asRecord(m))
      .filter((m): m is Record<string, unknown> => !!m)
      .map((m) => ({ modeId: m["modeId"], name: m["name"] }))
      .filter((m): m is { modeId: string; name: string } =>
        typeof m.modeId === "string" && typeof m.name === "string",
      );
    const collection: RawCollection = { id: c["id"], name: c["name"], modes };
    if (typeof c["defaultModeId"] === "string") collection.defaultModeId = c["defaultModeId"];
    out.set(collection.id, collection);
  }
  return out.size > 0 ? out : null;
}

function rawVariables(meta: Record<string, unknown>): Map<string, RawVariable> | null {
  const raw = asRecord(meta["variables"]);
  if (!raw) return null;
  const out = new Map<string, RawVariable>();
  for (const entry of Object.values(raw)) {
    const v = asRecord(entry);
    if (
      !v ||
      typeof v["id"] !== "string" ||
      typeof v["name"] !== "string" ||
      typeof v["variableCollectionId"] !== "string"
    ) {
      continue;
    }
    const valuesByMode = asRecord(v["valuesByMode"]);
    if (!valuesByMode) continue;
    out.set(v["id"], {
      id: v["id"],
      name: v["name"],
      variableCollectionId: v["variableCollectionId"],
      valuesByMode,
    });
  }
  return out;
}

function isAlias(value: unknown): value is { type: "VARIABLE_ALIAS"; id: string } {
  const v = asRecord(value);
  return !!v && v["type"] === "VARIABLE_ALIAS" && typeof v["id"] === "string";
}

/** 0–1 float channel → two lowercase hex digits. */
function channel(x: unknown): string | undefined {
  if (typeof x !== "number" || !Number.isFinite(x)) return undefined;
  const n = Math.round(Math.min(1, Math.max(0, x)) * 255);
  return n.toString(16).padStart(2, "0");
}

/**
 * A raw variable value → comparable string. Colors become hex (8-digit only when
 * alpha carries information), numbers and strings pass through, anything else is
 * JSON — stable, even if ugly, which is all a comparison needs.
 */
function normalize(value: unknown): string {
  const record = asRecord(value);
  if (record && "r" in record && "g" in record && "b" in record) {
    const r = channel(record["r"]);
    const g = channel(record["g"]);
    const b = channel(record["b"]);
    if (r !== undefined && g !== undefined && b !== undefined) {
      const a = record["a"] === undefined ? "ff" : channel(record["a"]);
      const hex = `#${r}${g}${b}`;
      return a === undefined || a === "ff" ? hex : `${hex}${a}`;
    }
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

/** Alias chains in real files are 1–2 hops; anything past this is a defect, not depth. */
const MAX_HOPS = 12;

export function resolveVariablesLocal(meta: unknown): ResolvedVariablesLocal | null {
  const doc = asRecord(meta);
  if (!doc) return null;
  const collections = rawCollections(doc);
  const variables = rawVariables(doc);
  if (!collections || !variables) return null;

  /**
   * One variable's value in one mode, aliases followed. The `modeId` is the
   * ORIGINAL requested mode all the way down the chain: each hop first tries the
   * target's value for that mode, then the target collection's default — which is
   * how a two-mode semantic resolves differently through a one-mode primitive.
   */
  function resolve(variable: RawVariable, modeId: string): string | undefined {
    let current = variable;
    const seen = new Set<string>();
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const key = `${current.id}@${modeId}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      const collection = collections!.get(current.variableCollectionId);
      const fallback = collection?.defaultModeId ?? collection?.modes[0]?.modeId;
      const raw =
        current.valuesByMode[modeId] ??
        (fallback !== undefined ? current.valuesByMode[fallback] : undefined);
      if (raw === undefined) return undefined;
      if (!isAlias(raw)) return normalize(raw);
      const next = variables!.get(raw.id);
      if (!next) return undefined;
      current = next;
    }
    return undefined;
  }

  const resolved: ResolvedVariable[] = [];
  for (const variable of variables.values()) {
    const collection = collections.get(variable.variableCollectionId);
    if (!collection) continue;
    const resolvedByMode: Record<string, string> = {};
    const unresolved: string[] = [];
    for (const mode of collection.modes) {
      const value = resolve(variable, mode.modeId);
      if (value === undefined) unresolved.push(mode.name);
      else resolvedByMode[mode.name] = value;
    }
    resolved.push({
      name: variable.name,
      collectionId: collection.id,
      collectionName: collection.name,
      resolvedByMode,
      unresolved,
    });
  }

  return {
    collections: [...collections.values()].map((c) => ({
      id: c.id,
      name: c.name,
      modes: c.modes.map((m) => m.name),
    })),
    variables: resolved,
  };
}
