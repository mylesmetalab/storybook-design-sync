import { registerServerChannel } from "./server.js";
import { loadConfig } from "./config.js";
import { scanCss } from "./scan-css.js";
import { setAutoTokenMap } from "./auto-tokens.js";

/**
 * Storybook 10 preset. Manager + preview entries are auto-discovered from
 * the package's `./manager` and `./preview` exports — registering them
 * here too causes the addon to be loaded twice (warning in the manager,
 * duplicate declarations in the preview, infinite spinner).
 *
 * This preset:
 *  - wires the Node-side server channel
 *  - scans consumer CSS once at startup and caches a selector → token map
 *    so drift checks compare against derived bindings instead of the
 *    hand-maintained `parameters.designSync.tokens` story param.
 */

interface ChannelLike {
  on(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

let scanPromise: Promise<void> | null = null;

async function runInitialScan(): Promise<void> {
  try {
    const config = await loadConfig();
    const result = await scanCss(process.cwd(), config.cssEntries);
    setAutoTokenMap(result.map);
    const selectorCount = Object.keys(result.map).length;
    // eslint-disable-next-line no-console
    console.log(
      `[design-sync] Scanned ${result.scannedFiles.length} CSS file(s); ` +
        `derived bindings for ${selectorCount} selector(s).`,
    );
    for (const w of result.warnings) {
      // eslint-disable-next-line no-console
      console.warn(`[design-sync] scan warning (${w.file}): ${w.message}`);
    }
  } catch (err) {
    // Non-fatal: the addon still works with empty auto-map (falls back to
    // story-param tokens). Surface the reason so the user knows the
    // scanner didn't run.
    const m = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[design-sync] CSS scan skipped: ${m}`);
    setAutoTokenMap({});
  }
}

export const experimental_serverChannel = async (
  channel: ChannelLike,
): Promise<ChannelLike> => {
  if (!scanPromise) scanPromise = runInitialScan();
  await scanPromise;
  return registerServerChannel(channel);
};
