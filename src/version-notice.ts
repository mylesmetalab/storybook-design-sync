/**
 * How the panel talks about which addon version it is running (issue #62).
 *
 * Separate from `addon-version.ts` because that module reads `package.json` from
 * disk and is Node-only; this one is pure and goes into the browser bundle with
 * the manager. Keeping the wording here also means the banner text is unit-tested
 * rather than living inside JSX.
 */

/** The header label: `v0.0.41`, or nothing when the version is unknown. */
export function versionLabel(version: string | undefined): string {
  return version === undefined ? "" : `v${version}`;
}

/**
 * True only when both versions are known and they disagree. Unknown is not stale:
 * a missing version is a gap in what we can report, not evidence of a mismatch,
 * and banner-ing on it would train users to ignore the banner.
 */
export function versionIsStale(
  loaded: string | undefined,
  installed: string | undefined,
): boolean {
  return loaded !== undefined && installed !== undefined && loaded !== installed;
}

/**
 * The banner for a Storybook that is running an older addon than the one on disk.
 *
 * The failure mode is invisible by nature — the panel produced v0.0.39 rows
 * against a v0.0.40 checkout for an hour, with `package.json` and `node_modules`
 * both saying 40 — so the wording has to carry the whole diagnosis: what is
 * running, what that means for the report on screen, and the one action that
 * fixes it.
 */
export function staleVersionMessage(loaded: string, installed: string): string {
  return (
    `Storybook is running design-sync v${loaded}, but v${installed} is installed. ` +
    `Every report in this session — including the one on screen — comes from v${loaded}, ` +
    `so it may show rows v${installed} no longer produces, or miss ones it does. ` +
    `Restart Storybook to load it; if the panel still says v${loaded} afterwards, ` +
    `clear the manager bundle cache (rm -rf node_modules/.cache/storybook).`
  );
}

/**
 * The counters line's cache note: how many entries an upgrade threw away, and
 * whether this report was withheld from the cache.
 *
 * Returns null when there is nothing to say — a run with a warm, valid cache and
 * a complete report should read exactly as it always has.
 */
export function cacheNoticeText(status: {
  discardedByVersion?: number;
  notPersisted?: string;
} | undefined): string | null {
  if (!status) return null;
  const parts: string[] = [];
  if (status.discardedByVersion !== undefined && status.discardedByVersion > 0) {
    parts.push(
      `discarded ${status.discardedByVersion} ` +
        `${status.discardedByVersion === 1 ? "entry" : "entries"} written by an older version`,
    );
  }
  if (status.notPersisted !== undefined) parts.push(status.notPersisted);
  return parts.length > 0 ? parts.join(" · ") : null;
}
