# Selected D: frontend and plugin contract

The dashboard and narrow panel share the worker contract for the selected Variant D design. Keep the running plugin and its existing [domain types](../src/contract.ts), [worker requests](../src/backend-protocol.ts) and [delivery gates](v1-spec.md) as the baseline.

## Workspace selection

Use one labelled, single-select control at the right of the Pending / Answered / All row. Its choices are **All workspaces** and one entry for each authorized workspace. Use readable workspace names; add the host label for duplicate names. Keep **Group by workspace** available as a separate presentation choice.

On entry, resolve the focused workspace and display its name. Focus can follow Orca until the user makes an explicit selection. An explicit selection stays fixed for the life of that view. When focus is ambiguous, or a selected workspace disappears, ask the user to select a workspace or All. Preserve the open decision and draft. Selecting a queue scope changes the queue only.

| Worker operation | Contract |
|---|---|
| `workspace.options` | No input. Return `Result<{ workspaces: { hostId, workspaceId, name, hostLabel? }[], truncated?: boolean }>` using strings for IDs and labels. Derive choices from authorized inventory, including workspaces with zero decisions. Represent partial inventory explicitly. |
| `workspace.resolve` (existing) | Map Orca's focused workspace ID to an unambiguous authorized host/workspace pair. |
| `listDecisionPage` (existing) | Send the existing `scope` union: `{kind:'all'}` or `{kind:'workspace', workspace:{hostId, workspaceId}}`. A changed scope starts a new first-page query. Refresh and Load more retain that scope. Discard late results from the previous query. |

The worker enforces authorization and per-source visibility. Unattributed native Items appear only under All workspaces. The picker stays populated during empty searches, filter changes and paging. An unavailable source and an empty result have distinct UI states.

## Ownership of the other D interactions

| User action | Implementation boundary |
|---|---|
| Find a decision | The dashboard and sidebar use the same typed queue request. The worker owns scoped results, search, ordering, cursor and source coverage. The default dashboard groups by priority. Before paging, the worker orders the whole scoped queue by P0 through P3, earliest deadline within a priority, undated last, then oldest creation and stable question ID. The view draws headings and tracks the selected row. A filter applied to loaded pages must disclose that limit until it is included in the worker query. |
| Inspect and page through a package | Select by stable question ID and call `getDecision`. The dashboard renders the resizable sheet, Background before Description, progress, inline evidence, source links and question pager. Host-owned sidebar components offer inline details and a wide-view entry. Both use the same record. |
| Add notes or adopt a recommendation | The view manages focus, zoom, selection and the contextual composer. The editor anchors selected text in Background, Description or Recommendation and supports notes on authorized images. The sidebar offers a paragraph or image picker and optional exact words. Both save through the same question-scoped, revisioned draft operation. Saving a note closes its composer and keeps the reply editable. Recommendation changes a draft; explicit Submit records an answer. |
| Send or check an answer | Core handles first-answer conflicts, append-only follow-ups and reply IDs. The Orca adapter supplies actual actions and delivery evidence. Native Items point to Orca for answering. A saved Chat answer, accepted mail and a confirmed agent receipt remain separate states. |
| Review an attachment | Render author-ordered Markdown and versioned inline placements. Request bytes through the worker's existing attachment grant. Commands render as copyable text. Retain a usable document when evidence is unavailable. |

## Smallest migration

1. **Replace the duplicate workspace logic.** Add the authorized inventory operation. Wire the D selector to the existing scope union; remove the seen-row inventory, extra workspace row filter and duplicate “This workspace” choice in that selector. Keep legacy callers and stored data compatible.
2. **Share behavior where there are two callers.** Keep scope selection and query construction in one small, testable function if both views need them. Keep DOM placement, pane resizing and focus behavior in the UI that renders them. Reuse the existing worker, adapters and storage.
3. **Prove a vertical slice.** Test a local and a paired workspace with the same name, a workspace with zero rows, an unattributed Item, a partial source, a late response from the previous scope and a draft reopened after switching. Verify the actual request scopes as well as the visible rows. Run the normal suite and Chromium preview. Record installed desktop and live paired-server results separately.

The broader refactor proceeds one user flow at a time when the same rule is implemented twice or the approved interaction cannot be expressed through the current contract. For each change, name the obsolete path to remove and the acceptance case that proves its replacement. The [design handoff](design-handoff.md) owns layout details; the [implementation handoff](implementation-handoff.md) owns release and host verification.
