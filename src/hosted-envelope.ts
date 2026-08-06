import type { CheckJsonDocument } from "./check-report.js";

/**
 * How a hosted check came to run. Recorded so a reader never has to guess
 * whether a result reflects a designer's live question or last night's sweep.
 */
export type HostedTrigger = "on-demand" | "on-merge" | "nightly" | "figma-webhook";

/**
 * `CheckJsonDocument`, plus what only exists once the check runs unattended,
 * on infrastructure separate from the thing it measures (HOSTED-CHECK-SPEC.md
 * §7).
 *
 * `measuringVersion` and `engineVersion` are two fields, not one: in hosted
 * mode the deployed Storybook build (what produced the DOM measurement) and
 * the checking service (what produced the comparison) are independently
 * deployed and can genuinely be on different releases at the same moment.
 * Recording only one would hide exactly the divergence the second-engine-host
 * correction in the spec exists to make visible.
 */
export interface HostedCheckEnvelope extends CheckJsonDocument {
  /** ISO. When this specific check ran — never shown next to a verdict alone. */
  computedAt: string;
  trigger: HostedTrigger;
  /** The exact git commit the deployed build came from. */
  codeRef: string;
  /** The deployed build's own addon version — what produced the measurement. */
  measuringVersion: string;
  /** The checking service's own pinned addon version — what produced the comparison. */
  engineVersion: string;
}

/**
 * `finishedAtMs`, not a fresh `Date.now()`: the run already knows the instant
 * it concluded, and a second, independent clock read here is exactly the
 * "scattered across formats and levels" problem §7 exists to remove.
 */
export function computedAtFrom(finishedAtMs: number): string {
  return new Date(finishedAtMs).toISOString();
}

/**
 * The one construction site for a `HostedCheckEnvelope` — the same rule
 * `buildCheckDocument` applies to `CheckJsonDocument`, one layer out.
 */
export function buildHostedEnvelope(input: {
  document: CheckJsonDocument;
  finishedAtMs: number;
  trigger: HostedTrigger;
  codeRef: string;
  measuringVersion: string;
  engineVersion: string;
}): HostedCheckEnvelope {
  return {
    ...input.document,
    computedAt: computedAtFrom(input.finishedAtMs),
    trigger: input.trigger,
    codeRef: input.codeRef,
    measuringVersion: input.measuringVersion,
    engineVersion: input.engineVersion,
  };
}
