import { createCssPostcssEngine, type CodeTarget } from "@metalab/design-sync-pipeline";
import type { Edit, EditResult } from "@metalab/design-sync-core";

/**
 * Apply a **code-scope** edit in-process, without the design-sync-pipeline
 * binary running. This is the server-side (preset) half of "Update code
 * works without the pipeline" (P1.4): the manager relays a code-scope Edit
 * over the Storybook channel, the preset applies it here directly using the
 * pipeline's CSS write engine, and returns an EditResult.
 *
 * Only the CSS (external-stylesheet) engine runs here — that's the path the
 * mde consumer uses. Inline-style (`code-tsx-inline`) and copy
 * (`code-tsx-text`) engines still route through the pipeline binary until
 * they're exported from the pipeline package for in-process use.
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
        `to design-sync.config.json so the addon knows which file to write.`,
    };
  }

  const engine = createCssPostcssEngine(cwd, codeTargets);
  if (!engine.canHandle(edit)) {
    return {
      id: edit.id,
      status: "rejected",
      engine: "addon-apply-code",
      message: `No in-process engine handles ${edit.kind}/${edit.scope} for the configured codeTargets.`,
    };
  }
  return engine.apply(edit);
}
