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

  return { styles, bindings, variantClasses };
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
  if (payload.tokens) {
    snapshot.bindings = { ...(snapshot.bindings ?? {}), ...payload.tokens };
  }
  const mode = readActiveMode(payload.modeAttribute);
  const out: CodeSnapshotPayload = { storyId: payload.storyId, snapshot, mode };
  channel.emit(EVENTS.CodeSnapshot, out);
});
