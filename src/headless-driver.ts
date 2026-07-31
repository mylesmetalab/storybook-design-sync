import { bridgeAttachedSource, bridgeInstallSource, type HeadlessDriver } from "./headless-check.js";

/**
 * The only file in this package that knows a browser exists.
 *
 * ## Why a browser at all, and why this one
 *
 * A drift check compares `getComputedStyle` against Figma. There is no way to
 * produce a computed style without a rendering engine — the cascade, inheritance,
 * `var()` resolution, `oklch()` conversion and layout are the engine's job, and
 * an approximation of them would answer a different question. So `check` needs a
 * real browser rendering a real story, and it drives the one the consumer's
 * Storybook already runs stories in.
 *
 * Playwright, and specifically as an **optional peer dependency**:
 *
 *  - Storybook 10's own test tooling (`storybook test`, Vitest browser mode)
 *    already installs Playwright, so a consumer running component tests has it.
 *    Checking before adding a dependency was the instruction; the answer is that
 *    Storybook's path *is* Playwright, so using it directly adds no new class of
 *    dependency.
 *  - Optional because `audit`, `register`, `ls` and `export-graph` need no
 *    browser, and the panel needs no CLI. A ~300MB browser download must not be
 *    the price of `design-sync audit` in CI.
 *  - Imported dynamically, so `dist/cli.js` loads with Playwright absent and only
 *    `check` reports the missing dependency — with the two commands that install
 *    it.
 *
 * Vitest browser mode was considered and rejected as the host: it is a test
 * runner, so it would put the check inside a test file, and a CI gate that must
 * be *invokable by an agent* and produce a machine-readable artefact should not
 * require a test harness to exist in the consumer's repo.
 */

/** Minimal slices of Playwright's API, so nothing here needs its types. */
interface PageLike {
  addInitScript(script: { content: string }): Promise<void>;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  evaluate<T>(expression: string): Promise<T>;
  waitForFunction(expression: string, arg?: unknown, options?: { timeout?: number }): Promise<unknown>;
  close(): Promise<void>;
  on(event: string, handler: (...args: unknown[]) => void): void;
}
interface BrowserLike {
  newPage(options?: { viewport?: { width: number; height: number } }): Promise<PageLike>;
  close(): Promise<void>;
}
interface PlaywrightLike {
  chromium: {
    launch(options?: { headless?: boolean; args?: string[] }): Promise<BrowserLike>;
  };
}

export const PLAYWRIGHT_MISSING_MESSAGE =
  "`design-sync check` needs a browser to render stories, and Playwright is not installed.\n" +
  "  npm i -D playwright && npx playwright install chromium\n" +
  "It is an optional peer dependency: audit, register, ls and export-graph need no browser, so\n" +
  "installing one is not the price of using them. If your project already runs `storybook test`,\n" +
  "Playwright is present and this is a resolution problem rather than a missing package.";

export class BrowserUnavailableError extends Error {}

/**
 * Import Playwright at runtime, from the *consumer's* installation.
 *
 * The specifier is held in a variable on purpose, and it is doing three jobs:
 *
 *  1. it keeps `playwright` out of this package's dependency graph, so it stays a
 *     genuinely optional peer rather than something every consumer downloads;
 *  2. esbuild cannot resolve a computed specifier, so it leaves the import alone
 *     instead of trying to bundle a browser driver into `dist/cli.js`;
 *  3. `tsc` types it as `any` without demanding the module be installed here,
 *     which is why this repo needs no devDependency on it either. The API surface
 *     is pinned by the `PlaywrightLike` interfaces above instead — a narrower
 *     contract than Playwright's own types, and the only part we rely on.
 *
 * Two resolution attempts: the package's own graph first, then the consumer's cwd.
 * The CLI usually runs from `node_modules/@metalab/storybook-design-sync/dist/`,
 * where the ordinary upward walk finds a hoisted install — but a strict pnpm store
 * hoists nothing, and the project root is where `npm i -D playwright` actually put
 * it.
 */
function isPlaywright(mod: unknown): mod is PlaywrightLike {
  const chromium = (mod as { chromium?: { launch?: unknown } } | null | undefined)?.chromium;
  return typeof chromium?.launch === "function";
}

