# Architecture

## Three sides

Storybook 10 addons run in three places. This addon uses all three.

```
┌────────────────────┐    ┌────────────────────┐    ┌────────────────────┐
│   Manager (UI)     │    │   Preview (story)  │    │   Server (Node)    │
│   src/manager.tsx  │    │   src/preview.ts   │    │   src/server.ts    │
│                    │    │                    │    │                    │
│   "Sync" panel     │    │   Reads computed   │    │   Loads config +   │
│   "Check drift"    │    │   styles from the  │    │   registry. Runs   │
│   table renderer   │    │   rendered story   │    │   the engine.      │
└─────────┬──────────┘    └─────────┬──────────┘    └─────────┬──────────┘
          │                         │                         │
          └─────── Storybook channel (events in src/channels.ts) ──────┘
```

The preset (`src/preset.ts`) registers all three sides:

- `managerEntries` → loads the panel
- `previewAnnotations` → loads the snapshot hook
- `experimental_serverChannel` → registers the Node-side handler

## Round trip

1. User clicks **Check drift** in the panel.
2. Manager emits `design-sync:checkDriftRequest { storyId }`.
3. Preview snapshots the rendered story DOM and emits
   `design-sync:codeSnapshot { storyId, snapshot }`.
4. Server loads config + registry, looks up the `nodeId`, calls the engine.
5. Engine returns a `DriftReport`. Server emits `design-sync:driftReport`.
6. Manager renders the diff table.

Errors at any stage emit `design-sync:driftError` with a message.

## Engine adapter

Engines implement a single method:

```ts
interface Engine {
  checkDrift(input: {
    storyId: string;
    nodeRef: { fileKey: string; nodeId: string };
    snapshot?: CodeSnapshot;
  }): Promise<DriftReport>;
}
```

The addon never imports a specific engine directly. `src/engines/index.ts`
holds a registry keyed by engine name (`"figma-rest"`, future
`"syncything"`, `"baluarte"`, etc.). The config selects which one runs.

## Dimensions

`DimensionDiff` models seven kinds. v0 populates three with real diffs:

| kind            | v0 status                         |
| --------------- | --------------------------------- |
| token-value     | computed CSS vs resolved Figma    |
| token-binding   | `data-token-*` attrs vs Figma var |
| variant-set     | BEM `--` classes vs Figma variants|
| copy            | `flag-only` placeholder           |
| props           | `flag-only` placeholder           |
| structure       | `flag-only` placeholder           |
| motion          | `flag-only` placeholder           |

`flag-only` rows are in the contract today so engines can fill them later
without API changes.

## Mode-aware values

Color tokens in `DimensionDiff.modes` always carry `light` and `dark`. The
engine pulls these from the variable's `valuesByMode` keyed by mode IDs
resolved through the variable collection's `modes` array. v0 only displays
them; v1 (writes) needs them.

## Staged edits

`design-sync:proposedEdit` is the contract with sibling addons (notably
`storybook-design-inspector`). v0 listens and lists. The contract is
deliberately fixed now so v1 can route them to engines without breaking
producers.

## What's reserved but unused in v0

- `Registry.stories[].lastSyncedHash` — for cheap hash-diffing in v1
- All `flag-only` dimension kinds
- The act of *acting on* `proposedEdit` events

Designed in. Not built.
