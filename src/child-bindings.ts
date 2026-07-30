/**
 * Declared child bindings — whole-component drift comparison.
 *
 * ## Why this exists
 *
 * `snapshotElement` reads `getComputedStyle` for exactly one element. Before
 * this module, a drift check compared the story's *root* element against the
 * registered Figma node and nothing inside it. On a Button that is nearly the
 * whole component; on a Card, Dialog or form field it means header padding,
 * nested label typography, icon sizing and body spacing were all unchecked —
 * a clean report meant "the root element matches", not "the component matches".
 *
 * ## Why *declared*, not inferred
 *
 * The registry names the pairs explicitly:
 *
 * ```json
 * "ui-card--default": {
 *   "nodeId": "2142:11380",
 *   "lastSyncedHash": null,
 *   "children": {
 *     "[data-slot=header]": "2142:11381",
 *     "[data-slot=body]":   "2142:11382"
 *   }
 * }
 * ```
 *
 * Auto-matching code children to Figma children by document order or by name
 * would be a new heuristic, and a mis-paired element produces drift numbers
 * that are real but describe a different element — the worst failure mode this
 * addon has. Declared only. (Auto-suggestion at *registration* time, where a
 * human reviews the pairing before it is committed, is possible future work;
 * it is deliberately not built here.)
 *
 * ## Honesty rules encoded below
 *
 * A declared binding that cannot be compared must produce a visible, named
 * message — never silence, and never a dropped row:
 *
 *   - selector matches nothing        → `selector-not-found`
 *   - selector matches >1 element     → `selector-ambiguous` (we never pick one)
 *   - selector is not valid CSS       → `selector-invalid`
 *   - value in the registry is bad    → `binding-malformed`
 *   - Figma node id doesn't resolve   → `node-unreachable`
 *   - no snapshot arrived for it      → `snapshot-missing`
 *
 * Kept free of Storybook/React imports so it is unit-testable against a plain
 * JSDOM document.
 */

/** Registry shape: CSS selector (relative to the story root) → Figma node id. */
export type ChildBindingMap = Record<string, string>;

/** One well-formed declaration. */
export interface ChildBindingDeclaration {
  selector: string;
  nodeId: string;
}

/**
 * Outcome of a declared child binding. `compared` is the only value that means
 * rows exist for it; every other value means **no comparison ran** and the
 * panel must say so.
 */
export type ChildBindingStatus =
  | "compared"
  | "selector-not-found"
  | "selector-ambiguous"
  | "selector-invalid"
  | "binding-malformed"
  | "snapshot-missing"
  | "node-unreachable";

export interface ChildBindingValidation {
  /** Well-formed declarations, in registry key order. */
  declarations: ChildBindingDeclaration[];
  /**
   * Entries present in the registry that are not usable. Reported, never
   * dropped: each becomes a visible `binding-malformed` row.
   */
  malformed: Array<{ selector: string; detail: string }>;
  /**
   * Set when `children` itself is the wrong shape (not a plain object). No
   * declarations can be read at all in that case.
   */
  fatal?: string;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Validate a registry entry's `children` field.
 *
 * Absent (`undefined` / `null`) is the legacy shape and is completely silent —
 * every pre-existing registry entry must behave exactly as it did before.
 */
export function validateChildBindings(raw: unknown): ChildBindingValidation {
  if (raw === undefined || raw === null) return { declarations: [], malformed: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      declarations: [],
      malformed: [],
      fatal:
        `"children" must be an object mapping "<css selector>" → "<figma node id>"; ` +
        `got ${typeName(raw)}.`,
    };
  }

  const declarations: ChildBindingDeclaration[] = [];
  const malformed: Array<{ selector: string; detail: string }> = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const selector = key.trim();
    if (selector.length === 0) {
      malformed.push({
        selector: key,
        detail: "the key is empty — it must be a CSS selector resolved inside the story root.",
      });
      continue;
    }
    if (typeof value !== "string") {
      malformed.push({
        selector,
        detail: `the value must be a Figma node id string; got ${typeName(value)}.`,
      });
      continue;
    }
    const nodeId = value.trim();
    if (nodeId.length === 0) {
      malformed.push({ selector, detail: "the Figma node id is empty." });
      continue;
    }
    if (/\s/.test(nodeId)) {
      malformed.push({
        selector,
        detail: `the Figma node id "${nodeId}" contains whitespace.`,
      });
      continue;
    }
    declarations.push({ selector, nodeId });
  }
  return { declarations, malformed };
}

