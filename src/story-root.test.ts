import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  resolveStoryRoot,
  findPortalledContent,
  findByComponentSegment,
  describeElement,
} from "./story-root.js";

/**
 * Radix and Base UI render Dialog / Popover / Tooltip / Select / Menu content
 * into `document.body`, outside `#storybook-root`. These tests pin the three
 * behaviours that matter:
 *
 *   1. the pre-existing story-root path still resolves exactly as before;
 *   2. portalled content resolves when the story root holds only a trigger;
 *   3. a genuinely ambiguous choice is REPORTED, never silently made — a wrong
 *      element produces drift numbers that are real but describe something else.
 */

function domOf(bodyHtml: string): Document {
  return new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`).window.document;
}

const ROOT_ONLY = `
  <div id="storybook-root">
    <div class="sb-main-centered">
      <button class="icon-button icon-button--accent">Save</button>
    </div>
  </div>
`;

describe("resolveStoryRoot — the story-root path still works", () => {
  it("finds the component-segment match inside #storybook-root", () => {
    const r = resolveStoryRoot({ doc: domOf(ROOT_ONLY), storyId: "atoms-iconbutton--accent" });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.via).toBe("component-segment");
    expect(r.element.tagName).toBe("BUTTON");
  });

  it("falls back to the deepest single-child walk when no class matches", () => {
    const doc = domOf(`
      <div id="storybook-root"><div class="wrap"><span class="leaf">hi</span></div></div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-button--primary" });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.via).toBe("single-child-walk");
    expect(r.element.className).toBe("leaf");
  });

  it("prefers an explicit target selector over everything else", () => {
    const doc = domOf(`
      <div id="storybook-root"><button class="icon-button">a</button></div>
      <div role="dialog" data-open class="popup">b</div>
    `);
    const r = resolveStoryRoot({
      doc,
      selector: ".icon-button",
      storyId: "atoms-iconbutton--accent",
    });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.via).toBe("target-selector");
    expect(r.element.className).toBe("icon-button");
  });

  it("resolves an explicit target selector that only matches portalled content", () => {
    // This is the documented disambiguation: the selector is queried against
    // the whole document, so it reaches outside #storybook-root.
    const doc = domOf(`
      <div id="storybook-root"><button>Open</button></div>
      <div data-radix-portal><div role="dialog" class="dialog-content">b</div></div>
    `);
    const r = resolveStoryRoot({ doc, selector: ".dialog-content", storyId: "ui-dialog--open" });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.element.className).toBe("dialog-content");
  });

  it("reports a target selector that matches nothing", () => {
    const r = resolveStoryRoot({ doc: domOf(ROOT_ONLY), selector: ".nope" });
    expect(r.kind).toBe("not-found");
    if (r.kind !== "not-found") return;
    expect(r.message).toContain(".nope");
  });

  it("uses a single data-design-sync-target", () => {
    const doc = domOf(`
      <div id="storybook-root"><div data-design-sync-target class="picked">x</div></div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-thing--default" });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.via).toBe("data-attribute");
  });

  it("reports when the whole document has no story root at all", () => {
    const r = resolveStoryRoot({ doc: domOf("<p>nothing</p>"), storyId: "ui-x--y" });
    expect(r.kind).toBe("not-found");
  });
});

describe("resolveStoryRoot — portalled content", () => {
  it("resolves Base UI portalled popup content (data-open, outside the root)", () => {
    const doc = domOf(`
      <div id="storybook-root"><button data-popup-open>Open</button></div>
      <div class="popup" data-open data-side="bottom">Popup body</div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-popover--open" });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.via).toBe("portal");
    expect(r.element.className).toBe("popup");
  });

  it("resolves Radix portalled dialog content (data-state=open)", () => {
    const doc = domOf(`
      <div id="storybook-root"><button>Open</button></div>
      <div data-radix-portal>
        <div role="dialog" data-state="open" class="dialog">Body</div>
      </div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-dialog--open" });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.element.className).toBe("dialog");
  });

  it("resolves through a bare portal container with no overlay signature", () => {
    const doc = domOf(`
      <div id="storybook-root"><button>Open</button></div>
      <div data-radix-popper-content-wrapper><div class="tooltip">tip</div></div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-tooltip--default" });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.element.className).toBe("tooltip");
  });

  it("collapses nested overlay matches to the outermost element", () => {
    const doc = domOf(`
      <div id="storybook-root"><button>Open</button></div>
      <div role="dialog" data-open class="outer">
        <div data-open class="inner">x</div>
      </div>
    `);
    expect(findPortalledContent(doc).map((e) => e.className)).toEqual(["outer"]);
    const r = resolveStoryRoot({ doc, storyId: "ui-dialog--open" });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.element.className).toBe("outer");
  });

  it("ignores overlay-looking elements INSIDE the story root", () => {
    // A non-portalled dialog rendered in-place is not a portal candidate; the
    // normal in-root paths handle it.
    const doc = domOf(`
      <div id="storybook-root"><div role="dialog" data-open class="inline-dialog">x</div></div>
    `);
    expect(findPortalledContent(doc)).toEqual([]);
    const r = resolveStoryRoot({ doc, storyId: "ui-dialog--inline" });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.via).not.toBe("portal");
  });

  it("ignores a closed popup", () => {
    const doc = domOf(`
      <div id="storybook-root"><button>Open</button></div>
      <div class="popup" data-closed>hidden</div>
      <div data-state="closed" class="other">hidden</div>
    `);
    expect(findPortalledContent(doc)).toEqual([]);
  });
});

