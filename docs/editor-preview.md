# Editor preview (dev only)

A quick way to see the real review editor (`src/review.ts`: dashboard, single review, settings) in a normal browser while you change it. It is development tooling: the shipping plugin never imports it, and it reads no live Orca data.

## Run

```sh
npm run preview:editor
```

It prints the address, by default `http://127.0.0.1:4870/` (the next free port if 4870 is busy; `-- --port 5000` picks one). It listens on loopback only. Open it in Chrome or Chromium. The page reloads by itself when a file under `src/` or `fixtures/` or the mock bridge changes. Drafts are kept across reloads (in the tab's session storage), as the worker would keep them.

| URL | What it shows |
| --- | --- |
| `/` or `?ref=dashboard` | Dashboard: queue and reader (resize below 800px for one surface at a time) |
| `?ref=bot-item:preview:e1:0` | Native Bot Item with two questions (paging, Markdown, footer) |
| `?ref=preview-long` | Long Chinese Chat decision (paragraphs, sticky reply area) |
| `?ref=image-review` | Seven synthetic images |
| `?ref=settings` | Inbox Settings |
| `&theme=light`, `&zone=Asia/Hong_Kong`, `&history=1` | Light theme, another time zone, answered history fixture |

Data comes from `fixtures/decisions.ts` plus a few synthetic cases in `scripts/preview-bridge.mjs`, which also stands in for `window.orca` (worker requests, drafts with the worker's compare-and-set rule, settings, the focused workspace). Nothing is installed in the plugin folder: the sources compile with the pinned TypeScript into a temporary directory (`PREVIEW_TMP_ROOT` chooses where), which is deleted on exit.

### Screenshots and layout checks

```sh
npm run preview:editor -- --shots /tmp/inbox-shots
```

Starts the same server, drives headless Chrome (`CHROME=/path` to choose one), saves PNGs at 1280×820, 820×900 and 390×844 and writes `checks.json`. It checks the dashboard's wide and narrow layouts, native paging, that the reply dock stays in the viewport while a long question scrolls, and that a source change reloads the page and keeps the draft (it touches `src/review.ts` without changing its content).

## In Orca itself

The preview is a browser approximation. For the real thing, load the folder as a development plugin and use Orca's own tools:

```sh
orca plugin dev watch . --check      # load, reload on change, report panel/editor errors and refused layouts
orca plugin check .                  # render each panel once against a stand-in host (scenarios: src/panel.check.ts)
orca plugin shot . --panel inbox --width 820 --scenario <name>     # PNG of the panel as Orca draws it
orca plugin shot . --editor <file.orca-decision> --width 820       # PNG of the custom editor
```

`plugin shot` needs the desktop app with a workspace and hides Orca's window while it captures, so run it when you are not using that window. Panel scenarios live in `src/panel.check.ts` (`defineCheck`, not yet added).

## What the preview cannot show

- The sidebar panel (`src/panel.tsx`): it is drawn by Orca's own components, not in a browser. Use `orca plugin check` / `plugin shot --panel`.
- Orca's theme tokens: only `--orca-foreground` and `--orca-background` are set (dark or light); fonts, zoom and the real editor frame size differ.
- The isolated frame's content security policy, `orca.shell.openExternal` consent, and how `inbox.changed` reaches the frame.
- Real worker behaviour: owner identity, Bot Item reads, mail delivery, wide-tab placement and `newFiles` from the + menu. Wide-tab requests are only logged.
- Real input methods, macOS shortcuts and screen readers.
