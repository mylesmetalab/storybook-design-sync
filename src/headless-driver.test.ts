import { describe, expect, it } from "vitest";
import { esmEntryFor } from "./headless-driver.js";

/**
 * `loadPlaywright`'s fallback resolution bug, found verifying the hosted-check
 * plan's `driveStorySnapshot` end to end against a real static Storybook build
 * (design-sync-starter): `createRequire(...).resolve("playwright")` followed
 * the `require`/`main` condition to an internal module with no `chromium` at
 * its top level, while `import("playwright")` resolves to the real public API.
 * Real playwright launching itself stays untested here, matching this file's
 * own reasoning for having no suite at all before this — the resolution LOGIC
 * that was actually wrong is what this covers.
 */
describe("esmEntryFor", () => {
  it("reads the import condition from Playwright's own real exports shape", () => {
    // Reduced from `node_modules/playwright/package.json` at the time this bug
    // was found — the shape that made the bug real, not a synthetic stand-in.
    expect(
      esmEntryFor({
        main: "index.js",
        exports: {
          ".": {
            types: "./index.d.ts",
            import: "./index.mjs",
            require: "./index.js",
            default: "./index.js",
          },
          "./package.json": "./package.json",
        },
      }),
    ).toBe("./index.mjs");
  });

  it("prefers `import` over `main` even when both are present", () => {
    expect(
      esmEntryFor({ main: "./cjs-entry.js", exports: { ".": { import: "./esm-entry.js" } } }),
    ).toBe("./esm-entry.js");
  });

  it("reads a nested `import: { default: ... }` condition", () => {
    expect(
      esmEntryFor({ exports: { ".": { import: { default: "./esm-entry.js" } } } }),
    ).toBe("./esm-entry.js");
  });

  it("treats a bare string exports map as the root condition itself", () => {
    expect(esmEntryFor({ exports: "./only-entry.js" })).toBe("./only-entry.js");
  });

  it("falls back to `module` when exports names no import condition", () => {
    expect(esmEntryFor({ main: "./cjs.js", module: "./esm.js", exports: { ".": {} } })).toBe(
      "./esm.js",
    );
  });

  it("falls back to `main` only when there is truly nothing ESM to read", () => {
    expect(esmEntryFor({ main: "./only.js" })).toBe("./only.js");
  });

  it("returns undefined for a package with no usable entry at all", () => {
    expect(esmEntryFor({})).toBeUndefined();
  });
});
