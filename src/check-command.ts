import { writeFile } from "node:fs/promises";
import { loadedVersion } from "./addon-version.js";
import { ConfigNotFoundError, loadConfig } from "./config.js";
import {
  HeadlessSetupError,
  runHeadlessCheck,
  type HeadlessRunResult,
} from "./headless-check.js";
import { BrowserUnavailableError, launchPlaywrightDriver } from "./headless-driver.js";
import {
  buildCheckDocument,
  CHECK_EXIT,
  formatCheckSummary,
  type CheckExitCode,
  type CheckJsonDocument,
} from "./check-report.js";
import { bulkBudgetMs } from "./check-budget.js";

/**
 * `design-sync check` — the panel's drift check, without the panel.
 *
 * ## What its green means
 *
 * Exactly what the panel's green means, because it is the same check: the same
 * preview code measures the same rendered story with `getComputedStyle`, the same
 * Node engine reads the same Figma file, the same triage groups and counts the
 * rows. This command supplies a browser tab and a loop — the manager's two jobs —
 * and nothing else.
 *
 * The one thing it cannot be is *independent of a running Storybook*. That is not
 * a shortcut; it is the honest consequence of where the work lives. The engine is
 * a Node module inside Storybook's dev server, and the measurement is the DOM
 * Storybook renders. A `check` that stood alone would need its own copy of both,
 * and that copy — a second source of truth for what "matches Figma" means — is
 * the thing this command was specified never to become.
 *
 * ## What is therefore NOT claimed
 *
 * - It does not work against `storybook build` output. A static build has no
 *   server channel (`createBrowserChannel` only adds the websocket transport when
 *   `CONFIG_TYPE === "DEVELOPMENT"`), so there is no engine to answer.
 * - It reads `FIGMA_PAT` from the **Storybook process's** environment, not the
 *   CLI's, for the same reason.
 * - It never writes. `apply` is irrelevant to it, in every mode.
 */

export interface CheckOptions {
  url: string;
  stories: string[];
  components: string[];
  dualMode: boolean;
  json: boolean;
  out?: string;
  includeReports: boolean;
  headed: boolean;
  quiet: boolean;
  budgetMs?: number;
}

/**
 * What `parseCheckArgs` alone can know: everything `CheckOptions` has, except
 * `url`, which is deliberately unresolved here (2.2, NEXT-WORK.md /
 * addon#109). Precedence is flag → `storybookUrl` in
 * design-sync.config.json → the conventional dev default, and parsing has no
 * access to the config file — only `resolveStorybookUrl` does. If parsing
 * filled in the default itself (as it used to), the flag-vs-not-passed
 * distinction the config layer needs would already be gone.
 */
export type CheckArgs = Omit<CheckOptions, "url"> & { url?: string };

/** Injectable so the command is testable without a browser or a filesystem. */
export interface CheckDeps {
  run: (opts: CheckOptions) => Promise<HeadlessRunResult>;
  version: () => Promise<string | undefined>;
  write: (path: string, contents: string) => Promise<void>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  now?: () => number;
}

async function defaultRun(opts: CheckOptions): Promise<HeadlessRunResult> {
  const driver = await launchPlaywrightDriver({ headed: opts.headed });
  try {
    return await runHeadlessCheck({
      driver,
      baseUrl: opts.url,
      selection: { stories: opts.stories, components: opts.components },
      dualMode: opts.dualMode,
      ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
      onServer: (server) => {
        if (server.error) {
          process.stderr.write(
            `[design-sync] the addon server reported a config problem: ${server.error}\n`,
          );
        }
      },
      onStoryStart: (index, storyId, total) => {
        if (!opts.quiet) {
          process.stderr.write(`[${index + 1}/${total}] ${storyId} … `);
        }
      },
      onStoryDone: (_index, outcome) => {
        if (!opts.quiet) {
          const verdict = outcome.report
            ? outcome.report.incomplete
              ? "incomplete"
              : "ok"
            : outcome.timedOut
              ? "timed out"
              : "error";
          process.stderr.write(`${verdict} (${outcome.durationMs}ms)\n`);
        }
      },
    });
  } finally {
    await driver.close();
  }
}

