# Implementation handoff

## Ownership and work order

1. The owner selects the development orchestrator later. The active Claude Sonnet session handles FE design with the Execution Engine skills [modern-web-guidance](../../execution_engine/.agents/skills/modern-web-guidance/SKILL.md) and [frontend-patterns](../../execution_engine/.agents/skills/frontend-patterns/SKILL.md). Leave in-flight UX choices with that session.
2. Use a GPT/Codex session for the minimal BE integration spike below. Record supported behavior and any upstream dependency before committing to the native integration plan.
3. Once the owner has settled design, a Claude Opus session implements FE against the [shared contract](../src/contract.ts) and [fixtures](../fixtures/decisions.ts). GPT/Codex implements BE against the same files. Keep product decisions with the owner.
4. Use a separate Claude Opus session for independent FE verification and a GPT/Codex session for BE verification. The owner-selected orchestrator writes owner-facing integration reports in Traditional Chinese. Specs, briefs, handoffs, design discussions with the owner, tests, and PRs are English. Repo AGENTS.md and role files define authority. The orchestrator selects the role and the brief defines the objective.

## Smallest native spike

Start with one disposable workspace Chat decision, one Inbox entry, one native Bot Item Needs you entry, and one owner answer. On an authorized desktop runtime, inspect `orca agent-context --json` and the version-matched host API guide first. Check for a supported CLI submit path callable from Claude and Codex Orca Chat that carries verified Chat origin. Local CLI discovery in 1.4.264 has generic orchestration gates but surfaced no dedicated Needs you submission command. Whether a supported agent path can meet this contract is unverified.

Exercise one owner answer from Inbox, repeat on a fresh decision from Needs you, and compare the accepted reply ID on both surfaces. For each run capture the authenticating owner context, both displayed states, and the receipt tied to the original Chat and reply ID. Repeat with simultaneous answers before expanding to the full matrix. Verify the file-backed `.orca-decision` editor can open against cross-repo content without moving workspace focus. Test with the pinned decision and draft already open.

If the public seam is missing, request the specific missing Orca primitive with the minimal reproduction. Candidate requests are a supported workspace Chat creation path for Needs you with trusted origin, a way to share the owner-answer transaction across native and Inbox views, or a verifiable per-reply receipt in the original Chat. Raise only the missing pieces identified by the spike. If only CLI ergonomics remain, a thin `orca-inbox` CLI can use CLI-Anything as a reference and expose JSON and errors from the same backend contract. [CLI-Anything upstream](https://github.com/HKUDS/CLI-Anything).

## Assumptions requiring evidence

| Integration | Evidence needed |
| --- | --- |
| Agent submission and identity | Supported Chat entry point, authenticated host/workspace/session identity, and verified participant and attachment grants. Once-per-host skill installation and production submission endpoint are pending. |
| Native decision synchronization | One owner-authenticated answer operation shared by both surfaces, atomic first acceptance, visible updates in both surfaces. |
| Durable answer and receipt | Restart-safe reply and retry identities, paired-host routing, and verified matching Chat receipt. Closed origin and permission changes must fail closed. |
| Wide review and scoped listing | Desktop cross-repo editor behavior, workspace scope changes, stable links, draft binding, and paired-workspace visibility. |
| Policy and source record | Defaults and overrides read by both supported agents, preview matches effective policy, and a reviewer can trace an answer through the original source record. |

All integrations in this table are unverified. The coordinator runtime reports that the plugin service is unavailable. Its offline checks validate scaffold structure and render the panel with the local test harness. They leave desktop behavior and all native integrations open.

## Acceptance matrix

The [fixtures](../fixtures/decisions.ts) use UTC and a fixed clock of 2030-06-14 at noon. The review has seven distinguishable metadata-only image placeholders, with width, height, orientation cues, and alt text. Supply synthetic image assets during visual verification. The fixture URLs and identities are synthetic. `historyExample` replaces the awaiting `layout` row in history scenarios.

| Case | Expected outcome |
| --- | --- |
| Short schedule and scope | At local studio, This workspace shows `image-review` then `schedule`. Pick Tuesday on `schedule`. Switching focus preserves the decision and draft. All workspaces remains selected across focus changes. |
| Staged approval and sort | Across scopes, P0 `room-route` then `room-reset` (oldest first) precede due-today `stage` then overdue `layout` by priority. `image-review` and `schedule` follow. Answer phase one only on the paired Chat. The local studio with the same workspace ID receives nothing. |
| Three options and search | Search `layout` by identifier, `contrast` by background, `Fold-out` by option, and `錄音` by recommendation. With the history fixture substituted, `matte sample` finds `layout` only with history enabled and scope containing local library. The long conditional answer remains intact, including the fallback to list. |
| Shared package and cross-repo review | From Paper Studio open `room-route` in Seed Catalogue without switching workspace. Approve the route. `room-reset` keeps independent status and receipt with the same package evidence `floor-plan`, version 2. |
| Seven-image comparison | Compare panorama and portrait side by side and enlarge each. Submit `reviewReply` with the free text, image comment on `model-6` version 1 and selected text “Paper models” at revision 1, offsets [0, 12) in UTF-16 code units. Deny attachment access to unauthorized participants. |
| Two owner surfaces and duplicates | Race differing initial answers and retry with the original reply ID. Both surfaces show the first accepted reply and only that reply routes. A follow-up appends and has its own receipt. Repeated decision submission reuses question identities. Conflicting request-ID reuse fails. |
| Receipt, disconnect, restart | Mail persistence leaves status submitted. Only an authenticated matching receipt advances it. A closed, disconnected, or wrong origin retains the reply and failure reason. Restart preserves accepted answers. Retry keeps reply ID and original destination, with no duplicate agent receipt. |
| Working agent and reviewer | Verify both agents read effective policy and selected role, review prior decisions, decide routine reversible choices, and continue unaffected work after submission. From the synthetic source record a reviewer finds the Inbox link and recorded result. A one-off answer stays scoped to its decision. |

## References

- Use the installed `orca skills get orca-plugin-authoring --full` guide as the version-matched reference. Follow the components panel and worker split and the isolated file editor registration. [Hello Worker Panel](https://github.com/stablyai/orca/tree/main/examples/plugins/hello-worker-panel), [Components Gallery](https://github.com/stablyai/orca/tree/main/examples/plugins/components-gallery), [Excalidraw](https://github.com/stablyai/orca-plugins/tree/main/plugins/excalidraw).
- Lean Agent OS Inbox informs scoped queue and reader composition, stable drafts, structured review content, and explicit delivery receipts. Its GitHub and T3 transport stay outside this design. [Local Inbox UX and integration notes](../../lean-agent-os/apps/control-center/src/inbox/INTEGRATION.md).
