import type { DimensionDiff } from "../dimensions/types.js";

/**
 * Figma **component properties** (BOOLEAN / TEXT / INSTANCE_SWAP) vs Storybook
 * story args.
 *
 * `componentPropertyDefinitions` was previously read for one thing only — the
 * `variantOptions` list feeding the variant-set check — so a component that
 * declares `Has Icon Start` / `Has Icon End` in Figma and maps them to the
 * presence of `iconStart` / `iconEnd` props in code had that mapping verified
 * by nothing at all.
 *
 * The comparison is deliberately narrow:
 *
 *   - **BOOLEAN** → truthiness of the one arg whose name corresponds. No
 *     candidate, or more than one, means no row (see `matchArgForProperty`).
 *   - **TEXT** → the arg's string value, unless the same string is already
 *     reported by the `copy` dimension (the main label almost always is), in
 *     which case `copy` wins and this emits nothing — one string, one row.
 *   - **INSTANCE_SWAP** → never compared. The Figma side is a component
 *     identity (which icon); the code side is a ReactNode. There is no honest
 *     equivalence, so these are collected into a single informational row that
 *     names them as unmodelled instead of pretending to check them.
 *   - **VARIANT** → skipped here; `diffProps` already compares variant axes
 *     parsed from the node name.
 *
 * ### Authoritative vs default values
 *
 * An INSTANCE carries `componentProperties` — the values that instance
 * actually renders with — and those support a real match/drift verdict. A
 * COMPONENT or COMPONENT_SET only carries `componentPropertyDefinitions`,
 * whose `defaultValue` is the component's *default*, not the state the story
 * depicts: a `WithIcon` story legitimately differs from a `Has Icon = false`
 * default. Disagreement against a default is therefore reported `flag-only`
 * with an explanation, never as drift.
 */

/** Figma REST `componentPropertyDefinitions` entry. */
export interface FigmaComponentPropertyDefinition {
  type: string;
  defaultValue?: unknown;
  variantOptions?: string[];
}

/** Figma REST `componentProperties` entry (present on INSTANCE nodes). */
export interface FigmaComponentPropertyValue {
  type: string;
  value?: unknown;
}

/**
 * Figma suffixes non-variant property keys with the defining node's id
 * (`"Has Icon Start#4611:0"`). The suffix is an implementation detail and must
 * be stripped before any name matching or display.
 */
export function stripPropertyIdSuffix(key: string): string {
  const hash = key.indexOf("#");
  return (hash === -1 ? key : key.slice(0, hash)).trim();
}

/** Lowercase, alphanumerics only: `"Has Icon Start"` → `"hasiconstart"`. */
export function normalizePropName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Drop a leading `has`/`is` from an already-normalized name. */
export function stripBooleanPrefix(normalized: string): string {
  return normalized.replace(/^(?:has|is)/, "");
}

export type ArgMatch =
  | { kind: "one"; key: string }
  | { kind: "none" }
  | { kind: "ambiguous"; keys: string[] };

/**
 * Find the single story arg that corresponds to a Figma property name.
 *
 * Two passes, exact before loose, because the exact pass is what disambiguates
 * the common near-collision: Figma `Has Icon` against args `{hasIcon, icon}`
 * resolves to `hasIcon` rather than reading as ambiguous.
 *
 *   1. **exact** — `normalizePropName` equal on both sides
 *      (`"Has Icon Start"` ↔ `hasIconStart`).
 *   2. **loose** — equal after also dropping a leading `has`/`is` from each
 *      (`"Has Icon Start"` ↔ `iconStart`).
 *
 * Anything other than exactly one winner in the first non-empty pass is a
 * refusal: `none` when nothing corresponds, `ambiguous` when several do
 * (`"Has Icon Start"` against `{iconStart, isIconStart}`). Both mean no row —
 * guessing which arg a designer meant is exactly the confident-but-wrong
 * signal this tool must not emit.
 */
export function matchArgForProperty(
  figmaName: string,
  args: Record<string, unknown>,
): ArgMatch {
  const target = normalizePropName(figmaName);
  if (!target) return { kind: "none" };
  const exact: string[] = [];
  const loose: string[] = [];
  const targetLoose = stripBooleanPrefix(target);
  for (const key of Object.keys(args)) {
    const norm = normalizePropName(key);
    if (!norm) continue;
    if (norm === target) {
      exact.push(key);
      continue;
    }
    if (targetLoose && stripBooleanPrefix(norm) === targetLoose) loose.push(key);
  }
  const pool = exact.length > 0 ? exact : loose;
  if (pool.length === 0) return { kind: "none" };
  if (pool.length > 1) return { kind: "ambiguous", keys: pool };
  return { kind: "one", key: pool[0]! };
}

/** One property's Figma-side value and how much authority it carries. */
interface EffectiveProperty {
  type: string;
  value: unknown;
  /** True for an INSTANCE's actual value; false for a component default. */
  authoritative: boolean;
}

