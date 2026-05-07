import { addons } from "storybook/preview-api";
import {
  EVENTS,
  type CheckDriftRequestPayload,
  type CodeSnapshotPayload,
} from "./channels.js";
import type { CodeSnapshot } from "./engines/types.js";

const SNAPSHOT_PROPERTIES = [
  "background-color",
  "color",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "font-size",
  "font-weight",
  "line-height",
] as const;

/**
 * Find the element that actually represents the rendered story.
 *
 * Resolution order:
 *   1. Explicit `parameters.designSync.target` selector (most specific)
 *   2. Element with `data-design-sync-target` (explicit opt-in)
 *   3. Class-name match: descendant whose class name (with hyphens stripped)
 *      starts with the kebab-collapsed component segment of the storyId
 *      (e.g. "atoms-iconbutton--accent" → look for ".icon-button" or
 *      ".iconbutton" on a descendant). Skips Storybook decorator wrappers
 *      automatically.
 *   4. Deepest single-child walker fallback
 */
function findStoryRoot(selector?: string, storyId?: string): HTMLElement | null {
  if (selector) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
  }
  const explicit = document.querySelector<HTMLElement>("[data-design-sync-target]");
  if (explicit) return explicit;

  const root = document.getElementById("storybook-root");
  if (!root) return null;

  if (storyId) {
    const matched = findByComponentSegment(root, storyId);
    if (matched) return matched;
  }

  let el: HTMLElement = root;
  while (el.children.length === 1 && el.firstElementChild instanceof HTMLElement) {
    el = el.firstElementChild;
  }
  return el;
}

/**
 * Walk descendants and return the first one whose classList carries a class
 * matching the component segment of the storyId.
 *
 * Component segment is the last hyphen-separated piece of the part before "--":
 *   "atoms-iconbutton--accent" → "iconbutton"
 *   "organisms-ai-popover--default" → "popover"   (false hit on multi-word)
 *
 * To compensate for SB collapsing component names ("IconButton" → "iconbutton"),
 * we strip hyphens from candidate class names before comparing — so
 * `.icon-button` matches "iconbutton" and `.ai-popover` matches "aipopover".
 *
 * Returns null if no match — caller falls back to the single-child walker.
 */
function findByComponentSegment(root: HTMLElement, storyId: string): HTMLElement | null {
  const beforeDoubleDash = storyId.split("--")[0] ?? "";
  // Use the WHOLE pre-double-dash segment (collapsed) to handle both
  // "atoms-iconbutton" and "organisms-aipopover" without losing the "ai" prefix.
  // We try increasingly specific matches: full pre-segment, then just the last word.
  const candidates = new Set<string>();
  const collapsed = beforeDoubleDash.replace(/-/g, "").toLowerCase();
  if (collapsed) candidates.add(collapsed);
  const lastSegment = beforeDoubleDash.split("-").pop()?.toLowerCase();
  if (lastSegment) candidates.add(lastSegment);

  // Prefer the deepest match so we land on the leafmost component element
  // (`.icon-button.icon-button--accent` rather than a wrapping container).
  let best: HTMLElement | null = null;
  let bestDepth = -1;

  function walk(el: HTMLElement, depth: number): void {
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
      if (child instanceof HTMLElement) walk(child, depth + 1);
    }
  }

  walk(root, 0);
  return best;
}

function snapshotElement(el: HTMLElement): CodeSnapshot {
  const cs = window.getComputedStyle(el);
  const styles: Record<string, string> = {};
  for (const prop of SNAPSHOT_PROPERTIES) {
    styles[prop] = cs.getPropertyValue(prop).trim();
  }

  // Bindings: data-token-* attrs map a CSS prop → token name.
  const bindings: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith("data-token-")) {
      bindings[attr.name.slice("data-token-".length)] = attr.value;
    }
  }

  // Visible text content: split innerText on whitespace-y separators and
  // keep non-empty trimmed strings. Used by the `copy` dimension to check
  // that each Figma TEXT-node character string appears somewhere in the
  // rendered story.
  const rawText = el.innerText ?? "";
  const texts = Array.from(
    new Set(
      rawText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  );

  // Variant signals — collect both styles consumers actually use:
  //  - BEM modifiers:    ".icon-button--accent"  → suffix "accent"
  //  - Adjacent classes: ".file-item.active"     → "active" (any class
  //                                                 after the first/base)
  //
  // We send all candidates; the engine matches case-insensitively against
  // Figma's variant values.
  const allClasses = Array.from(el.classList);
  const candidates = new Set<string>();
  // Adjacent modifiers: any class after the first (which is the base).
  for (const c of allClasses.slice(1)) candidates.add(c);
  // BEM modifiers: include the suffix after `--` of any class.
  for (const c of allClasses) {
    const i = c.indexOf("--");
    if (i !== -1) candidates.add(c.slice(i + 2));
  }
  const variantClasses = [...candidates];

  return { styles, bindings, variantClasses, texts };
}

const channel = addons.getChannel();

/**
 * Read the active mode from the rendered DOM. Default attribute is
 * `data-theme` (the Downmark / common convention). Falls back to "light".
 *
 * The attribute is read off the document root (`<html>`) but stories using
 * a wrapping element can override via `parameters.designSync.modeAttribute`
 * pointing to a different attribute.
 */
function readActiveMode(modeAttribute = "data-theme"): string {
  const root = document.documentElement;
  const value = root.getAttribute(modeAttribute);
  return (value || "light").toLowerCase();
}

channel.on(EVENTS.CheckDriftRequest, (payload: CheckDriftRequestPayload) => {
  const target = findStoryRoot(payload.target, payload.storyId);
  if (!target) {
    channel.emit(EVENTS.DriftError, {
      storyId: payload.storyId,
      message: payload.target
        ? `Story root not found: selector "${payload.target}" matched no element.`
        : "Story root not found in DOM (looked for [data-design-sync-target] and #storybook-root).",
    });
    return;
  }
  const snapshot = snapshotElement(target);
  if (payload.tokens) {
    snapshot.bindings = { ...(snapshot.bindings ?? {}), ...payload.tokens };
  }
  const mode = readActiveMode(payload.modeAttribute);
  const out: CodeSnapshotPayload = { storyId: payload.storyId, snapshot, mode };
  if (payload.args) out.args = payload.args;
  channel.emit(EVENTS.CodeSnapshot, out);
});
