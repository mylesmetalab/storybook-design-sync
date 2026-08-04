import { describe, expect, it } from "vitest";
import { resolveTokenPresence, type CustomPropertyIndex } from "./token-presence.js";

/**
 * Issues #66/#67 — is the CSS custom property a Figma variable name converts to
 * something this project actually declares?
 *
 * The consumer these numbers come from: 93 custom properties, colours under
 * `--color-*`, and `--text-*` occupied by Tailwind v4's font-size scale. A prompt
 * suggested `var(--text-positive-secondary)` for a colour. Two failures in one
 * sentence: wrong namespace (it would have registered as a font size) and absent
 * entirely (no positive/success family existed).
 */

const THEME: CustomPropertyIndex = {
  "color-primary": ["src/index.css"],
  "color-card-foreground": ["src/index.css"],
  "color-positive-secondary": ["src/index.css"],
  "text-base": ["src/index.css"],
  "text-2xl": ["src/index.css"],
  "text-2xl--line-height": ["src/index.css"],
  "radius-lg": ["src/tokens.css"],
  "radius-md": ["src/tokens.css"],
};

describe("resolveTokenPresence", () => {
  it("finds a token the project declares under the converted name", () => {
    const p = resolveTokenPresence("Radius/Lg", THEME);
    expect(p).toEqual({
      kind: "declared",
      cssVar: "--radius-lg",
      files: ["src/tokens.css"],
      source: "convention",
    });
  });

  it("finds it under the project's OWN namespace when Figma's path differs", () => {
    // `Text/Positive/Secondary` → `--text-positive-secondary` (absent), but this
    // project declares `--color-positive-secondary`. That is a lookup, not a guess:
    // the candidate is only accepted because the index really has it.
    const p = resolveTokenPresence("Text/Positive/Secondary", THEME);
    expect(p).toEqual({
      kind: "declared",
      cssVar: "--color-positive-secondary",
      files: ["src/index.css"], source: "convention",
    });
  });

  it("finds a name the project prefixes with its own namespace", () => {
    const index: CustomPropertyIndex = {
      "color-text-positive-secondary": ["src/index.css"],
      "color-primary": ["src/index.css"],
    };
    const p = resolveTokenPresence("Text/Positive/Secondary", index);
    expect(p).toMatchObject({ kind: "declared", cssVar: "--color-text-positive-secondary" });
  });

  it("reports absence with the evidence, and where a new token would go", () => {
    const p = resolveTokenPresence("Effect/Glow/Soft", THEME);
    expect(p.kind).toBe("absent");
    if (p.kind !== "absent") return;
    expect(p.converted).toBe("--effect-glow-soft");
    expect(p.declaredCount).toBe(8);
    // Ranked by how many properties each file declares — src/index.css has six.
    expect(p.themeFiles[0]).toBe("src/index.css");
  });

  it("names what is already in the namespace the converted name would join", () => {
    const p = resolveTokenPresence("Text/Placeholder/Weak", {
      "text-base": ["src/index.css"],
      "text-2xl": ["src/index.css"],
      "text-sm": ["src/index.css"],
    });
    expect(p.kind).toBe("absent");
    if (p.kind !== "absent") return;
    expect(p.namespaceNote).toMatch(/--text-\*/);
    expect(p.namespaceNote).toMatch(/3 custom properties/);
    expect(p.namespaceNote).toContain("--text-base");
  });

  /**
   * The distinction the whole module rests on. "We found no custom properties" is
   * not evidence that a specific one is missing — a project whose CSS the scanner
   * could not reach would otherwise get a token-layer prompt on every single row.
   */
  it("answers `unknown`, never `absent`, with no index to check against", () => {
    expect(resolveTokenPresence("Radius/Lg", undefined).kind).toBe("unknown");
    expect(resolveTokenPresence("Radius/Lg", {}).kind).toBe("unknown");
  });

  it("answers `unknown` for a row with no Figma token name", () => {
    expect(resolveTokenPresence(undefined, THEME).kind).toBe("unknown");
    expect(resolveTokenPresence("  ", THEME).kind).toBe("unknown");
  });

  it("does not accept a namespace candidate the index does not declare", () => {
    // `--color-*` exists here, but `--color-elevation-high` does not, so the answer
    // must be absence — not a plausible-looking name nobody declared.
    const p = resolveTokenPresence("Elevation/High", THEME);
    expect(p.kind).toBe("absent");
  });
});

/**
 * #93 — Figma's own `codeSyntax`, checked before any conversion.
 *
 * The rule the issue specified had to change: it said a `codeSyntax` naming a
 * property the project does not declare is "a finding". On the reference file
 * that is **356 of 361 variables**, because SDS ships its own `--sds-*` CSS while
 * the consumer maps it onto shadcn's names. See `code-syntax.ts`.
 */
describe("resolveTokenPresence + codeSyntax", () => {
  it("is authoritative when Figma names a property the project declares", () => {
    const p = resolveTokenPresence("Radius/200", THEME, "var(--radius-lg)");
    expect(p).toEqual({
      kind: "declared",
      cssVar: "--radius-lg",
      files: ["src/tokens.css"],
      source: "code-syntax",
    });
  });

  it("beats the conversion, so a name Figma states is never re-derived", () => {
    // Conversion would give `--radius-200`, which is absent. Figma's name wins
    // and the row resolves instead of reporting a missing token.
    const p = resolveTokenPresence("Radius/200", THEME, "var(--radius-lg)");
    expect(p.kind).toBe("declared");
  });

  it("does NOT treat a codeSyntax the project lacks as a finding", () => {
    // The normal case on a design-system file. It falls through to the ordinary
    // conversion path — `absent` here is about the CONVERTED name, exactly as
    // before #93.
    const p = resolveTokenPresence("Radius/200", THEME, "var(--sds-size-radius-200)");
    expect(p.kind).toBe("absent");
    if (p.kind !== "absent") throw new Error("unreachable");
    expect(p.converted).toBe("--radius-200");
    // …but Figma's own name is carried, so a message need not guess at that half.
    expect(p.figmaCodeSyntax).toBe("--sds-size-radius-200");
  });

  it("carries no figmaCodeSyntax when Figma declared none", () => {
    const p = resolveTokenPresence("Radius/200", THEME);
    expect(p.kind).toBe("absent");
    if (p.kind !== "absent") throw new Error("unreachable");
    expect(p.figmaCodeSyntax).toBeUndefined();
  });

  it("ignores an unparseable codeSyntax rather than half-using it", () => {
    const p = resolveTokenPresence("Radius/Lg", THEME, "rounded-lg");
    expect(p.kind).toBe("declared");
    if (p.kind !== "declared") throw new Error("unreachable");
    // Fell back to the conversion, and says so.
    expect(p.source).toBe("convention");
  });

  it("still returns unknown when nothing was scanned, even with a codeSyntax", () => {
    // A scan that read no files is not evidence that a name matches.
    expect(resolveTokenPresence("Radius/200", {}, "var(--radius-lg)")).toEqual({ kind: "unknown" });
  });
});
