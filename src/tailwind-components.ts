import {
  composeTailwindBindings,
  type TailwindStateContext,
  type TailwindThemeVars,
} from "@metalab/design-sync-core";

/**
 * Per-component Tailwind class layers, as authored in a `cva()` call, plus the
 * resolution that turns them into a binding set for one story, in the state that
 * story renders in.
 *
 * Why this exists: on the shadcn / Base UI / cva stack, a component's design
 * decisions are utility classes spread across a `cva()` base array and its
 * variant slots. Which of those slots apply depends on the story's args, so
 * there is no single "the component's classes" list to scan — flattening all
 * variants together would attribute `bg-primary`, `bg-secondary` AND
 * `bg-transparent` to the same property, which is a guess dressed up as a fact.
 *
 * So the scanner records the layers verbatim and resolution happens per story,
 * using the args the panel already sends with every snapshot.
 *
 * Pure module — no ts-morph, no fs. `scan-tsx.ts` builds the scans; the server
 * channel resolves them.
 */

/** One `cva()` variant axis, preserving declaration order. */
export interface TailwindVariantAxis {
  axis: string;
  /** Variant value → class list. Boolean axes appear as "true" / "false". */
  values: Record<string, string>;
}

/**
 * A `cva()` compound variant: extra classes applied when every listed axis
 * matches. Conditions are stored as string arrays so `variant: "primary"` and
 * `variant: ["primary", "neutral"]` are handled the same way.
 */
export interface TailwindCompoundVariant {
  when: Record<string, string[]>;
  classList: string;
}

export interface TailwindComponentScan {
  /**
   * Component identities this scan can be looked up by, lowercased. Collected
   * from the file basename and the assigned variable name with a trailing
   * `Variants` / `Styles` / `Classes` stripped, so both `button.tsx` and
   * `const buttonVariants = cva(...)` resolve `button`.
   */
  components: string[];
  /** Absolute path the classes were read from — used in ambiguity messages. */
  file: string;
  /** Always-applied class list. */
  base: string;
  /** Variant axes in `variants` declaration order. Order is load-bearing. */
  axes: TailwindVariantAxis[];
  /** `defaultVariants`, used when a story's args don't pin an axis. */
  defaultVariants: Record<string, string>;
  compoundVariants: TailwindCompoundVariant[];
}

export interface ResolvedComponentBindings {
  kind: "resolved";
  component: string;
  file: string;
  /** Property key → token name, for merging into the snapshot's `bindings`. */
  bindings: Record<string, string>;
  /** Property key → the utility class a fix should change. */
  classes: Record<string, string>;
  /**
   * Properties left unbound: applicable classes disagreed, or a variant slot /
   * compound variant / state modifier that could have set them couldn't be
   * evaluated.
   */
  conflicts: string[];
  /** Variant axis → the value resolution used (from args or defaults). */
  selection: Record<string, string>;
  /** The state the bindings were resolved for. Echoed for debuggability. */
  state: TailwindStateContext;
}

export type ComponentResolution =
  | ResolvedComponentBindings
  | { kind: "none" }
  /**
   * Two or more scanned components answer to the same name. Picking one would
   * be a coin flip whose result looks authoritative, so we resolve nothing and
   * let the caller say so.
   */
  | { kind: "ambiguous"; component: string; files: string[] };

/** `Variants` / `Styles` / `Classes` suffix stripping for the identity guess. */
export function componentIdentityFromVariableName(name: string): string {
  return name.replace(/(Variants|Styles|Classes|Class)$/, "").toLowerCase();
}

/**
 * Pick the value in play for each axis: an explicit story arg wins, then
 * `defaultVariants`. An axis with neither is *indeterminate* — we return it
 * separately so the caller can refuse to attribute anything that axis could
 * have overridden.
 */
function selectVariants(
  scan: TailwindComponentScan,
  args: Record<string, unknown> | undefined,
): { selection: Record<string, string>; indeterminate: string[] } {
  const selection: Record<string, string> = {};
  const indeterminate: string[] = [];
  for (const { axis, values } of scan.axes) {
    const fromArgs = args?.[axis];
    const raw =
      fromArgs === undefined || fromArgs === null
        ? scan.defaultVariants[axis]
        : String(fromArgs);
    if (raw === undefined || !(raw in values)) {
      // No arg, no default, or a value this axis doesn't declare (an arg the
      // component forwards to the DOM rather than to cva). Either way we don't
      // know which slot applied.
      indeterminate.push(axis);
      continue;
    }
    selection[axis] = raw;
  }
  return { selection, indeterminate };
}

/**
 * Which property keys a class list could bind — used to blank out unknowns.
 *
 * Called with an "everything on" state so a class list that only styles a state
 * (`data-disabled:bg-disabled`) still counts as touching `background-color`.
 * The point here is *could this slot have overridden the answer*, not *did it*.
 */
const ANY_STATE: TailwindStateContext = { disabled: true, mode: "dark" };

function propertiesTouchedBy(
  classList: string,
  themeVars: TailwindThemeVars,
): string[] {
  const { bindings, conflicts } = composeTailwindBindings(
    classList,
    [],
    themeVars,
    ANY_STATE,
  );
  return [...Object.keys(bindings), ...conflicts];
}

