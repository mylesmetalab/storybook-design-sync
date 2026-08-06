import { describe, expect, it } from "vitest";
import type { BulkStoryOutcome } from "./bulk-run.js";
import type { DriftReport } from "./dimensions/types.js";
import { buildCheckDocument } from "./check-report.js";
import { buildHostedEnvelope, computedAtFrom, type HostedCheckEnvelope } from "./hosted-envelope.js";

/**
 * Phase 1 of the 2026-08-07 hosted-check plan (HOSTED-CHECK-TASKS.md T1/T2):
 * the envelope every hosted trigger (on-demand, on-merge, nightly, the Figma
 * webhook) writes to, so the fields other phases depend on exist before any
 * of them are built.
 */

function outcome(over: Partial<BulkStoryOutcome<DriftReport>> = {}): BulkStoryOutcome<DriftReport> {
  return { storyId: "ui-button--primary", durationMs: 100, ...over };
}

function baseDocument() {
  return buildCheckDocument({
    version: "0.0.62",
    storybookUrl: "https://acme-storybook.example/iframe.html",
    fileKey: "FIGMA_KEY",
    dualMode: false,
    outcomes: [
      outcome({
        report: {
          storyId: "ui-button--primary",
          nodeId: "1:2",
          generatedAt: "2026-08-07T00:00:00.000Z",
          dimensions: [],
        },
      }),
    ],
    nodeIds: {},
    warm: { ms: 120 },
    startedAt: 0,
    finishedAt: 4200,
    includeReports: false,
    generatedAt: "2026-08-07T00:00:05.000Z",
  });
}

describe("computedAtFrom", () => {
  it("derives an ISO timestamp from the run's own finishedAt, not a fresh clock read", () => {
    expect(computedAtFrom(0)).toBe(new Date(0).toISOString());
    expect(computedAtFrom(1_722_902_400_000)).toBe(new Date(1_722_902_400_000).toISOString());
  });
});

describe("HostedCheckEnvelope", () => {
  it("carries every CheckJsonDocument field untouched, plus the hosted-only fields", () => {
    const document = baseDocument();
    const envelope: HostedCheckEnvelope = buildHostedEnvelope({
      document,
      finishedAtMs: 4200,
      trigger: "on-merge",
      codeRef: "76cd439",
      measuringVersion: "0.0.62",
      engineVersion: "0.0.63",
    });

    expect(envelope.tool).toBe(document.tool);
    expect(envelope.exitCode).toBe(document.exitCode);
    expect(envelope.stories).toEqual(document.stories);

    expect(envelope.computedAt).toBe(computedAtFrom(4200));
    expect(envelope.trigger).toBe("on-merge");
    expect(envelope.codeRef).toBe("76cd439");
    expect(envelope.measuringVersion).toBe("0.0.62");
    expect(envelope.engineVersion).toBe("0.0.63");
  });

  it("keeps measuringVersion and engineVersion structurally separate — a skew is representable, not an error", () => {
    // The deployed build and the checking service are two independently
    // deployed things in hosted mode; one field would hide exactly the
    // divergence the second-engine-host correction exists to make visible.
    const envelope = buildHostedEnvelope({
      document: baseDocument(),
      finishedAtMs: 0,
      trigger: "nightly",
      codeRef: "abc1234",
      measuringVersion: "0.0.60",
      engineVersion: "0.0.63",
    });
    expect(envelope.measuringVersion).not.toBe(envelope.engineVersion);
  });

  it.each(["on-demand", "on-merge", "nightly", "figma-webhook"] as const)(
    "accepts %s as a trigger",
    (trigger) => {
      const envelope = buildHostedEnvelope({
        document: baseDocument(),
        finishedAtMs: 0,
        trigger,
        codeRef: "abc1234",
        measuringVersion: "0.0.62",
        engineVersion: "0.0.62",
      });
      expect(envelope.trigger).toBe(trigger);
    },
  );
});
