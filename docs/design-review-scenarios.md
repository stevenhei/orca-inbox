# Design review scenarios (fixture-only preview)

Purpose: let the owner review the Decision Inbox UI in the desktop app while the production plugin stays fail-closed ("Authenticated owner access is unavailable on this Orca host"). This file lists what the owner needs to see. It does not change the production manifest or worker. Context: [design-handoff.md](design-handoff.md), [native-integration-audit.md](native-integration-audit.md).

## Ground rules

- **Synthetic data only**: the shared [fixtures](../fixtures/decisions.ts) and `historyExample`, clock `2030-06-14T12:00Z`, with the reviewing time zone injected (use `UTC`, and `Asia/Hong_Kong` for one deadline case).
- **No production behavior**: no worker calls to real storage, no submissions, replies or receipts, no claim of delivery. Every surface shows a persistent label such as "Design preview: sample data, nothing is sent".
- **Never enabled by the production plugin**: separate mechanisms below; the production panel and worker keep failing closed.
- Plugin ids must not start with `orca-` (reserved; the desktop refuses to install them). Never run `npm install` inside a plugin folder (symlinks are refused).

## Two mechanisms

| Surface | Mechanism | Notes |
| --- | --- | --- |
| Narrow panel | Official **scenario preview**: `src/panel.check.ts` with `defineCheck({...})`, then `orca plugin shot <dir> --scenario <name> [--width] [--theme]`. | The panel and worker render against a stand-in host, apart from the real plugin, so scenario data never reaches real storage or the real worker. Limits: still frames, local only, a dev plugin only, Orca's window must be hidden or minimized, no `--act`. Each scenario can stub a worker answer with `requests` or throw `hostError(code)` in `results`. |
| Wide review and Settings | A **separate fixture-only preview plugin** (suggested id `decision-inbox-preview`, execution `sandboxed-ui`, no `main`, no capabilities) holding only the review editor plus a fixture data source and the banner. | `scenario` shots do not cover custom editors. `orca plugin shot <dir> --editor <file> --act '[...]'` can drive a real editor with clicks and keys, but needs Orca's window hidden. A plugin cannot import files outside its own folder, so the preview needs its own copy of the editor and fixtures; keep it generated or clearly marked as a copy. |

The official scenario preview is the cheaper first step: it needs no second plugin and covers the panel states below.

## Panel scenarios (`src/panel.check.ts`)

Check each at widths 320, 360 and 480, in light and dark.

| Scenario | Setup | The owner should see |
| --- | --- | --- |
| `this-workspace` | Focus local `studio`, scope This workspace, no search. | "2 need you": `image-review` (P2) then `schedule` (P3). Paired `stage` is absent. Gear icon top right. |
| `all-workspaces` | Scope All workspaces. | Six rows in order `room-route`, `room-reset` (P0, oldest first), `stage` (due today), `layout` (overdue), `image-review`, `schedule`. Package badge on both `room-*` rows. Overdue badge red. |
| `history-search` | History on, search `matte sample`, `historyExample` substituted for `layout`. | Only `layout` with an "Agent received" badge. With history off the same search shows "No matches". |
| `search-cjk` | Search `錄音`, then a term that matches nothing. | `schedule` only; then "No matches, try another word, or turn on Include history". |
| `empty-workspace` | Scope This workspace on a workspace with no open questions. | EmptyState "Nothing needs you in this workspace" with a **Show all workspaces** button. |
| `loading` | Worker request still pending. | Skeleton "Loading decisions". |
| `offline` | Last saved list plus an offline flag. | Warning callout "Offline: showing the last saved list"; the list stays usable. |
| `unavailable` | Stub the list request to answer `unavailable` ("Authenticated owner access is unavailable on this Orca host"). | The exact production failure the owner saw today, as a deliberate scenario: danger callout "Could not load decisions" with a readable reason. |
| `due-today-zone` | `stage` deadline moved to `2030-06-14T17:00Z`, zone `UTC` vs `Asia/Hong_Kong`. | In UTC it sorts in the due-today group; in Hong Kong it does not. |
| `undelivered-row` | One question whose reply is Undelivered. | The row stays in the default list with a red "Undelivered" badge. |

## Review and Settings scenarios (preview plugin)

Check at widths 1100 and 600 (the 800px sidebar-to-modal switch must be visible on both sides), light and dark.

| Scenario | Fixture | The owner should see and do |
| --- | --- | --- |
| `schedule` | `schedule` | Short question. Pick Tuesday, type a note, Submit (button and Ctrl/Cmd+Enter). The strip goes Awaiting answer → Submitted / awaiting confirmation. An empty submit is refused with a message. |
| `stage` | `stage` | Paired-host chip, routing note ("reply goes to the original chat"), due-today badge, phase-one option. |
| `layout-conditional` | `layout` | Three options. Choose Grid and write a long conditional detail; it stays intact. |
| `layout-answered` | `historyExample` | Your answer with accepted time, receipt ID and time ("Agent received"). Add a follow-up: it appends below, original unchanged, own delivery line. A second follow-up marked Undelivered shows the reason, **Retry (same reply ID, same destination)** and **Copy reply**. |
| `package` | `room-route` and `room-reset` | Sibling chips show the other question and its own state; shared `floor-plan` v2 link; answering one does not change the other. |
| `images-single` | `image-review` | Seven thumbnails, one large viewer, zoom out, zoom in, reset. Placeholders keep their real aspect ratios (Panorama 1800×600, Tall detail 600×1800). |
| `images-compare` | `image-review` | **Compare side by side**: Panorama on one side, Front portrait on the other (click for the right pane, Shift-click for the left). Per-image note field on each. |
| `images-expired` | `image-review` | Snapshot 6 expired: "Snapshot expired or missing" with **Ask the agent to re-attach**; the other six still work. |
| `notes-wide` | `image-review` | Select "Paper models" (offsets [0, 12)) in Background: **Add note (Alt+N)** appears; the note shows its quote in the sidebar with its field focused. An image note appears in the same list. Notes are sent together with the reply. |
| `notes-narrow` | `image-review`, width 600 | The sidebar is gone. **Notes** and Alt+N open a modal composer; Esc closes it and focus returns to the opener. |
| `states` | any | Awaiting answer, Submitted, Agent received, Undelivered each visible in the four-step strip, with `aria-current="step"` on the current one. |
| `not-found` | unknown `questionId` | An alert instead of a blank tab. Also show a forbidden and an unavailable variant. |
| `settings` | none | Default template, one repo exception, effective-rules preview for each repo and "(any other repo)", an empty default (error, Save disabled), unsaved changes, Saved. |
| `keyboard` | any | Tab order is logical; every control has a visible `:focus-visible` ring; Alt+N, Ctrl/Cmd+Enter and Esc work; state changes are announced through the live region. |

## Evidence the owner needs back

For each scenario: a PNG (the `shot` default location is `.orca/shots/`), the width and theme, and the owner's verdict. Record the owner's decisions in [design-handoff.md](design-handoff.md). The evidence-layout choice (one large viewer plus an optional side-by-side compare) is still unconfirmed by the owner; `images-single` and `images-compare` exist to settle it.

## Open items for the worker session

- Choose where the preview editor lives (a folder in this repo such as `preview/`, or a separate plugin repo). It must be excluded from the production plugin folder so the production hash and approval do not change.
- The scenario preview needs a dev plugin and a hidden or minimized Orca window; confirm both on the owner's desktop before promising screenshots.
- Do not weaken the release gate: the preview proves layout and wording only, not authenticated submission, native Needs you sync, or receipts.
