import type { DimensionDiff } from "./dimensions/types.js";
import { expectedIdentity } from "./property-families.js";
import type { VariantScope } from "./fix-prompt.js";

/**
 * How far does an edit reach across a component's **variants**? (issue #68)
 *
 * `property-families.ts`'s `driftedSiblings` answers the other axis: properties
 * that move together *within* one story. This one is across stories, and it is the
 * axis that produced a wrong PR: drift on one Card variant's title colour, with the
 * prompt saying "keep the change minimal — touch only the declarations responsible
 * for this property on this component/variant", while the code applied the colour
 * from a single shared class on the shared `TitleTag`. There was no variant seam.
 * Applying the fix as written would have turned all ten Card titles green and put
 * **7 of 8** previously-clean stories into drift — the report gets worse by obeying
 * its own advice.
 *
 * The evidence was already in the panel: within one **Check all** run it held eight
 * stories, one selector, one property, one expected value against seven different
 * ones. Nothing looked.
 *
 * Two properties of this module matter as much as the comparison:
 *
 *  - **`undefined` is a real answer.** A single-story check has established nothing
 *    about siblings, and the prompt says so rather than implying the edit is safely
 *    scoped. Returning an empty-but-present scope would read as "we checked and
 *    found nothing", which is the opposite of the truth.
 *  - **It never decides.** A conflict is reported to the human with both sides
 *    named. Whether the answer is a new variant axis or a design fix is not the
 *    tool's call.
 */

/** One other story's report, reduced to what this comparison needs. */
export interface SiblingStoryRows {
  storyId: string;
  dimensions: readonly DimensionDiff[];
}

/** The row being asked about. */
export interface ScopeSubject {
  storyId: string;
  property: string;
  /** The row's element, or undefined for the story root. */
  childSelector?: string | undefined;
  tokenName?: string | undefined;
  figmaValue: unknown;
}

/**
 * What the other stories in this run expect for the same element + property.
 *
 * Comparison is on `expectedIdentity` — the Figma token name when there is one,
 * the resolved value otherwise — which is the same identity `driftedSiblings` uses,
 * so "same expected value" means one thing across the whole prompt builder. A
 * sibling row whose expected value is unreadable is skipped rather than counted as
 * agreeing: an unread value is not evidence of agreement.
 *
 * Both drifted and matching sibling rows count. A **matching** sibling is the
 * dangerous one — it is currently correct, and a component-wide edit is what would
 * break it.
 */
export function variantScopeFor(
  subject: ScopeSubject,
  siblings: readonly SiblingStoryRows[],
): VariantScope | undefined {
  const own = expectedIdentity(subject);
  if (own === null) return undefined;

  const comparedStories: string[] = [];
  const conflicting: { storyId: string; expected: string }[] = [];

  for (const sibling of siblings) {
    if (sibling.storyId === subject.storyId) continue;
    const row = sibling.dimensions.find(
      (d) =>
        d.kind === "token-value" &&
        d.property === subject.property &&
        (d.childSelector ?? undefined) === (subject.childSelector ?? undefined) &&
        (d.status === "drift" || d.status === "match"),
    );
    if (!row) continue;
    const identity = expectedIdentity(row);
    if (identity === null) continue;
    comparedStories.push(sibling.storyId);
    if (identity !== own) {
      conflicting.push({
        storyId: sibling.storyId,
        // The token name is the design decision, so it is what a human reasons
        // about; the resolved value is the fallback when Figma named none.
        expected: row.tokenName ?? String(flatten(row.figmaValue)),
      });
    }
  }

  if (comparedStories.length === 0) return undefined;
  return { comparedStories, conflicting };
}

/** A displayable form of a Figma value, per-mode maps included. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
