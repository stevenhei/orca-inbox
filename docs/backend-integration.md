# Decision Inbox backend integration

The worker registers the panel and isolated editor requests in [backend-protocol.ts](../src/backend-protocol.ts). It persists decisions, accepted replies, unfinished delivery attempts, drafts, and policy as a versioned state in Orca plugin storage. A single worker serializes each read-modify-write transaction. It stages chunks in the inactive slot and atomically switches a small index, keeping up to two generations within Orca's quota. The combined Inbox state is limited to 2 MiB per generation. Both an eventual native owner adapter and the Inbox must use that same writer or move the acceptance transaction to a shared host-owned store.

- List and detail apply caller access before sorting, filtering, or returning decision data. Workspace scope uses host and workspace IDs. Day boundaries use the worker's local time zone, with a clock and time zone injectable for tests.
- The first accepted initial answer is committed with its delivery obligation before any transport call. A racing answer receives the recorded winner. An identical submission replay returns the recorded answer. Changed content or binding under a used ID returns `conflict`.
- A reply awaiting receipt remains `submitted` after transport custody. Confirming receipt requires verified proof tied to the recorded reply and original Chat. Interrupted sends become `undelivered` on startup and wait for an explicit retry. Retry uses the original destination and reply ID. The native adapter must deduplicate that ID at the destination.
- A submission adapter supplies trusted participants, image bytes and grants, and versioned text for evidence selections. The worker authorizes private images separately and redacts inaccessible evidence and annotations. Snapshot responses fit the panel bridge by limiting base64 to 900,000 characters per image.
- Drafts are scoped by owner and question. Keep the same attempt ID across ambiguous submit results. Refetch after the empty `inbox.changed` event. Settings carry a revision and scope repo overrides to canonical IDs returned by `settings.repos`.

## Installed Orca integration boundary

The installed public Orca API provides plugin requests, workspace inventory, and plugin-owned storage. Panel request context identifies a panel or editor, and the development CLI can construct that context. It carries no verified owner principal. Shipping activation therefore serves workspace identity resolution and returns `unavailable` for owner requests until a supported identity adapter exists. The fixture-free production entry point registers no Chat submission or receipt route.

The injected worker in the regression tests exercises the same registered handlers with explicit owner and Chat claims. Native integration requires trusted Chat submission, a native Needs you answer mapped into the same acceptance transaction, per-reply delivery and receipt verification, and scoped attachment grants. The reference-opening adapter accepts either `{"questionId":"…"}` or `{"view":"settings"}`. Public `editor.open` requires a workspace-relative file, and the current build still needs an authorized reference creation strategy and desktop proof of cross-workspace placement. Decision links are stable logical identifiers pending a host resolver.

No agent CLI is installed. `orca plugin dev request` is a UI development tool and carries no authenticated Chat identity. [Native integration audit](native-integration-audit.md)

## Local verification

Run `npm test` for TypeScript, Orca's local plugin harness, plugin checks, and the DOM smoke test. `orca plugin validate . --json` validates the current manifest. The regression suite includes duplicate and concurrent acceptance, crash after transport custody, restart, same-ID retry, paired host routing, invalid and verified receipts, bilingual search, private evidence, draft persistence, and scoped settings.
