# Design handoff: Decision Inbox V1 (FE)

Audience: the FE implementation and verification sessions. Scope and release gate stay in [v1-spec.md](v1-spec.md); ownership and the acceptance matrix stay in [implementation-handoff.md](implementation-handoff.md). This file records the interaction decisions the owner made in the FE design session, how each state looks, and what the shipped FE does. The owner selected **Variant D** (design lab `orca-inbox-design-lab/variant-d`, production briefs `PRODUCTION-BRIEF.md` and `PRODUCTION-BRIEF-REV3.md`); it is implemented in the wide editor (dashboard and single review). There is no open variant selection. To see it in a browser, use the [editor preview](editor-preview.md).

## What exists

The FE is wired to the plugin worker through the shared contract and [backend-protocol.ts](../src/backend-protocol.ts). No UI module imports fixtures; tests inject them through controlled worker answers (a static check in the DOM tests enforces this). The design prototype is kept in `.design-backup/`.

| Path | Role |
| --- | --- |
| [src/model.ts](../src/model.ts) | Pure view-model: scope identity, actionable rule, sort, search, deadline text. Keep and reuse; the worker can share it. |
| [src/client.ts](../src/client.ts) | Worker requests that always resolve to a `Result`, live clock and desktop zone, reply-ID minting, draft reconciliation. |
| [src/panel.tsx](../src/panel.tsx) | Narrow sidebar panel, Orca components only, on bounded `listDecisionPage` pages. |
| [src/review.ts](../src/review.ts) | Wide editor (plain DOM, isolated custom editor): Variant D dashboard, single review and Inbox Settings, on worker requests. |
| [src/dashboard-style.ts](../src/dashboard-style.ts) | Variant D stylesheet, ported from the design lab's `d.css` and scoped to `.d-app` / `d-` classes. |
| [src/inbox.test.tsx](../src/inbox.test.tsx) | Orca-runner tests for the model and the panel against controlled worker answers. |
| [scripts/dom-smoke.mjs](../scripts/dom-smoke.mjs) | DOM scenarios for the editor (linkedom) against a recording stand-in worker, run by `npm run test:dom`. |
| [scripts/preview-editor.mjs](../scripts/preview-editor.mjs) | Browser preview and real-Chromium layout checks (`--shots`); see [editor-preview.md](editor-preview.md). |

## Sources (phased V1, owner-approved)

One queue holds two sources. Every row and review names its source in text.

| | Chat decision (`source.kind: 'plugin'`, or no source on legacy rows) | Bot Item (`source.kind: 'native-item'`) |
| --- | --- | --- |
| What it is | A plugin-owned decision from an ordinary workspace Chat. | A read-only copy of a native Orca Bot Item. |
| Row badge | "Chat decision", plus the four-state badge. | "Bot Item · answer in Orca", plus Orca's status ("Needs you", "In progress", "Planned", "Done", "Canceled"; any other status as reported). |
| Needs you | Awaiting answer, or any reply undelivered (owner-approved: a saved answer that could not be delivered stays in the queue). | Orca status `needs-you`; CLI spellings such as `needs_you` or `Needs You` are normalized (also `in_progress`). |
| Review | Full review; reply, follow-up and retry only when listed in `actions`. | Read-only: status with "as of" time, details, options as text, and "Where to answer: answer this in Orca's Bot Items: bot …, item …". No reply, notes, retry, resolve or deep link. |
| Workspace | Always attributed (host + workspace). | When `workspaceAttributed` is false the row appears only in **All workspaces**, labelled "No workspace attribution". |

Delivery for Chat decisions keeps two facts apart. **Mail submitted** (shown with time and message ID) means Orca accepted the message for the original chat (`submitted.transport`). **Agent received** needs a receipt matching the reply, question and exact origin. On a host without a supported plugin mail sender the worker saves the answer and returns it undelivered: the review says "saved in Decision Inbox, but not delivered to the original chat", keeps the reply ID, and offers Copy (Retry only when listed in `actions`).

