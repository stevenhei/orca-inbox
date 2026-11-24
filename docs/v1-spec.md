# Orca Decision Inbox V1

The Inbox contains actionable owner decisions and reviews from supported Claude and Codex Orca Chat sessions. The desktop right sidebar opens in **This workspace**. The owner can explicitly select **All workspaces**, and that choice survives workspace focus changes. An open decision and its draft stay bound to the original question ID. The proposed file-backed wide review opens a decision from another repo without switching the active workspace. That behavior requires desktop proof. Left navigation is a possible later Orca core extension.

Rows show question, project, workspace, priority P0–P3, optional deadline, and blocked work. Sort P0 first, then overdue or due today, then the remaining rows. Within each group sort by priority, then oldest first. Search within the selected scope by Chinese or English keyword and by identifier. Index title, background, recommendation, options, and reply. Include history only when toggled on. A package may share context and evidence across independently answerable questions. Each question maintains its own answer, delivery state, and receipts.

## Review and project record

Wide review shows background, recommendation, options, and source links. Owners can enlarge multiple images, compare them side by side, annotate individual images and selected text, and submit an option or free-text answer with comments in one operation. Relay annotations with stable evidence IDs and versions. Text anchors carry the quote and versioned source range. Private screenshots are immutable snapshots subject to attachment access. External evidence stays linked. Scheduled cleanup is deferred.

Each decision has a stable link and source issue or spec link where available. The source agent records the summary and Inbox link in the existing project record when repo rules require it. One-off answers apply to one decision. Only the owner can explicitly promote an answer to a standing rule.

## Agent workflow and authority

V1 calls for a versioned English skill and an agent submission entry point installed once per host for supported Claude and Codex Orca Chat. Installation and the production endpoint follow the spike. Inbox Settings allow editing defaults and optional per-repo exceptions with a preview. The agent reads applicable policy, repo AGENTS.md, and the selected role file. The orchestrator picks the role, which defines everyday decision and execution authority. The brief supplies the objective.

Agents research and check previous decisions first, decide routine reversible details within scope, submit material owner choices or decisions requiring owner authority with rationale and impact, and continue unaffected work. The plugin validates request shape, trusted session and workspace scope, and duplicate requests. Orca and underlying tools and accounts retain tool authority.

## Answer and delivery

[The shared contract](../src/contract.ts) names the operations. Resolve origin from authenticated host, workspace, and Chat session. Validate allowed participants and per-attachment grants, and authorize each list, detail, and reply operation. Caller-provided workspace scope is a filter within authorized data. Package, question, request, and reply IDs are stable. Repeating the same request returns the recorded result. Reusing an ID with changed content or a different binding is a conflict.

Inbox and native Bot Item **Needs you** share one authoritative owner-authenticated answer operation. The first accepted initial answer wins. Concurrent submissions and retries return that recorded answer. Follow-ups append and preserve the initial answer. Each accepted reply routes only to the original Orca Chat session. Retry uses the original reply ID and destination.

A question starts **Awaiting answer**. An accepted reply is **Submitted / awaiting confirmation** until an actual receipt matches the reply, question, and authenticated origin. That match yields **Agent received**. Delivery failure yields **Undelivered**, with the reply and reason retained. A mail storage receipt alone leaves delivery unconfirmed. Terminal input is excluded. A receipt applies only to its own reply.

## Release gate

Prove workspace Chat can raise native Needs you, both surfaces use the same owner-authenticated answer operation, both display the first accepted answer, and receipt in the original Chat is verifiable. Acceptance requires two local project workspaces and one paired Orca server source. Verify cross-repo context, concurrency and retries, restart and disconnect, closed or wrong origin, agent policy, and reviewer discovery from a source issue. Hold V1 release until this proof is recorded. See the [spike and acceptance matrix](implementation-handoff.md).
