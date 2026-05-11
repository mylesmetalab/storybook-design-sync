import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const EXTERNAL = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "storybook",
  "storybook/manager-api",
  "storybook/preview-api",
  "storybook/internal/*",
  "@storybook/*",
  "node:*",
];

// Bare node built-ins (no `node:` prefix). CJS deps like postcss
// `require("path")` without the prefix, so we list them explicitly for
// the Node-platform bundles. Browser bundles (manager, preview) don't
// pull these in, so listing them globally is harmless.
const NODE_BUILTINS = ["path", "fs", "fs/promises", "url", "events", "util", "stream", "os"];

const NODE_REQUIRE_BANNER =
  "import { createRequire as __designSyncCreateRequire } from 'node:module';" +
  "const require = __designSyncCreateRequire(import.meta.url);";

const shared = {
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: [...EXTERNAL, ...NODE_BUILTINS],
  sourcemap: true,
  logLevel: "info",
};

await Promise.all([
  // Manager runs in the browser (the Storybook UI). Use classic JSX so the
  // bundle calls React.createElement on the host React; this avoids
  // React 19's jsx-runtime requiring shared internals state.
  build({
    ...shared,
    entryPoints: ["src/manager.tsx"],
    outfile: "dist/manager.js",
    platform: "browser",
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    inject: ["./build-react-shim.js"],
  }),
  // Preview runs in the story iframe (also browser)
  build({
    ...shared,
    entryPoints: ["src/preview.ts"],
    outfile: "dist/preview.js",
    platform: "browser",
  }),
  // Server runs in Node (Storybook's dev server process). The banner gives
  // the ESM bundle a real `require` so CJS deps (postcss, etc.) that call
  // `require("path")` work — without it, esbuild emits a throwing stub.
  build({
    ...shared,
    entryPoints: ["src/server.ts"],
    outfile: "dist/server.js",
    platform: "node",
    banner: { js: NODE_REQUIRE_BANNER },
  }),
  // Preset is loaded by Storybook in Node
  build({
    ...shared,
    entryPoints: ["src/preset.ts"],
    outfile: "dist/preset.js",
    platform: "node",
    banner: { js: NODE_REQUIRE_BANNER },
  }),
  // Public types entry
  build({
    ...shared,
    entryPoints: ["src/index.ts"],
    outfile: "dist/index.js",
  }),
]);

// Emit .d.ts via tsc.
// `shell: true` is load-bearing for Windows — without it spawnSync can't
// resolve `npx` (it would only find `npx.cmd`). CI runs on windows-latest.
const { spawnSync } = await import("node:child_process");
const r = spawnSync("npx", ["tsc", "-p", "tsconfig.json", "--emitDeclarationOnly"], {
  stdio: "inherit",
  shell: true,
});
if (r.status !== 0) process.exit(r.status ?? 1);
