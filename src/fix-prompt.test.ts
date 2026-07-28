import { describe, expect, it } from "vitest";
import { buildFixPrompt, componentNameFromStoryId } from "./fix-prompt.js";

const base = {
  storyId: "atoms-iconbutton--accent",
  kind: "token-value",
  property: "border-top-left-radius",
  codeValue: "8px",
  figmaValue: "6px",
};

describe("componentNameFromStoryId", () => {
  it("takes the last title segment", () => {
    expect(componentNameFromStoryId("atoms-iconbutton--accent")).toBe("iconbutton");
    expect(componentNameFromStoryId("molecules-rowboolean--checked-true")).toBe("rowboolean");
  });

  it("falls back to the whole id without a `--` separator", () => {
    expect(componentNameFromStoryId("justonething")).toBe("justonething");
  });
});

describe("buildFixPrompt — self-contained agent prompt", () => {
  it("includes story id, component, property, and both values", () => {
    const p = buildFixPrompt(base);
    expect(p).toContain("atoms-iconbutton--accent");
    expect(p).toContain("iconbutton");
    expect(p).toContain("border-top-left-radius");
    expect(p).toContain("`8px`");
    expect(p).toContain("`6px`");
  });

  it("names token AND var(--token) form when the token is known", () => {
    const p = buildFixPrompt({ ...base, tokenName: "radius/lg" });
    expect(p).toContain("radius/lg");
    expect(p).toContain("var(--radius-lg)");
    expect(p).toMatch(/prefer wiring the token/i);
  });

  it("omits token guidance when no token name is known", () => {
    const p = buildFixPrompt(base);
    expect(p).not.toContain("var(--");
    expect(p).not.toMatch(/design token/);
  });

  it("lists configured code-target file paths when known", () => {
    const p = buildFixPrompt({
      ...base,
      filePaths: ["src/components/IconButton.css", "src/components/IconButton.tsx"],
    });
    expect(p).toContain("src/components/IconButton.css");
    expect(p).toContain("src/components/IconButton.tsx");
  });

  it("falls back to naming the selector and telling the agent to locate it", () => {
    const p = buildFixPrompt({ ...base, selector: ".icon-button--accent" });
    expect(p).toContain(".icon-button--accent");
    expect(p).toMatch(/search the codebase/i);
  });

  it("still instructs how to locate the code with neither paths nor selector", () => {
    const p = buildFixPrompt(base);
    expect(p).toMatch(/locate the styles/i);
  });

  it("carries the Figma node id and file key for reference", () => {
    const p = buildFixPrompt({ ...base, nodeId: "37:30", fileKey: "abc123" });
    expect(p).toContain("37:30");
    expect(p).toContain("abc123");
  });

  it("closes with minimal-change + typecheck/tests instructions", () => {
    const p = buildFixPrompt(base);
    expect(p).toMatch(/keep the change minimal/i);
    expect(p).toMatch(/typecheck/i);
    expect(p).toMatch(/test/i);
  });

  it("stringifies non-string (dual-mode) values instead of dropping them", () => {
    const p = buildFixPrompt({
      ...base,
      codeValue: { light: "8px", dark: "8px" },
      figmaValue: { light: "6px", dark: "4px" },
    });
    expect(p).toContain('{"light":"8px","dark":"8px"}');
    expect(p).toContain('{"light":"6px","dark":"4px"}');
  });

  it("includes the engine note when present", () => {
    const p = buildFixPrompt({ ...base, note: "variable not found in file" });
    expect(p).toContain("variable not found in file");
  });
});

/**
 * Tailwind consumers: a prompt that says "set background-color to #2c2c2c" is
 * not actionable on a shadcn/cva component — there is no declaration to edit.
 * When the scanner knows which utility class produced the binding, the prompt
 * has to name it.
 */
describe("buildFixPrompt — Tailwind class attribution", () => {
  it("names the class to change and where it may live", () => {
    const p = buildFixPrompt({ ...base, codeClassName: "bg-primary" });
    expect(p).toContain("`bg-primary`");
    expect(p).toMatch(/Tailwind utility class/i);
    expect(p).toMatch(/cva\(\)` base array or variant slot/i);
  });

  it("scopes the minimal-change instruction to that class", () => {
    const p = buildFixPrompt({ ...base, codeClassName: "rounded-md" });
    expect(p).toMatch(/change only the `rounded-md` class/i);
    expect(p).toMatch(/leave every other utility class alone/i);
  });

  it("advises a utility swap, not a CSS declaration, when a token is known", () => {
    const p = buildFixPrompt({
      ...base,
      tokenName: "size/radius/200",
      codeClassName: "rounded-md",
    });
    expect(p).toMatch(/swap `rounded-md` for the utility class/i);
    expect(p).toContain("--size-radius-200");
    // The CSS-declaration advice must NOT appear — it is uncorrectable advice
    // for this codebase.
    expect(p).not.toMatch(/set `border-top-left-radius: var\(/);
  });

  it("keeps the CSS-declaration advice when there is no class attribution", () => {
    const p = buildFixPrompt({ ...base, tokenName: "size/radius/200" });
    expect(p).toMatch(/set `border-top-left-radius: var\(--size-radius-200\)`/);
    expect(p).not.toMatch(/utility class/i);
  });
});
