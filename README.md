# Decision Inbox Preview

A try-it-now preview of the Orca Decision Inbox with built-in synthetic sample decisions. Answers you save stay in the preview on your desktop. Nothing is sent to a Chat, mail, or Bot Items.

This branch (`preview`) contains only the preview plugin. The production Decision Inbox lives on `main`, under its own plugin id (`decision-inbox`). The two plugins never share storage.

## Install and open

```sh
orca plugin install stevenhei/orca-inbox@preview
orca plugin open stevenhei.decision-inbox-preview --panel inbox
```

Orca asks you to approve a `sandboxed-ui` panel with no capabilities. Approve it with the `--approve <fingerprint>` command Orca prints. The repository is private, so the Orca host needs Git access to it (for example `gh auth setup-git`).

## What you can try

- **Queue**: eight sample cards that need an answer, sorted most urgent first (P0, then overdue or due today, then priority and age). Sample dates are placed relative to the moment you first open the panel.
- **Review in the panel**: select a card to read its project, deadline, blocked work, background, recommendation, evidence and options. **Back to list** returns to the queue.
- **Search**: by title, background, option, ID or Chinese text, for example `錄音`, `vd-` or `fold-out`.
- **Include history**: shows the sample history card and anything you answered in the preview.
- **Answer**: choose an option and add optional detail, or type a reply. Save with **Save test answer** or Ctrl+Enter (Cmd+Enter on macOS). The result appears straight away, and you can add follow-ups.
- **Multi-question package**: *Community Garden · volunteer-day* has three questions, each answered on its own.
- **Seven images**: *Compare seven paper model views* has a large viewer, Previous and Next buttons, numbered thumbnails and a note for each image.
- **Reset**: the refresh icon at the top clears every saved test answer after you confirm.

## Files

| Path | Contents |
| --- | --- |
| `orca-plugin.json` | Manifest: `decision-inbox-preview`, one components panel, no worker or capabilities |
| `src/panel.tsx` | The panel: queue, in-panel review, answers, reset |
| `src/preview-model.ts` | Sorting, search, deadline text and answer rules, following the production model |
| `src/sample.ts` | Synthetic sample decisions, shaped by the production contract and fixtures |
| `src/contract.ts` | The shared Decision Inbox contract (unchanged from `main`) |
| `assets/sample/*.png` | Seven distinct synthetic images |
| `src/panel.test.tsx`, `src/panel.check.ts` | Interaction tests and render scenarios |

## Check locally

```sh
orca plugin types .
npm exec --yes --package typescript@5.9.3 -- tsc -p tsconfig.json
orca plugin validate . --json
orca plugin test .
orca plugin check . --json
```

Do not run `npm install` here. Orca refuses plugins that contain symlinks.
