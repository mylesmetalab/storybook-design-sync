/**
 * A value read at **use** time rather than at capture time.
 *
 * Exists because of a specific, silent failure (issue #78, third finding).
 * Storybook's manager hook is:
 *
 *     const useChannel = (eventMap, deps = []) => { useEffect(…, deps); … }
 *
 * `deps` defaults to `[]`, so a panel's channel handlers are registered **once on
 * mount and never again**. The `RegisteredStories` handler that starts a
 * **Check all** therefore kept the `runBulk` closure from the first render — the
 * one that captured `dualMode === false`. Ticking **Both modes** and pressing
 * Check all ran the whole registry in single mode while the checkbox said
 * otherwise, and the summary reported a completed run.
 *
 * That is the same bug class as the rest of this release: a control that reports
 * it was applied when it wasn't. It also explains the other half of #69's
 * original evidence — "both modes" and "single mode" produced byte-identical
 * totals partly because the switch didn't work, and partly because the bulk path
 * was never asked for two modes at all.
 *
 * So options that a long-lived handler consumes are read through this box, whose
 * `get()` always returns the latest value regardless of which render captured it.
 */
export interface LiveValue<T> {
  get(): T;
  set(next: T): void;
}

export function createLiveValue<T>(initial: T): LiveValue<T> {
  let current = initial;
  return {
    get: () => current,
    set: (next: T) => {
      current = next;
    },
  };
}