/**
 * How many distinct *binding scopes* a set of component scans produced: the
 * base class list, plus each variant slot and compound variant that resolves at
 * least one token. This is what the startup log counts for Tailwind consumers —
 * a cva slot is a real, independently-resolvable scope, but it is not a CSS
 * selector, so it is reported as its own number rather than folded silently
 * into the selector count.
 */
export function countTailwindScopes(
  scans: TailwindComponentScan[],
  themeVars: TailwindThemeVars,
): number {
  let total = 0;
  for (const scan of scans) {
    if (propertiesTouchedBy(scan.base, themeVars).length > 0) total++;
    for (const { values } of scan.axes) {
      for (const classList of Object.values(values)) {
        if (propertiesTouchedBy(classList, themeVars).length > 0) total++;
      }
    }
    for (const compound of scan.compoundVariants) {
      if (propertiesTouchedBy(compound.classList, themeVars).length > 0) total++;
    }
  }
  return total;
}

/**
 * Resolve one story's Tailwind bindings — the bindings for the state this story
 * actually renders in, not an abstract resting state. A `disabled: true` story
 * paints its `data-disabled:` classes, and core's `composeTailwindBindings`
 * grades each modifier against `state` accordingly.
 *
 * `componentName` is the component segment of the story id (see
 * `componentNameFromStoryId` in `fix-prompt.ts`); `args` are the story's args
 * as the panel already sends them.
 *
 * Honesty rules, in order:
 *  - two scans claiming the same name → `ambiguous`, nothing resolved;
 *  - an axis whose applied value can't be determined → every property any of
 *    that axis's slots could set is dropped, because one of them may have
 *    overridden the base;
 *  - a compound variant we can't evaluate (it tests an indeterminate axis) →
 *    same treatment for the properties it touches;
 *  - anything left over came from a class list we know applied.
 */
export function resolveComponentBindings(
  scans: TailwindComponentScan[],
  componentName: string,
  args: Record<string, unknown> | undefined,
  themeVars: TailwindThemeVars,
  mode?: string,
): ComponentResolution {
  const name = componentName.toLowerCase();
  const matches = scans.filter((s) => s.components.includes(name));
  if (matches.length === 0) return { kind: "none" };
  if (matches.length > 1) {
    return { kind: "ambiguous", component: name, files: matches.map((m) => m.file) };
  }

  const scan = matches[0]!;
  const { selection, indeterminate } = selectVariants(scan, args);

  // Overlays in `variants` declaration order — cva concatenates the slots in
  // that order and `cn()` / tailwind-merge resolves last-wins, so the order is
  // the actual precedence, not a convention.
  const overlays: string[] = [];
  for (const { axis, values } of scan.axes) {
    const chosen = selection[axis];
    if (chosen === undefined) continue;
    overlays.push(values[chosen] ?? "");
  }

  const unknown = new Set<string>();
  // Any slot of an indeterminate axis might be the one that applied.
  for (const { axis, values } of scan.axes) {
    if (!indeterminate.includes(axis)) continue;
    for (const classList of Object.values(values)) {
      for (const prop of propertiesTouchedBy(classList, themeVars)) unknown.add(prop);
    }
  }

  for (const compound of scan.compoundVariants) {
    const verdict = evaluateCompound(compound, selection, indeterminate);
    if (verdict === "applies") {
      overlays.push(compound.classList);
    } else if (verdict === "unknown") {
      for (const prop of propertiesTouchedBy(compound.classList, themeVars)) {
        unknown.add(prop);
      }
    }
    // "excluded" contributes nothing, which is correct.
  }

  // State the story renders in. `disabled` comes straight from the story's args
  // (absent means false — see core's TailwindStateContext); `mode` from the
  // snapshot payload, and is left undefined when the consumer sets no mode
  // attribute, which makes `dark:` classes indeterminate rather than assumed.
  const state: TailwindStateContext = { disabled: args?.["disabled"] === true };
  if (mode !== undefined) state.mode = mode;

  const composed = composeTailwindBindings(scan.base, overlays, themeVars, state);

  const bindings: Record<string, string> = {};
  const classes: Record<string, string> = {};
  for (const [prop, binding] of Object.entries(composed.bindings)) {
    if (unknown.has(prop)) continue;
    bindings[prop] = binding.token;
    classes[prop] = binding.className;
  }

  return {
    kind: "resolved",
    component: name,
    file: scan.file,
    bindings,
    classes,
    conflicts: [...new Set([...composed.conflicts, ...unknown])].sort(),
    selection,
    state,
  };
}

function evaluateCompound(
  compound: TailwindCompoundVariant,
  selection: Record<string, string>,
  indeterminate: string[],
): "applies" | "excluded" | "unknown" {
  let sawUnknown = false;
  for (const [axis, allowed] of Object.entries(compound.when)) {
    const chosen = selection[axis];
    if (chosen === undefined) {
      // The compound tests an axis we couldn't pin down.
      if (indeterminate.includes(axis)) sawUnknown = true;
      else return "excluded";
      continue;
    }
    if (!allowed.includes(chosen)) return "excluded";
  }
  return sawUnknown ? "unknown" : "applies";
}
