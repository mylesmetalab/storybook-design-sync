import { normalizeTokenName } from "@metalab/design-sync-core";
import { SHORTHAND_EXPANSIONS, INLINE_BINDING_KEY } from "./binding-shape.js";
import { flattenDualModeValue } from "./row-triage.js";
import type { DimensionDiff } from "./dimensions/types.js";

/**
 * Property families — which CSS properties move together as **one** design
 * decision.
 *
 * Why this exists: a per-row fix prompt for one of four drifted paddings, handed
 * over on its own, produced a component with `6px / 12px / 12px / 12px` padding
 * — a state nobody designed. A single drifted row is therefore not enough
 * context to act on: the prompt has to know that `padding-top` has siblings and
 * say so (see `fix-prompt.ts`), and the bulk prompt has to present the four as
 * one change rather than four.
 *
 * The relationships are **derived** from the shorthand tables in
 * `./binding-shape.js` (a re-export of `@metalab/design-sync-core`), not
 * re-listed here. Three tables disagreeing about which longhands belong to
 * `padding` is the exact bug class binding-shape exists to prevent, and this
 * module must never become the fourth.
 */

export interface PropertyFamily {
  /**
   * Label used in prompt headings — the shorthand or engine key the family is
   * named after (`padding`, `border-radius`, `border-color`).
   */
  label: string;
  /**
   * Every property that belongs to the family, including the shorthand / engine
   * key itself. The engine emits some families per-edge (`border-top-color`)
   * and some collapsed onto one key (`border-color`), so both spellings belong
   * to the same family or a row would find no siblings depending on which
   * scanner produced it.
   */
  members: readonly string[];
}

/**
 * Relationships CSS has no shorthand for, and which therefore cannot come out
 * of `SHORTHAND_EXPANSIONS`. Deliberately tiny: an entry here is a claim that
 * two properties are one design decision, and a wrong claim would tell an agent
 * to change a property nobody said had drifted.
 *
 * `font-size` / `line-height`: the pair is a single step on the type ramp, and
 * Figma stores them on one TEXT style. The CSS `font` shorthand does relate
 * them, but no scanner in this codebase emits it, so it is not in the
 * shorthand table.
 */
const NON_SHORTHAND_FAMILIES: readonly PropertyFamily[] = [
  { label: "type ramp", members: ["font-size", "line-height"] },
];

function buildFamilies(): PropertyFamily[] {
  const families: PropertyFamily[] = [];

  // 1. Shorthand → longhands. `padding` → the four sides, `border-radius` →
  //    the four corners. `background` expands to a single longhand and so has
  //    no siblings to name; skipped rather than emitted as a family of one.
  for (const [shorthand, longhands] of Object.entries(SHORTHAND_EXPANSIONS)) {
    if (longhands.length < 2) continue;
    families.push({ label: shorthand, members: [shorthand, ...longhands] });
  }

  // 2. Per-edge longhands that all normalize onto one engine key:
  //    `border-*-color` → `border-color`, `border-*-width` → `border-width`.
  //    Same table the scanners use to file bindings, read in reverse.
  const byKey = new Map<string, string[]>();
  for (const [prop, key] of Object.entries(INLINE_BINDING_KEY)) {
    const list = byKey.get(key) ?? [];
    list.push(prop);
    byKey.set(key, list);
  }
  for (const [key, props] of byKey) {
    if (props.length < 2) continue;
    families.push({ label: key, members: [key, ...props] });
  }

  families.push(...NON_SHORTHAND_FAMILIES);
  return families;
}

const FAMILIES: readonly PropertyFamily[] = buildFamilies();

const FAMILY_BY_PROPERTY: Map<string, PropertyFamily> = (() => {
  const map = new Map<string, PropertyFamily>();
  for (const family of FAMILIES) {
    for (const member of family.members) {
      // First family wins — the tables don't overlap today, and silently
      // re-homing a property later would change which siblings a prompt names.
      if (!map.has(member)) map.set(member, family);
    }
  }
  return map;
})();

/** Every derived family. Exported for tests and for prompt-side iteration. */
export function propertyFamilies(): readonly PropertyFamily[] {
  return FAMILIES;
}

/**
 * The family a property belongs to, or `undefined` when it stands alone
 * (`gap`, `box-shadow`, `color`, …). A property with no family never grows
 * sibling context — there is nothing true to say about it.
 */
export function propertyFamily(property: string): PropertyFamily | undefined {
  return FAMILY_BY_PROPERTY.get(property);
}

/**
 * A comparable identity for "the value Figma expects here", so two drifted rows
 * can be judged to have drifted to the *same* thing.
 *
 * Prefers the token name (normalized, so `Space/150` ≡ `space-150`) because
 * that is the design decision; falls back to the resolved value string. Returns
 * null when neither side is readable — a row with no expected value can never
 * be shown as another row's sibling.
 */
export function expectedIdentity(d: {
  tokenName?: string | undefined;
  figmaValue: unknown;
}): string | null {
  if (d.tokenName !== undefined && d.tokenName !== null && d.tokenName !== "") {
    return `token:${normalizeTokenName(d.tokenName)}`;
  }
  const flat = flattenDualModeValue(d.figmaValue);
  if (flat !== null) return `value:${flat}`;
  return null;
}

/**
 * The other properties in `target`'s family that drifted **to the same expected
 * value on the same element**.
 *
 * All four conditions matter:
 *  - same family — `padding-top` and `gap` are not one change;
 *  - same element — a child's `padding-top` says nothing about the root's;
 *  - both drifted — a matching sibling must not be dragged into the edit;
 *  - same expected value — four paddings drifting to four *different* values
 *    are four decisions, and naming them as one would be the same kind of lie
 *    this feature exists to remove.
 *
 * Order follows `all`, so the prompt lists siblings in table order.
 */
export function driftedSiblings(
  target: DimensionDiff,
  all: readonly DimensionDiff[],
): DimensionDiff[] {
  if (target.kind !== "token-value" || target.status !== "drift") return [];
  const family = propertyFamily(target.property);
  if (!family) return [];
  const identity = expectedIdentity(target);
  if (identity === null) return [];
  const members = new Set(family.members);
  return all.filter(
    (d) =>
      d !== target &&
      d.kind === "token-value" &&
      d.status === "drift" &&
      d.property !== target.property &&
      d.childSelector === target.childSelector &&
      members.has(d.property) &&
      expectedIdentity(d) === identity,
  );
}
