/**
 * Story-root resolution, including portalled overlay content.
 *
 * The problem: Radix and Base UI render Dialog, Popover, Tooltip, Select and
 * Dropdown content into `document.body` via a portal — *outside*
 * `#storybook-root`. The previous resolver only looked at
 * `[data-design-sync-target]` and `#storybook-root`, so no overlay primitive
 * could be drift-checked at all: the snapshot landed on the trigger (or on the
 * empty story root) and reported that element's styles as the component's.
 *
 * The hard constraint is determinism. A wrong element produces plausible-looking
 * garbage drift, which is worse than an error — the numbers are real, they just
 * describe something else. So when the choice between the in-root content and a
 * portal (or between two portals) is genuinely ambiguous, this resolver refuses
 * and reports the candidates instead of picking one.
 *
 * Disambiguation for consumers, in precedence order:
 *   1. `parameters.designSync.target: "<selector>"` — queried against the WHOLE
 *      document, so it reaches portalled content. This is the escape hatch for
 *      every ambiguous case, and the first match wins (an explicit selector is
 *      a statement of intent).
 *   2. `data-design-sync-target` on the element to snapshot. Also searched
 *      document-wide. Two of them is an authoring bug, and is reported.
 *
 * Extracted from `preview.ts` so it can be unit-tested against a DOM without
 * importing Storybook's preview API (which opens a channel at module load).
 */

/** Roots Storybook itself owns; portal candidates must live outside these. */
const STORYBOOK_ROOT_IDS = ["storybook-root", "root", "storybook-docs"];

/**
 * Selectors that identify *open, portalled overlay content* — the element a
 * Dialog/Popover/Tooltip/Menu/Select actually paints.
 *
 * Deliberately narrow. Matching "anything appended to body" would sweep up
 * Storybook's own injected nodes, `<style>` hosts, live regions and the
 * portal *container* divs (which carry none of the component's styling). Each
 * entry below is either an ARIA role that only overlay content uses, or a
 * library's own open-state attribute:
 *
 *   - Base UI marks an open popup with `data-open` (see
 *     `@base-ui/react/utils/popupStateMapping`: `CommonPopupDataAttributes.open`).
 *   - Radix marks content with `data-state="open"` and wraps positioned content
 *     in `[data-radix-popper-content-wrapper]`.
 *
 * Roles are listed separately from attributes so a headless primitive that sets
 * neither library's attribute still resolves via its role.
 */
const OVERLAY_CONTENT_SELECTORS = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  "[data-open]",
  '[data-state="open"]',
];

/**
 * Containers a library uses to *hold* portalled content. They carry no
 * component styling themselves, so a match inside them is preferred over the
 * container — but their presence is what tells us a portal exists.
 */
const PORTAL_CONTAINER_SELECTORS = [
  "[data-radix-popper-content-wrapper]",
  "[data-radix-portal]",
  "[data-base-ui-portal]",
  "[data-portal]",
];

export type StoryRootResolution =
  | { kind: "found"; element: HTMLElement; via: ResolutionPath }
  | { kind: "not-found"; message: string }
  | { kind: "ambiguous"; message: string; candidates: string[] };

export type ResolutionPath =
  | "target-selector"
  | "data-attribute"
  | "portal"
  | "component-segment"
  | "single-child-walk";

export interface ResolveStoryRootOptions {
  doc: Document;
  /** `parameters.designSync.target`. */
  selector?: string | undefined;
  storyId?: string | undefined;
}

/**
 * Element narrowing by `nodeType` rather than `instanceof HTMLElement`.
 *
 * `instanceof` is realm-bound: it is false for a node from a different
 * document/realm even when the node is a perfectly good element. The preview
 * runs inside Storybook's iframe and the unit tests build standalone JSDOM
 * documents, so both are realms where the global constructor may not be the
 * node's. `nodeType === 1` is the realm-independent test.
 */
const ELEMENT_NODE = 1;

function asElement(node: Node | null | undefined): HTMLElement | null {
  return node && node.nodeType === ELEMENT_NODE ? (node as HTMLElement) : null;
}

/** A short, human-recognisable description of an element for error messages. */
export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const cls = Array.from(el.classList).slice(0, 3).join(".");
  const role = el.getAttribute("role");
  return (
    tag +
    id +
    (cls ? `.${cls}` : "") +
    (role ? `[role="${role}"]` : "") +
    (el.hasAttribute("data-open") ? "[data-open]" : "")
  );
}

function isInsideStorybookRoot(doc: Document, el: Element): boolean {
  for (const id of STORYBOOK_ROOT_IDS) {
    const root = doc.getElementById(id);
    if (root && (root === el || root.contains(el))) return true;
  }
  return false;
}

/**
 * Portalled overlay content roots: elements matching an overlay signature that
 * live OUTSIDE every Storybook root. Nested matches collapse to their outermost
 * ancestor, so a Dialog whose popup also carries `data-open` on an inner node
 * counts once.
 */
export function findPortalledContent(doc: Document): HTMLElement[] {
  const matches = new Set<HTMLElement>();
  for (const selector of OVERLAY_CONTENT_SELECTORS) {
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(selector))) {
      if (isInsideStorybookRoot(doc, el)) continue;
      matches.add(el);
    }
  }
  // A portal container with exactly one element child and no overlay signature
  // of its own still identifies the content: take the child.
  for (const selector of PORTAL_CONTAINER_SELECTORS) {
    for (const container of Array.from(doc.querySelectorAll<HTMLElement>(selector))) {
      if (isInsideStorybookRoot(doc, container)) continue;
      const alreadyCovered = Array.from(matches).some(
        (m) => m === container || container.contains(m) || m.contains(container),
      );
      if (alreadyCovered) continue;
      const child = asElement(container.firstElementChild);
      if (child) matches.add(child);
    }
  }
  // Collapse nested matches to their outermost.
  const all = [...matches];
  return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
}