describe("resolveStoryRoot — ambiguity is reported, not guessed", () => {
  it("refuses when two portalled overlays are open", () => {
    const doc = domOf(`
      <div id="storybook-root"><button>Open</button></div>
      <div role="dialog" data-open class="dialog">a</div>
      <div role="tooltip" data-open class="tooltip">b</div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-dialog--open" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.candidates).toHaveLength(2);
    // The message must name the escape hatch, not just complain.
    expect(r.message).toContain("parameters.designSync.target");
  });

  it("refuses when the root has a component match AND a portal is open", () => {
    // Dialog stories look exactly like this: trigger in the root, content in a
    // portal. Both are plausible targets, so the consumer has to say which.
    const doc = domOf(`
      <div id="storybook-root"><button class="dialog-trigger">Open</button></div>
      <div role="dialog" data-open class="dialog-content">Body</div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-dialog--open" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.candidates).toEqual([
      'button.dialog-trigger',
      'div.dialog-content[role="dialog"][data-open]',
    ]);
    expect(r.message).toContain("data-design-sync-target");
  });

  it("an explicit target selector resolves the trigger-plus-portal ambiguity", () => {
    const doc = domOf(`
      <div id="storybook-root"><button class="dialog-trigger">Open</button></div>
      <div role="dialog" data-open class="dialog-content">Body</div>
    `);
    const r = resolveStoryRoot({
      doc,
      selector: ".dialog-content",
      storyId: "ui-dialog--open",
    });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.element.className).toBe("dialog-content");
  });

  it("data-design-sync-target also resolves the trigger-plus-portal ambiguity", () => {
    const doc = domOf(`
      <div id="storybook-root"><button class="dialog-trigger">Open</button></div>
      <div role="dialog" data-open data-design-sync-target class="dialog-content">Body</div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-dialog--open" });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.via).toBe("data-attribute");
    expect(r.element.className).toBe("dialog-content");
  });

  it("refuses when two elements carry data-design-sync-target", () => {
    const doc = domOf(`
      <div id="storybook-root">
        <div data-design-sync-target class="a">a</div>
        <div data-design-sync-target class="b">b</div>
      </div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-x--y" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.candidates).toEqual(["div.a", "div.b"]);
  });

  /**
   * addon#106... no, #109's sibling — 2.1 in NEXT-WORK.md. Base UI's Dialog
   * portal renders a backdrop and a popup as siblings, and BOTH carry
   * `data-open` — the real shape that made the Dialog walkthrough refuse with
   * a message naming two candidates a designer couldn't act on. The backdrop
   * is decorative (no element children of its own); the popup is where the
   * title, body and actions actually live. That is a real, checkable
   * difference, not a guess, so exactly one candidate having descendants
   * resolves it without `parameters.designSync.target`.
   */
  it("auto-resolves two portals when only one has any element descendants (backdrop + popup)", () => {
    const doc = domOf(`
      <div id="storybook-root"><button>Open</button></div>
      <div role="presentation" data-open class="backdrop"></div>
      <div role="dialog" data-open class="popup">
        <h2 class="title">Save changes?</h2>
        <p class="body">You have unsaved changes.</p>
      </div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-dialog--open" });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.via).toBe("portal");
    expect(r.element.className).toBe("popup");
  });

  it("still refuses two portals that BOTH have descendants — genuine ambiguity", () => {
    const doc = domOf(`
      <div id="storybook-root"><button>Open</button></div>
      <div role="dialog" data-open class="dialog"><h2>Title A</h2></div>
      <div role="tooltip" data-open class="tooltip"><span>Tip B</span></div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-dialog--open" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.candidates).toHaveLength(2);
  });

  it("still refuses two portals that BOTH lack descendants — no way to prefer one", () => {
    const doc = domOf(`
      <div id="storybook-root"><button>Open</button></div>
      <div role="presentation" data-open class="backdrop"></div>
      <div role="tooltip" data-open class="empty-tooltip"></div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-dialog--open" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.candidates).toHaveLength(2);
  });

  it("the descendant-count tiebreak still yields to an in-root component match — stays ambiguous", () => {
    const doc = domOf(`
      <div id="storybook-root"><button class="dialog-trigger">Open</button></div>
      <div role="presentation" data-open class="backdrop"></div>
      <div role="dialog" data-open class="dialog-content"><h2>Title</h2></div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-dialog--open" });
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    // Only the two PLAUSIBLE candidates (trigger + popup) are named — the
    // backdrop was never in contention, so naming it would mislead.
    expect(r.candidates).toEqual([
      'button.dialog-trigger',
      'div.dialog-content[role="dialog"][data-open]',
    ]);
  });

  it("a single portal with no in-root component match is NOT ambiguous", () => {
    // Nothing in the root answers to the story name, so the portal is the only
    // plausible target — resolve it rather than erroring.
    const doc = domOf(`
      <div id="storybook-root"><button class="trigger">Open</button></div>
      <div role="dialog" data-open class="dialog-content">Body</div>
    `);
    const r = resolveStoryRoot({ doc, storyId: "ui-dialog--open" });
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.via).toBe("portal");
  });
});

describe("helpers", () => {
  it("findByComponentSegment strips hyphens when matching", () => {
    const doc = domOf(`<div id="r"><span class="ai-popover">x</span></div>`);
    const root = doc.getElementById("r")!;
    expect(findByComponentSegment(root, "organisms-aipopover--default")?.className).toBe(
      "ai-popover",
    );
  });

  it("describeElement produces a recognisable one-liner", () => {
    const doc = domOf(`<div id="x" class="a b c d" role="dialog" data-open></div>`);
    expect(describeElement(doc.getElementById("x")!)).toBe(
      'div#x.a.b.c[role="dialog"][data-open]',
    );
  });
});