async function loadPlaywright(): Promise<PlaywrightLike> {
  const specifier = ["play", "wright"].join("");
  const attempts: string[] = [];
  try {
    const mod = (await import(specifier)) as unknown;
    if (isPlaywright(mod)) return mod;
    attempts.push("resolved from the addon's own module graph but exposes no `chromium.launch`");
  } catch (err: unknown) {
    attempts.push(`from the addon's module graph: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const requireFromCwd = createRequire(pathToFileURL(join(process.cwd(), "package.json")));
    const resolved = requireFromCwd.resolve(specifier);
    const mod = (await import(pathToFileURL(resolved).href)) as unknown;
    if (isPlaywright(mod)) return mod;
    attempts.push(`resolved from ${process.cwd()} but exposes no \`chromium.launch\``);
  } catch (err: unknown) {
    attempts.push(`from ${process.cwd()}: ${err instanceof Error ? err.message : String(err)}`);
  }
  throw new BrowserUnavailableError(
    `${PLAYWRIGHT_MISSING_MESSAGE}\n\nResolution attempts:\n  - ${attempts.join("\n  - ")}`,
  );
}

export interface PlaywrightDriverHandle extends HeadlessDriver {
  close(): Promise<void>;
  /** Console errors the page logged. Surfaced when a story fails to render. */
  pageErrors(): string[];
}

/**
 * Launch a headless Chromium with the bridge installed as an init script.
 *
 * `addInitScript` — not a post-load `evaluate` — is load-bearing: the bridge
 * traps `globalThis.__STORYBOOK_ADDONS_CHANNEL__` on assignment, and the first
 * story's `storyPrepared` fires while the preview boots. Installing after load
 * would miss it and every story would then need a redundant re-render to produce
 * one.
 */
export async function launchPlaywrightDriver(opts: {
  /** Visible browser, for debugging a check that behaves differently headless. */
  headed?: boolean;
  viewport?: { width: number; height: number };
  navigationTimeoutMs?: number;
} = {}): Promise<PlaywrightDriverHandle> {
  const playwright = await loadPlaywright();
  const browser = await playwright.chromium.launch({
    headless: opts.headed !== true,
    // `--disable-backgrounding-occluded-windows` and friends are deliberately
    // NOT set. The addon's preview code must work in a document the browser
    // considers hidden — that is the environment a CI runner and the Claude
    // browser pane both provide, and papering over it here would hide the exact
    // class of bug (`await requestAnimationFrame` in a hidden document) that has
    // already cost this project a release.
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: opts.viewport ?? { width: 1280, height: 900 },
  });

  const errors: string[] = [];
  page.on("console", (...args: unknown[]) => {
    const message = args[0] as { type?: () => string; text?: () => string } | undefined;
    try {
      if (message?.type?.() === "error") errors.push(message.text?.() ?? "");
    } catch {
      // A console message we cannot read is not worth failing a check over.
    }
  });
  page.on("pageerror", (...args: unknown[]) => {
    const err = args[0] as { message?: string } | undefined;
    errors.push(err?.message ?? String(args[0]));
  });

  const install = bridgeInstallSource();
  await page.addInitScript({ content: install });

  const navigationTimeoutMs = opts.navigationTimeoutMs ?? 60_000;

  return {
    async navigate(url: string): Promise<void> {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
      } catch (err: unknown) {
        throw new BrowserUnavailableError(
          `Could not load ${url} — is Storybook running there? ` +
            `Start it with \`storybook dev\` (a static \`storybook build\` has no addon server, ` +
            `so it cannot answer a drift check). Underlying error: ${
              err instanceof Error ? err.message : String(err)
            }`,
        );
      }
      // The bridge object exists from the init script; `attached` becomes true
      // when Storybook installs its channel. Waiting on `attached` rather than on
      // a load event is what guarantees we are listening before any story event.
      try {
        await page.waitForFunction(`() => ${bridgeAttachedSource()}`, undefined, {
          timeout: navigationTimeoutMs,
        });
      } catch {
        throw new BrowserUnavailableError(
          `${url} loaded but never installed a Storybook channel. ` +
            `Either it is not a Storybook preview, or the preview failed to boot.` +
            (errors.length > 0 ? `\nPage errors:\n  ${errors.slice(0, 5).join("\n  ")}` : ""),
        );
      }
    },
    evaluate<T>(expression: string): Promise<T> {
      return page.evaluate<T>(expression);
    },
    pageErrors(): string[] {
      return [...errors];
    },
    async close(): Promise<void> {
      try {
        await page.close();
      } finally {
        await browser.close();
      }
    },
  };
}
