import type { DriftReport } from "../dimensions/types.js";
import type { ChildBindingStatus } from "../child-bindings.js";

export interface NodeRef {
  fileKey: string;
  nodeId: string;
}

export interface CodeSnapshot {
  /**
   * Computed style values pulled from the rendered story root, keyed by
   * CSS property (e.g. "padding-top", "background-color", "--space-8").
   */
  styles: Record<string, string>;
  /**
   * Variable references the code intends to use, if discoverable from the
   * DOM (e.g. a `data-token` attribute or a CSS custom property indirection).
   * Keyed the same way as `styles`. Values are token names like "space.8".
   */
  bindings?: Record<string, string>;
  /**
   * BEM modifier classes or other variant signals on the story root element.
   * Used by the variant-set diff.
   */
  variantClasses?: string[];
  /**
   * Every class on the story root element, in DOM order (so the first entry is
   * the base class). `variantClasses` is the *expanded candidate set* derived
   * from these, which destroys the information needed to tell "this component
   * expresses variants as modifier classes" from "this component is styled
   * with utility classes and selects variants by prop" — so the raw list is
   * sent alongside it and `variantSetRowApplicable` decides on that basis.
   */
  rootClasses?: string[];
  /**
   * Visible text content within the targeted element (recursive innerText),
   * trimmed and split into non-empty strings. Used by the `copy` diff to
   * check that Figma TEXT-node strings appear in the rendered story.
   */
  texts?: string[];
  /**
   * The element's **own** text — its direct child text nodes, concatenated and
   * untrimmed. Distinct from `texts`, which is the whole subtree: this is what
   * decides whether a typography/`color`/`copy` verdict about this element is
   * about anything at all. See `applicability.ts`.
   *
   * Absent on any snapshot captured before v0.0.40 (or replayed from a cache
   * written by one), which the predicate treats as "not probed" — never as
   * "no text".
   */
  ownText?: string;
  /** Tag name of the snapshot target. Lets a form control count as text-bearing. */
  tagName?: string;
  /** The `type` attribute when the target is an `<input>`. */
  inputType?: string;
}

/**
 * One declared child binding as handed to the engine. Every binding in the
 * registry's `children` map produces exactly one of these, **including the ones
 * that failed to resolve** — the engine reports on all of them so a failure can
 * never be silently dropped.
 *
 * `snapshot` present ⟺ `problem` absent. When `problem` is set no comparison
 * runs for this child and the engine emits a report entry carrying the reason.
 */
export interface ChildTarget {
  /** CSS selector exactly as declared in the registry. Row identity + label. */
  selector: string;
  /** Figma node id declared for it (empty string when the binding is malformed). */
  nodeId: string;
  /** Computed-style snapshot of the single matched element. */
  snapshot?: CodeSnapshot;
  /** Pre-computed resolution failure (DOM side, or registry shape). */
  problem?: {
    status: Exclude<ChildBindingStatus, "compared">;
    message: string;
  };
}

export interface CheckDriftInput {
  storyId: string;
  nodeRef: NodeRef;
  /** Optional snapshot of the rendered code-side story. */
  snapshot?: CodeSnapshot;
  /**
   * Declared child bindings for this story, in registry order. Absent/empty for
   * every legacy entry — the engine then behaves exactly as it did before, with
   * no extra requests and no `children` field on the report.
   */
  children?: ChildTarget[];
  /**
   * Consumer-relative registry path (`config.registryPath`). Used **only** to
   * word child-binding failures so the message says where to make the edit.
   */
  registryPath?: string;
  /**
   * Active mode name (e.g. "light", "dark") read from the rendered DOM.
   * The engine uses this to pick matching values when resolving Figma
   * variables, so dark-mode comparisons aren't always made against the
   * file's default (Light) mode.
   */
  mode?: string;
  /** Storybook story args at request time. Used by the props dimension. */
  args?: Record<string, unknown>;
  /**
   * Why this check is running.
   *
   *  - `"explicit"` (default when absent) — a human pressed **Check drift** on
   *    this story, or the panel re-checked after a write. A deliberate re-check
   *    is a request for the truth, so engines MUST NOT answer it out of a
   *    time-based cache: the caller's whole question is "has Figma changed?".
   *  - `"bulk"` — one story of a **Check all** run. Here caching is the point:
   *    one variables fetch legitimately serves ~90 stories, and without it the
   *    run hits Figma's rate limits.
   *
   * Absent means `"explicit"` — the conservative default. A caller that forgets
   * to say gets correctness, not speed.
   */
  trigger?: "explicit" | "bulk";
  /**
   * `config.tokenAliases` — explicit Figma-variable-name → project-token-name
   * equivalences, consulted before the `normalizeTokenName` heuristic when
   * comparing token bindings. Absent/empty = heuristic only.
   *
   * Passed per check rather than held on the engine so editing
   * `design-sync.config.json` takes effect on the next check, without minting a
   * new engine instance (and throwing away its warm Figma caches).
   */
  tokenAliases?: Record<string, string>;
  /**
   * Identifier for the user action this check belongs to. A dual-mode check runs
   * the engine twice for one press of Check drift; both calls carry the same
   * `checkId`, so an explicit check revalidates Figma **once** per press instead
   * of once per mode. Absent means "assume a fresh action" (revalidate).
   */
  checkId?: string;
}

export interface Engine {
  readonly name: string;
  checkDrift(input: CheckDriftInput): Promise<DriftReport>;
  /**
   * Optional: pre-fetch whatever this engine shares across an entire **Check
   * all** run (for `figma-rest`: the file's variables and its `lastModified`).
   *
   * Exists because of a real, reproducible unfairness (issue #56): the first
   * story of a cold bulk run paid the shared variables + metadata fetch *inside*
   * its own per-story budget and timed out at 8016ms, while every story after it
   * finished in ~1s off the warm cache. The work isn't the first story's — so it
   * is hoisted out of the first story's budget and run once, before the loop.
   *
   * Must never throw: a failed warm-up is a slow run, not a broken one — the
   * per-story path fetches what it needs regardless.
   */
  warm?(fileKey: string): Promise<void>;
}

export interface EngineContext {
  /** PAT or other secret material; engines must never log this. */
  figmaPat?: string;
  /**
   * Absolute path to the persistent cache sidecar. When set, engines may
   * use it to short-circuit re-checks of unchanged stories. Optional —
   * engines should work without it.
   */
  cachePath?: string;
}

export type EngineFactory = (ctx: EngineContext) => Engine;
