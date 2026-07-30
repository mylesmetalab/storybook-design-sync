/**
 * Retry policy for Figma REST calls, and the error a rate limit produces.
 *
 * Extracted from `figma-rest.ts` because the policy is where issue #74 lived and
 * a policy that can't be unit-tested is a policy nobody can check.
 *
 * The bug: `throttledFetch` retried a 429 up to `MAX_RETRIES` times, sleeping
 * whatever `Retry-After` asked for (capped at 30s each). Four attempts × up to
 * 30s is over 90 seconds of silence per request, and a single drift check makes
 * several requests in sequence. Live symptom: per-story **Check drift** sitting
 * in "Checking…" past 90s with nothing shown, twice, including after a page
 * reload. The retry loop was working exactly as written; nothing was wrong except
 * that a UI-driven check spent minutes not saying the one thing it knew.
 *
 * So the sleeping is bounded per request (`MAX_TOTAL_BACKOFF_MS`), and when the
 * next required wait would exceed what's left, the request **fails with the
 * cause** rather than waiting it out: "Figma rate-limited this request (HTTP 429)
 * — retry in 27s". A short backoff (Figma usually asks for a second or two, and
 * a 5xx sequence of 1s+2s+4s fits) still retries exactly as before.
 *
 * A refusal that names the wait is strictly more useful than a spinner: the user
 * learns what happened, learns when to try again, and the panel gets to leave
 * its loading state.
 */

export const MAX_RETRIES = 3;
export const RETRY_BASE_MS = 1000;
/**
 * Ceiling on any single **sleep**. Deliberately not applied to the parsed
 * `Retry-After` itself: a 45s wait clamped to 30s before it reaches the message
 * would have the tool telling the user to retry 15 seconds too early. We cap what
 * we are willing to wait, and report what Figma actually asked for.
 */
export const RETRY_MAX_MS = 30_000;
/**
 * Ceiling on the *total* time one request may spend asleep between attempts.
 * 8s is deliberately the same order as the bulk run's per-story budget: a
 * request that has already slept that long will not save the check, so the
 * honest move is to report the rate limit and let the caller decide.
 */
export const MAX_TOTAL_BACKOFF_MS = 8_000;

export type RetryDecision =
  | { action: "retry"; waitMs: number }
  | { action: "give-up"; reason: "attempts" | "backoff-budget" };

/**
 * Whether a response status is worth retrying at all. 429 is the rate limit;
 * 5xx is Figma having a moment. Everything else is an answer, not a hiccup.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Decide what to do after a retryable response.
 *
 * `spentBackoffMs` is how long this request has already slept. The decision is
 * pure — the caller does the sleeping — so the "would this push us over the
 * budget?" branch is directly testable, which is the branch #74 turned on.
 */
export function retryDecision(opts: {
  attempt: number;
  retryAfterMs: number | null;
  spentBackoffMs: number;
  maxRetries?: number;
  maxTotalBackoffMs?: number;
  /** 0..1, injectable so tests get a deterministic backoff. */
  jitter?: number;
}): RetryDecision {
  const maxRetries = opts.maxRetries ?? MAX_RETRIES;
  const maxTotal = opts.maxTotalBackoffMs ?? MAX_TOTAL_BACKOFF_MS;
  if (opts.attempt >= maxRetries) return { action: "give-up", reason: "attempts" };
  const waitMs =
    opts.retryAfterMs === null
      ? backoffMs(opts.attempt, opts.jitter)
      : Math.min(opts.retryAfterMs, RETRY_MAX_MS);
  if (opts.spentBackoffMs + waitMs > maxTotal) {
    // Sleeping here is what produced a 90-second silent hang. The wait is real
    // and we know how long it is — say so instead of serving it.
    return { action: "give-up", reason: "backoff-budget" };
  }
  return { action: "retry", waitMs };
}

/** Capped exponential backoff with jitter. */
export function backoffMs(attempt: number, jitter = Math.random()): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
  return Math.round(base + jitter * base * 0.25);
}

/**
 * `Retry-After` in ms, or null when absent/unparseable. Both spec forms:
 * delta-seconds (what Figma sends) and an HTTP-date.
 *
 * Returned **uncapped**. This value is reported to the user as "retry in N", so
 * clamping it here would understate the wait; `retryDecision` clamps what it is
 * willing to sleep instead.
 */
export function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return null;
    return seconds * 1000;
  }
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) {
    return Math.max(ts - Date.now(), 0);
  }
  return null;
}

/**
 * A Figma request that could not be completed because the API refused it for
 * load reasons. Carries the wait Figma asked for so every surface — the panel's
 * error, a child binding's "not compared" message, the bulk summary — can say
 * when to try again instead of inventing advice.
 */
export class FigmaRateLimitError extends Error {
  override readonly name = "FigmaRateLimitError";
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(opts: { status: number; retryAfterMs: number | null; what?: string }) {
    super(rateLimitMessage(opts));
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * The one wording for a rate limit. Names the status, names the wait when Figma
 * supplied one, and says what to do — never "request failed".
 */
export function rateLimitMessage(opts: {
  status: number;
  retryAfterMs: number | null;
  what?: string;
}): string {
  const subject = opts.what ? `Figma request for ${opts.what}` : "Figma request";
  if (opts.status === 429) {
    const wait =
      opts.retryAfterMs === null
        ? `Figma sent no Retry-After; wait a minute before re-running`
        : `retry in ${formatWait(opts.retryAfterMs)}`;
    return (
      `Rate limited by Figma (HTTP 429) — ${subject} was refused and ${wait}. ` +
      `Nothing was compared, so this is not a clean result. ` +
      `Two Check-all runs in quick succession are usually the cause.`
    );
  }
  return (
    `Figma returned HTTP ${opts.status} for this ${subject} and did not recover within ` +
    `${Math.round(MAX_TOTAL_BACKOFF_MS / 1000)}s of retries. Nothing was compared.`
  );
}

/** `12s`, `1.5s`, `2m 5s` — short enough for a table cell. */
export function formatWait(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 10) {
    const rounded = Math.round(totalSeconds * 10) / 10;
    return `${rounded}s`;
  }
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function isRateLimitError(err: unknown): err is FigmaRateLimitError {
  return err instanceof FigmaRateLimitError;
}

/**
 * One line describing why a Figma read produced nothing, for any thrown error.
 * Rate limits keep their full wording (they carry the retry advice); anything
 * else is relayed verbatim. Never returns an empty string — a blank reason is
 * how "not compared" starts looking like "compared and fine".
 */
export function describeFetchFailure(err: unknown): string {
  if (isRateLimitError(err)) return err.message;
  if (err instanceof Error && err.message) return err.message;
  const text = String(err);
  return text === "" || text === "undefined" ? "Figma request failed (no detail available)" : text;
}

/**
 * The largest `Retry-After` among a set of failures, when any carried one.
 * Used so a report with several rate-limited children reports one wait rather
 * than the first one it happened to see.
 */
export function longestRetryAfter(errors: readonly unknown[]): number | null {
  let out: number | null = null;
  for (const err of errors) {
    if (!isRateLimitError(err) || err.retryAfterMs === null) continue;
    if (out === null || err.retryAfterMs > out) out = err.retryAfterMs;
  }
  return out;
}