/* ------------------------------------------------------------------------- *
 * DOM resolution (runs in the preview iframe)
 * ------------------------------------------------------------------------- */

export type ChildElementResolution =
  | { selector: string; nodeId: string; kind: "found"; element: HTMLElement }
  | { selector: string; nodeId: string; kind: "not-found"; rootMatches: boolean }
  | { selector: string; nodeId: string; kind: "ambiguous"; candidates: string[] }
  | { selector: string; nodeId: string; kind: "invalid"; detail: string };

/**
 * A short, human-recognisable description of an element. Mirrors
 * `story-root.ts`'s `describeElement`; duplicated rather than imported because
 * that module owns story-root resolution and this one owns child resolution —
 * neither should depend on the other's internals.
 */
export function describeChildElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = Array.from(el.classList).slice(0, 3).join(".");
  return tag + id + (cls ? `.${cls}` : "");
}

const ELEMENT_NODE = 1;

/**
 * Resolve each declared selector **within the story root**.
 *
 * Descendants only: `querySelectorAll` never returns the root itself. When a
 * selector matches nothing but *would* have matched the root, we record that
 * so the message can say so instead of leaving the author guessing.
 *
 * Ambiguity is reported, never resolved by taking the first match — see the
 * module docstring.
 */
export function resolveChildElements(
  root: Element,
  declarations: readonly ChildBindingDeclaration[],
): ChildElementResolution[] {
  return declarations.map((decl): ChildElementResolution => {
    let matches: Element[];
    try {
      matches = Array.from(root.querySelectorAll(decl.selector));
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      return { selector: decl.selector, nodeId: decl.nodeId, kind: "invalid", detail };
    }
    const elements = matches.filter((el) => el.nodeType === ELEMENT_NODE) as HTMLElement[];
    if (elements.length === 1) {
      return { selector: decl.selector, nodeId: decl.nodeId, kind: "found", element: elements[0]! };
    }
    if (elements.length === 0) {
      let rootMatches = false;
      try {
        rootMatches = root.matches(decl.selector);
      } catch {
        rootMatches = false;
      }
      return { selector: decl.selector, nodeId: decl.nodeId, kind: "not-found", rootMatches };
    }
    return {
      selector: decl.selector,
      nodeId: decl.nodeId,
      kind: "ambiguous",
      candidates: elements.slice(0, 6).map(describeChildElement),
    };
  });
}

/* ------------------------------------------------------------------------- *
 * Message formatting (runs on the server, which knows the registry path)
 * ------------------------------------------------------------------------- */

export interface ChildProblemContext {
  status: Exclude<ChildBindingStatus, "compared">;
  selector: string;
  storyId: string;
  /** Consumer-relative registry path, so the message says where to edit. */
  registryPath: string;
  nodeId?: string | undefined;
  /** Element descriptions for the ambiguous case. */
  candidates?: string[] | undefined;
  /** Extra detail from the source of the problem (parser / HTTP status). */
  detail?: string | undefined;
  /** True when the story root itself matches a selector that found nothing. */
  rootMatches?: boolean | undefined;
  /**
   * `node-unreachable` only: the Figma read **failed** (rate limit, network, HTTP
   * error) rather than Figma confirming the node isn't in the file. The advice is
   * different and the old wording gave the wrong one — telling a user to re-check
   * a node id they typed correctly, when the answer is "you were rate limited,
   * wait N seconds" (issue #73).
   */
  transient?: boolean | undefined;
}

/**
 * The single place child-binding failures are worded. Every message names the
 * selector and the story, says plainly that no comparison ran, and gives the
 * next action — the alternative (silence, or a dropped row) is what would make
 * "clean" a lie.
 */
