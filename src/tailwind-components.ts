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
  /**
   * The identifier the `cva()` call was assigned to (`"cardHeaderVariants"`),
   * when it was assigned to one.
   *
   * Load-bearing, not decoration. `components` conflates two identities of very
   * different strength: the **file basename**, which every `cva()` in
   * `card.tsx` answers to, and the **variable name**, which names one specific
   * class list. Without the distinction, a file with `cardVariants`,
   * `cardHeaderVariants` and `cardTitleVariants` presents three equally-strong
   * candidates for `"card"` and resolution is refused — see
   * {@link resolveComponentBindings}.
   */
  variableName?: string;
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
   * Two or more scanned class lists answer to the same name and none of them
   * claims it specifically. Picking one would be a coin flip whose result looks
   * authoritative, so we resolve nothing and let the caller say so.
   *
   * `files` is **deduplicated**. It used to be one entry per candidate, which on
   * the live Card printed the same path three times and advised "rename one" —
   * advice for a cross-file collision, given for a single file, where it cannot
   * be followed. `sameFile` says which situation this actually is, and `names`
   * carries the identifiers so the message can point at something real.
   */
  | {
      kind: "ambiguous";
      component: string;
      files: string[];
      sameFile: boolean;
      names: string[];
    };

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
 *  - several scans claiming the same name, none of them specifically →
 *    `ambiguous`, nothing resolved (see {@link pickScan});
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
  /**
   * Pseudo-states the caller has **actually forced** on the element being
   * snapshotted, e.g. `["hover"]`.
   *
   * Without this, core grades `hover:` / `focus:` / `active:` variants as
   * provably off — correct for a resting snapshot, and wrong for one taken with
   * the state forced. The consequence is specific: while measuring a forced
   * `:hover`, `hover:bg-primary-hover` is inactive, so the value the element is
   * *actually painting* gets attributed to the base utility or to nothing, and a
   * fix prompt names the wrong declaration. See core's `TailwindStateContext`.
   *
   * Empty or absent is the resting state, which is every pre-existing caller.
   */
  forcedStates?: readonly string[],
): ComponentResolution {
  const name = componentName.toLowerCase();
  const matches = scans.filter((s) => s.components.includes(name));
  if (matches.length === 0) return { kind: "none" };

  const scan = pickScan(matches, name);
  if (!scan) {
    const files = [...new Set(matches.map((m) => m.file))];
    return {
      kind: "ambiguous",
      component: name,
      files,
      sameFile: files.length === 1,
      names: matches.map((m) => m.variableName ?? "(unnamed cva call)"),
    };
  }
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
  // Only ever the states the caller really forced — naming one that is not
  // forced claims a class applies when it does not.
  if (forcedStates !== undefined && forcedStates.length > 0) {
    state.forcedStates = forcedStates;
  }

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

/**
 * Choose the one scan that answers to `name`, or `null` when the candidates are
 * genuinely indistinguishable.
 *
 * The bug this replaces: a `card.tsx` holding three `cva()` calls contributed
 * three scans, and every one of them listed the file basename `"card"` among its
 * identities. So `"card"` matched three times, resolution was refused, and the
 * component's Tailwind bindings were withheld wholesale — token-attributed rows
 * on the live Card went from 26 to 12 with no signal beyond one advisory line
 * that named the same file three times and said "rename one". The failure only
 * appears on components complex enough to want more than one class list, which
 * is exactly where the attribution matters.
 *
 * The ladder:
 *
 *  1. **One candidate.** Nothing to disambiguate.
 *  2. **Exactly one candidate is *named* for it** — its `cva()` was assigned to
 *     an identifier that reduces to `name` (`cardVariants` → `card`). Every other
 *     candidate matched only because it shares the filename. This is not a
 *     tie-break by fiat: `cardVariants` is the card's class list and
 *     `cardTitleVariants` is not, and the code said so.
 *  3. **Otherwise, refuse.** Including when all candidates sit in one file. The
 *     three `cva()` calls in `card.tsx` style three different elements, so
 *     "derive from that file" still has to choose between them, and choosing
 *     `cardTitleVariants`' `text-2xl` as the card root's font size would be a
 *     coin flip wearing a token name. What changes for this case is the message,
 *     not the verdict — the caller words a same-file collision as the fixable
 *     thing it is (name one of them for the component) instead of telling the
 *     reader to rename one of three identical paths.
 */
function pickScan(
  matches: readonly TailwindComponentScan[],
  name: string,
): TailwindComponentScan | null {
  if (matches.length === 1) return matches[0]!;
  const named = matches.filter(
    (m) => m.variableName && componentIdentityFromVariableName(m.variableName) === name,
  );
  return named.length === 1 ? named[0]! : null;
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