/**
 * Collapse an INSTANCE's `componentProperties` and a COMPONENT(_SET)'s
 * `componentPropertyDefinitions` into one map keyed by the display name.
 * Instance values win — they describe what is actually rendered.
 */
export function effectiveComponentProperties(node: {
  componentProperties?: Record<string, FigmaComponentPropertyValue> | undefined;
  componentPropertyDefinitions?: Record<string, FigmaComponentPropertyDefinition> | undefined;
}): Map<string, EffectiveProperty> {
  const out = new Map<string, EffectiveProperty>();
  for (const [key, entry] of Object.entries(node.componentProperties ?? {})) {
    const name = stripPropertyIdSuffix(key);
    if (!name || !entry) continue;
    out.set(name, { type: entry.type, value: entry.value, authoritative: true });
  }
  for (const [key, def] of Object.entries(node.componentPropertyDefinitions ?? {})) {
    const name = stripPropertyIdSuffix(key);
    if (!name || !def || out.has(name)) continue;
    out.set(name, { type: def.type, value: def.defaultValue, authoritative: false });
  }
  return out;
}

/** Keep the cell JSON-safe: story args can carry ReactNodes and functions. */
function describeArgValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return "<provided>";
}

function propsRow(opts: {
  property: string;
  codeValue: unknown;
  figmaValue: unknown;
  status: DimensionDiff["status"];
  note?: string;
}): DimensionDiff {
  return {
    kind: "props",
    property: opts.property,
    codeValue: opts.codeValue,
    figmaValue: opts.figmaValue,
    status: opts.status,
    ...(opts.note ? { note: opts.note } : {}),
  };
}

const DEFAULT_ONLY_NOTE =
  "Figma reports this as the component's *default* value (the registered node is a " +
  "COMPONENT/COMPONENT_SET, not an instance), so a story depicting the other state is not " +
  "necessarily wrong — no drift claimed. Register the story against an INSTANCE to get a verdict.";

/**
 * Build the component-property rows for one node.
 *
 * `figmaTexts` is the set of TEXT-node strings the `copy` dimension will
 * report; a TEXT property whose value is one of them is skipped so the same
 * string isn't reported twice.
 */
export function componentPropertyRows(opts: {
  node: {
    componentProperties?: Record<string, FigmaComponentPropertyValue> | undefined;
    componentPropertyDefinitions?: Record<string, FigmaComponentPropertyDefinition> | undefined;
  };
  args: Record<string, unknown>;
  figmaTexts?: string[];
}): DimensionDiff[] {
  const properties = effectiveComponentProperties(opts.node);
  const rows: DimensionDiff[] = [];
  const unmodelled: string[] = [];
  const copyOwned = new Set((opts.figmaTexts ?? []).map((t) => t.trim().toLowerCase()));

  for (const [name, prop] of properties) {
    if (prop.type === "INSTANCE_SWAP") {
      unmodelled.push(name);
      continue;
    }
    if (prop.type !== "BOOLEAN" && prop.type !== "TEXT") continue; // VARIANT et al.

    const match = matchArgForProperty(name, opts.args);
    if (match.kind !== "one") continue; // no candidate / ambiguous → no row
    const argValue = opts.args[match.key];

    if (prop.type === "BOOLEAN") {
      if (typeof prop.value !== "boolean") continue; // unreadable Figma side
      const codeTruthy = Boolean(argValue);
      const agrees = codeTruthy === prop.value;
      rows.push(
        propsRow({
          property: name,
          codeValue: { [match.key]: describeArgValue(argValue) },
          figmaValue: prop.value,
          status: agrees ? "match" : prop.authoritative ? "drift" : "flag-only",
          ...(agrees || prop.authoritative ? {} : { note: DEFAULT_ONLY_NOTE }),
        }),
      );
      continue;
    }

    // TEXT
    if (typeof prop.value !== "string") continue;
    const figmaText = prop.value.trim();
    if (!figmaText) continue;
    if (copyOwned.has(figmaText.toLowerCase())) continue; // `copy` already reports it
    if (typeof argValue !== "string") continue; // a ReactNode isn't comparable to a string
    const agrees = argValue.trim().toLowerCase() === figmaText.toLowerCase();
    rows.push(
      propsRow({
        property: name,
        codeValue: { [match.key]: argValue },
        figmaValue: figmaText,
        status: agrees ? "match" : prop.authoritative ? "drift" : "flag-only",
        ...(agrees || prop.authoritative ? {} : { note: DEFAULT_ONLY_NOTE }),
      }),
    );
  }

  if (unmodelled.length > 0) {
    rows.push(
      propsRow({
        property: "instance-swap",
        codeValue: null,
        figmaValue: unmodelled,
        status: "flag-only",
        note:
          `Figma declares INSTANCE_SWAP propert${unmodelled.length === 1 ? "y" : "ies"} ` +
          `[${unmodelled.join(", ")}]. The Figma side is a component identity and the code side a ` +
          `ReactNode — there is no honest equivalence, so these are surfaced as unmodelled rather ` +
          `than compared.`,
      }),
    );
  }

  return rows;
}
