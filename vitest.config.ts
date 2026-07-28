import { defineConfig } from "vitest/config";

/**
 * Test discovery. Vitest's defaults are fine except for one local hazard:
 * agent worktrees under `.claude/worktrees/**` contain full copies of this
 * package, including its `*.test.ts` files. Those copies get collected by the
 * default glob, so `npm test` silently reports a different test count depending
 * on which worktrees happen to exist, and a stale copy can fail the suite for
 * code that isn't in the repo. `.claude/` is gitignored, so this never affected
 * CI — only the numbers a human reads locally.
 */
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ".claude/**",
    ],
  },
});