export const defaultCheckDeps: CheckDeps = {
  run: defaultRun,
  version: loadedVersion,
  write: (path, contents) => writeFile(path, contents, "utf8"),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/**
 * `check`'s own parser. Deliberately does **not** go through
 * `parseCommonAllowing`: that accepts `--stories <glob>`, and `check` has no use
 * for globs — it asks the running addon server for the registry, so the story
 * list comes from the same reader the panel uses. Accepting a flag that could not
 * affect the outcome would be worse than not having it.
 */
export function parseCheckArgs(rest: string[]): CheckArgs {
  const options: CheckArgs = {
    stories: [],
    components: [],
    dualMode: false,
    json: false,
    includeReports: false,
    headed: false,
    quiet: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const value = (): string => {
      const next = rest[++i];
      if (!next) throw new Error(`${arg} requires a value`);
      return next;
    };
    switch (arg) {
      case "--url":
        options.url = value();
        break;
      case "--story":
        options.stories.push(value());
        break;
      case "--component":
        options.components.push(value());
        break;
      case "--both-modes":
        options.dualMode = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--out":
        options.out = value();
        break;
      case "--full-report":
        options.includeReports = true;
        break;
      case "--timeout": {
        const ms = Number(value());
        if (!Number.isFinite(ms) || ms <= 0) throw new Error("--timeout must be a positive number of milliseconds");
        options.budgetMs = ms;
        break;
      }
      case "--headed":
        options.headed = true;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      default:
        throw new Error(
          `Unknown argument: ${arg}. \`check\` accepts --url, --story, --component, --both-modes, ` +
            `--json, --out, --full-report, --timeout, --headed, --quiet.`,
        );
    }
  }
  return options;
}

/** `check`'s own fallback when neither `--url` nor config names a Storybook. */
export const DEFAULT_STORYBOOK_URL = "http://localhost:6006";

/**
 * Resolve the Storybook `check` talks to (2.2, NEXT-WORK.md / addon#109):
 * an explicit `--url` wins outright; otherwise `storybookUrl` in
 * design-sync.config.json; otherwise the conventional dev default.
 *
 * `check` has never required a config file to exist, so a MISSING one stays
 * silent — this is purely additive. A config file that exists but fails to
 * parse or validate is different: the user clearly tried to configure
 * something, so `warn` fires (non-fatal — the run still proceeds against the
 * default) rather than the misconfiguration disappearing into "why is this
 * hitting the wrong port".
 */
export async function resolveStorybookUrl(
  explicit: string | undefined,
  opts: { cwd?: string; warn?: (message: string) => void } = {},
): Promise<string> {
  if (explicit) return explicit;
  const warn = opts.warn ?? (() => {});
  try {
    const config = await loadConfig(opts.cwd);
    if (config.storybookUrl) return config.storybookUrl;
  } catch (err: unknown) {
    if (!(err instanceof ConfigNotFoundError)) {
      warn(
        `[design-sync] Could not read \`storybookUrl\` from design-sync.config.json (${
          err instanceof Error ? err.message : String(err)
        }); using ${DEFAULT_STORYBOOK_URL}.\n`,
      );
    }
  }
  return DEFAULT_STORYBOOK_URL;
}

export async function runCheck(
  opts: CheckOptions,
  deps: CheckDeps = defaultCheckDeps,
): Promise<CheckExitCode> {
  if (!opts.quiet) {
    deps.stderr(
      `[design-sync] checking ${opts.url} — ${opts.dualMode ? "both modes" : "single mode"}, ` +
        `${opts.budgetMs ?? bulkBudgetMs(opts.dualMode)}ms per story\n`,
    );
  }

  let result: HeadlessRunResult;
  try {
    result = await deps.run(opts);
  } catch (err: unknown) {
    // Both of these mean nothing was compared, so neither may be reported as a
    // statement about drift. `CouldNotRun` is a separate code precisely so a CI
    // job cannot read "Storybook was not running" as "the design matches".
    if (err instanceof HeadlessSetupError || err instanceof BrowserUnavailableError) {
      deps.stderr(`${err.message}\n`);
      return CHECK_EXIT.CouldNotRun;
    }
    deps.stderr(
      `The headless check could not run: ${err instanceof Error ? err.message : String(err)}\n` +
        `Nothing was compared, so this is not a verdict on drift.\n`,
    );
    return CHECK_EXIT.CouldNotRun;
  }

  const cliVersion = (await deps.version()) ?? "unknown";
  const doc = buildCheckDocument({
    version: result.server.addonVersion ?? cliVersion,
    storybookUrl: opts.url,
    fileKey: result.fileKey,
    dualMode: opts.dualMode,
    outcomes: result.outcomes,
    nodeIds: result.nodeIds,
    warm: result.warm,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    includeReports: opts.includeReports,
  });

  const serialized = `${JSON.stringify(doc, null, 2)}\n`;
  if (opts.out) await deps.write(opts.out, serialized);
  if (opts.json) deps.stdout(serialized);

  if (!opts.quiet) {
    deps.stderr(`${versionNotice(result, cliVersion)}${formatCheckSummary(doc)}\n`);
    if (opts.out) deps.stderr(`\nJSON written to ${opts.out}\n`);
  }
  return doc.exitCode;
}

/**
 * Say plainly when the CLI and the Storybook process are different releases.
 *
 * Not an error and not a gate: a dev server a patch behind still produces a real
 * report. But it produces *that version's* report, and a reader comparing this
 * output against this version's documentation would otherwise have no way to
 * know. Same failure as #62, one process further out.
 */
export function versionNotice(result: HeadlessRunResult, cliVersion: string): string {
  const running = result.server.addonVersion;
  if (!running || running === cliVersion) return "";
  return (
    `\n[design-sync] VERSION SKEW — this CLI is ${cliVersion}, the Storybook process is running ` +
    `${running}${
      result.server.installedVersion && result.server.installedVersion !== running
        ? ` (with ${result.server.installedVersion} on disk — it was upgraded while running)`
        : ""
    }. The report below is ${running}'s answer, not ${cliVersion}'s. Restart Storybook to align them.\n`
  );
}

export type { CheckJsonDocument };
