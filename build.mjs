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

const shared = {
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  external: EXTERNAL,
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
  // Server runs in Node (Storybook's dev server process)
  build({
    ...shared,
    entryPoints: ["src/server.ts"],
    outfile: "dist/server.js",
    platform: "node",
  }),
  // Preset is loaded by Storybook in Node
  build({
    ...shared,
    entryPoints: ["src/preset.ts"],
    outfile: "dist/preset.js",
    platform: "node",
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
