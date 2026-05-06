# Adding an engine

An engine produces a `DriftReport` for a single story. Anything that can
implement that contract is an engine: a REST client (v0 `figma-rest`), a
local daemon (planned `syncything`), a SQLite-indexed tool (planned
`baluarte`), a fixture for testing.

## The contract

```ts
import type { Engine, EngineFactory } from "@metalab/storybook-design-sync";

class MyEngine implements Engine {
  readonly name = "my-engine";

  async checkDrift(input) {
    // input.storyId, input.nodeRef.{fileKey,nodeId}, input.snapshot
    return {
      storyId: input.storyId,
      nodeId: input.nodeRef.nodeId,
      generatedAt: new Date().toISOString(),
      dimensions: [
        // token-value, token-binding, variant-set: real diffs
        // copy, props, structure, motion: fill in or leave flag-only
      ],
    };
  }
}

export const createMyEngine: EngineFactory = (ctx) => new MyEngine();
```

## Registering

For now, register inside `src/engines/index.ts`:

```ts
const REGISTRY: Record<string, EngineFactory> = {
  "figma-rest": createFigmaRestEngine,
  "my-engine": createMyEngine,
};
```

A future version will expose a public registration API so consumers can
plug engines in without forking. Out of scope for v0.

## What you get

- `input.snapshot` — a `CodeSnapshot` from the preview side, including
  computed CSS, `data-token-*` bindings, and variant classes.
- `ctx.figmaPat` — the `FIGMA_PAT` env var if set. Only relevant if your
  engine talks to Figma; otherwise ignore.

## What you must do

- Always return all seven dimension kinds the engine cares about. Use
  `status: "flag-only"` for kinds you don't diff yet — keeps the table
  shape stable.
- Preserve mode-aware values (`modes: { light, dark }`) on color tokens
  end-to-end. Don't collapse to a single value.
- Never log the PAT. Never persist it. Never echo it in error messages.
- Never write to Figma in v0. The whole pipeline is read-only.

## What you must not do

- Don't import preview/manager code from inside the engine. Engines run
  in the Node-side server context.
- Don't shell out to processes the consumer didn't sign up for.
- Don't mutate `.design-sync/registry.json` in v0.

## Testing an engine

Mock at the `Engine` interface — feed in a `CheckDriftInput`, assert on the
returned `DriftReport`. No need to spin up Storybook for unit tests.