Without a supported retry, the row badge for an undelivered reply reads "Saved · not delivered" (or "Follow-up saved · not delivered"); with retry it reads "Undelivered".

Read coverage and delivery are separate page facts. `sources[]` reports read coverage only (`partial` means some rows were not read, for example pending intake checks: "Some Chat decisions could not be read … The Chat decisions shown can still be answered"). `mail` reports whether a delivery sender exists: when unavailable the panel shows a neutral notice "Answers are saved, not delivered yet" and never says loaded Chat decisions cannot be answered; it does not make an empty list look degraded.

Each source reports its own availability (`sources[]` on a page). A source that is unavailable or partial gets its own warning callout saying what still works ("… below are not affected"); it never blanks the other source. An empty list with a degraded source says "Nothing found … from the sources that could be read" instead of "You are all caught up".

Run everything: `npm test` (typecheck, `orca plugin test`, `orca plugin check`, DOM tests). Orca's test runner cannot import npm packages, so DOM tests are a separate script. **Never run `npm install` in this folder**: it creates `node_modules/.bin` symlinks, and Orca refuses to install a plugin that contains a symlink or an unsafe path ("the plugin contains an unsafe file path or symlink"). The DOM script installs linkedom and compiles the editor in a temporary directory instead, and deletes it afterwards. It compiles only `src/review.ts` and its imports, so unfinished backend files do not break it. `orca plugin test` needs the `~/resources` symlink workaround on Orca 1.4.271 (the CLI resolves test hooks under `$HOME`).

## Owner decisions

