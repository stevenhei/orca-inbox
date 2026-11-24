# Orca Decision Inbox V1

Decision Inbox organizes authorized Orca Bot Items and plugin-owned decisions from ordinary workspace Chats. Read native Items in the merged queue and answer them in Orca. Save plugin-owned answers in the Inbox. Mail delivery requires a legitimate Orca plugin sender.

## Try a decision

Open **Decision Inbox dashboard** from the editor’s **+** menu and choose **Practice**. Eight fictional questions are available on each installation. Open **活動海報要用哪一款版面？** to compare two designs, attach a note to the image or a passage, then choose an option or type a reply. Open **請寫一句海報標題** to try a free-text answer. After saving, find the answer under **Answered**. Practice drafts, notes and answers are stored by this installation and survive reopening. Practice works without access to Chat, Bot Items or mail.

| Decision source | What you can do | Where the result goes |
| --- | --- | --- |
| Practice | Write an answer, select options, annotate text and images, and revisit answers | Practice storage on this installation |
| Workspace Chat | Review a verified submission, annotate it and save an answer | Decision Inbox storage. On hosts without a plugin mail sender, the original Chat receives no notification. |
| Native Bot Item | Read the question, recommendation and options | Answer in Orca’s Bot Items view. The Inbox shows the bot name and item number. |

The live queue reports source coverage independently. A local submission can still be waiting for its originating Chat to be verified. A readable Bot Item whose workspace is unknown appears under **All workspaces**. If a source read fails, inspect the source details for what could not be loaded. Paired Bot Item reads use the local host’s saved pairing. Intake from ordinary Chats on a paired host and plugin-originated mail delivery still require host support.

## Use on an Orca desktop

For a GitHub installation, run `orca plugin update stevenhei.decision-inbox` on the Orca host that runs the plugin. For a first install, run `orca plugin install stevenhei/orca-inbox@main` and follow Orca’s approval prompt. Open the dashboard from the editor’s **+** menu or open the sidebar with `orca plugin open stevenhei.decision-inbox --panel inbox`. Review and settings tabs use reference files under `.orca-decision-inbox/` in the current local workspace. The references contain only a question ID or the settings selector. The worker uses the host-installed Orca CLI where available. For a local workspace Chat, follow the [agent skill](agent/decision-inbox/SKILL.md) and run:

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
