// Styles for the isolated editor. Host theme tokens apply to review, dashboard and settings.
export const editorStyles = `
:root{--fg:var(--orca-foreground);--bg:var(--orca-background);
 --line:color-mix(in srgb,var(--fg) 18%,transparent);--soft:color-mix(in srgb,var(--fg) 6%,transparent);
 --mute:color-mix(in srgb,var(--fg) 62%,transparent);--acc:color-mix(in srgb,#3b82f6 80%,var(--fg));
 --bad:color-mix(in srgb,#ef4444 85%,var(--fg));--warn:color-mix(in srgb,#eab308 70%,var(--fg));
 --ring:color-mix(in srgb,#f59e0b 85%,var(--fg))}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.55 system-ui,sans-serif}
.layout{max-width:1120px;margin:0 auto;padding:16px 20px 48px}
body{container-type:inline-size}
/* A contained body no longer paints the page canvas: paint the root too, or short pages show white. */
html{background:var(--orca-background)}
h1{font-size:18px;margin:2px 0 4px;text-wrap:balance}h2{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:20px 0 6px}
.meta{color:var(--mute);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.chip{border:1px solid var(--line);border-radius:99px;padding:0 8px;font-size:11px}
.chip.bad{background:var(--bad);color:#fff;border-color:transparent}
button,textarea,input,select{font:inherit;color:inherit}
button{background:var(--soft);border:1px solid var(--line);border-radius:6px;padding:3px 10px;cursor:pointer;min-block-size:28px;min-inline-size:28px}
button:hover{background:var(--line)}button.pri{background:var(--acc);color:#fff;border-color:transparent}
button[aria-disabled=true]{opacity:.55;cursor:not-allowed}
/* Selected and focused look different: selection is a filled tint and a check mark, focus is an outside ring. */
button[aria-pressed=true]{background:color-mix(in srgb,var(--acc) 22%,transparent);border-color:var(--acc);font-weight:600}
button[aria-pressed=true]::before{content:"✓ "}
:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
@media(forced-colors:active){:focus-visible{outline-color:Highlight}button[aria-pressed=true]{border:2px solid SelectedItem}}
textarea,input[type=text]{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 8px}
.callout{border:1px solid var(--bad);border-radius:6px;padding:6px 10px;margin:10px 0}.callout.warn{border-color:var(--warn)}.callout.info{border-color:var(--line)}
.opt{display:flex;gap:8px;border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:4px 0;cursor:pointer}
.opt:has(input:checked){border-color:var(--acc);background:color-mix(in srgb,var(--acc) 10%,transparent)}
.opt:has(input:focus-visible){outline:2px solid var(--ring);outline-offset:2px}
dialog .note textarea{margin-top:4px}
.bar{display:flex;gap:6px;align-items:center;padding:6px 0;flex-wrap:wrap}.bar input{flex:1;min-width:140px}
.miss{display:grid;place-items:center;height:100%;color:var(--mute);text-align:center;padding:12px}
.note{border-left:3px solid var(--warn);padding:2px 8px;margin:8px 0}.note q{display:block;color:var(--mute);margin-bottom:2px}.note.stale{border-left-color:var(--bad)}
.strip{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0;list-style:none;padding:0}
.step{border:1px solid var(--line);border-radius:6px;padding:3px 9px;color:var(--mute)}
.step[aria-current=step]{color:var(--fg);border-color:var(--acc);font-weight:600}.step.bad[aria-current=step]{border-color:var(--bad)}
.pkg{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
#pop{position:fixed;display:none;z-index:950}
dialog{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:14px;width:min(440px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto}
dialog::backdrop{background:color-mix(in srgb,#000 45%,transparent)}
.rich p{margin:0 0 8px}.rich ul,.rich ol{margin:0 0 8px;padding-left:22px}.rich li{margin:2px 0}.rich a{color:var(--acc)}
.rich code{font:12px ui-monospace,monospace;background:var(--soft);padding:0 3px;border-radius:3px}
.ctx{color:var(--mute);margin:0 0 2px}
.pager{display:flex;gap:6px;align-items:center;color:var(--mute);margin:4px 0}
details{border-top:1px solid var(--line);padding:6px 0}details>summary{cursor:pointer;color:var(--mute);padding:2px 0}
.raw{white-space:pre-wrap;border-left:3px solid var(--line);padding:2px 10px;color:var(--mute);margin:6px 0}
.sr{position:absolute;left:-9999px}
.reply{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:8px 0}
.reply.fu{margin-left:18px;border-style:dashed}
.reply h3{margin:0 0 4px;font-size:12px;color:var(--mute);font-weight:600}
.set{max-width:760px;margin:0 auto;padding:16px 20px 48px}
.row2{display:grid;grid-template-columns:200px 1fr auto;gap:8px;align-items:start;margin:6px 0}@media(max-width:640px){.row2{grid-template-columns:1fr}}
.err{color:var(--bad);font-size:12px}
.prev{border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--soft)}

.d-app { --bg: var(--orca-background);
  --fg: var(--orca-foreground);
  --surface: color-mix(in oklab, var(--fg) 4%, var(--bg));
  --raised: color-mix(in oklab, var(--fg) 8%, var(--bg));
  --line: color-mix(in oklab, var(--fg) 15%, var(--bg));
  --line-soft: color-mix(in oklab, var(--fg) 9%, var(--bg));
  --muted: color-mix(in oklab, var(--fg) 62%, var(--bg));
  --accent: #4fc78f;
  --accent-ink: #062a1a;
  --accent-text: #6fdba7;
  --sel: color-mix(in oklab, var(--accent) 17%, var(--bg));
  --sel-line: var(--accent);
  --hover: color-mix(in oklab, var(--fg) 6%, var(--bg));
  --danger: #f0807a;
  --warn: #e3b55d;
  --info: #86a8f0;
  --note: #e8c75a;
  --note-bg: color-mix(in oklab, #e8c75a 30%, transparent);
  --sans: "Geist", system-ui, -apple-system, "Segoe UI", "Noto Sans", "Noto Sans CJK TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
  --r: 6px; }
:root.light .d-app { --accent: #1f8f5c; --accent-ink: #ffffff; --accent-text: #17724a;
  --danger: #b3261e; --warn: #85580a; --info: #2f55c8; --note: #8a6a00; --note-bg: color-mix(in oklab, #f3d36b 60%, transparent);
  --sel: color-mix(in oklab, var(--accent) 14%, var(--bg)); }
.d-app, .d-app * { box-sizing: border-box; }
.d-app button, .d-app input, .d-app select, .d-app textarea { font: inherit; color: inherit; }
.d-app button { cursor: pointer; }
.d-app :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
.d-app .d-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.d-app a { color: var(--accent-text); text-underline-offset: 2px; }
.d-app [hidden] { display: none !important; }
.d-app .d-app { height: 100dvh; display: grid; grid-template-rows: auto 1fr; min-width: 0; }
.d-app .d-topbar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--line-soft); font-size: 12px; color: var(--muted); min-width: 0; }
.d-app .d-crumbs { display: flex; gap: 6px; align-items: center; white-space: nowrap; }
.d-app .d-crumbs b { color: var(--fg); font-weight: 600; }
.d-app .d-banner { margin-inline-start: auto; display: flex; gap: 8px; align-items: center; min-width: 0; }
.d-app .d-banner span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px dashed var(--line); border-radius: 99px; padding: 1px 10px; }
.d-app .d-icon-btn { background: none; border: 1px solid transparent; border-radius: var(--r); min-width: 32px; height: 32px; display: inline-grid; place-items: center; color: var(--muted); padding: 0 6px; }
.d-app .d-icon-btn:hover { background: var(--hover); color: var(--fg); }
.d-app .d-workspace { min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
.d-app .d-workspace.d-has-sheet { grid-template-columns: minmax(0, 1fr) clamp(460px, 40vw, 780px); }
.d-app .d-list-side { min-width: 0; min-height: 0; display: flex; flex-direction: column; padding: 12px 16px 0; }
.d-app .d-tabs { display: inline-flex; background: var(--surface); border: 1px solid var(--line-soft); border-radius: 8px; padding: 2px; gap: 2px; align-self: flex-start; }
.d-app .d-tab { background: none; border: 0; border-radius: 6px; padding: 5px 12px; color: var(--muted); display: inline-flex; gap: 6px; align-items: center; min-height: 30px; }
.d-app .d-tab[aria-selected="true"] { background: var(--raised); color: var(--fg); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
.d-app .d-tab .d-n { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--muted); }
.d-app .d-tab[aria-selected="true"] .d-n { color: var(--accent-text); }
.d-app .d-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: end; margin-top: 10px; padding: 8px 10px 10px; background: var(--surface); border: 1px solid var(--line-soft); border-radius: 8px; }
.d-app .d-field { display: grid; gap: 2px; min-width: 0; }
.d-app .d-field > span { font-size: 11px; color: var(--muted); }
.d-app .d-field select, .d-app .d-field input[type=search] { height: 32px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r); padding: 0 8px; min-width: 120px; }
.d-app .d-field.d-grow { flex: 1 1 200px; }
.d-app .d-field.d-grow input { width: 100%; }
.d-app .d-btn { height: 32px; padding: 0 12px; border-radius: var(--r); border: 1px solid var(--line); background: var(--raised); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.d-app .d-btn:hover { background: color-mix(in oklab, var(--fg) 13%, var(--bg)); }
.d-app .d-btn.d-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); font-weight: 600; }
.d-app .d-btn.d-primary:hover { filter: brightness(1.07); }
.d-app .d-btn.d-ghost { background: none; border-color: transparent; color: var(--muted); }
.d-app .d-btn.d-ghost:hover { color: var(--fg); background: var(--hover); }
.d-app .d-btn[disabled] { opacity: .5; cursor: not-allowed; }
.d-app .d-filter-toggle { display: none; }
.d-app .d-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; align-items: center; }
.d-app .d-chip { display: inline-flex; align-items: center; gap: 4px; background: var(--raised); border: 1px solid var(--line); border-radius: 99px; padding: 0 4px 0 10px; height: 26px; font-size: 12px; }
.d-app .d-chip button { background: none; border: 0; width: 20px; height: 20px; border-radius: 50%; color: var(--muted); display: grid; place-items: center; padding: 0; }
.d-app .d-chip button:hover { background: var(--hover); color: var(--fg); }
.d-app .d-meta-line { font-size: 12px; color: var(--muted); margin: 8px 0 8px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.d-app .d-group-by { margin-inline-start: auto; display: inline-flex; gap: 6px; align-items: center; }
.d-app .d-group-by select { height: 26px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r); padding: 0 6px; font-size: 12px; }
.d-app .d-table-wrap { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--line-soft); border-bottom: 0; border-radius: 8px 8px 0 0; background: var(--surface); scroll-padding-top: 64px; }
.d-app table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 13px; }
.d-app thead th { position: sticky; top: 0; z-index: 3; background: var(--raised); text-align: start; font-weight: 500; font-size: 11px; color: var(--muted); padding: 7px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.d-app tbody td, .d-app tbody th { padding: 9px 10px; border-bottom: 1px solid var(--line-soft); vertical-align: top; text-align: start; font-weight: 400; }
.d-app tr.d-group th { position: sticky; top: 29px; z-index: 2; background: color-mix(in oklab, var(--fg) 6%, var(--bg)); font-size: 12px; font-weight: 600; padding: 5px 10px; border-bottom: 1px solid var(--line); }
.d-app tr.d-group .d-gc { color: var(--muted); font-weight: 400; margin-inline-start: 6px; }
.d-app tr.d-row { cursor: pointer; }
.d-app tr.d-row:hover td, .d-app tr.d-row:hover th { background: var(--hover); }
.d-app tr.d-row[data-sel] td, .d-app tr.d-row[data-sel] th { background: var(--sel); }
.d-app tr.d-row[data-sel] th { box-shadow: inset 4px 0 0 var(--sel-line); }
.d-app tr.d-row[data-sel] .d-title { color: var(--fg); }
.d-app .d-title { all: unset; cursor: pointer; font-weight: 600; font-size: 13.5px; line-height: 1.45; display: block; color: var(--fg); overflow-wrap: anywhere; }
.d-app .d-title:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.d-app .d-sub { font-size: 12px; color: var(--muted); margin-top: 2px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.d-app .d-bg-snip { color: var(--muted); font-size: 12.5px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; max-width: 46ch; }
.d-app .d-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--line); white-space: nowrap; }
.d-app .d-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.d-app .d-p-P0 { color: var(--danger); border-color: color-mix(in oklab, var(--danger) 55%, transparent); font-weight: 700; }
.d-app .d-p-P1 { color: var(--warn); border-color: color-mix(in oklab, var(--warn) 55%, transparent); font-weight: 600; }
.d-app .d-p-P2 { color: var(--info); border-color: color-mix(in oklab, var(--info) 50%, transparent); }
.d-app .d-p-P3 { color: var(--muted); }
.d-app .d-s-awaiting, .d-app .d-s-needs-you { color: var(--accent-text); }
.d-app .d-s-undelivered { color: var(--danger); border-color: color-mix(in oklab, var(--danger) 55%, transparent); }
.d-app .d-s-submitted, .d-app .d-s-saved { color: var(--warn); }
.d-app .d-s-received, .d-app .d-s-in-progress, .d-app .d-s-done { color: var(--muted); }
.d-app .d-due-over { color: var(--danger); font-weight: 600; }
.d-app .d-due-today { color: var(--warn); font-weight: 600; }
.d-app .d-tag { font-size: 11px; border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; color: var(--muted); background: var(--bg); }
.d-app .d-tag.d-pk { color: var(--info); }
.d-app .d-tag.d-bot { color: var(--accent-text); }
.d-app .d-empty { padding: 32px 16px; text-align: center; color: var(--muted); }
.d-app .d-empty b { display: block; color: var(--fg); margin-bottom: 4px; }
.d-app .d-col-bg { display: none; }
@container (min-width: 900px) {.d-app .d-col-bg { display: table-cell; }}
.d-app .d-list-side { container-type: inline-size; }
.d-app .d-nm { white-space: nowrap; }
.d-app .d-sheet { min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--bg); border-inline-start: 1px solid var(--line); box-shadow: -12px 0 24px -16px rgb(0 0 0 / .5); position: relative; }
.d-app .d-sheet.d-sheet-enter { animation: slide .18s ease-out; }
@keyframes slide { from { transform: translateX(24px); opacity: 0; } }
.d-app .d-sheet-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--line-soft); min-height: 48px; }
.d-app .d-sheet-head .d-where { font-size: 12px; color: var(--muted); }
.d-app .d-sheet-head .d-spacer { flex: 1; }
.d-app .d-pager { display: inline-flex; align-items: center; gap: 2px; border: 1px solid var(--line); border-radius: var(--r); padding: 0 2px; }
.d-app .d-pager span { font-size: 12px; padding: 0 6px; font-variant-numeric: tabular-nums; }
.d-app .d-pager .d-icon-btn { height: 28px; min-width: 28px; }
.d-app .d-back { display: none; }
.d-app .d-sheet-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 14px 18px 20px; scroll-padding-bottom: 24px; }
.d-app .d-sheet-body .d-prose, .d-app .d-sheet-body .d-opt-list, .d-app .d-sheet-body h2 { max-width: 70ch; }
.d-app .d-sheet-body h2 { font-size: 17px; line-height: 1.4; margin: 0 0 6px; text-wrap: balance; overflow-wrap: anywhere; font-weight: 650; }
.d-app .d-sheet-body h2:focus { outline: none; }
.d-app .d-srcline { font-size: 12.5px; color: var(--muted); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.d-app .d-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 6px 12px; margin: 10px 0 6px; padding: 8px 12px; background: var(--surface); border: 1px solid var(--line-soft); border-radius: 8px; max-width: none; }
.d-app .d-meta dt { font-size: 11px; color: var(--muted); }
.d-app .d-meta dd { margin: 0; font-size: 12.5px; font-weight: 500; overflow-wrap: anywhere; }
.d-app .d-rail { margin: 8px 0 4px; border: 1px solid var(--line-soft); border-radius: 8px; background: var(--surface); font-size: 12px; max-width: none; }
.d-app .d-rail > summary { list-style: none; padding: 6px 10px; display: flex; gap: 8px; align-items: center; cursor: pointer; color: var(--muted); min-height: 32px; }
.d-app .d-rail > summary::-webkit-details-marker { display: none; }
.d-app .d-rail > summary::before { content: "▸"; font-size: 10px; transition: transform .12s; }
.d-app .d-rail[open] > summary::before { transform: rotate(90deg); }
.d-app .d-rail .d-rail-title { color: var(--fg); font-weight: 600; }
.d-app .d-steps { display: flex; flex-wrap: wrap; gap: 4px 14px; padding: 2px 10px 10px; margin: 0; list-style: none; }
.d-app .d-steps li { display: flex; gap: 6px; align-items: baseline; color: var(--muted); }
.d-app .d-steps li::before { content: "○"; font-size: 11px; }
.d-app .d-steps li.d-done { color: var(--fg); }
.d-app .d-steps li.d-done::before { content: "●"; color: var(--accent); }
.d-app .d-steps li.d-bad { color: var(--danger); }
.d-app .d-steps li.d-bad::before { content: "▲"; color: var(--danger); }
.d-app .d-rail-note { padding: 0 10px 10px; color: var(--muted); }
.d-app .d-sec { padding: 9px 0 2px; border-top: 1px solid var(--line-soft); margin-top: 6px; }
.d-app .d-sec h3 { font-size: 12.5px; margin: 0 0 6px; font-weight: 650; }
.d-app .d-sec p { margin: 0 0 6px; }
.d-app .d-sec ul { margin: 0 0 8px; padding-inline-start: 20px; }
.d-app .d-prose { font-size: 14px; line-height: 1.7; overflow-wrap: anywhere; }
.d-app .d-prose :lang(zh), .d-app .d-prose { word-break: normal; line-break: strict; }
.d-app .d-opt-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.d-app .d-opt-list li { display: flex; gap: 8px; align-items: baseline; }
.d-app .d-opt-list kbd { font: 600 11px var(--mono); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; color: var(--muted); }
.d-app mark.d-n { background: var(--note-bg); color: inherit; border-bottom: 2px solid var(--note); border-radius: 2px; scroll-margin: 80px; }
.d-app mark.d-n.d-flash, .d-app .d-flash { animation: flash 1.4s ease-out; }
@keyframes flash { 0%, 40% { outline: 3px solid var(--note); outline-offset: 2px; } 100% { outline: 3px solid transparent; } }
.d-app .d-callout { margin: 10px 0; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); font-size: 13px; max-width: none; }
.d-app .d-callout.d-warn { border-color: color-mix(in oklab, var(--warn) 55%, transparent); }
.d-app .d-callout.d-err { border-color: color-mix(in oklab, var(--danger) 55%, transparent); }
.d-app .d-callout b { display: block; margin-bottom: 2px; }
.d-app .d-answers { display: grid; gap: 8px; }
.d-app .d-ans { border-inline-start: 2px solid var(--accent); padding: 2px 0 2px 10px; }
.d-app .d-ans .d-by { font-size: 12px; color: var(--muted); }
.d-app .d-ans .d-st { font-size: 12px; margin-top: 2px; }
.d-app .d-dock { flex: none; border-top: 1px solid var(--line); background: var(--surface); padding: 10px 18px 12px; display: grid; gap: 8px; box-shadow: 0 -8px 16px -12px rgb(0 0 0 / .5); position: relative; z-index: 10; }
.d-app .d-dock-row { display: flex; gap: 8px 12px; align-items: center; flex-wrap: wrap; }
.d-app .d-seg { display: inline-flex; border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }
.d-app .d-seg label { padding: 3px 12px; cursor: pointer; font-size: 12.5px; min-height: 28px; display: inline-flex; align-items: center; }
.d-app .d-seg input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.d-app .d-seg label:has(input:checked) { background: var(--accent); color: var(--accent-ink); font-weight: 600; }
.d-app .d-seg label:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 1px; }
.d-app .d-demo-tag { font-size: 11px; color: var(--muted); }
.d-app .d-opts { display: flex; gap: 6px; flex-wrap: wrap; }
.d-app .d-opt { border: 1px solid var(--line); background: var(--bg); border-radius: 99px; padding: 3px 12px; font-size: 12.5px; min-height: 28px; }
.d-app .d-opt[aria-pressed="true"] { background: var(--sel); border-color: var(--accent); color: var(--fg); font-weight: 600; }
.d-app .d-opt[aria-pressed="true"]::before { content: "✓ "; color: var(--accent-text); }
.d-app .d-dock textarea { width: 100%; resize: none; field-sizing: content; min-height: 3.2em; max-height: 9em; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r); padding: 7px 9px; line-height: 1.55; }
.d-app .d-dock textarea:focus-visible { outline-offset: 0; border-color: var(--accent); }
.d-app .d-dock-foot { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.d-app .d-notes-btn[aria-expanded="true"] { border-color: var(--note); }
.d-app .d-count { display: inline-grid; place-items: center; min-width: 18px; height: 18px; border-radius: 99px; background: var(--note); color: #000; font-size: 11px; font-weight: 700; padding: 0 5px; }
.d-app .d-count.d-zero { background: var(--line); color: var(--muted); }
.d-app .d-note { border: 1px solid var(--line); border-inline-start: 3px solid var(--note); border-radius: 6px; padding: 7px 9px; margin-bottom: 8px; background: var(--surface); }
.d-app .d-note .d-nq { font-size: 12px; color: var(--muted); display: flex; gap: 8px; align-items: center; }
.d-app .d-note .d-nq q { quotes: "“" "”"; color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 36ch; display: inline-block; vertical-align: bottom; }
.d-app .d-note img { width: 44px; height: 32px; object-fit: cover; border-radius: 3px; }
.d-app .d-note textarea { width: 100%; min-height: 2.6em; resize: vertical; background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 5px 7px; margin: 5px 0; field-sizing: content; max-height: 8em; }
.d-app .d-note .d-acts { display: flex; gap: 6px; }
.d-app .d-note .d-btn { height: 26px; font-size: 12px; padding: 0 8px; }
.d-app .d-ro-dock .d-cmd { font: 12.5px var(--mono); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; overflow-wrap: anywhere; }
@media (max-width: 899px) {.d-app .d-workspace.d-has-sheet { grid-template-columns: minmax(0, 1fr); } .d-app .d-sheet { position: fixed; inset: 0; z-index: 20; border: 0; } .d-app .d-sheet.d-sheet-enter { animation: rise .18s ease-out; } @keyframes rise { from { transform: translateY(16px); opacity: 0; } } .d-app .d-back { display: inline-flex; } .d-app .d-banner span { max-width: 38vw; } .d-app .d-banner .d-long { display: none; } .d-app .d-sheet-body, .d-app .d-dock { padding-inline: 16px; }}
@media (max-width: 899px) {.d-app .d-toolbar .d-field.d-sel { display: none; } .d-app .d-toolbar.d-open .d-field.d-sel { display: grid; } .d-app .d-toolbar .d-field.d-sel select { width: 100%; } .d-app .d-filter-toggle { display: inline-flex; } .d-app .d-toolbar .d-field.d-grow { flex: 1 1 140px; } .d-app thead { display: none; } .d-app table, .d-app tbody, .d-app tr.d-row, .d-app tr.d-row td, .d-app tr.d-row th, .d-app tr.d-group, .d-app tr.d-group th { display: block; } .d-app tr.d-row { padding: 8px 12px 10px; border-bottom: 1px solid var(--line-soft); } .d-app tr.d-row td, .d-app tr.d-row th { border: 0 !important; padding: 0; background: none !important; box-shadow: none !important; } .d-app tr.d-row td.d-c-meta { display: inline-block; margin: 6px 8px 0 0; } .d-app tr.d-row td.d-col-bg, .d-app tr.d-row td.d-c-ws { display: none; } .d-app tr.d-row[data-sel] { background: var(--sel); box-shadow: inset 4px 0 0 var(--sel-line); } .d-app tr.d-group th { top: 0; } .d-app .d-list-side { padding-inline: 10px; } .d-app .d-table-wrap { border-inline: 0; border-radius: 0; } .d-app .d-group-by { margin-inline-start: 0; }}
@media (prefers-reduced-motion: reduce) {.d-app .d-sheet, .d-app .d-sheet.d-sheet-enter { animation: none; } .d-app mark.d-n.d-flash, .d-app .d-flash { animation: none; outline: 3px solid var(--note); }}
.d-app .d-ws-inline { display: none; }
@media (max-width: 899px) {.d-app .d-ws-inline { display: inline; }}
@media (max-height: 760px) {.d-app .d-dock { padding-block: 8px 10px; gap: 6px; } .d-app .d-dock textarea { min-height: 2.5em; padding: 5px 8px; } .d-app .d-sheet-body { padding-top: 10px; }}
.d-app .d-crumbs .d-c1 {  }
@media (max-width: 899px) {.d-app .d-crumbs .d-c1, .d-app .d-crumbs .d-sep { display: none; } .d-app .d-banner { margin-inline-start: 0; flex: 1; justify-content: flex-end; } .d-app .d-banner span { max-width: none; flex: 1; text-align: center; } .d-app .d-dock { gap: 6px; } .d-app .d-dock-foot { gap: 8px; } .d-app .d-dock-foot .d-notes-btn { margin-inline-start: auto; } .d-app .d-demo-tag { display: none; }}
.d-app { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }

html,body{height:100%}
body:has(.d-app){overflow:hidden}
.d-app{height:100dvh;display:flex;flex-direction:column;min-height:0;font-size:13.5px}
.d-app.d-dash>.d-workspace{flex:1;min-height:0}
.d-app.d-solo>.d-sheet{flex:1;min-height:0;border-inline-start:0;box-shadow:none;animation:none}
.d-app .d-sheet-slot{min-width:0;min-height:0;display:flex}.d-app .d-sheet-slot>.d-sheet{flex:1}
.d-app .d-sheet-slot[hidden]{display:none}
.d-app h1{font-size:17px;line-height:1.4;margin:0 0 6px;text-wrap:balance;overflow-wrap:anywhere;font-weight:650}
.d-app h1:focus{outline:none}
.d-app .d-sec-h{font-size:12px;letter-spacing:0;text-transform:none;color:var(--muted);font-weight:600;margin:18px 0 6px}
.d-app .d-meta{border:1px solid var(--line-soft);border-radius:8px;padding:8px 12px;background:var(--surface)}
.d-app .d-pill.d-p-P0{color:var(--danger)}.d-app .d-pill.d-p-P1{color:var(--warn)}.d-app .d-pill.d-p-P2{color:var(--info)}
.d-app .d-tabs-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.d-app .d-tab{all:unset;cursor:pointer;padding:4px 12px;border-radius:6px;font-size:13px;display:inline-flex;gap:6px;align-items:center;min-height:28px}
.d-app .d-tab[aria-selected=true]{background:var(--raised);font-weight:600}
.d-app .d-tab:focus-visible{outline:2px solid var(--accent)}
.d-app .d-tab .d-n{font-size:11.5px;color:var(--muted)}
.d-app .d-ws-pick{margin-inline-start:auto}
.d-app .d-ws-select{height:30px;max-width:min(300px,60vw);background:var(--bg);border:1px solid var(--line);border-radius:var(--r);padding:0 8px}
.d-app .d-results{flex:1;min-height:0;display:flex;flex-direction:column}
.d-app .d-results>.d-table-wrap{flex:1}
.d-app .d-results>[data-k=dash-more]{align-self:center;margin:8px 0}
.d-app .d-c-wsh,.d-app .d-c-ws{display:none}@container (min-width:900px){.d-app .d-c-wsh,.d-app .d-c-ws{display:table-cell}}
.d-app tr.d-row{cursor:pointer}
.d-app thead th .d-sort{all:unset;cursor:pointer;display:inline-flex;align-items:center;min-height:24px;border-radius:4px;white-space:nowrap}
.d-app thead th .d-sort:hover{color:var(--fg)}.d-app thead th[aria-sort] .d-sort{color:var(--fg);font-weight:600}
.d-app thead th .d-sort:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* Below 900px the table has no column headers: a compact Sort select stands in for them. */
@media (min-width:900px){.d-app .d-toolbar .d-sortby{display:none}}
@media (max-width:899px){.d-app .d-toolbar .d-sortby{flex:1 1 140px}.d-app .d-toolbar .d-sortby select{width:100%;height:32px}}
.d-app tr.d-row[data-sel]{background:var(--sel);box-shadow:inset 3px 0 0 var(--sel-line)}
.d-app .d-title .qt{display:block}
.d-app button.qrow{all:unset;cursor:pointer;font-weight:600;font-size:13.5px;line-height:1.45;display:block;overflow-wrap:anywhere}
.d-app button.qrow:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* Narrative context: readable measure, headings, inert code, figures with captions. */
.d-app .rich{max-width:72ch;line-height:1.6}
.d-app .rich .rich-h{font-size:14.5px;margin:16px 0 6px;font-weight:650;letter-spacing:0;text-transform:none;color:var(--fg)}
.d-app .rich h3.rich-h{font-size:15.5px}
.d-app .rich p{margin:0 0 10px}
.d-app .rich a{color:var(--accent-text)}
.d-app .codeblock{position:relative;margin:8px 0 12px}
.d-app .codeblock pre{margin:0;padding:10px 12px;background:var(--surface);border:1px solid var(--line-soft);border-radius:var(--r);overflow:auto;font:12.5px/1.5 var(--mono);white-space:pre}
.d-app .codeblock pre code{font:inherit;background:none;padding:0}
.d-app .code-copy{position:absolute;top:4px;right:4px;min-width:28px;min-height:28px;padding:0;background:var(--raised);border:1px solid var(--line);border-radius:var(--r);color:var(--muted)}
.d-app .fig{margin:10px 0 14px;max-width:72ch}
.d-app .fig img{display:block;max-width:100%;height:auto;border:1px solid var(--line-soft);border-radius:var(--r)}
.d-app .fig .miss{border:1px dashed var(--line);border-radius:var(--r);min-height:72px;height:auto}
.d-app .fig figcaption{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:var(--muted);margin-top:4px}
.d-app .fig figcaption span:first-child{flex:1}
.d-app .fig figcaption button{position:relative;padding:0;background:none;border:1px solid transparent}
.d-app .fig .nb{position:absolute;top:-6px;right:-6px;background:var(--note);color:#000;border-radius:99px;font-size:10px;min-width:15px;line-height:15px}
.d-app .d-images,.d-app .d-details{border:1px solid var(--line-soft);border-radius:8px;background:var(--surface);padding:4px 10px;margin:12px 0 4px}
.d-app .d-details+.d-details{margin-top:6px}
.d-app .d-rail{margin:4px 0}
.d-app .d-rail .strip{margin:2px 0 8px;padding:0 6px}
/* Reply card: pager and recommendation at the top, then options, the text box and the actions. */
.d-app .d-dock{max-height:58%;overflow:auto;overscroll-behavior:contain}
.d-app .d-dock{min-height:min(196px,50dvh)}
.d-app .d-dock-head{justify-content:space-between;min-height:30px}
.d-app .d-dock-head .d-rec-label{font-size:12px;color:var(--muted);font-weight:600}
.d-app .d-pager{display:inline-flex;gap:2px;align-items:center;border:1px solid var(--line);border-radius:var(--r);padding:0 2px;font-size:12.5px;color:var(--fg);margin:0}
.d-app .d-pager .d-icon-btn{min-width:28px;height:28px;padding:0;border:0;background:none}
.d-app .d-pager .d-icon-btn[aria-disabled=true]{opacity:.35}
.d-app .d-rec{border-inline-start:3px solid var(--accent);background:var(--raised);border-radius:0 var(--r) var(--r) 0;padding:6px 10px;font-size:13px}
.d-app .d-rec-head{display:flex;justify-content:space-between;align-items:center}
.d-app .d-rec .d-rec-label{font-size:12px;font-weight:650}
.d-app .d-rec .d-rec-more{min-width:24px;height:24px;padding:0;border:0;background:none}
.d-app .d-rec-head{gap:4px 6px;flex-wrap:wrap}.d-app .d-rec-head .d-spacer{flex:1}
/* Nothing in the card may widen it past the sheet (380px minimum): one shrinkable column. */
.d-app .d-dock{grid-template-columns:minmax(0,1fr)}
/* Notes and Submit stay together on the right of the card. */
.d-app .d-dock .d-dock-foot .d-notes-btn{margin-inline-start:auto}
.d-app .d-sheet-body h2.d-sec-h{font-size:13.5px;line-height:1.4;color:var(--fg);font-weight:650;margin:20px 0 6px;padding-top:12px;border-top:1px solid var(--line-soft);text-transform:none;letter-spacing:0}
.d-app .d-meta>div{min-width:0}
.d-app .d-images>summary{cursor:pointer;color:var(--muted);padding:4px 0}
.d-app .d-rec .rich{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.d-app .d-rec.open .rich{display:block;max-height:26vh;overflow:auto}
.d-app .d-rec .rich p{margin:0 0 4px}
.d-app .d-ws-label{font-size:12px;color:var(--muted);margin-inline-end:8px}
.d-app .code-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--muted);padding:2px 0 4px}
.d-app .codeblock .code-copy{position:static}
.d-app .d-opts{display:flex;flex-wrap:wrap;gap:6px}
.d-app .d-opt{display:inline-flex;align-items:center;gap:6px;margin:0;padding:3px 12px;border-radius:99px;min-height:30px;border:1px solid var(--line);background:var(--bg);font-size:12.5px}
.d-app .d-opt input{position:absolute;opacity:0;width:1px;height:1px}
.d-app label.d-opt:has(input:checked){background:var(--sel);border-color:var(--accent);font-weight:600}
.d-app label.d-opt:has(input:checked)::before{content:"✓";color:var(--accent-text)}
.d-app .d-opt .meta{display:inline;font-weight:400}
.d-app .d-dock textarea{width:100%;resize:none;field-sizing:content;min-height:3.4em;max-height:9em;background:var(--bg);border:1px solid var(--line);border-radius:var(--r);padding:7px 9px;line-height:1.55}
.d-app .d-dock .callout{margin:0}
.d-app .d-dock-foot{display:flex;gap:8px 10px;align-items:center;flex-wrap:wrap}
.d-app .d-btn{height:32px;padding:0 12px;border-radius:var(--r);border:1px solid var(--line);background:var(--raised)}
.d-app .d-btn.d-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
.d-app .d-btn[aria-disabled=true]{opacity:.5}
/* Owner annotations: progress card, source actions, PM recommendation, image viewer, title-only rows. */
.d-app .d-progress{border:1px solid var(--line-soft);border-radius:8px;background:var(--surface);padding:6px 10px;margin:6px 0 4px}
.d-app .d-progress-head{display:flex;gap:4px 10px;align-items:center;flex-wrap:wrap}
.d-app .d-state-pill{display:inline-flex;align-items:center;border:1px solid var(--line);border-radius:99px;padding:1px 10px;font-size:12px;font-weight:600;color:var(--accent-text)}
.d-app .d-state-pill.bad{color:var(--danger);border-color:color-mix(in oklab,var(--danger) 55%,transparent)}
.d-app .d-progress-say{font-size:12.5px}
.d-app .d-milestones{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-wrap:wrap;gap:2px 16px;font-size:12px;color:var(--muted)}
.d-app .d-milestones b{color:var(--fg);font-weight:600}.d-app .d-milestones .d-next{color:var(--accent-text)}
.d-app .d-proposed,.d-app .d-confirm{background:var(--sel);border:1px solid var(--accent);border-radius:var(--r);padding:4px 8px;font-size:12.5px}
.d-app .d-proposed>span,.d-app .d-confirm>span{flex:1 1 200px}
.d-app tr.d-row[data-sel]{box-shadow:inset 4px 0 0 var(--sel-line)}.d-app .d-progress-head .d-bad{color:var(--danger)}
.d-app .d-srcline{align-items:center}
.d-app .d-src-act{display:inline-flex;align-items:center;gap:2px;font-size:12px;min-height:26px;padding:0 8px;border:1px solid var(--line);border-radius:99px;background:var(--bg);color:var(--fg);text-decoration:none}
.d-app .d-src-act:hover{background:var(--hover)}
.d-app .d-btn.d-sm{height:26px;padding:0 8px;font-size:12px}
.d-app .d-rec-head .d-btn.d-sm{margin-inline-start:6px}
.d-app .d-fig-open{all:unset;cursor:zoom-in;display:block;max-width:100%}.d-app .d-fig-open:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.d-zoom{position:fixed;inset:0;z-index:1000;height:100dvh;display:flex;flex-direction:column;background:color-mix(in oklab,var(--bg) 92%,#000)}
.d-zoom .d-zoom-bar{display:flex;gap:6px;align-items:center;padding:6px 12px;border-bottom:1px solid var(--line)}
.d-zoom .d-zoom-bar .d-spacer{flex:1}
.d-zoom .d-icon-btn{min-width:36px;height:36px;font-size:16px}
.d-zoom-stage{flex:1;min-height:0;overflow:hidden;display:grid;place-items:center;padding:12px;touch-action:none}
.d-zoom-stage img{max-width:100%;max-height:100%;object-fit:contain;transform-origin:center;user-select:none}
.d-zoom-stage.zoomed{cursor:grab}
.d-app .d-c-src{display:none}@container (min-width:900px){.d-app .d-c-src{display:table-cell}}
.d-app .d-filters-btn{display:none}
/* Grouping: a labelled view control set apart from the filters, and group headings as clear bands. */
.d-app .d-toolbar .d-groupby{margin-inline-start:auto;padding-inline-start:12px;border-inline-start:1px solid var(--line)}
.d-app .d-toolbar .d-groupby>span{color:var(--fg);font-weight:600}
.d-app .d-toolbar .d-groupby select{height:32px;min-width:120px;background:var(--raised);border:1px solid var(--line);border-radius:var(--r);padding:0 8px;font-weight:600}
.d-app tr.d-group th{padding:18px 12px 6px;background:var(--bg);border-top:1px solid var(--line);border-bottom:2px solid var(--line);font-size:13px;font-weight:650;color:var(--fg)}
.d-app tbody tr.d-group:first-child th{padding-top:10px;border-top:0}
.d-app tr.d-group .d-gc{display:inline-grid;place-items:center;min-width:22px;height:20px;padding:0 6px;margin-inline-start:8px;border-radius:99px;background:var(--raised);border:1px solid var(--line);font-size:11.5px;font-weight:600;color:var(--fg)}
@media (max-width:899px){.d-app .d-toolbar .d-groupby{margin-inline-start:0;border:0;padding:0;flex:1 1 140px}.d-app .d-toolbar .d-groupby select{width:100%}}
/* Resizable sheet: a 0-width grid track holding a 12px hit area over the boundary. */
.d-app .d-workspace.d-has-sheet{grid-template-columns:minmax(0,1fr) 0 var(--sheet-w,clamp(460px,40vw,780px))}
.d-app .d-divider{display:none}
.d-app .d-workspace.d-has-sheet>.d-divider{display:block;position:relative;z-index:5;width:0;cursor:col-resize;touch-action:none}
.d-app .d-divider::before{content:"";position:absolute;inset:0 -6px;}
.d-app .d-divider::after{content:"";position:absolute;top:50%;left:-2px;width:4px;height:40px;margin-top:-20px;border-radius:2px;background:var(--line);transition:background .12s}
.d-app .d-divider:hover::after,.d-app .d-divider.d-dragging::after,.d-app .d-divider:focus-visible::after{background:var(--accent);height:72px;margin-top:-36px}
.d-app .d-divider:focus-visible{outline:none}
.d-app .d-divider:focus-visible::before{outline:2px solid var(--accent);outline-offset:-4px;border-radius:4px}
@media (max-width:899px){.d-app .d-workspace.d-has-sheet{grid-template-columns:minmax(0,1fr)}.d-app .d-workspace.d-has-sheet>.d-divider,.d-app .d-wide-only{display:none}}
/* Note composer and saved notes. */
.d-nc{position:fixed;z-index:900;height:auto;width:min(360px,calc(100vw - 16px));background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:0 12px 32px -12px rgb(0 0 0 / .6);padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.d-nc.d-nc-sheet{left:0;right:0;bottom:0;top:auto;width:auto;border-radius:10px 10px 0 0;max-height:70dvh;overflow:auto}
.d-nc .d-nc-quote{margin:0;padding:4px 8px;border-inline-start:3px solid var(--note);background:var(--note-bg);font-size:12.5px;max-height:6em;overflow:auto;white-space:pre-wrap}
.d-nc textarea{width:100%;resize:vertical;min-height:4.2em;background:var(--bg);border:1px solid var(--line);border-radius:var(--r);padding:6px 8px}
.d-nc>*{flex-shrink:0}
.d-nc .d-nc-thumb{display:block;max-width:100%;max-height:96px;margin:2px 0 0;border-radius:4px;align-self:flex-start}
.d-app mark.d-n{cursor:pointer}
.d-nc .d-nc-err{margin:0;color:var(--danger);font-size:12px}
.d-nc .d-nc-foot{display:flex;gap:8px;align-items:center;justify-content:flex-end}
.d-app .d-note-saved{font-size:12.5px;color:var(--muted)}.d-app .d-note-saved>span{flex:1 1 200px}
.d-app mark.d-n{background:var(--note-bg);color:inherit;border-bottom:2px solid var(--note);border-radius:2px}
.d-app mark.d-n.d-flash{outline:3px solid var(--note);outline-offset:2px}
@media (max-width:899px){.d-app tr.d-row td.d-c-ws,.d-app tr.d-row td.d-c-src,.d-app tr.d-row td.d-c-meta{display:inline-block;font-size:12px;color:var(--muted);padding:0 8px 8px 0;border:0}
 .d-app tr.d-row th{border:0;padding-bottom:4px}.d-app tr.d-row{border-bottom:1px solid var(--line-soft);padding:8px 12px}.d-app tr.d-row td.d-no-due{display:none}
 .d-app .d-filters-btn{display:inline-flex;align-items:center}.d-app .d-toolbar .d-field.d-grow{flex:1 1 140px}}
@media (max-width:899px){.d-app .d-dock{max-height:58dvh}.d-app .d-tabs-row{flex-wrap:nowrap}.d-app .d-ws-label{display:none}.d-app .d-ws-pick{min-width:0;flex:0 1 auto}.d-app .d-ws-select{max-width:100%;width:100%}.d-app .d-tab{padding:4px 8px}}
@media (max-height:560px){.d-app .d-dock{max-height:72dvh;gap:5px;padding-block:6px 8px;min-height:0}.d-app .d-rec{padding:4px 8px}.d-app .d-rec .rich{-webkit-line-clamp:2}
 .d-app .d-dock textarea{min-height:2.4em;max-height:5em}.d-app .d-dock-foot{justify-content:flex-end}
 .d-app .d-btn{height:30px}.d-app .d-opt{min-height:28px}}
/* Inbox / Practice switch: always visible above the queue, also when the sheet covers it (narrow). */
.d-app .d-mode{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:2px 0 8px}
.d-app .d-mode-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.d-app .d-mode-seg button{appearance:none;border:0;background:transparent;color:var(--fg);font:inherit;font-size:12.5px;padding:5px 12px;cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.d-app .d-mode-seg button+button{border-inline-start:1px solid var(--line)}
.d-app .d-mode-seg button[aria-pressed="true"]{background:var(--sel);font-weight:600}
.d-app .d-mode-seg button:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.d-app .d-mode-seg .d-practice-tag{font-size:10.5px;font-weight:600;letter-spacing:.02em;border-radius:999px;padding:0 6px;border:1px solid var(--info,#6b8cff);color:var(--info,#8aa4ff)}
.d-app .d-mode-say{font-size:12px;color:var(--muted);min-width:0}
.d-app .d-practice-note{border:1px solid color-mix(in oklab,var(--info,#6b8cff) 55%,var(--line));background:color-mix(in oklab,var(--info,#6b8cff) 8%,var(--bg));border-radius:8px;padding:7px 10px;margin:4px 0 8px;font-size:12.5px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.d-app .d-practice-note b{font-weight:600}
.d-app .d-ws-static{font-size:12.5px;color:var(--muted);white-space:nowrap}
/* One collapsible source status instead of a banner per source. */
.d-app .d-srcstat{border:1px solid var(--line-soft);border-radius:8px;margin:4px 0 8px;font-size:12.5px}
.d-app .d-srcstat.warn{border-color:color-mix(in oklab,var(--warn) 70%,var(--line))}
.d-app .d-srcstat>summary{cursor:pointer;padding:5px 10px;color:var(--muted);list-style-position:inside}
.d-app .d-srcstat.warn>summary{color:var(--fg)}
.d-app .d-srcstat>summary::marker{color:var(--muted)}
.d-app .d-srcstat ul{margin:0;padding:2px 12px 8px 28px;display:grid;gap:4px}
.d-app .d-srcstat li b{font-weight:600}
.d-app .d-srcstat li.warn b{color:var(--warn)}
.d-app .d-srcstat .d-srcstat-act{margin:0 10px 8px}
/* Where an answer goes, said at the reply; stays visible on short and narrow windows. */
.d-app .d-reach{font-size:11.5px;color:var(--muted);margin:0}
.d-app .d-reach.d-reach-local{color:var(--fg)}
.d-app .d-reach.d-reach-local::before{content:'◆ ';color:var(--info,#8aa4ff)}
.d-app .d-try-practice{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--muted);margin:0}
`
