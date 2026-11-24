# Orca Decision Inbox V1

Decision Inbox organizes authorized Orca Bot Items and plugin-owned decisions from ordinary workspace Chats. Read native Items in the merged queue and answer them in Orca. Save plugin-owned answers in the Inbox. Mail delivery requires a legitimate Orca plugin sender.

## Use on an Orca desktop

Load the folder as an approved trusted plugin using `orca plugin install .` and Orca's approval flow. Open its panel with `orca plugin open decision-inbox --panel inbox`. Review and settings tabs use reference files under `.orca-decision-inbox/` in the current local workspace. The references contain only a question ID or the settings selector. The worker uses the host-installed Orca CLI where available. For a local workspace Chat, follow the [agent skill](agent/decision-inbox/SKILL.md) and run:

```sh
node /path/to/orca-inbox/agent/decision-inbox/inbox.mjs submit INPUT.json
```

Put the emitted line in the Chat's visible assistant response, then open or refresh the desktop Inbox. On this release path only the local plugin can save the answer. On the inspected host the Inbox reports mail unavailable and saves the reply as undelivered. An Orca mail acceptance, when implemented on a supported surface, will leave the reply awaiting explicit acknowledgement.

## File map

| Path | Contents |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Session ownership, role authority, and language |
| [Approved V1 scope](docs/v1-spec.md) | Product behavior and release gate |
| [Implementation handoff](docs/implementation-handoff.md) | Phase 1 operation, Phase 2 context, and acceptance matrix |
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

The host-supplied Orca CLI 1.4.271 can read authorized Bot Items and ordinary Chat records. The PATH CLI 1.4.264 lacks Bot Item commands. The inspected headless runtime did not expose the plugin service or an approved plugin mail sender. The disposable ordinary-Chat transport control used a genuine Chat sender. Desktop and paired acceptance are pending. See the [handoff](docs/implementation-handoff.md) and [Phase 2 audit](docs/native-integration-audit.md).
