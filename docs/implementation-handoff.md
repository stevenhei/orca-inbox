# Implementation handoff

## Ownership and work order

1. The owner selects the development orchestrator later. The active Claude Sonnet session handles FE design with the Execution Engine skills [modern-web-guidance](../../execution_engine/.agents/skills/modern-web-guidance/SKILL.md) and [frontend-patterns](../../execution_engine/.agents/skills/frontend-patterns/SKILL.md). Leave in-flight UX choices with that session.
2. Use a GPT/Codex session for the minimal BE integration spike below. Record supported behavior and any upstream dependency before committing to the native integration plan.
3. Once the owner has settled design, a Claude Opus session implements FE against the [shared contract](../src/contract.ts) and [fixtures](../fixtures/decisions.ts). GPT/Codex implements BE against the same files. Keep product decisions with the owner.
4. Use a separate Claude Opus session for independent FE verification and a GPT/Codex session for BE verification. The owner-selected orchestrator writes owner-facing integration reports in Traditional Chinese. Specs, briefs, handoffs, design discussions with the owner, tests, and PRs are English. Repo AGENTS.md and role files define authority. The orchestrator selects the role and the brief defines the objective.

## Phase 1 production path

- The approved desktop worker uses host-supplied panel/editor context and the local workspace inventory. The principal is Inbox-local. It cannot create a native owner comment. The supported local CLI lists the authorized Bot roster and reads each local bot's Items. The queue reports partial coverage for first-page limits or omitted paired bots. Unattributed Items appear only under All workspaces.
- Run `node agent/decision-inbox/inbox.mjs submit INPUT.json` from the originating local workspace Chat and place the emitted line in its visible assistant response. The next first-page load or refresh verifies only the hinted session and request. The hint stores IDs only. The worker verifies exact runtime session and workspace identity. It accepts a marker only in the final assistant message of the latest completed exchange when the preceding user boundary is visible in the returned suffix. The CLI exposes up to 20 recent entries for this check and supplies no turn ID. A suffix cut through the exchange is insufficient. Conflicting matching lines in that assistant message are refused. Earlier turns are ignored and the durable request ID handles replay. The CLI uses no reply destination supplied by the agent.
- Save the answer with `submitReply` through the Inbox panel. When no legitimate plugin mail sender is exposed, the Inbox reports saved locally and undelivered. It exposes no retry action until mail is available. The review and settings actions open a minimal reference file in the focused, authorized local workspace through `editor.open`. The worker stores only the question ID or settings reference under `.orca-decision-inbox/`. A local workspace Chat can explicitly stage bounded image files with the submission CLI’s `--image` option. Automatic access to a Chat’s private attachments remains unavailable.
- A mail acceptance record requires a transport message ID. An acknowledgement needs a matching assistant record in the same exact Chat. The `ack` hint is checked against persisted transport acceptance and the exact question/reply IDs.

On the inspected installation, the PATH CLI is 1.4.264 and lacks Bot Item commands. The host-supplied `~/.orca/cli/bin/orca` is 1.4.271 and supports `bot item list/show`. Its headless runtime reports that the plugin service is unavailable. From an identity-free process, documented orchestration send failed with `no_active_sender_terminal`. Both send and reply resolve a sender. From a genuine Chat, the same mail channel reached a disposable ordinary Codex Chat and that Chat wrote an explicit acknowledgement. That control exercised Orca mail, separate from Inbox delivery.

