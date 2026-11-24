# Orca Decision Inbox V1

The Inbox organizes two sources. Genuine Orca Bot Items are a read-only view of authorized local Items. An ordinary Claude or Codex Orca workspace Chat can submit a separate Inbox-owned decision. The owner can save an answer to that decision through the desktop Inbox. Native Items are answered in Orca's Bot Items view. The desktop right sidebar opens in **This workspace**. The owner can explicitly select **All workspaces**, and that choice survives workspace focus changes. An open decision and its draft stay bound to the original question ID. The proposed file-backed wide review opens a decision from another repo without switching the active workspace. That behavior requires desktop proof. Left navigation is a possible later Orca core extension.

Rows show question, project, workspace, priority P0–P3, optional deadline, and blocked work. Sort P0 first, then overdue or due today, then the remaining rows. Within each group sort by priority, then oldest first. Search within the selected scope by Chinese or English keyword and by identifier. Index title, background, recommendation, options, and reply. Include history only when toggled on. A package may share context and evidence across independently answerable questions. Each question maintains its own answer, delivery state, and receipts.

## Review and project record

Wide review shows background, recommendation, options, and source links. Owners can enlarge multiple images, compare them side by side, annotate individual images and selected text, and submit an option or free-text answer with comments in one operation. Relay annotations with stable evidence IDs and versions. Text anchors carry the quote and versioned source range. Private screenshots are immutable snapshots subject to attachment access. External evidence stays linked. Scheduled cleanup is deferred.

Each decision has a stable link and source issue or spec link where available. The source agent records the summary and Inbox link in the existing project record when repo rules require it. One-off answers apply to one decision. Only the owner can explicitly promote an answer to a standing rule.

## Agent workflow and authority

The versioned [agent skill](../agent/decision-inbox/SKILL.md) documents the local intake command. The CLI writes a lookup hint and emits a structured line for the originating Chat's assistant response. The desktop worker verifies a matching marker in the final assistant response of the latest completed exchange in the explicitly named, live local Chat and checks its host and workspace against the approved desktop scope. A hint alone provides no origin authority. Inbox Settings support local defaults and workspace-project exceptions. Agents follow the repository rules and selected role and continue unaffected work.

Agents research and check previous decisions first, decide routine reversible details within scope, submit material owner choices or decisions requiring owner authority with rationale and impact, and continue unaffected work. The plugin validates request shape, trusted session and workspace scope, and duplicate requests. Orca and underlying tools and accounts retain tool authority.

## Answer and delivery

[The shared contract](../src/contract.ts) names the operations. Resolve origin from authenticated host, workspace, and Chat session. Validate allowed participants and per-attachment grants, and authorize each list, detail, and reply operation. Caller-provided workspace scope is a filter within authorized data. Package, question, request, and reply IDs are stable. Repeating the same request returns the recorded result. Reusing an ID with changed content or a different binding is a conflict.

An Inbox-owned question starts **Awaiting answer**. Its first saved initial answer wins and follow-ups append. The outbox binds each attempt to the recorded origin and reply ID. A failed delivery leaves the saved answer visible as **Undelivered**. Orca mail acceptance, where supported, leaves it **Submitted / awaiting confirmation**. Only explicit acknowledgement from the authenticated original Chat qualifies as **Agent received**.

The worker uses authorized Orca CLI Item list/show on supported hosts. An Item can carry native structured asks and options. Its description may include a single line `ORCA-DECISION-META {"priority":"P1","deadline":"2030-06-14T12:00:00Z","blockedWork":["Publish layout"]}`. All fields are optional. Unknown or invalid metadata is ignored. Plain Items remain readable with history enabled. A host-scoped Item with no verified workspace falls under **All workspaces** only. Each source reports its own availability.

## Release gate

Verify the approved desktop panel and editor boundary, exact local Chat intake, first-answer concurrency, durable outbox and same-ID retry, and explicit acknowledgement after real plugin-originated mail. Unavailable features remain explicit. The inspected headless runtime lacks a plugin service and the documented mail CLI requires a sender identity that the trusted worker does not receive. Plugin-local answers can be saved in this configuration with mail unavailable. Paired-host routing, private Chat uploads, cross-workspace editor placement, and desktop acceptance require separate evidence.

Sharing the native owner transaction, native Item creation from ordinary Chat and native parity are Phase 2. See the [implementation handoff](implementation-handoff.md) and [Phase 2 native audit](native-integration-audit.md).
