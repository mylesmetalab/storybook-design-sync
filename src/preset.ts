import { registerServerChannel } from "./server.js";
import { loadConfig } from "./config.js";
import { scanCss, type AutoTokenMap } from "./scan-css.js";
import { scanTsx } from "./scan-tsx.js";
import { setAutoScan, setAutoTokenMap } from "./auto-tokens.js";
import { countTailwindScopes } from "./tailwind-components.js";

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

/**
 * Merge two scan maps. When the same selector exists in both, per-property
 * keys overlay — TSX entries win, on the rationale that inline-style
 * declarations are closer to the rendered element than a CSS rule and
 * tend to be the explicit binding when both exist. v0: simple last-wins
 * merge; collision logging can come later if it matters.
 */
function mergeMaps(a: AutoTokenMap, b: AutoTokenMap): AutoTokenMap {
  const out: AutoTokenMap = { ...a };
  for (const [sel, props] of Object.entries(b)) {
    out[sel] = { ...(out[sel] ?? {}), ...props };
  }
  return out;
}

async function runInitialScan(): Promise<void> {
  try {
    const config = await loadConfig();
    const cwd = process.cwd();
    // CSS first: it yields the Tailwind `@theme` variables the TSX scan needs
    // to turn a utility class into a token. (`bg-primary` is only a binding if
    // the consumer's theme declares `--color-primary`.)
    const cssResult = await scanCss(cwd, config.cssEntries);
    const tsxResult = await scanTsx(cwd, config.tsxEntries, cssResult.themeVars);
    const merged = mergeMaps(cssResult.map, tsxResult.map);
    setAutoScan({
      map: merged,
      themeVars: cssResult.themeVars,
      components: tsxResult.components,
      classHints: tsxResult.classHints,
      customProperties: cssResult.customProperties,
    });
    const themeCount = Object.keys(cssResult.themeVars).length;
    const cvaScopes = countTailwindScopes(tsxResult.components, cssResult.themeVars);
    const componentNames = tsxResult.components
      .map((c) => c.components[0] ?? "?")
      .join(", ");
    // A cva variant slot is an independently-resolvable binding scope but it is
    // NOT a CSS selector, so it is named as its own number in the breakdown
    // rather than folded silently into "selector(s)".
    // eslint-disable-next-line no-console
    console.log(
      `[design-sync] Scanned ${cssResult.scannedFiles.length} CSS + ` +
        `${tsxResult.scannedFiles.length} TSX file(s); ` +
        `derived bindings for ${Object.keys(merged).length + cvaScopes} selector(s) ` +
        `(css: ${Object.keys(cssResult.map).length}, ` +
        `tsx: ${Object.keys(tsxResult.map).length}, ` +
        `tailwind-cva: ${cvaScopes} scope(s) across ` +
        `${tsxResult.components.length} component(s)` +
        (componentNames ? ` [${componentNames}]` : "") +
        `); Tailwind @theme vars: ${themeCount}, ` +
        `custom properties declared: ${Object.keys(cssResult.customProperties).length}.`,
    );
    for (const w of [...cssResult.warnings, ...tsxResult.warnings]) {
      // eslint-disable-next-line no-console
      console.warn(`[design-sync] scan warning (${w.file}): ${w.message}`);
    }
    // Files a `cssEntries` glob asked for and did NOT get (issue #46). Logged
    // separately from `warnings`, and worded as a coverage hole rather than a
    // file-level hiccup: a scanner that derived nothing is indistinguishable
    // from a codebase that declares nothing, and a consumer who hits this
    // silently gets a panel reporting clean for the rest of the session.
    for (const skipped of cssResult.skipped) {
      // eslint-disable-next-line no-console
      console.warn(`[design-sync] NOT SCANNED — ${skipped.message}`);
    }
  } catch (err) {
    // Non-fatal: the addon still works with empty auto-map (falls back to
    // story-param tokens). Surface the reason so the user knows the
    // scanner didn't run.
    const m = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[design-sync] Scan skipped: ${m}`);
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