[Issue #43424](https://github.com/stablyai/orca/issues/43424) describes a CLI call with an explicitly supplied sender, and [PR #43425](https://github.com/stablyai/orca/pull/43425) proposes rendering a plugin label for a supplied address. The open PR describes display attribution. A registered plugin origin or approved worker host mail method has not been established. The next desktop observation is an approved installed plugin worker sending with a **documented, host-issued plugin identity**, followed by a matching transport ID and original-Chat acknowledgement. A cosmetic sender label alone cannot establish authority. An explicit agent CLI read of one answer would require a separate product decision and a documented exact-Chat access seam. This phase does not add a pull protocol.

## Remaining workspace rollout work

| Priority | Capability | Acceptance |
| --- | --- | --- |
| 1 | Reply delivery from the installed plugin | A saved answer reaches the exact originating Chat under a supported plugin identity. Record mail acceptance and the receiving agent’s acknowledgement separately. |
| 2 | Reliable agent intake across repositories and paired hosts | An ordinary Chat can submit a durable, authorized decision from each participating workspace. Verify that a later conversation turn or delayed dashboard refresh does not lose a pending decision. The current local CLI path requires a recent marker and a same-host hint. |
| 3 | Installed desktop and paired-host acceptance | From two real repositories and one paired host, verify source attribution, offline recovery, answer and note persistence across restart, and delivery to the correct session. |
| Phase 2 | Answer native Bot Items inside the Inbox | Use an Orca-supported owner-mediated write path. Until then, native Items are answered in Bot Items. |

## Narrow desktop verification

1. On a desktop with the version-matched bundled CLI, run `orca plugin install . --json` and follow Orca's capability approval. Open the installed plugin with `orca plugin open decision-inbox --panel inbox`. Verify the local roster with `orca bot list --json`, then `orca bot item list --bot BOT_ID --all --limit 50 --json` and `orca bot item show ITEM_UID --json`. Use disposable Items or read-only observations. Check that unattributed Items display only in All workspaces.
2. In a disposable ordinary Codex or Claude workspace Chat, run the skill command with synthetic data and emit its marker. Open or refresh Inbox and check that the row matches that Chat. Open its review while another authorized local workspace is focused. Confirm the editor opens in the currently focused workspace, the reference only contains its question ID, and the draft stays bound through a focus change.
3. Save an answer and restart the worker. Verify the recorded answer persists, a new initial attempt returns the recorded winner, and unavailable mail is shown as undelivered. Run settings and review actions from the actual installed panel/editor bridge.
4. Run the [standalone desktop push probe](../diagnostics/desktop-push-probe/README.md) against one disposable tool-free Chat. Retain the actual installed worker’s CLI report and the separate observer transcript check. A probe observation provides capability evidence. Production receipt and paired verification remain separate.

## Phase 2 native parity

The [native integration audit](native-integration-audit.md) preserves the earlier shared-native-transaction spike and paired/desktop assumptions. Native owner writeback, parity, and native-origin creation from ordinary Chat are Phase 2. The shared behavioral fixtures below remain useful for backend and desktop acceptance.

## Acceptance matrix

The [fixtures](../fixtures/decisions.ts) use UTC and a fixed clock of 2030-06-14 at noon. The review has seven distinguishable metadata-only image placeholders, with width, height, orientation cues, and alt text. Supply synthetic image assets during visual verification. The fixture URLs and identities are synthetic. `historyExample` replaces the awaiting `layout` row in history scenarios.

| Case | Expected outcome |
| --- | --- |
| Short schedule and scope | At local studio, This workspace shows `image-review` then `schedule`. Pick Tuesday on `schedule`. Switching focus preserves the decision and draft. All workspaces remains selected across focus changes. |
| Staged approval and sort | Across scopes, P0 `room-route` then `room-reset` (oldest first) precede due-today `stage` then overdue `layout` by priority. `image-review` and `schedule` follow. Answer phase one only on the paired Chat. The local studio with the same workspace ID receives nothing. |
| Three options and search | Search `layout` by identifier, `contrast` by background, `Fold-out` by option, and `錄音` by recommendation. With the history fixture substituted, `matte sample` finds `layout` only with history enabled and scope containing local library. The long conditional answer remains intact, including the fallback to list. |
| Shared package and cross-repo review | From Paper Studio open `room-route` in Seed Catalogue without switching workspace. Approve the route. `room-reset` keeps independent status and receipt with the same package evidence `floor-plan`, version 2. |
| Multiple images | Open the panorama and portrait separately in the overlay, scroll to zoom and return to the same place in the sheet. Submit `reviewReply` with the free text, image comment on `model-6` version 1 and selected text “Paper models” at revision 1, offsets [0, 12) in UTF-16 code units. Deny attachment access to unauthorized participants. |
| Two owner surfaces and duplicates | Race differing initial answers and retry with the original reply ID. Inbox shows the first accepted plugin reply and only that reply routes. Native cross-surface parity is Phase 2. A follow-up appends and has its own receipt. Repeated decision submission reuses question identities. Conflicting request-ID reuse fails. |
| Receipt, disconnect, restart | Mail persistence leaves status submitted. Only an authenticated matching receipt advances it. A closed, disconnected, or wrong origin retains the reply and failure reason. Restart preserves accepted answers. Retry keeps reply ID and original destination, with no duplicate agent receipt. |
| Working agent and reviewer | Verify both agents read effective policy and selected role, review prior decisions, decide routine reversible choices, and continue unaffected work after submission. From the synthetic source record a reviewer finds the Inbox link and recorded result. A one-off answer stays scoped to its decision. |

## References

- Use the installed `orca skills get orca-plugin-authoring --full` guide as the version-matched reference. Follow the components panel and worker split and the isolated file editor registration. [Hello Worker Panel](https://github.com/stablyai/orca/tree/main/examples/plugins/hello-worker-panel), [Components Gallery](https://github.com/stablyai/orca/tree/main/examples/plugins/components-gallery), [Excalidraw](https://github.com/stablyai/orca-plugins/tree/main/plugins/excalidraw).
- Lean Agent OS Inbox informs scoped queue and reader composition, stable drafts, structured review content, and explicit delivery receipts. Its GitHub and T3 transport stay outside this design. [Local Inbox UX and integration notes](../../lean-agent-os/apps/control-center/src/inbox/INTEGRATION.md).
