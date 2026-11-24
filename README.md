# Orca Decision Inbox V1

Local implementation scaffold for owner decisions and reviews in desktop Orca. The sidebar, worker, and file-backed review entries are placeholders. The shared contract and synthetic fixtures support parallel FE and BE work after the native spike and owner design decisions.

## File map

| Path | Contents |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Session ownership, role authority, and language |
| [Approved V1 scope](docs/v1-spec.md) | Product behavior and release gate |
| [Implementation handoff](docs/implementation-handoff.md) | Work order, upstream references, native spike, and acceptance matrix |
| [orca-plugin.json](orca-plugin.json) | Sidebar, worker, and isolated custom editor contributions |
| [Sidebar](src/panel.tsx), [worker](src/worker.ts), [review](src/review.ts) | Minimal Orca entry points |
| [Shared contract](src/contract.ts) | Domain, operation shapes, origin, and delivery states |
| [Fixtures](fixtures/decisions.ts), [sample review file](fixtures/scaffold.orca-decision) | Synthetic cases and a custom editor sample |
| [Scaffold checks](src/scaffold.test.ts), [TS config](tsconfig.json) | Local panel and fixture tests and strict TypeScript config |
| [FE design handoff](docs/design-handoff.md) | Interaction decisions, state representations, acceptance coverage, open assumptions |
| [View-model](src/model.ts), [DOM tests](scripts/dom-smoke.mjs) | Shared sort, search and scope logic; editor tests (`npm run test:dom`) |

## Local validation

Run from this folder with Orca CLI and Node available. Orca loads the TypeScript entries directly. The TypeScript command uses a pinned compiler via npm's cache.

```sh
orca skills get orca-plugin-authoring
orca plugin types .
npm exec --yes --package typescript@5.9.3 -- tsc -p tsconfig.json
orca plugin validate . --json
orca plugin test . --json
orca plugin check . --json
```

## Current evidence

Orca CLI 1.4.264 generated the local typings. TypeScript 5.9.3 type checking and manifest validation passed. The Orca Node runner passed two tests covering sidebar mount and shared fixture references. `orca plugin check` rendered the sidebar in its local harness and checked the editor entry with zero issues or warnings. The engine minimum `>=1.4.248` follows the installed isolated editor template and Components Gallery reference. Generated SDK typings live under the ignored `.orca/` directory.

`orca plugin list --json` returned `runtime_error` with “Plugin service is not available on this runtime.” Desktop loading, cross-repo review, authenticated Chat submission, native Needs you state synchronization, durable reply handling, and original Chat receipt are unverified. The [handoff](docs/implementation-handoff.md) defines the minimum native proof required before release.
