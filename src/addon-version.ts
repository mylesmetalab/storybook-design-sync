import { readFile } from "node:fs/promises";

/**
 * The addon's own version, and whether the running process is a version behind
 * what is installed on disk.
 *
 * Issue #62: a running Storybook keeps serving the manager bundle it started
 * with. Upgrade the addon without restarting and the panel reports the **old**
 * version's rows against a new checkout — `package.json` says 40, `node_modules`
 * says 40, the panel behaves like 39, and nothing in the UI says a word. The only
 * tell was `"version": 3` in a cache file no designer opens. It cost a wrong
 * baseline and nearly a duplicate fix for three already-fixed bugs.
 *
 * Two reads, and the difference between them is the signal:
 *
 *  - `loadedVersion()` — read **once**, at module initialisation. The server
 *    module is imported when Storybook's dev server starts, so this is the
 *    version the running process is actually executing.
 *  - `installedVersion()` — read fresh on every request. This is what is on disk
 *    now.
 *
 * Equal is the normal state. Different means the package moved under a running
 * process: the code in memory is stale, and the fix is to restart Storybook.
 */

/** `<pkg>/dist/server.js` → `<pkg>/package.json`. */
const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);

async function readVersion(): Promise<string | undefined> {
  try {
    const raw = await readFile(PACKAGE_JSON_URL, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    // A packaging layout we don't recognise. Reporting no version is honest;
    // guessing one would defeat the purpose of the field.
    return undefined;
  }
}

/**
 * Started at import time on purpose: this promise's value is the version of the
 * code that was loaded, and deferring the read would make it the version on disk
 * whenever the panel happened to ask.
 */
const loadedVersionPromise = readVersion();

export function loadedVersion(): Promise<string | undefined> {
  return loadedVersionPromise;
}

export function installedVersion(): Promise<string | undefined> {
  return readVersion();
}

/** Both versions plus the derived question the panel asks. */
export interface VersionInfo {
  loaded?: string;
  installed?: string;
  /** True only when both are known and they disagree. */
  stale: boolean;
}

export async function versionInfo(): Promise<VersionInfo> {
  const [loaded, installed] = await Promise.all([loadedVersion(), installedVersion()]);
  return {
    ...(loaded !== undefined ? { loaded } : {}),
    ...(installed !== undefined ? { installed } : {}),
    // Unknown is not stale. A missing version is a gap in what we can report, not
    // evidence of a mismatch, and banner-ing on it would train users to ignore it.
    stale: loaded !== undefined && installed !== undefined && loaded !== installed,
  };
}

// The panel's wording for a stale process lives in `version-notice.ts`: that
// module is pure and ships in the browser bundle, while this one reads from disk.
