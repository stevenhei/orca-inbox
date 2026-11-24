# Design handoff: Decision Inbox V1 (FE)

Audience: the FE implementation and verification sessions. Scope and release gate stay in [v1-spec.md](v1-spec.md); ownership and the acceptance matrix stay in [implementation-handoff.md](implementation-handoff.md). This file records the interaction decisions the owner made in the FE design session, how each state looks, and what the working prototype already does.

## What exists

The FE design is a working prototype on top of the shared contract and fixtures. It replaces the scaffold `panel.tsx` and `review.ts` (originals in `.design-backup/`). It is **design code, not production code**:

| Path | Role |
| --- | --- |
| [src/model.ts](../src/model.ts) | Pure view-model: scope identity, actionable rule, sort, search, deadline text. Keep and reuse; the worker can share it. |
| [src/panel.tsx](../src/panel.tsx) | Narrow sidebar panel, Orca components only. Imports fixtures; replace with `listDecisions`. |
| [src/review.ts](../src/review.ts) | Wide review tab and Inbox Settings in one isolated custom editor (plain DOM). Imports fixtures; replace with worker calls. |
| [src/inbox.test.tsx](../src/inbox.test.tsx) | Orca-runner tests for model and panel. |
| [scripts/dom-smoke.mjs](../scripts/dom-smoke.mjs) | DOM tests for the editor (linkedom), run by `npm run test:dom`. |

Everything marked `DESIGN-ONLY` or `Design preview` in the code (state forcing, "Preview: …" buttons, the focused-workspace selector) is scaffolding for design review. Delete it when wiring real data.

Run everything: `npm test` (typecheck, `orca plugin test`, `orca plugin check`, DOM tests). Orca's test runner cannot import npm packages, so DOM tests are a separate script. **Never run `npm install` in this folder**: it creates `node_modules/.bin` symlinks, and Orca refuses to install a plugin that contains a symlink or an unsafe path ("the plugin contains an unsafe file path or symlink"). The DOM script installs linkedom and compiles the editor in a temporary directory instead, and deletes it afterwards. It compiles only `src/review.ts` and its imports, so unfinished backend files do not break it. `orca plugin test` needs the `~/resources` symlink workaround on Orca 1.4.271 (the CLI resolves test hooks under `$HOME`).

## Owner decisions

| Topic | Decision |
| --- | --- |
| Flow | The panel is a scan list. Selecting a row opens the wide review tab. No inline answering in the panel. |
| Scope | Segmented control: **This workspace** / **All workspaces**. Opens on This workspace. An explicit All workspaces choice survives focus changes. Scope identity is `hostId` plus `workspaceId`, never `workspaceId` alone. |
| Actionable rows | Shown by default: **Awaiting answer** and **Undelivered**. **Submitted / awaiting confirmation** and **Agent received** appear only with **Include history**. |
| One row per question | A package is not one row. Each question is its own row, sorted on its own. Rows from the same package carry a "Package · N questions" badge. |
| Deadlines in the list | Relative text only ("Overdue 21h", "Due in 3h", "Due in 2d"). The full timestamp belongs to the wide review. |
| Annotations | A sticky **Notes sidebar** in the wide review. Below 800px the sidebar is hidden; **Add note** opens a **modal composer** instead. |
| Settings entry | A gear icon at the top right of the panel. The form opens in the wide editor. Placement may move top left if the broader design needs it. |
| Receipt display | Four-step strip in the wide review, one status badge in the list row. The four states are never merged. |
| Language | Specs, handoffs and design discussion are English; owner-facing reports are Traditional Chinese. |

Proposed by design and **not explicitly confirmed** by the owner: the evidence layout below. Confirm it during review.

## Narrow panel

Top to bottom: title and "N need you" badge with the settings gear; scope toggle (a `Toolbar`, arrow keys move between the two buttons); search; Include history checkbox; optional offline callout; the list.

Each row shows: question title; project and workspace; priority badge (P0 danger, P1 warning, others neutral); relative deadline badge (danger when overdue); a state badge when the state is not Awaiting answer; a package badge; and `Blocks: …` text. Row press opens the review for that `questionId`.

Sort: P0 first; then overdue or due the same UTC day; then everything else. Inside each group: priority, then oldest `createdAt`, then `questionId` (a total order). Search is case-folded substring over title, background, recommendation, option labels and details, reply text, `questionId` and `packageId`, so Chinese works as typed. History replies are searchable only when history is on.

| State | Representation |
| --- | --- |
| Loading | `Skeleton` block, label "Loading decisions". |
| Empty (This workspace) | `EmptyState` "Nothing needs you in this workspace" with a **Show all workspaces** button. |
| Empty (All workspaces) | "You are all caught up." |
| No search match | "No matches. Try another word, or turn on Include history." |
| Offline | Warning `Callout` over the last saved list: replies stay as drafts and send on reconnect. |
| Open failed | Danger `Callout` "Could not open the review tab" with the error text. |

## Wide review

Layout: content column plus the Notes sidebar. Order: meta line (project, workspace, host chip when not local, priority, deadline, blocked work); title; routing note (the reply goes to the original chat, wherever the owner is); overdue alert; same-package questions with their states; Background; Recommendation; Options; Evidence; Reply; delivery strip; Source links.