| Topic | Decision |
| --- | --- |
| Flow | The panel is a scan list. Selecting a row opens the wide review tab. No inline answering in the panel. **0.1.1 hotfix (needs owner confirmation):** because Orca may refuse to open the wide tab, a row now opens its detail inside the panel (Bot Items read-only with options and where to answer; Chat decisions with options, reply text, drafts and the same reply-ID and first-answer rules), the gear opens settings inside the panel, **← Back to list** returns, and **Open wide review** / **Open in a wide tab** is optional. A wide-tab failure is shown as "The wide tab did not open … Only the wide tab failed", separately from read failures ("Could not read this decision", "Decision not found", "No access to this decision"). |
| Scope | Segmented control: **This workspace** / **All workspaces**. Opens on This workspace. An explicit All workspaces choice survives focus changes. Scope identity is `hostId` plus `workspaceId`, never `workspaceId` alone. |
| Actionable rows | Shown by default: **Awaiting answer** and **Undelivered**. **Submitted / awaiting confirmation** and **Agent received** appear only with **Include history**. |
| One row per question | A package is not one row. Each question is its own row, sorted on its own. Rows from the same package carry a "Package · N questions" badge. |
| Deadlines in the list | Relative text only ("Overdue 21h", "Due in 3h", "Due in 2d"). The full timestamp belongs to the wide review. |
| Annotations | One contextual note composer next to the selected text or image (see [Notes](#wide-review)). Saved notes are listed in a **Notes** panel opened from the reply card (a modal dialog below 800px); there is no always-visible Notes sidebar. |
| Settings entry | A gear icon at the top right of the panel. The form opens in the wide editor. Placement may move top left if the broader design needs it. |
| Receipt display | The wide review shows an always-visible current-state card (state, one sentence, recorded milestones only); the panel and table rows show one status. The four states are never merged. |
| Dashboard direction | Variant D, with the owner's later annotations: workspace picker top right of the tabs row; title-only question cells; recommendation shown once in the reply card with the pager; labelled icon controls; agent narrative context; Ctrl/Cmd+Enter in notes saves only the note; state card; full-screen images; Use PM recommendation; source actions; note composer that closes after saving; resizable sheet; Background before Description; clearer grouping. |
| Language | Specs, handoffs and design discussion are English; owner-facing reports are Traditional Chinese. |

Proposed by design and **not explicitly confirmed** by the owner: keeping the side-by-side compare inside the collapsed **All images** section (see [Known differences](#known-differences-from-the-prototype)).

## Reader layout (owner readability request)

**Narrow panel reader.** Top to bottom: item context, the active question as the heading, compact badges (source, status, P0/P1, deadline), **Background** as sanitized Markdown (paragraphs, bold, http(s) links, lists), blocked work, the recorded thread, and collapsed **Details** / **Original activity**. The reply card at the bottom (a non-shrinking `Box`, at most 58% of the panel height, scrolling on its own) holds **Question i / N** with Previous / Next, the **Recommendation** (shown once, only here), then the native footer or the reply controls. Orca has no sticky/dock component; the card stays in view only when the host gives the panel a definite height (desktop-unverified). Each question keeps its own draft.

**Wide review (Variant D sheet).** A header (Back and Close in the dashboard, Copy decision link, Reset panel width), a body that scrolls on its own, and a reply card anchored at the bottom. Body order: title; source line with source actions; current-state card; facts card (priority, status, deadline, opened or "as of", blocks); **Background** then **Description**, each under its own heading only when supplied (an authored heading that already matches is not repeated; Description carries no note anchors); all images (collapsed when the agent placed them inline); linked evidence; the recorded thread; collapsed **Details** and **Original activity**. Background Markdown is built from text nodes with recorded source offsets, so anchored notes keep exact UTF-16 offsets into the unchanged background.

**Narrative context.** Headings, paragraphs, lists, bold, inline code and http(s) links. Fenced code is inert text with a language label ("copy only, never run by Inbox") and a Copy button. Inline images come from the worker's `inlineImages` placements (raw UTF-16 offsets into the background, before a line or at the end, never inside a fence): the exact evidence version is fetched with `getSnapshot` and shown with its plain-text caption, width and height; a denied or failed placement is an "Image unavailable" placeholder without metadata. No raw HTML runs, nothing is executed, and no image is loaded except through the authorized snapshot request.

## Dashboard tab

`+` menu / command palette → **Decision Inbox dashboard** (`newFiles` template `templates/dashboard.orca-decision`, content `{"view":"dashboard"}`) opens in the existing `review` editor.

**List.** Tabs **Pending** (actionable) / **Answered** / **All** with counts (arrow keys move between tabs), and the **Workspace** picker at the top right of the same row (This workspace, All workspaces, or one workspace seen in the rows; it adds no filter chip). The toolbar has **Priority**, **Status**, **Search** (sent to the worker, debounced), **Reset**, and, set apart from the filters, a labelled **Group by** control (Urgency, Priority, Status, Workspace). Below 900px Priority and Status sit behind a **Filters** toggle. Active filters show as removable chips. Source and mail notices appear once above the table; **Load more** pages the worker.

**Table.** Columns: Question (the title button only: no tags, badges, counts or "Question x/N"), Background snippet, Priority, Status, Source (Chat / Bot Item), Workspace, Due. Each group has a full-width heading band with its name and a count badge, more space above it than below, so it sits with its own rows. The selected row has `aria-current="true"` on its title, a tint, a 4px bar and a bold title. Arrow keys move between row titles. Below 900px rows become cards and the source and workspace show inline.

**Sheet.** Choosing a row opens the decision in the right-hand sheet without a new tab; the previous draft is saved under its own question first, and late answers from an earlier selection or search are dropped. Nothing opens by default. At 900px and wider the sheet sits beside the table and can be **resized**: drag the divider (pointer or touch), or focus it (`role="separator"`) and use ←/→ (Shift for larger steps), Home/End for the limits, Enter or a double-click to reset; **Reset panel width** in the header does the same. The sheet stays between 380px and the width that leaves the list column 460px. Below 900px the sheet is a full-screen modal (`aria-modal`, the list `inert`) with Back and Close. Esc closes the innermost layer: image viewer, note composer, Notes panel, then the sheet; focus returns to the row title.

## Narrow panel

Top to bottom: title and "N need you" badge with the settings gear; scope (`RadioGroup`, so the selected scope is exposed); search (sent to the worker, debounced); Include history; source and load notices; the list; **Load more** while pages remain. Invalidations refresh the loaded pages in place.

Each row shows: question title; project and workspace; priority badge (P0 danger, P1 warning, others neutral); relative deadline badge (danger when overdue); a state badge when the state is not Awaiting answer; a package badge; and `Blocks: …` text. Row press opens the review for that `questionId`.

Sort: P0 first; then overdue or due the same UTC day; then everything else. Inside each group: priority, then oldest `createdAt`, then `questionId` (a total order). Search is case-folded substring over title, background, recommendation, option labels and details, reply text, `questionId` and `packageId`, so Chinese works as typed. History replies are searchable only when history is on.

| State | Representation |
| --- | --- |
| Loading | `Skeleton` block, label "Loading decisions". |
| Empty (This workspace) | `EmptyState` "Nothing needs you in this workspace" with a **Show all workspaces** button. |
| Empty (All workspaces) | "You are all caught up." |
| No search match | "No matches. Try another word, or turn on Include history." |
| Refresh failed | Warning `Callout` "Showing the last loaded list" with the reason, "Nothing is sent from this list", and **Retry loading**. |
| Source unavailable / partial | Warning `Callout` per source ("Bot Items are unavailable", "Some Bot Items could not be read", "Chat decisions are unavailable") saying what still works. |
| Open failed | Danger `Callout` "Could not open the review tab" with the error text. |

## Wide review

The same sheet as in the dashboard, full-width when the editor opens one decision (`{"questionId": …}`); see [Reader layout](#reader-layout-owner-readability-request).

**Current state.** An always-visible card under the title: the state, one sentence, and only the milestones that were recorded (Opened; Answer or Follow-up saved; Submitted to Orca mail with time and message ID; Agent received with receipt ID; Delivery failed with the reason), plus at most one next step. Bot Items show Orca's status and the snapshot time. The current state carries `aria-current="step"`. Undelivered replies keep the alert with the reason, **Retry (same reply ID, same destination)** only when listed in `actions`, and **Copy reply**.

**Source actions.** Beside the source line: direct links for the worker's `workItemLinks` that pass the client allow-list (https only, no credentials; `github.com/<owner>/<repo>/issues|pull/<n>` and `linear.app/<team>/issue/<ID>`), deduplicated by case, trailing slash, query and hash, opened through `orca.shell.openExternal` on a click; and **Copy session ID** when `originalSessionId` is known. There is no "Focus session" action: Orca has no verified way to focus that session.

**Images.** Inline images (and a ⤢ button in each caption) open a full-screen viewer appended to the page, not the sheet (`role="dialog"`, `aria-modal`, the editor `inert`, focus on Close): fit to screen, zoom ×1.5 steps to ×8 (+ / − / 0, the wheel at the cursor, double-click), drag or arrow keys to pan when zoomed (clamped), Esc or Close; focus and the sheet's scroll return. **All images** keeps the optional side-by-side compare (thumbnail fills the right pane, Shift-click the left), per-viewer zoom and a note field per image. Snapshot failures read "Snapshot expired or missing", "You do not have access to this snapshot", or offer **Try again**; there is no re-attach action.

**Notes.** One contextual flow. Select text in Background or the Recommendation and press **Add note (Alt+N)**, or press ✎ under an image: a small composer opens next to it (a bottom sheet on small screens) with the quote or caption, a text box, **Cancel** and **Add note**. Ctrl/Cmd+Enter adds the note and never submits the decision (ignored while an input method is composing); Esc cancels. An empty note or a failed save keeps the composer open with the text. After a successful save the composer and the Notes panel close, the sheet's scroll is kept, focus returns to where the note started (✎ or the Notes button), the text is highlighted at its anchor, and the reply card shows "Note saved with your draft … Not sent yet" with **Edit notes**. The **Notes (n)** button in the reply card opens the Notes panel (a modal dialog below 800px) to edit, remove or **Go to** each note. Text notes store the quote and UTF-16 start and end offsets with the question `revision`; image notes carry `evidenceId` and `version`. Notes are saved with the draft and sent with the reply in one operation.

**Reply card (Chat decisions).** Anchored at the bottom of the sheet; at most 58% of its height, scrolling on its own, compacted when the viewport is short so the text box and Submit stay visible with an on-screen keyboard. Order: Recommendation (shown once, clamped to three lines with an expand control) with the package pager **i / N** in its header (labelled previous/next icons; unknown totals read `N+`); option chips; **Use PM recommendation**; the reply text (Ctrl/Cmd+Enter submits); notices; a hint line, **Notes (n)** and **Submit reply** (or **Send follow-up**). **Use PM recommendation** selects the option named by `recommendedOptionId`, otherwise puts the recommendation text in the reply and never guesses an option; when a draft already exists it first asks "Replace your draft with the PM recommendation?" with focus on **Keep my draft**; after replacing it shows "Proposed from the PM recommendation … Nothing is sent until you submit" with **Undo**. Each question keeps its own draft when paging. A send acts only on the decision as drawn: if another surface recorded an answer while the owner was writing, nothing is sent and the owner's text stays as **Your unsent answer** with **Write a follow-up from this text**, **Copy** and **Discard**. An empty reply is refused with a live-region message.

**Reply card (Bot Items).** Read-only: the Recommendation and pager, "Answer in Orca's Bot Items: bot …, item …", **Copy location**, the options as text and "Read-only copy: Decision Inbox cannot answer, resolve or open this Item for you." No reply, notes, Use PM recommendation, retry, resolve or deep link.

**Answered question.** The initial reply shows as it was sent, with its accepted time, notes count and its own delivery line. Follow-ups append below, each with its own delivery line. The original is never rewritten; a follow-up is never composed or sent automatically.

**Not found.** A missing or inaccessible `questionId` shows an alert instead of a blank tab.

## Known differences from the prototype

- No Answer / Clarify toggle: the contract has no clarify path.
- The primary action is **Submit reply** (a real reply is sent, with truthful delivery state), not the prototype's local **Save**.
- Notes are saved with the draft when added; the prototype's "pending until saved" note state does not exist.
- No **Focus session** button (the prototype's is a stub); only **Copy session ID**.
- Compare lives in the collapsed **All images** section instead of a header icon.
- Rows do not show Draft / saved-note marks: list rows carry no draft data.
- The narrow sidebar panel follows D only where Orca components allow (pager and recommendation in the footer card); the table, sheet, composer and viewer are wide-editor features.

## Inbox Settings

Opened by the panel gear into the same editor (`{"view":"settings"}`). Sections: the default question template (an empty default is refused and disables Save); repo exceptions, one per repo, each with a repo select, its own template and Remove; and an **Effective rules preview** that shows, for a chosen repo, whether the Default or an Exception applies, the template text, and a reminder that agents also read that repo's `AGENTS.md` and the selected role file (not editable here). Save and Revert are `aria-disabled` when nothing changed; a status line reads "Unsaved changes" or "Saved".

The `Settings` shape (`defaultTemplate`, `exceptions[{repo, template}]`) lives only in `review.ts`. The contract has no settings operations; BE must define them.

## Keyboard and focus

The panel uses Orca's built-in keyboard handling. In the editor: arrow keys move between dashboard tabs and between row titles; Alt+N opens the note composer for the selection; Ctrl/Cmd+Enter submits the reply or follow-up from the reply box only, and in a note composer adds the note only; the sheet divider resizes with the arrow keys, Home, End and Enter; Esc closes the innermost layer (viewer, composer, Notes panel, sheet) with focus returned to its opener. Focus rings use `:focus-visible` outlines. State changes announce through a `role="status"` live region. ARIA state attributes are strings (`aria-pressed="true"`), enforced in the `el()` helper and tested.

## Acceptance examples (fixtures, clock 2030-06-14 12:00Z)

Covered by tests today:
- Sort across scopes: `room-route`, `room-reset`, `stage`, `layout`, `image-review`, `schedule` (`inbox.test.tsx`).
- This workspace on local `studio` shows only `image-review` and `schedule`; paired `studio` is excluded (`inbox.test.tsx`).
- Search: `layout` by ID, `contrast` by background, `Fold-out` by option, `錄音` by recommendation; `matte sample` finds `layout` only with the history fixture and history on.
- `historyExample` is Agent received and hidden by default.
- Seven-image review, notes, expired snapshot, submit, and the current state; answered thread, appended follow-up and undelivered retry; settings validation, exceptions, preview and save; not-found alert (`dom-smoke.mjs`).

Also covered: the dashboard tabs, filters, grouping, selection, narrow modal sheet and Esc; the `richContext` narrative (inline image at its raw offset, denied placeholder, inert code and Copy, code-block note offsets); Background-then-Description with no duplicate headings and unchanged Background offsets; the note composer (empty and failed saves, Ctrl/Cmd+Enter isolation, Esc, focus return); Use PM recommendation (confirm, Undo, no guessed option); source-action allow-list; the image viewer (`dom-smoke.mjs`). Real-Chromium layout checks at 1920, 1603×656, 1280, 820, 390 and short heights run with `npm run preview:editor -- --shots` ([editor-preview.md](editor-preview.md)).

Not covered, for desktop acceptance: everything inside a real Orca desktop (frame CSP for `data:` images, `orca.shell.openExternal` consent, whether `inbox.changed` reaches the isolated editor); real Chinese IME in the reply box and note composer; touch drag of the sheet divider and image pan; screen-reader output; theme colors beyond `--orca-foreground/background`; the narrow panel's reply card height.

## Assumptions to prove (also marked `ASSUMPTION` in code)

| ID | Assumption | Where |
| --- | --- | --- |
| A1 | The focused workspace comes from `workspace.changed`; the fixture hard-codes local `studio`. | panel |
| A2 | The review tab is a `.orca-decision` reference file opened by the worker with `editor.open` (worker-only), requested from the panel as `plugin.request` named `review.open` (`{questionId}`) or `settings.open`. These names are now the shipped requests; the worker opens a minimal reference file in the focused local workspace. Cross-repo placement without moving workspace focus still needs desktop proof. | panel, review |
| A3 | Private snapshot bytes reach the editor only through the worker's `getSnapshot` (inline placements and the image list); the frame's CSP for `data:` images is desktop-unproven. | review |
| A4 | Only `--orca-foreground` and `--orca-background` are confirmed; all other colors are derived with `color-mix`. | review |
| A5 | A reply routes to the original Chat, including on a paired host. This is a release gate. | review |
| A6 | Drafts (with compare-and-set revisions), follow-ups and settings persist through the worker. Desktop restart behaviour is unproven. | review |

## Known gaps for implementation

- The package reply flow is per question; there is no "answer the whole package" action.
- Desktop-only checks: real Chinese IME (reply box and note composer), click timing after typing, sheet scroll retention after notes and image viewer, the Notes dialog below 800px, compare stacking below 640px, macOS Option+N and Cmd+Enter, divider drag by touch, whether `inbox.changed` reaches the isolated editor, `data:` image CSP, external-open consent for source actions, panel remount.
- Plugin load on Orca 1.4.271 from the CLI is blocked on this runtime ("Plugin service is not available"); desktop load is by Settings → Plugins → Development folders.