/**
 * Component segment of the story id, hyphen-collapsed, used to find the
 * component's own element inside the story root.
 *
 *   "atoms-iconbutton--accent"     → "iconbutton"
 *   "organisms-ai-popover--default" → "aipopover" (and "popover")
 */
function componentSegmentCandidates(storyId: string): Set<string> {
  const beforeDoubleDash = storyId.split("--")[0] ?? "";
  const candidates = new Set<string>();
  const collapsed = beforeDoubleDash.replace(/-/g, "").toLowerCase();
  if (collapsed) candidates.add(collapsed);
  const lastSegment = beforeDoubleDash.split("-").pop()?.toLowerCase();
  if (lastSegment) candidates.add(lastSegment);
  return candidates;
}

/**
 * Walk descendants and return the deepest one whose classList carries a class
 * matching the component segment of the storyId. Hyphens are stripped from
 * candidate class names before comparing, so `.icon-button` matches
 * "iconbutton". Returns null when nothing matches.
 */
export function findByComponentSegment(
  root: HTMLElement,
  storyId: string,
): HTMLElement | null {
  const candidates = componentSegmentCandidates(storyId);
  let best: HTMLElement | null = null;
  let bestDepth = -1;

  const walk = (el: HTMLElement, depth: number): void => {
    for (const cls of Array.from(el.classList)) {
      const stripped = cls.replace(/-/g, "").toLowerCase();
      for (const candidate of candidates) {
        if (stripped === candidate || stripped.startsWith(candidate)) {
          if (depth > bestDepth) {
            best = el;
            bestDepth = depth;
          }
          break;
        }
      }
    }
    for (const child of Array.from(el.children)) {
      const childEl = asElement(child);
      if (childEl) walk(childEl, depth + 1);
    }
  };

  walk(root, 0);
  return best;
}

/** Deepest single-child descendant — skips Storybook's decorator wrappers. */
function singleChildWalk(root: HTMLElement): HTMLElement {
  let el: HTMLElement = root;
  for (;;) {
    if (el.children.length !== 1) break;
    const only = asElement(el.firstElementChild);
    if (!only) break;
    el = only;
  }
  return el;
}

const DISAMBIGUATE =
  'Set `parameters.designSync.target: "<css selector>"` on the story (it is queried ' +
  "against the whole document, so it reaches portalled content), or put " +
  "`data-design-sync-target` on the element you want snapshotted.";

/**
 * Resolve the element that represents the rendered story.
 *
 * Resolution order:
 *   1. explicit `target` selector — whole document, first match wins;
 *   2. `[data-design-sync-target]` — whole document; more than one is ambiguous;
 *   3. portalled overlay content, when present:
 *      - exactly one portal and no component-segment match in the story root →
 *        the portal (this is the Dialog/Popover case: the root holds only the
 *        trigger);
 *      - exactly one portal AND a component-segment match in the root → both are
 *        plausible, so **ambiguous**;
 *      - more than one portal → **ambiguous**;
 *   4. component-segment match inside the story root;
 *   5. deepest single-child walk from the story root.
 */
export function resolveStoryRoot(options: ResolveStoryRootOptions): StoryRootResolution {
  const { doc, selector, storyId } = options;

  if (selector) {
    // Document-wide on purpose: this is how a consumer points at portalled
    // content, and it is the documented answer to every ambiguity below.
    const el = doc.querySelector<HTMLElement>(selector);
    if (el) return { kind: "found", element: el, via: "target-selector" };
    return {
      kind: "not-found",
      message: `Story root not found: selector "${selector}" matched no element.`,
    };
  }

  const explicit = Array.from(doc.querySelectorAll<HTMLElement>("[data-design-sync-target]"));
  if (explicit.length === 1) {
    return { kind: "found", element: explicit[0]!, via: "data-attribute" };
  }
  if (explicit.length > 1) {
    return {
      kind: "ambiguous",
      message:
        `${explicit.length} elements carry \`data-design-sync-target\`; which one the story ` +
        `means is not inferable, and snapshotting the wrong one produces drift numbers that ` +
        `are real but describe a different element. Keep exactly one, or set ` +
        `\`parameters.designSync.target\` to the specific selector.`,
      candidates: explicit.map(describeElement),
    };
  }

  const root = doc.getElementById("storybook-root");
  const portals = findPortalledContent(doc);
  const inRoot = root && storyId ? findByComponentSegment(root, storyId) : null;

  if (portals.length > 1) {
    return {
      kind: "ambiguous",
      message:
        `${portals.length} portalled overlays are open outside #storybook-root; which one is ` +
        `this story's component is not inferable. ${DISAMBIGUATE}`,
      candidates: portals.map(describeElement),
    };
  }

  if (portals.length === 1) {
    if (inRoot) {
      return {
        kind: "ambiguous",
        message:
          `This story renders both an element matching "${storyId}" inside #storybook-root and ` +
          `a portalled overlay outside it (typical of a trigger plus its popup). Snapshotting ` +
          `the wrong one produces plausible-looking drift for the other element. ${DISAMBIGUATE}`,
        candidates: [describeElement(inRoot), describeElement(portals[0]!)],
      };
    }
    return { kind: "found", element: portals[0]!, via: "portal" };
  }

  if (!root) {
    return {
      kind: "not-found",
      message:
        "Story root not found in DOM (looked for [data-design-sync-target], an open portalled " +
        "overlay, and #storybook-root).",
    };
  }

  if (inRoot) return { kind: "found", element: inRoot, via: "component-segment" };
  return { kind: "found", element: singleChildWalk(root), via: "single-child-walk" };
}
