import {
  createCssPostcssEngine,
  createTsxInlineEngine,
  createTsxTextEngine,
  pickEngine,
  type CodeTarget,
} from "@metalab/design-sync-pipeline";
import type { Edit, EditResult } from "@metalab/design-sync-core";

/**
 * Apply a **code-scope** edit in-process, without the design-sync-pipeline
 * binary running. This is the server-side (preset) half of "Update code
 * works without the pipeline" (P1.4): the manager relays a code-scope Edit
 * over the Storybook channel, the preset applies it here directly using the
 * pipeline's write engines, and returns an EditResult.
 *
 * All three code engines run in-process (same roster the pipeline binary
 * would use for code-scope edits):
 *   - `code-css-postcss`  — token swaps in external stylesheets
 *   - `code-tsx-inline`   — token swaps in JSX `style={{ … }}` expressions
 *   - `code-tsx-text`     — copy rewrites of static JSX text (P2.1)
 * `pickEngine` disambiguates by kind/scope + each engine's canHandle
 * (extension-filtered codeTargets), exactly like the pipeline's router.
 *
 * Figma-scope edits are NOT handled here — they still POST to the pipeline
 * (which does the Variables REST write and queues node bindings for the
 * plugin). Passing a figma-scope edit returns a rejection.
 */
export async function applyCodeEdit(
  edit: Edit,
  cwd: string,
  codeTargets: CodeTarget[],
): Promise<EditResult> {
  if (edit.scope !== "code") {
    return {
      id: edit.id,
      status: "rejected",
      engine: "addon-apply-code",
      message: `applyCodeEdit only handles scope:"code" (got "${edit.scope}"). Figma-scope edits route through the pipeline.`,
    };
  }
  if (codeTargets.length === 0) {
    return {
      id: edit.id,
      status: "rejected",
      engine: "addon-apply-code",
      message:
        `No codeTargets configured. Add "codeTargets": [{ "path": "src/style.css" }] ` +
        `(plus any .tsx files for inline-style/copy edits) to design-sync.config.json ` +
        `so the addon knows which files it may write.`,
    };
  }

  const engines = [
    createTsxInlineEngine(cwd, codeTargets),
    createTsxTextEngine(cwd, codeTargets),
    createCssPostcssEngine(cwd, codeTargets),
  ];
  const engine = pickEngine(engines, edit);
  if (!engine) {
    return {
      id: edit.id,
      status: "rejected",
      engine: "addon-apply-code",
      message:
        `No in-process engine handles ${edit.kind}/${edit.scope} for the configured codeTargets ` +
        `(css → .css targets, inline-style/copy → .tsx/.jsx targets).`,
    };
  }
  return engine.apply(edit);
}