export function formatChildProblem(ctx: ChildProblemContext): string {
  const where = `child binding \`${ctx.selector}\` on story \`${ctx.storyId}\``;
  const edit = `Edit "children" for "${ctx.storyId}" in ${ctx.registryPath}.`;
  switch (ctx.status) {
    case "selector-not-found":
      return (
        `Not compared — ${where} matched no element inside the story root. ` +
        (ctx.rootMatches
          ? `The story root itself matches this selector; child selectors are resolved among the ` +
            `root's descendants only, so a root-matching selector can never bind. `
          : "") +
        `${edit} Nothing about this element was checked against Figma node ${ctx.nodeId ?? "?"}.`
      );
    case "selector-ambiguous":
      return (
        `Not compared — ${where} matched ${ctx.candidates?.length ?? 2} elements inside the story ` +
        `root. Which one the binding means is not inferable, and snapshotting the wrong one would ` +
        `produce drift numbers that are real but describe a different element, so no comparison ran. ` +
        `Narrow the selector until exactly one element matches. ${edit}` +
        (ctx.candidates && ctx.candidates.length > 0
          ? ` Candidates: ${ctx.candidates.join(" | ")}`
          : "")
      );
    case "selector-invalid":
      return (
        `Not compared — ${where} is not a valid CSS selector` +
        (ctx.detail ? ` (${ctx.detail})` : "") +
        `. ${edit}`
      );
    case "binding-malformed":
      return (
        `Not compared — ${where} is malformed: ${ctx.detail ?? "unrecognised shape."} ` +
        `Expected "<css selector>": "<figma node id>". ${edit}`
      );
    case "snapshot-missing":
      return (
        `Not compared — no snapshot arrived for ${where}. The preview did not report a result for ` +
        `this selector, so it was neither resolved nor checked. Re-run Check drift; if it persists, ` +
        `the preview bundle is older than the server (restart Storybook).`
      );
    case "node-unreachable":
      if (ctx.transient) {
        // The id is fine and the registry is fine; the request failed. Sending
        // the reader to re-check the node id would waste their time, and (worse)
        // invite them to "fix" a binding that was never broken.
        return (
          `Not compared — the Figma read for ${where} failed, so node ` +
          `\`${ctx.nodeId ?? "?"}\` was never looked at` +
          (ctx.detail ? `: ${ctx.detail}` : ".") +
          ` The selector resolved and the binding is fine — nothing to change here. ` +
          `Re-run the check once the wait is over; this result is not cached, so it will retry.`
        );
      }
      return (
        `Not compared — Figma node \`${ctx.nodeId ?? "?"}\` declared for ${where} could not be read` +
        (ctx.detail ? ` (${ctx.detail})` : "") +
        `. The selector resolved fine; the Figma side did not. Check the node id (copy it from ` +
        `Figma via "Copy link to selection") and that the PAT can read the file. ${edit}`
      );
  }
}

/* ------------------------------------------------------------------------- *
 * CLI
 * ------------------------------------------------------------------------- */

/**
 * `design-sync register --child "<selector>=<nodeId>"` → a `{selector, nodeId}`
 * pair.
 *
 * Split on the LAST `=` so a selector containing one (`[data-slot=header]` —
 * the common case) needs no escaping. Figma node ids never contain `=`.
 */
export function parseChildFlag(raw: string): ChildBindingDeclaration {
  const idx = raw.lastIndexOf("=");
  const bad = (): never => {
    throw new Error(
      `--child expects "<css selector>=<figma node id>" (got "${raw}"). ` +
        `The split is on the LAST "=", so "[data-slot=header]=2142:11381" works unescaped.`,
    );
  };
  if (idx <= 0 || idx === raw.length - 1) bad();
  const selector = raw.slice(0, idx).trim();
  const nodeId = raw.slice(idx + 1).trim();
  if (!selector || !nodeId) bad();
  return { selector, nodeId };
}

/* ------------------------------------------------------------------------- *
 * CLI shape report
 * ------------------------------------------------------------------------- */

export interface ChildShapeIssue {
  storyId: string;
  message: string;
}

/**
 * Validate the `children` shape of every registry entry. Used by
 * `design-sync audit`.
 *
 * Shape only. Audit has no DOM and no Figma access, so it cannot know whether a
 * selector resolves to exactly one element or whether a node id exists — the
 * caller must say so rather than implying it checked.
 */
export function auditChildBindings(
  stories: Record<string, { children?: unknown }>,
): { issues: ChildShapeIssue[]; storiesWithChildren: number; declaredBindings: number } {
  const issues: ChildShapeIssue[] = [];
  let storiesWithChildren = 0;
  let declaredBindings = 0;
  for (const storyId of Object.keys(stories).sort()) {
    const raw = stories[storyId]?.children;
    if (raw === undefined || raw === null) continue;
    storiesWithChildren++;
    const { declarations, malformed, fatal } = validateChildBindings(raw);
    declaredBindings += declarations.length;
    if (fatal) {
      issues.push({ storyId, message: fatal });
      continue;
    }
    for (const m of malformed) {
      issues.push({ storyId, message: `children["${m.selector}"]: ${m.detail}` });
    }
    if (declarations.length === 0 && malformed.length === 0) {
      issues.push({
        storyId,
        message: `"children" is present but empty — remove it, or declare at least one binding.`,
      });
    }
  }
  return { issues, storiesWithChildren, declaredBindings };
}
