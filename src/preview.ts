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
 *   1. Element with `data-design-sync-target` (explicit opt-in)
 *   2. Storybook story root (`#storybook-root`) — drill down through any
 *      single-child wrappers Storybook/Preact decorators introduce
 *   3. null
 */
function findStoryRoot(selector?: string): HTMLElement | null {
  if (selector) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
  }
  const explicit = document.querySelector<HTMLElement>("[data-design-sync-target]");
  if (explicit) return explicit;

  const root = document.getElementById("storybook-root");
  if (!root) return null;

  let el: HTMLElement = root;
  while (el.children.length === 1 && el.firstElementChild instanceof HTMLElement) {
    el = el.firstElementChild;
  }
  return el;
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

  // Variant signal: BEM-modifier classes (anything with "--").
  const variantClasses = Array.from(el.classList).filter((c) => c.includes("--"));

  return { styles, bindings, variantClasses };
}

const channel = addons.getChannel();

channel.on(EVENTS.CheckDriftRequest, (payload: CheckDriftRequestPayload) => {
  const target = findStoryRoot(payload.target);
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
  // Overlay story-declared token bindings on top of any DOM-attribute bindings.
  if (payload.tokens) {
    snapshot.bindings = { ...(snapshot.bindings ?? {}), ...payload.tokens };
  }
  const out: CodeSnapshotPayload = { storyId: payload.storyId, snapshot };
  channel.emit(EVENTS.CodeSnapshot, out);
});