**Evidence.** Seven images default to one large viewer with a thumbnail row. **Compare side by side** opens two viewers: click a thumbnail for the right pane, Shift-click for the left. Each viewer has zoom out, zoom in and reset, and its own note field. Placeholders keep the real width, height and alt text. A missing or expired snapshot shows "Snapshot expired or missing" with an **Ask the agent to re-attach** action. Linked evidence is a list of external links with versions.

**Notes.** Image notes carry `evidenceId` and `version`. Selecting text in Background offers **Add note (Alt+N)**; the note stores the quote and UTF-16 start and end offsets with the question `revision`, as the contract requires. In the wide layout the new note appears in the sidebar with its field focused. Below 800px a native `<dialog>` modal collects the text. Notes are sent with the reply in one operation.

**Reply.** Radio options when the question has them, plus a text field. With an option the text is `detail`; without one it is a text answer. Submit with the button or Ctrl/Cmd+Enter. An empty reply is refused with a live-region message and does not change state.

**Delivery strip.** Four steps, the current one marked `aria-current="step"`: Awaiting answer, Submitted / awaiting confirmation, Agent received, Undelivered. Undelivered shows an alert with the reason, **Retry (same reply ID, same destination)** and **Copy reply**; the reply is kept.

**Answered question.** The initial reply shows as it was sent, with its accepted time, notes count and its own delivery line (receipt ID and time, or "waiting for a matching receipt", or the undelivered alert). Follow-ups append below, indented with a dashed border, each with its own delivery line. The original is never rewritten. A follow-up box (Ctrl/Cmd+Enter to send) sits under the thread; the button is `aria-disabled` while empty.

**Not found.** A missing or inaccessible `questionId` shows an alert instead of a blank tab.

## Inbox Settings

Opened by the panel gear into the same editor (`{"view":"settings"}`). Sections: the default question template (an empty default is refused and disables Save); repo exceptions, one per repo, each with a repo select, its own template and Remove; and an **Effective rules preview** that shows, for a chosen repo, whether the Default or an Exception applies, the template text, and a reminder that agents also read that repo's `AGENTS.md` and the selected role file (not editable here). Save and Revert are `aria-disabled` when nothing changed; a status line reads "Unsaved changes" or "Saved".

The `Settings` shape (`defaultTemplate`, `exceptions[{repo, template}]`) lives only in `review.ts`. The contract has no settings operations; BE must define them.

## Keyboard and focus

List and toolbar use Orca's built-in keyboard handling. In the editor: Alt+N adds a note from the selection; Ctrl/Cmd+Enter submits the reply or the follow-up; Esc dismisses the selection pop-up and, in the modal, closes it with focus returning to the opener (native `<dialog>`). Focus rings use `:focus-visible` outlines. State changes announce through a `role="status"` live region. ARIA state attributes are strings (`aria-pressed="true"`), enforced in the `el()` helper and tested.

## Acceptance examples (fixtures, clock 2030-06-14 12:00Z)

Covered by tests today:
- Sort across scopes: `room-route`, `room-reset`, `stage`, `layout`, `image-review`, `schedule` (`inbox.test.tsx`).
- This workspace on local `studio` shows only `image-review` and `schedule`; paired `studio` is excluded (`inbox.test.tsx`).
- Search: `layout` by ID, `contrast` by background, `Fold-out` by option, `錄音` by recommendation; `matte sample` finds `layout` only with the history fixture and history on.
- `historyExample` is Agent received and hidden by default.
- Seven-image review, notes, expired snapshot, submit, and the four-state strip; answered thread, appended follow-up and undelivered retry; settings validation, exceptions, preview and save; not-found alert (`dom-smoke.mjs`).

Not covered, for FE verification: selection-offset capture against the real DOM; the 800px sidebar-to-modal switch; modal focus return; side-by-side layout at narrow widths; theme colors from `--orca-*`; all behavior inside a real Orca desktop.

## Assumptions to prove (also marked `ASSUMPTION` in code)

| ID | Assumption | Where |
| --- | --- | --- |
| A1 | The focused workspace comes from `workspace.changed`; the fixture hard-codes local `studio`. | panel |
| A2 | The review tab is a `.orca-decision` reference file opened by the worker with `editor.open` (worker-only), requested from the panel as `plugin.request` named `review.open` (`{questionId}`) or `settings.open`. Both names are design placeholders. Cross-repo opening without moving workspace focus needs desktop proof. | panel, review |
| A3 | Private snapshot bytes reach the editor through the worker. The prototype draws placeholders from metadata. | review |
| A4 | Only `--orca-foreground` and `--orca-background` are confirmed; all other colors are derived with `color-mix`. | review |
| A5 | A reply routes to the original Chat, including on a paired host. This is a release gate. | review |
| A6 | Drafts, follow-ups and settings persist through the worker. The prototype keeps them in memory. | review |

## Known gaps for implementation

- The editor needs a worker request for each of: open review, load decision, submit reply, retry reply, and settings read and write. Request names above are placeholders.
- The package reply flow is per question; there is no "answer the whole package" action.
- Offline and loading states are forced by design-preview controls only; wire them to real connectivity.
- Plugin load on Orca 1.4.271 from the CLI is blocked on this runtime ("Plugin service is not available"); desktop load is by Settings → Plugins → Development folders.
