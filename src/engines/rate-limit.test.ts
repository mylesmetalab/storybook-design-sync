import { describe, expect, it } from "vitest";
import {
  FigmaRateLimitError,
  MAX_TOTAL_BACKOFF_MS,
  describeFetchFailure,
  formatWait,
  isRateLimitError,
  isRetryableStatus,
  longestRetryAfter,
  parseRetryAfter,
  retryDecision,
} from "./rate-limit.js";

/**
 * Issue #74: per-story Check drift sat in "Checking…" past 90 seconds with no
 * error, because the retry loop honoured a long `Retry-After` up to four times
 * and said nothing while it did.
 *
 * What these tests pin: the retry policy still retries a short backoff, and it
 * **refuses rather than waits** once the sleeping would exceed the per-request
 * budget — with the rate limit and the wait in the message.
 */

describe("retryDecision", () => {
  it("retries a short Retry-After", () => {
    expect(
      retryDecision({ attempt: 0, retryAfterMs: 1500, spentBackoffMs: 0 }),
    ).toEqual({ action: "retry", waitMs: 1500 });
  });

  it("gives up rather than sleeping past the per-request backoff budget", () => {
    // The #74 shape: Figma asks for 30s. Sleeping it (four times) is what
    // produced the >90s hang.
    expect(
      retryDecision({ attempt: 0, retryAfterMs: 30_000, spentBackoffMs: 0 }),
    ).toEqual({ action: "give-up", reason: "backoff-budget" });
  });

  it("counts what it has already slept, so several short waits still terminate", () => {
    const first = retryDecision({ attempt: 0, retryAfterMs: 5000, spentBackoffMs: 0 });
    expect(first).toEqual({ action: "retry", waitMs: 5000 });
    // 5000 + 5000 > 8000 budget.
    expect(
      retryDecision({ attempt: 1, retryAfterMs: 5000, spentBackoffMs: 5000 }),
    ).toEqual({ action: "give-up", reason: "backoff-budget" });
  });

  it("still allows the classic 1s/2s/4s 5xx backoff within the budget", () => {
    let spent = 0;
    const waits: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const decision = retryDecision({
        attempt,
        retryAfterMs: null,
        spentBackoffMs: spent,
        jitter: 0,
      });
      expect(decision.action).toBe("retry");
      if (decision.action !== "retry") return;
      waits.push(decision.waitMs);
      spent += decision.waitMs;
    }
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(spent).toBeLessThanOrEqual(MAX_TOTAL_BACKOFF_MS);
  });

  it("gives up once the attempts are spent", () => {
    expect(
      retryDecision({ attempt: 3, retryAfterMs: 10, spentBackoffMs: 0 }),
    ).toEqual({ action: "give-up", reason: "attempts" });
  });

  it("retries only rate limits and 5xx", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("12")).toBe(12_000);
  });

  it("reads an HTTP-date", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const parsed = parseRetryAfter(future);
    expect(parsed).not.toBeNull();
    expect(parsed!).toBeGreaterThan(2000);
    expect(parsed!).toBeLessThanOrEqual(6000);
  });

  it("reports the wait Figma asked for, uncapped", () => {
    // Clamping here would tell the user to retry 15s too early.
    expect(parseRetryAfter("45")).toBe(45_000);
  });

  it("caps what it is willing to sleep, not what it reports", () => {
    expect(
      retryDecision({ attempt: 0, retryAfterMs: 45_000, spentBackoffMs: 0, maxTotalBackoffMs: 60_000 }),
    ).toEqual({ action: "retry", waitMs: 30_000 });
  });

  it("returns null for absent or unparseable headers", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("-5")).toBeNull();
  });
});

describe("the rate-limit error says what happened and when to retry", () => {
  it("names the status and the wait", () => {
    const err = new FigmaRateLimitError({
      status: 429,
      retryAfterMs: 27_000,
      what: "node 2142:11381",
    });
    expect(err.message).toContain("429");
    expect(err.message).toContain("retry in 27s");
    expect(err.message).toContain("node 2142:11381");
    // The verdict, not just the mechanics: this is not a clean result.
    expect(err.message).toContain("Nothing was compared");
    expect(isRateLimitError(err)).toBe(true);
  });

  it("says so plainly when Figma supplied no Retry-After", () => {
    const err = new FigmaRateLimitError({ status: 429, retryAfterMs: null });
    expect(err.message).toContain("no Retry-After");
    expect(err.retryAfterMs).toBeNull();
  });

  it("words a 5xx as a failure to recover, not as a rate limit", () => {
    const err = new FigmaRateLimitError({ status: 503, retryAfterMs: null });
    expect(err.message).toContain("503");
    expect(err.message).not.toContain("Rate limited");
  });

  it("is distinguishable from an ordinary error", () => {
    expect(isRateLimitError(new Error("boom"))).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

describe("describeFetchFailure", () => {
  it("keeps the rate-limit advice intact", () => {
    const err = new FigmaRateLimitError({ status: 429, retryAfterMs: 3000 });
    expect(describeFetchFailure(err)).toBe(err.message);
  });

  it("relays an ordinary error message", () => {
    expect(describeFetchFailure(new Error("ECONNRESET"))).toBe("ECONNRESET");
  });

  it("never returns an empty reason", () => {
    expect(describeFetchFailure(new Error(""))).not.toBe("");
    expect(describeFetchFailure(undefined)).not.toBe("");
  });
});

describe("longestRetryAfter", () => {
  it("reports the longest wait across several failures", () => {
    expect(
      longestRetryAfter([
        new FigmaRateLimitError({ status: 429, retryAfterMs: 2000 }),
        new FigmaRateLimitError({ status: 429, retryAfterMs: 9000 }),
        new Error("unrelated"),
      ]),
    ).toBe(9000);
  });

  it("is null when nothing carried one", () => {
    expect(longestRetryAfter([new Error("x")])).toBeNull();
    expect(longestRetryAfter([])).toBeNull();
  });
});

describe("formatWait", () => {
  it("renders short and long waits readably", () => {
    expect(formatWait(500)).toBe("500ms");
    expect(formatWait(1500)).toBe("1.5s");
    expect(formatWait(12_000)).toBe("12s");
    expect(formatWait(125_000)).toBe("2m 5s");
    expect(formatWait(120_000)).toBe("2m");
  });
});
