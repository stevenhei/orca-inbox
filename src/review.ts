import type { Annotation, Answer, Decision, Delivery, Evidence, RecordedReply, SubmitReply, VisibleInlineImage, Workspace } from './contract.ts'
import type { DecisionPage, EffectivePolicy, InboxSettings } from './backend-protocol.ts'
import { variantDCss } from './dashboard-style.ts'
import { tokenizeInline, type InlineToken } from './markdown-inline.ts'
import { STATE_LABEL, actionsOf, deadlineLabel, group, isActionable, nativeOf, nativeStatusLabel, order, replyState, shownState, type NativeSource, type ShownState } from './model.ts'
import {
  call, clock, draftIsEmpty, emptyDraft, failureText, formatInstant, newReplyId, reconcile, replies,
  sourcesOf, transportOf, type Draft, type Failure, type Requester, type SourceStatus
} from './client.ts'

// Wide review tab: an isolated custom editor on a `.orca-decision` reference file whose content is
// `{"questionId": "..."}` (a review), `{"view": "dashboard"}` (queue + reader in one tab) or
// `{"view": "settings"}` (Inbox Settings). Every decision,
// draft, reply, snapshot and setting comes from the plugin worker; there is no fixture fallback.
// Plain DOM, themed only through `--orca-*` (only foreground/background are confirmed, so the rest
// is derived with color-mix). Notes live in a sticky sidebar; below 800px they move to a modal.
//
// Truthfulness rules: the delivery strip only shows what the worker recorded. A reply is never
// shown as accepted before `submitReply` returns it, and Agent received needs a receipt that
// matches the reply, question and exact origin (see `replyState`).

const css = `
:root{--fg:var(--orca-foreground);--bg:var(--orca-background);
 --line:color-mix(in srgb,var(--fg) 18%,transparent);--soft:color-mix(in srgb,var(--fg) 6%,transparent);
 --mute:color-mix(in srgb,var(--fg) 62%,transparent);--acc:color-mix(in srgb,#3b82f6 80%,var(--fg));
 --bad:color-mix(in srgb,#ef4444 85%,var(--fg));--warn:color-mix(in srgb,#eab308 70%,var(--fg));
 --ring:color-mix(in srgb,#f59e0b 85%,var(--fg))}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.55 system-ui,sans-serif}
.layout{max-width:1120px;margin:0 auto;padding:16px 20px 48px;display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}
/* The reader's own width decides its layout (container queries), so a reader beside the dashboard
   queue drops the Notes sidebar for the Notes dialog even in a wide window. */
body{container-type:inline-size}
/* A contained body no longer paints the page canvas: paint the root too, or short pages show white. */
html{background:var(--orca-background)}
@container (max-width:820px){.layout{grid-template-columns:minmax(0,1fr);padding:12px 14px 32px}.side{display:none}}
@container (min-width:821px){.only-narrow{display:none}}
.layout>main.full{grid-column:1/-1}
.side{position:sticky;top:12px;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:calc(100vh - 24px);overflow:auto}
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
.film{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
.vp{display:grid;grid-template-columns:minmax(0,1fr);gap:10px}.vp.pair{grid-template-columns:repeat(2,minmax(0,1fr))}
@media(max-width:640px){.vp.pair{grid-template-columns:minmax(0,1fr)}}
.view{height:340px;overflow:auto;background:var(--soft);border:1px solid var(--line);border-radius:8px}.vp.pair .view{height:260px}
dialog .note textarea{margin-top:4px}
.view img{display:block;height:auto;max-width:none}
.bar{display:flex;gap:6px;align-items:center;padding:6px 0;flex-wrap:wrap}.bar input{flex:1;min-width:140px}
.miss{display:grid;place-items:center;height:100%;color:var(--mute);text-align:center;padding:12px}
.note{border-left:3px solid var(--warn);padding:2px 8px;margin:8px 0}.note q{display:block;color:var(--mute);margin-bottom:2px}.note.stale{border-left-color:var(--bad)}
.strip{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0;list-style:none;padding:0}
.step{border:1px solid var(--line);border-radius:6px;padding:3px 9px;color:var(--mute)}
.step[aria-current=step]{color:var(--fg);border-color:var(--acc);font-weight:600}.step.bad[aria-current=step]{border-color:var(--bad)}
.pkg{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
#pop{position:fixed;display:none;z-index:5}
dialog{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:14px;width:min(440px,92vw)}
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
`
/* Variant D additions for this editor: the reader sheet fills the frame, its body scrolls on its own
   and the reply card sits below it, so a short viewport or an open keyboard shrinks the body, never the
   card's controls. */
const dCss = `
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
.d-app .d-rec-head{gap:6px}.d-app .d-rec-head .d-spacer{flex:1}
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
.d-app .d-dock-foot .d-hint{flex:1 1 180px;font-size:11.5px;color:var(--muted);min-width:0}
.d-app .d-btn{height:32px;padding:0 12px;border-radius:var(--r);border:1px solid var(--line);background:var(--raised)}
.d-app .d-btn.d-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
.d-app .d-btn[aria-disabled=true]{opacity:.5}
.d-app .d-notes-panel{z-index:4}
.d-app .d-notes-panel[hidden]{display:none}
.d-app .d-notes-head{display:flex;justify-content:flex-end;margin-bottom:-28px}
.d-app .d-notes-panel .side,.d-app .d-notes-panel{position:absolute}
.d-app .d-sheet .side{max-height:min(52dvh,420px)}
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
.d-app .d-use-rec{gap:6px 10px}.d-app .d-use-rec .d-hint{font-size:11.5px;color:var(--muted);flex:1 1 160px}
.d-app .d-fig-open{all:unset;cursor:zoom-in;display:block;max-width:100%}.d-app .d-fig-open:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.d-zoom{position:fixed;inset:0;z-index:1000;height:100dvh;display:flex;flex-direction:column;background:color-mix(in oklab,var(--bg) 92%,#000)}
.d-zoom .d-zoom-bar{display:flex;gap:6px;align-items:center;padding:6px 12px;border-bottom:1px solid var(--line)}
.d-zoom .d-zoom-bar .d-spacer{flex:1}.d-zoom .d-zoom-level{font-size:12px;color:var(--muted);min-width:3.5em}
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
.d-nc .d-nc-err{margin:0;color:var(--danger);font-size:12px}
.d-nc .d-nc-foot{display:flex;gap:8px;align-items:center}.d-nc .d-nc-foot .d-hint{flex:1;font-size:11.5px;color:var(--muted)}
.d-app .d-note-saved{font-size:12.5px;color:var(--muted)}.d-app .d-note-saved>span{flex:1 1 200px}
.d-app mark.d-n{background:var(--note-bg);color:inherit;border-bottom:2px solid var(--note);border-radius:2px}
.d-app mark.d-n.d-flash{outline:3px solid var(--note);outline-offset:2px}
@media (max-width:899px){.d-app tr.d-row td.d-c-ws,.d-app tr.d-row td.d-c-src,.d-app tr.d-row td.d-c-meta{display:inline-block;font-size:12px;color:var(--muted);padding:0 8px 8px 0;border:0}
 .d-app tr.d-row th{border:0;padding-bottom:4px}.d-app tr.d-row{border-bottom:1px solid var(--line-soft);padding:8px 12px}.d-app tr.d-row td.d-no-due{display:none}
 .d-app .d-filters-btn{display:inline-flex;align-items:center}.d-app .d-toolbar .d-field.d-grow{flex:1 1 140px}}
@media (max-width:899px){.d-app .d-dock{max-height:58dvh}.d-app .d-tabs-row{flex-wrap:nowrap}.d-app .d-ws-label{display:none}.d-app .d-ws-pick{min-width:0;flex:0 1 auto}.d-app .d-ws-select{max-width:100%;width:100%}.d-app .d-tab{padding:4px 8px}}
@media (max-height:560px){.d-app .d-dock{max-height:72dvh;gap:5px;padding-block:6px 8px;min-height:0}.d-app .d-rec{padding:4px 8px}.d-app .d-rec .rich{-webkit-line-clamp:2}
 .d-app .d-dock textarea{min-height:2.4em;max-height:5em}.d-app .d-use-rec .d-hint,.d-app .d-dock-foot .d-hint{display:none}.d-app .d-dock-foot{justify-content:flex-end}
 .d-app .d-btn{height:30px}.d-app .d-opt{min-height:28px}}
`
document.head.append(Object.assign(document.createElement('style'), { textContent: css + variantDCss + dCss }))
// Variant D's light palette: follow Orca's background luminance.
{
  const probe = typeof getComputedStyle !== 'function' ? '' : getComputedStyle(document.documentElement).getPropertyValue('--orca-background').trim()
  const m = /^#([0-9a-f]{6})$/i.exec(probe)
  if (m) { const v = parseInt(m[1], 16); const l = (0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255; document.documentElement.classList.toggle('light', l > 0.6) }
}

type K = Record<string, unknown>
/** `data-k` names an element across re-renders so focus and caret survive them. */
function el<T extends HTMLElement>(tag: string, props: K = {}, ...kids: (Node | string)[]): T {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    else if (k === 'class') n.className = String(v)
    // ARIA states are strings: aria-pressed must be "true" or "false", never an empty attribute.
    else if (k.startsWith('aria-') && typeof v === 'boolean') n.setAttribute(k, String(v))
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : String(v))
  }
  n.append(...kids)
  return n as T
}
const field = (tag: 'textarea' | 'input', props: K, value: string) => {
  const f = el<HTMLTextAreaElement | HTMLInputElement>(tag, props)
  f.value = value
  if (tag === 'textarea') f.textContent = value
  return f
}

const req: Requester = (name, input, options) =>
  (orca.plugin.request as unknown as Requester)(name, input, options)

// ---- safe Markdown (paragraphs, line breaks, lists, bold, links, code) -----------------------------
// Built from text nodes only (never innerHTML). Each text node records the offset of its text in the
// raw source string, so a selection maps back to exact UTF-16 offsets for anchored notes.
const rawOffset = new WeakMap<Node, number>()
const textAt = (s: string, at: number) => { const n = document.createTextNode(s); rawOffset.set(n, at); return n }
const LIST = /^(\s*)([-*+]|\d+[.)])\s+/
function inline(parent: HTMLElement, raw: string, start: number, end: number) {
  // Boundaries (bare URLs, CJK punctuation, balanced brackets, http(s) only) come from the shared
  // tokenizer; every node keeps its offset in the raw string.
  appendTokens(parent, tokenizeInline(raw, start, end))
}
function appendTokens(parent: HTMLElement, tokens: InlineToken[]) {
  for (const t of tokens) {
    if (t.kind === 'text') parent.append(t.at < 0 ? document.createTextNode(t.text) : textAt(t.text, t.at))
    else if (t.kind === 'strong') { const b = el('strong'); appendTokens(b, t.children); parent.append(b) }
    else if (t.kind === 'code') parent.append(el('code', {}, textAt(t.text, t.at)))
    else {
      const href = t.href
      parent.append(el('a', { href, onclick: (ev: Event) => { ev.preventDefault(); void openLink(href) } }, textAt(t.text, t.at)))
    }
  }
}
/**
 * Block Markdown for the agent's narrative: headings, paragraphs (with line breaks), lists, inline
 * formatting and links, fenced code (inert, with Copy) and inline images placed at the worker's
 * `inlineImages` offsets (before a line or at the end, never inside a fence). Every text node keeps
 * its offset in the raw string, so text notes keep exact UTF-16 anchors.
 */
function rich(raw: string, attrs: K = {}, images: readonly VisibleInlineImage[] = [], x?: Decision): HTMLElement {
  const box = el('div', { class: 'rich', ...attrs })
  const lines: { text: string; at: number }[] = []
  let at = 0
  for (const text of raw.split('\n')) { lines.push({ text, at }); at += text.length + 1 }
  let para: HTMLElement | null = null
  let list: HTMLElement | null = null
  let fence: { mark: string; code: HTMLElement; text: string[] } | null = null
  let next = 0
  const place = (upTo: number) => {
    while (next < images.length && images[next].offset <= upTo) { box.append(figure(images[next], x)); next++; para = null; list = null }
  }
  for (const line of lines) {
    if (fence) {
      if (line.text.trim().startsWith(fence.mark)) { fence = null; continue }
      fence.code.append(textAt(line.text + '\n', line.at)); fence.text.push(line.text); continue
    }
    place(line.at)
    const f = /^ {0,3}(```+|~~~+)\s*([\w+-]*)/.exec(line.text)
    if (f) {
      const code = el('code', f[2] ? { 'data-lang': f[2] } : {})
      const text: string[] = []
      const copyBtn = el('button', { type: 'button', class: 'code-copy', 'aria-label': `Copy ${f[2] ? `${f[2]} ` : ''}code`, title: 'Copy',
        onclick: () => copy(text.join('\n'), 'Code') }, '⧉')
      // Inert: shown as text, never run. Copy only.
      box.append(el('div', { class: 'codeblock' }, el('div', { class: 'code-head' }, el('span', {}, `${f[2] || 'text'} · copy only, never run by Inbox`), copyBtn), el('pre', { tabindex: 0 }, code)))
      fence = { mark: f[1][0].repeat(3), code, text }; para = null; list = null; continue
    }
    const h = /^ {0,3}(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line.text)
    if (h) {
      const level = Math.min(6, h[1].length + 2) // the question title is h1; narrative headings start at h3
      const head = el(`h${level}`, { class: 'rich-h' }); inline(head, raw, line.at + line.text.indexOf(h[2]), line.at + line.text.indexOf(h[2]) + h[2].length)
      box.append(head); para = null; list = null; continue
    }
    const m = LIST.exec(line.text)
    if (!line.text.trim()) { para = null; list = null; continue }
    if (m) {
      const ordered = /\d/.test(m[2])
      if (!list || list.tagName !== (ordered ? 'OL' : 'UL')) { list = el(ordered ? 'ol' : 'ul'); box.append(list) }
      const li = el('li'); inline(li, raw, line.at + m[0].length, line.at + line.text.length); list.append(li)
      para = null
    } else {
      list = null
      if (!para) { para = el('p'); box.append(para) } else para.append(el('br'))
      inline(para, raw, line.at, line.at + line.text.length)
    }
  }
  place(Infinity)
  return box
}

/**
 * One inline image: the exact authorized evidence version through getSnapshot, its plain-text
 * caption, and a labelled control to annotate it. Denied or missing placements are a placeholder
 * with no image metadata.
 */
function figure(p: VisibleInlineImage, x?: Decision): HTMLElement {
  const ev = x && !('unavailable' in p) ? x.evidence.find((e): e is Img => e.kind === 'image-snapshot' && e.evidenceId === p.evidenceId && e.version === p.version) : undefined
  if (!ev || 'unavailable' in p) return el('figure', { class: 'fig unavailable' }, el('div', { class: 'miss', role: 'img', 'aria-label': 'Image unavailable' }, 'Image unavailable'))
  ensureSnapshot(ev)
  const snap = snaps.get(ev.attachmentId)!
  const notesHere = draft.annotations.filter((n) => n.kind === 'image' && n.evidence.evidenceId === ev.evidenceId && n.evidence.version === ev.version).length
  const media = snap.state === 'ok' ? el('button', { type: 'button', class: 'd-fig-open', 'data-k': `fig-open-${ev.evidenceId}`, 'aria-label': `Enlarge ${ev.label}`, title: 'Enlarge',
      onclick: (e: Event) => openZoom(ev, snap.url, e.currentTarget as HTMLElement) },
      el('img', { src: snap.url, alt: ev.alt, width: ev.width, height: ev.height, loading: 'lazy' }))
    : snap.state === 'loading' ? el('div', { class: 'miss', style: `aspect-ratio:${ev.width}/${ev.height}` }, `Loading ${ev.label}…`)
    : el('div', { class: 'miss' }, snap.f.code === 'forbidden' ? 'You do not have access to this image.' : 'Image unavailable.')
  return el('figure', { class: 'fig', 'data-evidence': ev.evidenceId },
    media,
    el('figcaption', {},
      el('span', {}, p.caption ?? ev.label),
      ...(snap.state === 'ok' ? [el('button', { type: 'button', class: 'icon', 'data-k': `fig-full-${ev.evidenceId}`, 'aria-label': `Open ${ev.label} full screen`, title: 'Full screen',
        onclick: (e: Event) => openZoom(ev, snap.url, e.currentTarget as HTMLElement) }, '⤢')] : []),
      el('button', { type: 'button', class: 'icon', 'data-k': `fig-note-${ev.evidenceId}`, 'aria-label': `Add a note on ${ev.label}${notesHere ? `, ${notesHere} note${notesHere > 1 ? 's' : ''}` : ''}`, title: 'Add note',
        onclick: (e: Event) => noteOnImage(ev, e.currentTarget as HTMLElement, p.caption ?? ev.label) }, '✎', ...(notesHere ? [el('span', { class: 'nb' }, String(notesHere))] : []))))
}
/** Raw [start, end) of a selection inside a rich field, from its text nodes' recorded offsets. */
function rawRange(r: Range, field: Element): [number, number] | null {
  let start = Infinity, end = -Infinity
  const walk = (n: Node) => {
    const at = rawOffset.get(n)
    if (at !== undefined && r.intersectsNode(n)) {
      const len = (n.textContent ?? '').length
      const s = n === r.startContainer ? r.startOffset : 0
      const e = n === r.endContainer ? r.endOffset : len
      start = Math.min(start, at + s); end = Math.max(end, at + e)
    }
    n.childNodes.forEach(walk)
  }
  walk(field)
  return end > start ? [start, end] : null
}

// ---- reference file ---------------------------------------------------------------------------
type Ref = { view: 'review'; questionId: string } | { view: 'settings' } | { view: 'dashboard' } | { view: 'invalid' }
const readRef = (text: string): Ref => {
  try {
    const v = JSON.parse(text)
    if (v?.view === 'settings') return { view: 'settings' }
    if (v?.view === 'dashboard') return { view: 'dashboard' }
    if (typeof v?.questionId === 'string' && v.questionId) return { view: 'review', questionId: v.questionId }
  } catch { /* fall through */ }
  return { view: 'invalid' }
}
const session = orca.document ? await orca.document.session<string>({ merge: (_b, outside) => outside }) : null
let ref: Ref = readRef(session?.value ?? '')

const root = el('div', { class: 'layout' })
const pop = el<HTMLButtonElement>('button', { id: 'pop', class: 'pri', type: 'button', onclick: () => addQuoteNote(),
  // Keep the text selection while pressing the button.
  onpointerdown: (e: Event) => e.preventDefault() }, 'Add note (Alt+N)')
const live = el('div', { class: 'sr', role: 'status', 'aria-live': 'polite' })
const composer = el<HTMLDialogElement>('dialog', { 'aria-labelledby': 'cmp-h' })
document.body.append(root, pop, live, composer)
const narrow = matchMedia('(max-width: 800px)')
narrow.addEventListener('change', () => render())
const say = (m: string) => { live.textContent = m }
/** Notes use the dialog when the reader is too narrow for its sidebar (window or container). */
const notesInDialog = () => {
  if (narrow.matches) return true
  const side = root.querySelector('aside.side')
  return !!side && typeof getComputedStyle === 'function' && getComputedStyle(side).display === 'none'
}

// ---- background re-renders wait for the owner ---------------------------------------------------
// render() rebuilds the DOM. Background causes (worker invalidations, the minute clock, snapshot
// loads, save status) go through requestRender(), which waits while the owner is typing in a text
// field, composing with an IME, pressing a control, or holding a text selection, then renders once.
let composing = false
let pointerDown = false
let pendingRender = false
let pendingAnnounced = false
const isTextEntry = (e: Element | null) => !!e && root.contains(e) &&
  (e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && ['text', 'search', ''].includes((e as HTMLInputElement).type ?? '')))
const busy = () => composing || pointerDown || quote !== null || composer.open || nc !== null || isTextEntry(document.activeElement)
function requestRender(external = false) {
  if (!busy()) { render(); return }
  pendingRender = true
  if (external && !pendingAnnounced) { pendingAnnounced = true; say('This decision changed elsewhere. The page updates when you leave the field.') }
}
function flushSoon() {
  if (!pendingRender) return
  setTimeout(() => { if (pendingRender && !busy()) render() }, 0)
}
document.addEventListener('compositionstart', () => { composing = true }, true)
document.addEventListener('compositionend', () => { composing = false; flushSoon() }, true)
document.addEventListener('pointerdown', () => { pointerDown = true }, true)
const released = () => { pointerDown = false; flushSoon() }
document.addEventListener('pointerup', released, true)
document.addEventListener('pointercancel', released, true)
root.addEventListener('focusout', () => flushSoon())
composer.addEventListener('close', () => render())

/** role="alert" only when the alert is new, so a re-render does not announce it again. */
let shownAlerts = new Set<string>()
let nextAlerts = new Set<string>()
const alertRole = (key: string): K => { nextAlerts.add(key); return shownAlerts.has(key) ? {} : { role: 'alert' } }

// ---- review state (bound to one question ID) ----------------------------------------------------
type Notice = { tone: 'bad' | 'warn' | 'info'; text: string; retry?: boolean; notes?: boolean }
type Snap = { state: 'loading' } | { state: 'ok'; url: string } | { state: 'fail'; f: Failure }
let d: Decision | null = null
let loadFail: Failure | null = null
let pkg: Decision[] = []
let pkgFail: Failure | null = null
/** The package page had more rows: its total is not known. */
let pkgMore = false
let draft: Draft = emptyDraft()
let draftFor: string | null = null
let draftFail: Failure | null = null
let notice: Notice | null = null
let sending = false
let seq = 0
const snaps = new Map<string, Snap>()
let a = 0 // primary snapshot index
let b: number | null = null // optional second snapshot for side-by-side
let target: 'left' | 'right' = 'right'
const zoom = new Map<string, number>()
type Quote = { field: 'background' | 'recommendation'; text: string; start: number; end: number }
let quote: Quote | null = null
let focusNote: number | null = null

/** What the owner is told about a recorded reply: only its actual state and receipt. */
function recordedNotice(r: RecordedReply, x: Decision, own: boolean): Notice {
  const state = replyState(r, x)
  const receipt = state === 'agent-received' && r.delivery.state === 'agent-received' ? `, receipt ${r.delivery.receipt.receiptId}` : ''
  const what = r.kind === 'initial' ? 'answer' : 'follow-up'
  return own
    ? state === 'undelivered' && r.delivery.state === 'undelivered'
      ? { tone: 'warn', text: `Your ${what} is saved in Decision Inbox (reply ID ${r.replyId}) but was not delivered to the original chat. ${REASON[r.delivery.reason]}` }
      : { tone: 'info', text: `Your ${what} was recorded (reply ID ${r.replyId}). ${STATE_LABEL[state]}${receipt}.${state === 'submitted' ? ` ${mailLine(r)}` : ''}` }
    : { tone: 'warn', text: `Another answer was recorded first, so yours was not sent. The recorded answer is shown below (${STATE_LABEL[state]}${receipt || ', no receipt yet'}). Your unsent answer is kept; nothing else is sent unless you choose to.` }
}

/**
 * Loads the decision (and, for a new question, its stored draft), then reconciles the draft with
 * what the worker recorded, by reply ID. `passive` loads come from invalidations: they change the
 * page only when the decision, its package or the draft actually changed.
 */
async function loadReview(questionId: string, keepNotice = false, passive = false) {
  const mine = ++seq
  if (!keepNotice) notice = null
  const dr = await call(req, 'getDecision', { questionId })
  if (mine !== seq) return
  // Native Bot Items are read-only here: no draft, no package siblings, no replies.
  const native = dr.ok && nativeOf(dr.value)
  const wr = native || draftFor === questionId ? null : await call(req, 'draft.get', { questionId })
  if (mine !== seq) return
  const before = d ? JSON.stringify(d) : null
  if (!dr.ok) {
    // A passive refresh that fails keeps the page; an explicit load shows the failure.
    if (passive && d) return
    d = null; loadFail = dr; render(); return
  }
  if (d?.questionId !== questionId) { snaps.clear(); a = 0; b = null; zoom.clear() }
  d = dr.value; loadFail = null
  let changed = JSON.stringify(d) !== before
  if (wr) {
    draftFor = questionId; changed = true
    if (wr.ok) { draft = wr.value.draft ?? emptyDraft(); draftRevision = wr.value.revision; draftFail = null }
    else { draft = emptyDraft(); draftRevision = null; draftFail = wr }
  }
  const attempted = draft.replyId
  const rec = reconcile(draft, d)
  if (rec.kind === 'sent') {
    // The attempt was recorded (for example after a timeout): say so, with its actual state.
    const r = replies(d).find((x) => x.replyId === attempted)!
    draft = emptyDraft(); void saveDraftNow()
    notice = recordedNotice(r, d, true); say(notice.text); changed = true
  }
  if (rec.kind === 'superseded' && !(keepNotice && notice)) {
    // Kept as the owner wrote it; reusing it as a follow-up is the owner's explicit choice. A more
    // specific notice from the send that just lost is kept.
    notice = { tone: 'warn', text: 'Another answer was recorded first, so yours was not sent. The recorded answer is shown below. Your unsent answer is kept; nothing else is sent unless you choose to.' }
    say(notice.text); changed = true
  }
  if (!passive) render()
  else if (changed) requestRender(true)
  // Native siblings declared by ID need no package read.
  if (native && d.package?.questionIds) { pkg = []; pkgMore = false; return }
  // Same-package questions from the same origin workspace, each with its own state.
  // One bounded, server-searched page by package ID; only exact package members are kept.
  const unattributed = native && !native.workspaceAttributed
  const pr = await call(req, 'listDecisionPage', {
    scope: unattributed ? { kind: 'all' } : { kind: 'workspace', workspace: { hostId: d.origin.hostId, workspaceId: d.origin.workspaceId } },
    query: d.packageId, includeHistory: true, timeZone: clock.zone()
  })
  if (mine !== seq || !d) return
  const pkgBefore = JSON.stringify([pkg, pkgFail])
  if (pr.ok) { pkgMore = !!pr.value.nextCursor; pkg = pr.value.rows.filter((x) => x.packageId === d!.packageId && x.questionId !== d!.questionId); pkgFail = null }
  else if (!passive) { pkg = []; pkgFail = pr }
  if (JSON.stringify([pkg, pkgFail]) !== pkgBefore) requestRender(passive)
  if (passive && !busy() && !saveTimer) await checkExternalDraft(questionId)
}

/**
 * After an invalidation, a stored draft revision we did not write means another tab or window
 * changed this draft. Adopt it only when this tab has no unsaved edits; otherwise the next save's
 * compare-and-set reports the conflict.
 */
async function checkExternalDraft(questionId: string) {
  await saving
  if (draftFor !== questionId || saveTimer || draftRevision === null) return
  const g = await call(req, 'draft.get', { questionId })
  if (!g.ok || draftFor !== questionId || saveTimer || busy() || g.value.revision === draftRevision) return
  draft = g.value.draft ?? emptyDraft(); draftRevision = g.value.revision
  notice = { tone: 'warn', text: 'This draft was changed in another tab or window. The saved draft is shown.' }
  say(notice.text); render()
}

// ---- draft persistence (worker-backed, bound to the question ID) --------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<unknown> = Promise.resolve()
/** The stored draft's revision for compare-and-set; null when it could not be read. */
let draftRevision: number | null = null
function scheduleSave() {
  // Every edit records what the owner is writing, from the page they see: an initial answer while
  // the question awaits one, otherwise a follow-up. Only a genuine initial answer can be held.
  const x = shownD ?? d
  if (!draft.kind && x && !draftIsEmpty(draft)) draft.kind = answered(x) ? 'follow-up' : 'initial'
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { saveTimer = null; void saveDraftNow() }, 400)
}
/**
 * Saves the current draft (partial notes included) for the question it belongs to, against the
 * stored revision. Saves run one at a time, in order. Resolves true only when this save is durable.
 * A conflict means another tab or window saved first: its draft is loaded and shown instead.
 */
function saveDraftNow(): Promise<boolean> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const questionId = draftFor
  if (!questionId) return saving.then(() => false)
  const value: Draft | null = draftIsEmpty(draft) && !draft.replyId ? null : structuredClone(draft)
  const p = saving.then(async (): Promise<boolean> => {
    if (draftRevision === null) {
      const g = await call(req, 'draft.get', { questionId })
      if (draftFor !== questionId) return false
      if (!g.ok) { draftFail = g; requestRender(); return false }
      draftRevision = g.value.revision
    }
    const r = await call(req, 'draft.save', { questionId, draft: value, revision: draftRevision })
    if (draftFor !== questionId) return r.ok
    if (r.ok) {
      draftRevision = r.value.revision
      if (draftFail) { draftFail = null; requestRender() }
      return true
    }
    if (r.code === 'conflict') {
      const g = await call(req, 'draft.get', { questionId })
      if (draftFor !== questionId) return false
      if (g.ok) {
        draft = g.value.draft ?? emptyDraft(); draftRevision = g.value.revision; draftFail = null
        notice = { tone: 'warn', text: 'This draft was changed in another tab or window, so your latest edit was not saved. The saved draft is shown.' }
        say(notice.text)
      } else { draftRevision = null; draftFail = g }
      render(); return false
    }
    draftFail = r; requestRender(); return false
  })
  saving = p.catch(() => false)
  return p
}
const flushDraft = () => (saveTimer ? saveDraftNow() : saving)
orca.on('editor.flush', () => flushDraft())
window.addEventListener('pagehide', () => { void flushDraft() })
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flushDraft() })

// ---- annotations --------------------------------------------------------------------------------
function staleNote(n: Annotation, x: Decision): string | null {
  if (n.kind === 'selection' && n.anchor.kind === 'question') {
    if (n.anchor.revision !== x.revision || x[n.anchor.field].slice(n.start, n.end) !== n.quote) return 'The text changed since this note was made. Remove it and select the text again.'
    return null
  }
  const ref = n.kind === 'image' ? n.evidence : n.anchor.kind === 'evidence' ? n.anchor.evidence : null
  if (ref && !x.evidence.some((e) => e.evidenceId === ref.evidenceId && e.version === ref.version)) return 'This evidence version is no longer attached.'
  return null
}
function addSelection(note: string) {
  if (!d || !quote) return
  draft.annotations.push({ kind: 'selection', anchor: { kind: 'question', field: quote.field, revision: d.revision }, start: quote.start, end: quote.end, quote: quote.text, text: note })
  scheduleSave()
}
function addQuoteNote() {
  const q = quote
  if (!q || (d && nativeOf(d))) { pop.style.display = 'none'; return }
  let rect: DOMRect | null = null
  try { const sel = getSelection(); rect = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect?.() ?? null : null } catch { rect = null }
  openNoteComposer({ kind: 'text', q, rect })
}
/**
 * Narrow layout (no sidebar): a native modal that lists every note for review, editing and
 * removal, plus a new note for the current selection when there is one. The browser handles the
 * inert page, focus containment, Esc and focus return; closing re-renders the page.
 */
/**
 * Ctrl+Enter (Cmd+Enter on macOS) in a note field saves that note and nothing else: it never
 * reaches the reply shortcut, and is ignored while an input method is composing.
 */
function noteShortcut(ev: KeyboardEvent, save: () => void) {
  if (ev.key !== 'Enter' || !(ev.ctrlKey || ev.metaKey)) return
  ev.preventDefault(); ev.stopPropagation()
  if (ev.isComposing || composing) return
  save()
}
function openComposer(quoted: { field: 'background' | 'recommendation'; text: string; start: number; end: number } | null) {
  fillComposer(quoted)
  if (!composer.open) composer.showModal()
}
function fillComposer(quoted: typeof quote) {
  const x = d; if (!x) return
  const ta = el<HTMLTextAreaElement>('textarea', { rows: 3, 'aria-label': 'New note', placeholder: 'Your note (Ctrl+Enter adds it)', autofocus: true })
  const add = () => {
    const text = ta.value
    if (!text.trim()) return say('Write the note first')
    quote = quoted; addSelection(text); quote = null; say('Note added'); fillComposer(null)
  }
  ta.addEventListener('keydown', (ev) => noteShortcut(ev, add))
  composer.replaceChildren(
    el('h3', { id: 'cmp-h', style: 'margin:0 0 6px' }, `Notes (${draft.annotations.length})`),
    ...(draft.annotations.length ? draft.annotations.map((n, i) => noteEditor(n, i, x, 'dialog'))
      : [el('p', { class: 'meta' }, 'No notes yet. Select text in Background or Recommendation to add one.')]),
    ...(quoted ? [el('h3', { style: 'margin:10px 0 4px' }, 'Add a note'), el('div', { class: 'raw' }, quoted.text), ta,
      el('div', { style: 'display:flex;justify-content:flex-end;margin-top:6px' }, el('button', { type: 'button', class: 'pri', onclick: add }, 'Add note'))] : []),
    el('div', { style: 'display:flex;gap:6px;justify-content:flex-end;margin-top:10px' },
      el('button', { type: 'button', autofocus: !quoted, onclick: () => composer.close() }, 'Done')))
}
/**
 * UTF-16 offsets into the field's text. A selection may start or end outside the paragraph or on an
 * element boundary (a triple-click ends at the start of the next element); it is clipped to the
 * field's text node.
 */
document.addEventListener('selectionchange', () => {
  const sel = getSelection()
  const had = quote !== null
  quote = null
  if (sel && sel.rangeCount && !sel.isCollapsed && d) {
    const r = sel.getRangeAt(0)
    for (const f of ['background', 'recommendation'] as const) {
      const field = root.querySelector(`[data-field="${f}"]`)
      const span = field && rawRange(r, field)
      if (!span) continue
      const text = d[f].slice(span[0], span[1])
      if (text.trim()) quote = { field: f, text, start: span[0], end: span[1] }
      break
    }
  }
  if (quote) {
    const box = sel!.getRangeAt(0).getBoundingClientRect()
    pop.style.cssText = `display:block;left:${box.left}px;top:${box.bottom + 6}px`
  } else {
    pop.style.display = 'none'
    if (had) flushSoon()
  }
})
document.addEventListener('keydown', (e) => {
  if (composer.open || (nc && nc.contains(e.target as Node))) return
  // e.code: on macOS Option+N is a dead key, so e.key is not "n" there.
  if (e.altKey && (e.code === 'KeyN' || e.key.toLowerCase() === 'n')) { e.preventDefault(); if (quote) addQuoteNote() }
  if (e.key === 'Escape' && !e.isComposing) {
    // Esc closes the innermost layer: the note popover, then the notes panel, then the dashboard sheet.
    if (pop.style.display !== 'none' && pop.style.display) { pop.style.display = 'none'; return }
    if (notesOpen && ref.view !== 'settings') { notesOpen = false; render(); root.querySelector<HTMLElement>('[data-k="notes-open"]')?.focus(); return }
    if (ref.view === 'dashboard' && dashSel) { e.preventDefault(); closeDashSheet() }
  }
  // The reply shortcut never fires from a note field, the image viewer or while composing.
  const inNote = (e.target as Element | null)?.closest?.('[data-note], [data-dialog-note], .side, dialog, .d-zoom')
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing && !inNote && (ref.view === 'review' || (ref.view === 'dashboard' && dashSel))) { e.preventDefault(); void send() }
})

// ---- reply --------------------------------------------------------------------------------------
const answered = (x: Decision) => x.answerState.state === 'answered'
/** The decision as last drawn. Sends act on what the owner saw, never on a newer reload. */
let shownD: Decision | null = null
/** An initial answer the owner wrote that lost to another accepted answer: kept, never sent. */
const heldInitial = (x: Decision) => answered(x) && (draft.kind ?? 'initial') === 'initial' && !draftIsEmpty(draft)
function buildAnswer(x: Decision): Answer | null {
  const text = draft.text.trim()
  if (!answered(x) && draft.optionId && x.options.some((o) => o.optionId === draft.optionId))
    return { kind: 'option', optionId: draft.optionId, ...(text ? { detail: text } : {}) }
  return text ? { kind: 'text', text } : null
}

/** Opens the notes that block sending: the dialog on narrow layouts, the sidebar otherwise. */
function reviewNotes() {
  const x = d; if (!x) return
  if (notesInDialog()) return openComposer(null)
  const i = draft.annotations.findIndex((n) => noteProblem(n, x))
  notesOpen = true; focusNote = Math.max(0, i); render()
}

/**
 * Sends the initial answer or a follow-up. The reply ID is minted once per attempt and saved in
 * the draft before the request, so a retry (after a timeout, a restart or `unavailable`) reuses it.
 * The payload is fixed when Send is pressed and the compose fields are locked until the worker
 * answers, so nothing typed meanwhile is lost or mixed into the request.
 */
async function send() {
  const x = shownD
  if (!x || !d || sending) return
  // A background reload may have replaced the decision while drawing waited for the owner (for
  // example another surface recorded the answer). Never send against a page the owner did not see.
  if (x.questionId !== d.questionId || x.revision !== d.revision || JSON.stringify(x.answerState) !== JSON.stringify(d.answerState)) {
    notice = { tone: 'warn', text: 'This decision changed while you were writing, so nothing was sent. Check what is recorded below before you continue; your text is kept.' }
    render(); return say(notice.text)
  }
  if (heldInitial(x)) return say('Your unsent answer was not sent because another answer was recorded first. Choose “Write a follow-up from this text” to send it as a follow-up.')
  const kind: SubmitReply['kind'] = answered(x) ? 'follow-up' : 'initial'
  if (!actionsOf(x).includes(kind === 'initial' ? 'reply' : 'follow-up')) return say('Replying here is not available for this decision.')
  const answer = buildAnswer(x)
  if (!answer) return say(kind === 'initial' ? 'Choose an option or write a reply first' : 'Write a follow-up first')
  if (draft.annotations.some((n) => noteProblem(n, x))) {
    notice = { tone: 'bad', notes: true, text: 'Some notes are empty or no longer match the decision. Fix or remove them in Notes, then send again.' }
    render(); return say(notice.text)
  }
  sending = true
  if (!draft.replyId || draft.kind !== kind) { draft.replyId = newReplyId(); draft.kind = kind }
  const replyId = draft.replyId
  const annotations: Annotation[] = draft.annotations.map((n) => ({ ...structuredClone(n), text: n.text.trim() }))
  notice = null; render()
  // The attempt (with its reply ID) must be durable before sending, or a retry after a restart
  // could not reuse the ID.
  if (!(await saveDraftNow())) {
    sending = false
    if (d?.questionId !== x.questionId) return
    // A draft conflict during the save already set its own (warn) notice.
    const cur = notice as Notice | null
    if (!cur || cur.tone !== 'warn') notice = { tone: 'bad', retry: !!draft.replyId, text: `Not sent. This reply attempt could not be saved first, so a later retry could not reuse its reply ID.${draftFail ? ` ${failureText(draftFail)}` : ''}` }
    say((notice as Notice | null)?.text ?? ''); render(); return
  }
  const r = await call(req, 'submitReply', { questionId: x.questionId, replyId, kind, answer, annotations })
  sending = false
  if (d?.questionId !== x.questionId) return
  let conflictId: string | null = null
  if (r.ok && r.value.replyId === replyId) {
    draft = emptyDraft(); void saveDraftNow()
    notice = recordedNotice(r.value, x, true)
  } else if (r.ok) {
    // The first accepted answer wins. Keep the owner's answer as written (option included); it
    // becomes a follow-up only if the owner chooses that.
    const { replyId: _id, ...rest } = draft
    draft = rest; void saveDraftNow()
    notice = recordedNotice(r.value, x, false)
  } else if (r.code === 'conflict') {
    // This reply ID is already bound to other content. Keep the text as a new attempt and say
    // what was actually recorded once the decision reloads.
    conflictId = replyId
    const { replyId: _id, ...rest } = draft
    draft = rest; void saveDraftNow()
    notice = null
  } else if (r.code === 'unavailable') {
    // Ambiguous: the worker may have recorded it. The reload below reconciles by reply ID.
    notice = { tone: 'bad', retry: true, text: `Not confirmed. ${failureText(r)} The reply may or may not have been recorded. The draft and reply ID ${replyId} are kept; Retry sends the same reply ID, so it is recorded at most once.` }
  } else {
    notice = { tone: 'bad', retry: true, text: `Not sent. ${failureText(r)} Your draft and reply ID are kept.` }
  }
  if (notice) say(notice.text)
  await loadReview(x.questionId, true)
  if (conflictId && d?.questionId === x.questionId) {
    const rec = replies(d).find((y) => y.replyId === conflictId)
    const kept = draft.text.trim() ? ' Your text is kept as a new draft.' : ''
    notice = rec
      ? { tone: 'warn', text: `An earlier attempt with reply ID ${conflictId} was already recorded with different content. That recorded reply is shown below (${STATE_LABEL[replyState(rec, d)]}).${kept}` }
      : { tone: 'warn', text: `Reply ID ${conflictId} could not be used because a different reply was already recorded. The recorded answer is shown below.${kept}` }
    say(notice.text); render()
  }
}

async function retryDelivery(r: RecordedReply) {
  const x = d; if (!x) return
  const out = await call(req, 'retryReply', { questionId: r.questionId, replyId: r.replyId })
  notice = out.ok
    ? { tone: 'info', text: `Retried reply ${out.value.replyId} to the original chat. ${STATE_LABEL[replyState(out.value, x)]}.` }
    : { tone: 'bad', text: `Retry failed. ${failureText(out)} The reply is kept.` }
  say(notice.text)
  await loadReview(x.questionId, true)
}

async function copy(text: string, what: string) {
  try { await navigator.clipboard.writeText(text); say(`${what} copied`) }
  catch { say(`Could not copy the ${what.toLowerCase()}. Select the text and copy it instead.`) }
}

async function openLink(url: string) {
  const r = await orca.shell?.openExternal(url)
  if (!r) say('Opening links is not available here.')
  else if (!r.opened) say(r.reason === 'cancelled' ? 'Link not opened.' : 'Could not ask to open the link.')
}

async function openOther(questionId: string) {
  const r = await call(req, 'review.open', { questionId })
  if (!r.ok) { notice = { tone: 'bad', text: `Could not open that question. ${failureText(r)}` }; say(notice.text); render() }
}

// ---- evidence -----------------------------------------------------------------------------------
// PROVISIONAL (proposed by design, not owner-signed): one large viewer with an optional
// side-by-side compare. Reversible; confirm during owner review.
type Img = Extract<Evidence, { kind: 'image-snapshot' }>
const MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
function ensureSnapshot(e: Img) {
  const x = d; if (!x || snaps.has(e.attachmentId)) return
  snaps.set(e.attachmentId, { state: 'loading' })
  void call(req, 'getSnapshot', { questionId: x.questionId, attachmentId: e.attachmentId }).then((r) => {
    if (d?.questionId !== x.questionId) return
    const ok = r.ok && MIME.has(r.value.mimeType) && /^[A-Za-z0-9+/]+={0,2}$/.test(r.value.base64)
    snaps.set(e.attachmentId, ok ? { state: 'ok', url: `data:${r.value.mimeType};base64,${r.value.base64}` }
      : { state: 'fail', f: r.ok ? { ok: false, code: 'unavailable', message: 'The snapshot data was not a supported image.' } : r })
    requestRender()
  })
}
function snapshotFailure(e: Img, f: Failure) {
  const text = f.code === 'forbidden' ? 'You do not have access to this snapshot.'
    : f.code === 'not-found' ? 'Snapshot expired or missing.'
    : `Could not load the snapshot. ${failureText(f)}`
  return el('div', { class: 'miss' }, el('div', {}, el('p', { style: 'margin:0 0 6px' }, text),
    ...(f.code === 'unavailable' ? [el('button', { type: 'button', onclick: () => { snaps.delete(e.attachmentId); render() } }, 'Try again')] : [])))
}
function viewer(list: Img[], i: number, side: string) {
  const e = list[i]
  ensureSnapshot(e)
  const z = zoom.get(e.evidenceId) ?? 1
  const s = snaps.get(e.attachmentId)!
  const v = el('div', { class: 'view', tabindex: 0, 'data-k': `view-${side}`, role: 'group', 'aria-label': `${side} viewer: ${e.label}, v${e.version}, zoom ${Math.round(z * 100)}%` })
  if (s.state === 'ok') v.append(el('img', { src: s.url, alt: e.alt, width: e.width, height: e.height, style: `width:${Math.round(z * 100)}%` }))
  else if (s.state === 'loading') v.append(el('div', { class: 'miss', style: `aspect-ratio:${e.width}/${e.height}` }, `Loading ${e.label} (${e.width}×${e.height})…`))
  else v.append(snapshotFailure(e, s.f))
  const zb = (label: string, name: string, f: (n: number) => number) => el('button', { type: 'button', 'data-k': `z-${side}-${name}`, 'aria-label': `${name} ${e.label}`, onclick: () => { zoom.set(e.evidenceId, f(z)); render() } }, label)
  const note = draft.annotations.find((n) => n.kind === 'image' && n.evidence.evidenceId === e.evidenceId && n.evidence.version === e.version)
  return el('div', {}, v, el('div', { class: 'bar' }, zb('−', 'Zoom out', (n) => Math.max(0.25, n - 0.25)), zb('+', 'Zoom in', (n) => Math.min(4, n + 0.25)), zb('100%', 'Reset zoom', () => 1),
    field('input', { type: 'text', 'data-k': `note-${e.evidenceId}`, 'aria-label': `Note for ${e.label}`, placeholder: `Note on ${e.label}`,
      // Commit on every keystroke, as typed (trimmed only when sent). No re-render on blur, so a
      // click that moves focus away (Submit, Remove) is never swallowed by a rebuilt button.
      oninput: (ev: Event) => {
        const before = draft.annotations.length
        setImageNote(e, (ev.target as HTMLInputElement).value); scheduleSave()
        if (draft.annotations.length > before && !notesInDialog()) { notesOpen = true; root.querySelector('#notesPanel')?.removeAttribute('hidden') }
        refreshNotes()
      } }, note?.text ?? '')))
}

/**
 * One note per image version, kept in place so the sidebar order stays stable while typing. The
 * text is stored exactly as typed ("Check the " keeps its space); clearing the field removes it.
 */
function setImageNote(e: Img, text: string) {
  const i = draft.annotations.findIndex((n) => n.kind === 'image' && n.evidence.evidenceId === e.evidenceId)
  const note: Annotation = { kind: 'image', evidence: { evidenceId: e.evidenceId, version: e.version }, text }
  if (i < 0) { if (text.trim()) draft.annotations.push(note) }
  else if (text.trim()) draft.annotations[i] = note
  else draft.annotations.splice(i, 1)
}

/** Notes that would block sending: empty, or no longer matching the decision. */
const noteProblem = (n: Annotation, x: Decision) => (!n.text.trim() ? 'This note is empty. Write it or remove it.' : staleNote(n, x))
const notesLabel = (x: Decision) => {
  const bad = draft.annotations.filter((n) => noteProblem(n, x)).length
  return `Notes (${draft.annotations.length})${bad ? ` · ${bad} need${bad > 1 ? '' : 's'} attention` : ''}`
}
/**
 * Updates note counts and the sidebar in place after a note edit, without rebuilding the page.
 * The sidebar is rebuilt only when focus is not inside it.
 */
function refreshNotes() {
  const x = d; if (!x) return
  root.querySelectorAll('[data-k="notes-open"]').forEach((btn) => { btn.textContent = notesLabel(x) })
  const side = root.querySelector('.side')
  if (side && !side.contains(document.activeElement)) side.replaceChildren(...notesPanelKids(x))
}
/** Notes for this reply, in the reply card: always in the page, shown with the Notes toggle. */
let notesOpen = false
const notesPanelKids = (x: Decision) => [
  el('div', { class: 'd-notes-head' }, el('span', {}, ''), el('button', { type: 'button', class: 'd-icon-btn', 'data-k': 'notes-close', 'aria-label': 'Close notes', title: 'Close notes',
    onclick: () => { notesOpen = false; render(); root.querySelector<HTMLElement>('[data-k="notes-open"]')?.focus() } }, '✕')),
  sidebar(x)]
function notesPanel(x: Decision): HTMLElement {
  return el('section', { class: 'side d-notes-panel', id: 'notesPanel', 'aria-label': 'Notes', ...(notesOpen ? {} : { hidden: true }) }, ...notesPanelKids(x))
}
/**
 * Full-screen image viewer, outside the sheet: fit to screen, zoom in and out, drag or arrow keys to
 * pan when zoomed, 0 or Fit to reset, Esc or Close to leave. Focus returns to the image that opened
 * it; the reader's scroll position is untouched because nothing behind it re-renders for it.
 */
function openZoom(e: Img, url: string, from: HTMLElement) {
  const back = from.getAttribute('data-k')
  let scale = 1, x = 0, y = 0
  const img = el<HTMLImageElement>('img', { src: url, alt: e.alt, draggable: 'false' })
  const level = el('span', { class: 'd-zoom-level', 'aria-live': 'polite' }, 'Fit')
  const apply = () => {
    if (scale <= 1) { scale = 1; x = 0; y = 0 }
    // Clamp the pan so the image edge never leaves the stage.
    const r = stage.getBoundingClientRect?.(), bw = img.offsetWidth || 0, bh = img.offsetHeight || 0
    if (r && bw) { const mx = Math.max(0, (bw * scale - r.width) / 2), my = Math.max(0, (bh * scale - r.height) / 2); x = Math.min(mx, Math.max(-mx, x)); y = Math.min(my, Math.max(-my, y)) }
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`
    stage.classList.toggle('zoomed', scale > 1)
    level.textContent = scale === 1 ? 'Fit' : `${Math.round(scale * 100)}%`
  }
  const zoom = (f: number) => { scale = Math.min(8, Math.max(1, +(scale * f).toFixed(3))); apply() }
  const btn = (label: string, glyph: string, k: string, fn: () => void) => el('button', { type: 'button', class: 'd-icon-btn', 'aria-label': label, title: label, 'data-zk': k, onclick: fn }, glyph)
  const stage = el('div', { class: 'd-zoom-stage' }, img)
  const close = () => {
    overlay.remove(); document.removeEventListener('keydown', onKey, true)
    for (const el2 of inertOn) el2.removeAttribute('inert')
    ;(root.querySelector<HTMLElement>(`[data-k="${CSS.escape(back ?? '')}"]`) ?? from).focus({ preventScroll: true })
  }
  const overlay = el('div', { class: 'd-app d-zoom', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Image: ${e.label}` },
    el('div', { class: 'd-zoom-bar' }, el('strong', {}, e.label), level, el('span', { class: 'd-spacer' }),
      btn('Zoom out', '−', 'out', () => zoom(1 / 1.5)), btn('Zoom in', '+', 'in', () => zoom(1.5)), btn('Fit to screen', '⤢', 'fit', () => { scale = 1; apply() }), btn('Close image', '✕', 'close', close)),
    stage)
  // Pan by dragging while zoomed.
  let drag: { px: number; py: number; x: number; y: number } | null = null
  stage.addEventListener('pointerdown', (ev) => { if (scale > 1) { drag = { px: ev.clientX, py: ev.clientY, x, y }; stage.setPointerCapture?.(ev.pointerId) } })
  stage.addEventListener('pointermove', (ev) => { if (drag) { x = drag.x + ev.clientX - drag.px; y = drag.y + ev.clientY - drag.py; apply() } })
  stage.addEventListener('pointerup', () => { drag = null })
  // Wheel zooms at the cursor; double-click toggles fit and 2x.
  const zoomAt = (f: number, cx: number, cy: number) => {
    const r = stage.getBoundingClientRect(), old = scale
    scale = Math.min(8, Math.max(1, +(scale * f).toFixed(3)))
    const k = scale / old, ox = cx - (r.left + r.width / 2), oy = cy - (r.top + r.height / 2)
    x = ox - (ox - x) * k; y = oy - (oy - y) * k; apply()
  }
  stage.addEventListener('wheel', (ev) => { ev.preventDefault(); zoomAt(ev.deltaY < 0 ? 1.25 : 0.8, ev.clientX, ev.clientY) }, { passive: false })
  stage.addEventListener('dblclick', (ev) => { if (scale > 1) { scale = 1; apply() } else zoomAt(2, ev.clientX, ev.clientY) })
  function onKey(ev: KeyboardEvent) {
    if (!overlay.isConnected) return
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); return close() }
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); ev.stopPropagation(); return }
    if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoom(1.5) }
    else if (ev.key === '-') { ev.preventDefault(); zoom(1 / 1.5) }
    else if (ev.key === '0') { ev.preventDefault(); scale = 1; apply() }
    else if (scale > 1 && ev.key.startsWith('Arrow')) { ev.preventDefault(); const d2 = 40; if (ev.key === 'ArrowLeft') x += d2; if (ev.key === 'ArrowRight') x -= d2; if (ev.key === 'ArrowUp') y += d2; if (ev.key === 'ArrowDown') y -= d2; apply() }
    else if (ev.key === 'Tab') {
      const f = Array.from(overlay.querySelectorAll<HTMLElement>('button')); const i = f.indexOf(document.activeElement as HTMLElement)
      ev.preventDefault(); f[(i + (ev.shiftKey ? f.length - 1 : 1)) % f.length].focus()
    }
  }
  const inertOn = [root].filter((n) => !n.hasAttribute('inert'))
  for (const n of inertOn) n.setAttribute('inert', '')
  document.addEventListener('keydown', onKey, true)
  document.body.append(overlay); apply()
  overlay.querySelector<HTMLElement>('[data-zk="close"]')!.focus()
}
// ---- contextual note composer ------------------------------------------------------------------
// One flow for every new note: select text (then the Add note button or Alt+N) or use ✎ on an image;
// a small composer opens next to it with the quote or caption, Add and Cancel. Ctrl/Cmd+Enter adds,
// Esc cancels. After the note is saved with the draft the composer and the Notes panel close, the
// reader's scroll is kept and focus returns to where the note started. An empty note or a failed
// save keeps the composer open with the text. Notes are local to the draft until the reply is sent.
/** Viewport size (absent outside a browser, e.g. in the DOM tests). */
const vw = () => (typeof innerWidth === 'number' ? innerWidth : 1280)
const vh = () => (typeof innerHeight === 'number' ? innerHeight : 800)
type NoteTarget = { kind: 'text'; q: Quote; rect: DOMRect | null } | { kind: 'image'; e: Img; caption: string; from: HTMLElement }
let nc: HTMLElement | null = null
let ncBack: { k: string | null; scroll: number } | null = null
let noteSaved: string | null = null
function closeNoteComposer(restore: boolean) {
  if (!nc) return
  nc.remove(); nc = null
  const back = ncBack; ncBack = null
  render()
  if (restore && back) {
    const body = root.querySelector<HTMLElement>('[data-k="sheet-body"]'); if (body) body.scrollTop = back.scroll
    root.querySelector<HTMLElement>(`[data-k="${CSS.escape(back.k ?? 'notes-open')}"]`)?.focus({ preventScroll: true })
  }
}
function openNoteComposer(t: NoteTarget) {
  const x = d
  if (!x || nativeOf(x)) return
  if (nc) { nc.remove(); nc = null }
  pop.style.display = 'none'
  const body = root.querySelector<HTMLElement>('[data-k="sheet-body"]')
  ncBack = { k: t.kind === 'image' ? t.from.getAttribute('data-k') : 'notes-open', scroll: body?.scrollTop ?? 0 }
  const ta = el<HTMLTextAreaElement>('textarea', { rows: 3, 'aria-label': 'New note', placeholder: 'Your note. Ctrl+Enter adds it.', 'data-nc': '' })
  const err = el('p', { class: 'd-nc-err', role: 'alert', hidden: true })
  const addBtn = el<HTMLButtonElement>('button', { type: 'button', class: 'd-btn d-primary', 'data-k': 'nc-add' }, 'Add note')
  const add = async () => {
    if (addBtn.getAttribute('aria-busy') === 'true') return
    const text = ta.value
    if (!text.trim()) { err.textContent = 'Write the note first.'; err.hidden = false; ta.focus(); return }
    if (d !== x) { closeNoteComposer(false); return }
    const n: Annotation = t.kind === 'text'
      ? { kind: 'selection', anchor: { kind: 'question', field: t.q.field, revision: x.revision }, start: t.q.start, end: t.q.end, quote: t.q.text, text }
      : { kind: 'image', evidence: { evidenceId: t.e.evidenceId, version: t.e.version }, text }
    draft.annotations.push(n)
    addBtn.setAttribute('aria-busy', 'true'); addBtn.textContent = 'Saving…'
    scheduleSave()
    const ok = await saveDraftNow()
    if (!nc) return
    if (!ok || draftFail) {
      draft.annotations.splice(draft.annotations.indexOf(n), 1)
      addBtn.removeAttribute('aria-busy'); addBtn.textContent = 'Add note'
      err.textContent = `The note was not saved. ${draftFail ? failureText(draftFail) : 'Try again.'}`; err.hidden = false; ta.focus()
      return
    }
    quote = null; notesOpen = false; noteSaved = x.questionId
    closeNoteComposer(true)
    say('Note saved with your draft. It is sent with your reply, not before.')
  }
  addBtn.addEventListener('click', () => void add())
  ta.addEventListener('keydown', (ev) => noteShortcut(ev, () => void add()))
  ta.addEventListener('input', () => { err.hidden = true })
  nc = el('section', { class: 'd-app d-nc', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'ncTitle', 'data-question': x.questionId },
    el('div', { class: 'd-nc-head' }, el('b', { id: 'ncTitle' }, t.kind === 'text' ? 'Note on the selected text' : `Note on ${t.e.label}`)),
    el('blockquote', { class: 'd-nc-quote' }, t.kind === 'text' ? (t.q.text.length > 240 ? `${t.q.text.slice(0, 240)}…` : t.q.text) : t.caption),
    ta, err,
    el('div', { class: 'd-nc-foot' }, el('span', { class: 'd-hint' }, 'Saved with your draft · not sent'),
      el('button', { type: 'button', class: 'd-btn d-ghost', 'data-k': 'nc-cancel', onclick: () => { closeNoteComposer(true); say('Note discarded') } }, 'Cancel'), addBtn))
  nc.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !ev.isComposing) { ev.preventDefault(); ev.stopPropagation(); closeNoteComposer(true); say('Note discarded') }
  })
  document.body.append(nc)
  // Next to the anchor: below it, or above when there is no room; a bottom sheet on small screens.
  const r = t.kind === 'text' ? t.rect : t.from.getBoundingClientRect?.()
  if (vw() > 600 && r && nc.getBoundingClientRect) {
    const w = Math.min(360, vw() - 16), h = nc.getBoundingClientRect().height || 200
    const left = Math.max(8, Math.min(vw() - w - 8, r.left))
    const top = r.bottom + 8 + h <= vh() - 8 ? r.bottom + 8 : Math.max(8, r.top - h - 8)
    nc.style.cssText = `left:${Math.round(left)}px;top:${Math.round(top)}px;width:${w}px`
  } else nc.classList.add('d-nc-sheet')
  ta.focus()
}
/** ✎ on an image placed in the narrative: the note composer for that image version. */
function noteOnImage(e: Img, from: HTMLElement, caption: string) {
  openNoteComposer({ kind: 'image', e, caption, from })
}
/** Highlights each text note at its anchor (raw offsets), with the note as its tooltip. */
function markNotes(box: Element, field: 'background' | 'recommendation') {
  const notes = draft.annotations.flatMap((n, i) => n.kind === 'selection' && n.anchor.kind === 'question' && n.anchor.field === field ? [[n, i] as const] : [])
  if (!notes.length) return
  const texts: Text[] = []
  const walk = (n: Node) => { for (const c of Array.from(n.childNodes)) c.nodeType === 3 ? texts.push(c as Text) : walk(c) }
  walk(box)
  for (const t of texts) {
    const at = rawOffset.get(t); if (at === undefined) continue
    const len = t.data.length, end = at + len
    const hits = notes.filter(([n]) => n.kind === 'selection' && n.start < end && n.end > at)
    if (!hits.length) continue
    const cuts = new Set([0, len])
    for (const [n] of hits) if (n.kind === 'selection') { cuts.add(Math.max(0, n.start - at)); cuts.add(Math.min(len, n.end - at)) }
    const pts = [...cuts].sort((p, q) => p - q)
    const parts: Node[] = []
    for (let i = 0; i < pts.length - 1; i++) {
      const piece = textAt(t.data.slice(pts[i], pts[i + 1]), at + pts[i])
      const cover = hits.filter(([n]) => n.kind === 'selection' && n.start <= at + pts[i] && n.end >= at + pts[i + 1])
      parts.push(cover.length ? el('mark', { class: 'd-n', 'data-note-mark': cover.map(([, j]) => j).join(' '), title: `Note: ${cover.map(([n]) => n.text).join(' · ')}` }, piece) : piece)
    }
    t.replaceWith(...parts)
  }
}

function sidebar(x: Decision) {
  const list = draft.annotations
  return el('div', {}, el('h2', { style: 'margin-top:0' }, `Notes (${list.length})`),
    ...(list.length ? [] : [el('p', { class: 'meta' }, 'Select text and press Alt+N, or use ✎ on an image. Notes are sent with your reply.')]),
    ...list.map((n, i) => noteEditor(n, i, x, 'side')))
}

/** One note with its anchor, any problem, its text and Remove. Shared by the sidebar and the
 *  narrow-layout notes dialog, so notes that block sending can be fixed at any width. */
function noteEditor(n: Annotation, i: number, x: Decision, where: 'side' | 'dialog') {
  const name = n.kind === 'image'
    ? `${x.evidence.find((e) => e.evidenceId === n.evidence.evidenceId)?.label ?? n.evidence.evidenceId} · v${n.evidence.version}`
    : n.anchor.kind === 'question' ? (n.anchor.field === 'background' ? 'Background' : 'Recommendation') : 'Evidence'
  const problem = noteProblem(n, x)
  const errId = `${where}-note-err-${i}`
  return el('div', { class: `note${problem ? ' stale' : ''}` },
    el('b', {}, name), ...(n.kind === 'selection' ? [el('q', {}, n.quote)] : []),
    ...(problem ? [el('div', { class: 'err', id: errId }, problem)] : []),
    field(where === 'side' ? 'input' : 'textarea', {
      ...(where === 'side' ? { type: 'text', 'data-note': i } : { rows: 2, 'data-dialog-note': i }),
      'data-k': `${where}-note-${i}`, 'aria-label': `Note text ${i + 1}`, 'aria-describedby': problem ? errId : false,
      oninput: (ev: Event) => { n.text = (ev.target as HTMLInputElement).value; scheduleSave(); refreshNotes() },
      onkeydown: (ev: KeyboardEvent) => noteShortcut(ev, () => { if (!n.text.trim()) return say('Write the note first'); void flushDraft(); say('Note saved') })
    }, n.text),
    ...(n.kind === 'selection' ? [el('button', { type: 'button', 'aria-label': `Go to the text of note ${i + 1}`, onclick: () => {
      if (where === 'dialog') composer.close()
      const m = root.querySelector<HTMLElement>(`mark[data-note-mark~="${i}"]`)
      if (m) { m.scrollIntoView?.({ block: 'center' }); m.classList.add('d-flash'); setTimeout(() => m.classList.remove('d-flash'), 1500) }
    } }, 'Go to')] : []),
    el('button', { type: 'button', 'aria-label': `Remove note ${i + 1}`, onclick: () => {
      draft.annotations.splice(draft.annotations.indexOf(n), 1); scheduleSave()
      say('Note removed')
      if (where === 'dialog') fillComposer(null); else render()
    } }, 'Remove'))
}

// ---- answered thread and follow-ups -------------------------------------------------------------
const REASON: Record<Extract<Delivery, { state: 'undelivered' }>['reason'], string> = {
  'closed-origin': 'The original chat is closed.',
  disconnected: 'The host is disconnected.',
  'origin-mismatch': 'The chat no longer matches the original origin.',
  'delivery-failed': 'Orca could not hand it to that chat.'
}
const when = (iso: string) => formatInstant(iso, clock.zone())
function answerText(ans: Answer, x: Decision) {
  if (ans.kind === 'text') return ans.text
  const label = x.options.find((o) => o.optionId === ans.optionId)?.label ?? ans.optionId
  return ans.detail ? `${label}\n${ans.detail}` : label
}
/** Each reply carries its own delivery state: a receipt only ever applies to its own reply ID. */
/**
 * Mail custody and the origin's acknowledgement are separate facts: mail submitted means Orca
 * accepted the message for the original chat, not that the agent there received it.
 */
function mailLine(r: RecordedReply): string {
  const t = transportOf(r.delivery)
  return t ? `Mail submitted to the original chat at ${when(t.acceptedAt)} (message ${t.messageId}); waiting for that chat to acknowledge it.`
    : 'Mail hand-off to the original chat is not reported yet; waiting for that chat to acknowledge it.'
}
function deliveryView(r: RecordedReply, x: Decision) {
  const s = r.delivery
  const state = replyState(r, x)
  if (state === 'agent-received' && s.state === 'agent-received')
    return el('div', { class: 'meta' }, el('span', { class: 'chip' }, `● ${STATE_LABEL['agent-received']}`), `Receipt ${s.receipt.receiptId} · ${when(s.receipt.receivedAt)}`)
  if (s.state === 'undelivered')
    return el('div', { class: 'callout', ...alertRole(`undelivered:${r.replyId}:${s.reason}`) }, el('b', {}, `${STATE_LABEL.undelivered}. `),
      `Saved in Decision Inbox, but not delivered to the original chat. ${REASON[s.reason]} `,
      // Retry only when the worker supports it for this decision.
      ...(actionsOf(x).includes('retry') ? [el('button', { type: 'button', 'data-k': `retry-${r.replyId}`, onclick: () => retryDelivery(r) }, 'Retry (same reply ID, same destination)'), ' ']
        : [el('span', {}, 'Retry is not available here; copy the reply and paste it into that chat if it is needed now. ')]),
      el('button', { type: 'button', 'data-k': `copy-${r.replyId}`, onclick: () => copy(answerText(r.answer, x), 'Reply') }, 'Copy reply'))
  return el('div', { class: 'meta' }, el('span', { class: 'chip' }, `● ${STATE_LABEL.submitted}`),
    s.state === 'agent-received' ? 'A receipt arrived that does not match this reply and origin, so it is not counted.' : mailLine(r))
}
const thread = (x: Decision): HTMLElement[] => {
  if (x.answerState.state !== 'answered') return []
  const { initial, followUps } = x.answerState
  return [initial, ...followUps].map((r, i) => el('section', { class: `reply${i ? ' fu' : ''}`, 'aria-label': i === 0 ? 'Your answer' : `Follow-up ${i}` },
    el('h3', {}, `${i === 0 ? 'Answer' : `Follow-up ${i}`} · accepted ${when(r.acceptedAt)} · ${r.replyId}`),
    el('div', { style: 'white-space:pre-wrap' }, answerText(r.answer, x)),
    ...(r.annotations.length ? [el('p', { class: 'meta' }, `${r.annotations.length} note${r.annotations.length > 1 ? 's' : ''} sent with this reply`)] : []),
    deliveryView(r, x)))
}

/** The owner's unsent initial answer after another answer won: shown, with explicit choices. */
function heldArea(x: Decision): HTMLElement[] {
  const opt = draft.optionId ? x.options.find((o) => o.optionId === draft.optionId)?.label ?? draft.optionId : null
  return [
    el('h2', {}, 'Your unsent answer'),
    el('p', { class: 'meta' }, 'Another answer was recorded first, so this was not sent. Nothing is sent unless you choose to.'),
    el('div', { class: 'raw' }, [opt && `Option: ${opt}`, draft.text.trim()].filter(Boolean).join('\n')),
    el('div', { class: 'bar' },
      el('button', { type: 'button', class: 'pri', 'data-k': 'start-follow', onclick: () => {
        const { replyId: _id, optionId: _opt, ...rest } = draft
        draft = { ...rest, kind: 'follow-up' }; scheduleSave(); notice = null; render()
        root.querySelector<HTMLElement>('[data-k="reply"]')?.focus()
        say(opt ? `Follow-up started from your text. The option ${opt} is not part of a follow-up; mention it in the text if it still applies.` : 'Follow-up started from your text.')
      } }, 'Write a follow-up from this text'),
      el('button', { type: 'button', 'data-k': 'copy-held', onclick: () => copy(draft.text, 'Unsent answer') }, 'Copy'),
      el('button', { type: 'button', 'data-k': 'discard-held', onclick: () => { draft = emptyDraft(); scheduleSave(); notice = null; render(); say('Unsent answer discarded') } }, 'Discard'))
  ]
}

function composeArea(x: Decision): HTMLElement[] {
  if (heldInitial(x)) return [...(notice ? [el('div', { class: `callout ${notice.tone === 'bad' ? '' : notice.tone}`, ...(notice.tone === 'bad' ? alertRole(`notice:${notice.text}`) : {}) }, notice.text)] : []), ...heldArea(x)]
  const isFollow = answered(x)
  const empty = !buildAnswer(x)
  const label = isFollow ? 'Send follow-up' : 'Submit reply'
  const sendBtn = el<HTMLButtonElement>('button', { type: 'button', class: 'pri', 'data-k': 'send', 'aria-disabled': empty || sending, onclick: () => send() }, sending ? 'Sending…' : label)
  const ta = field('textarea', {
    rows: 3, 'data-k': 'reply', 'aria-label': isFollow ? 'Follow-up' : 'Reply text', readonly: sending, 'aria-busy': sending,
    placeholder: isFollow ? 'Follow-up to the agent (Ctrl+Enter to send)' : draft.optionId ? 'Optional detail with your option (Ctrl+Enter to submit)' : 'Free-text answer (Ctrl+Enter to submit)'
  }, draft.text)
  const onEdit = () => { draft.text = ta.value; scheduleSave(); sendBtn.setAttribute('aria-disabled', String(!buildAnswer(x) || sending)) }
  ta.addEventListener('input', onEdit); ta.addEventListener('change', onEdit)
  const notesBtn = el('button', { type: 'button', class: 'd-btn d-notes-btn', 'data-k': 'notes-open', 'aria-expanded': notesInDialog() ? false : notesOpen, 'aria-controls': 'notesPanel',
    onclick: () => {
      noteSaved = null
      if (notesInDialog()) return openComposer(null)
      notesOpen = !notesOpen; render()
      root.querySelector<HTMLElement>(notesOpen ? '#notesPanel input, #notesPanel textarea, [data-k="notes-close"]' : '[data-k="notes-open"]')?.focus()
    } }, notesLabel(x))
  sendBtn.classList.add('d-btn', 'd-primary')
  return [
    ...(isFollow ? [el('p', { class: 'meta fu-help', style: 'margin:0' }, 'Add a follow-up. Your first answer stays as recorded.')] : []),
    ta,
    ...(notice ? [el('div', { class: `callout ${notice.tone === 'bad' ? '' : notice.tone}`, ...(notice.tone === 'bad' ? alertRole(`notice:${notice.text}`) : {}) }, notice.text,
      ...(notice.retry && draft.replyId ? [' ', el('button', { type: 'button', 'data-k': 'retry-send', onclick: () => send() }, `Retry (same reply ID ${draft.replyId})`), ' ',
        el('button', { type: 'button', onclick: () => copy(draft.text, 'Reply') }, 'Copy reply')] : []),
      ...(notice.notes ? [' ', el('button', { type: 'button', 'data-k': 'review-notes', onclick: () => reviewNotes() }, 'Review notes')] : []))] : []),
    ...(draftFail ? [el('div', { class: 'callout warn', role: 'status' }, `Draft not saved. ${failureText(draftFail)} It is kept in this tab only.`)] : []),
    el('div', { class: 'd-dock-foot' },
      el('span', { class: 'd-hint' }, 'Replies go only to the original chat. Ctrl+Enter sends.'),
      notesBtn, sendBtn)
  ]
}

const STEPS: ShownState[] = ['awaiting-answer', 'submitted', 'agent-received', 'undelivered']
/** Optional reader fields agreed with the BE worker (absent on older workers). */
type RichDecision = Decision & {
  context?: string
  activity?: { label: string; at?: string; text: string }[]
  package?: { index: number; size: number | null }
  nativeLinks?: { kind: string; ref: string; label: string; url?: string }[]
}
const pkgOrder = (a: Decision, b: Decision) => {
  const ia = (a as RichDecision).package?.index, ib = (b as RichDecision).package?.index
  if (ia !== undefined && ib !== undefined) return ia - ib
  const na = Number(a.questionId.split(':').at(-1)), nb = Number(b.questionId.split(':').at(-1))
  if (nativeOf(a) && Number.isInteger(na) && Number.isInteger(nb)) return na - nb
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.questionId.localeCompare(b.questionId)
}
/** Rebinds this editor to another question of the package; drafts stay with their own question. */
function goTo(questionId: string) {
  if (ref.view === 'dashboard') return void selectInDashboard(questionId)
  ref = { view: 'review', questionId }; void bind()
}
/** "Question i / N" with Previous / Next over the package (siblings from one bounded page). */
function pager(x: Decision): HTMLElement {
  const declared = x.package
  // Sibling IDs: declared by the worker (native asks), else from the loaded package page.
  const ids = declared?.questionIds ?? [...pkg.filter((s) => s.questionId !== x.questionId), x].sort(pkgOrder).map((s) => s.questionId)
  const at = Math.max(0, ids.indexOf(x.questionId))
  const index = declared?.index ?? at
  const known = declared?.questionIds ? ids.length : declared?.size ?? null
  const total = known !== null ? String(known) : declared ? `${Math.max(ids.length, index + 1)}+` : pkgMore ? `${ids.length}+` : String(ids.length)
  const prev = ids[at - 1], next = ids[at + 1]
  return el('nav', { class: 'pager', 'aria-label': 'Questions in this package' }, `Question ${index + 1} / ${total}`,
    el('button', { type: 'button', 'data-k': 'q-prev', 'aria-disabled': !prev, onclick: () => prev && goTo(prev) }, '‹ Previous'),
    el('button', { type: 'button', 'data-k': 'q-next', 'aria-disabled': !next, onclick: () => next && goTo(next) }, 'Next ›'))
}
/** Secondary metadata and the original source text, on demand. */
function disclosures(x: Decision, rows: [string, string][], extra: HTMLElement[] = []): HTMLElement[] {
  const r = x as RichDecision
  return [
    el('details', { class: 'd-details' }, el('summary', {}, 'Details'), ...extra,
      el('dl', { class: 'meta', style: 'display:grid;grid-template-columns:max-content 1fr;gap:2px 10px;margin:6px 0' },
        ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', { style: 'margin:0;color:var(--fg)' }, v)])),
      ...(r.nativeLinks ?? []).map((l) => el('p', { class: 'meta', style: 'margin:2px 0' }, l.url
        ? el('a', { href: l.url, onclick: (ev: Event) => { ev.preventDefault(); void openLink(l.url!) } }, `${l.label} ↗`) : `${l.label} (${l.kind} ${l.ref})`)),
      ...(x.sourceLinks.length ? [el('p', { style: 'margin:4px 0' }, ...x.sourceLinks.map((l) => el('a', { href: l.url, onclick: (ev: Event) => { ev.preventDefault(); void openLink(l.url) } }, `${l.label} ↗  `)))] : [])),
    ...((r.activity ?? []).length ? [el('details', { class: 'd-details' }, el('summary', {}, 'Original activity'),
      ...r.activity!.map((a) => el('section', {}, el('p', { class: 'meta', style: 'margin:6px 0 2px' }, a.at ? `${a.label} · ${when(a.at)}` : a.label), rich(a.text))))] : [])
  ]
}
/** Sheet header: source, and labelled icon controls (Back/Close in the dashboard, Copy link). */
function sheetHead(x: Decision | null): HTMLElement {
  const inDash = ref.view === 'dashboard'
  const n = x && nativeOf(x)
  return el('div', { class: 'd-sheet-head' },
    ...(inDash ? [el('button', { type: 'button', class: 'd-icon-btn', 'data-k': 'sheet-back', 'aria-label': 'Back to the decision list', title: 'Back', onclick: () => closeDashSheet() }, '←')] : []),
    el('span', { class: 'd-where' }, !x ? 'Decision' : n ? 'Bot Item · read-only' : 'Chat decision'),
    el('span', { class: 'd-spacer' }),
    ...(inDash ? [el('button', { type: 'button', class: 'd-icon-btn d-wide-only', 'data-k': 'sheet-reset', 'aria-label': 'Reset the decision panel width', title: 'Reset panel width', ...(sheetW === null ? { hidden: true } : {}), onclick: () => setSheetW(null) }, '↔')] : []),
    ...(x && x.decisionLink ? [el('button', { type: 'button', class: 'd-icon-btn', 'data-k': 'copy-link', 'aria-label': 'Copy decision link', title: 'Copy decision link', onclick: () => copy(x.decisionLink, 'Decision link') }, '⧉')] : []),
    ...(inDash ? [el('button', { type: 'button', class: 'd-icon-btn', 'data-k': 'sheet-close', 'aria-label': 'Close decision', title: 'Close (Esc)', onclick: () => closeDashSheet() }, '✕')] : []))
}
const sheet = (x: Decision | null, body: HTMLElement[], dock: HTMLElement | null) =>
  el('section', { class: 'd-sheet', 'aria-labelledby': 'sheetTitle' }, sheetHead(x),
    el('div', { class: 'd-sheet-body', 'data-k': 'sheet-body', tabindex: -1 }, ...body), ...(dock ? [dock] : []))

/** "1 / 3" with labelled previous/next icon buttons, for the reply card. */
function pagerNode(x: Decision): HTMLElement | null {
  const declared = x.package
  const ids = declared?.questionIds ?? [...pkg.filter((s) => s.questionId !== x.questionId), x].sort(pkgOrder).map((s) => s.questionId)
  const at = Math.max(0, ids.indexOf(x.questionId))
  const index = declared?.index ?? at
  const known = declared?.questionIds ? ids.length : declared?.size ?? null
  const total = known !== null ? String(known) : declared ? `${Math.max(ids.length, index + 1)}+` : pkgMore ? `${ids.length}+` : String(ids.length)
  if (total === '1') return null
  const prev = ids[at - 1], next = ids[at + 1]
  return el('nav', { class: 'pager d-pager', 'aria-label': 'Questions in this package' },
    el('button', { type: 'button', class: 'd-icon-btn', 'data-k': 'q-prev', 'aria-label': 'Previous question', 'aria-disabled': !prev, onclick: () => prev && goTo(prev) }, '‹'),
    el('span', { 'aria-live': 'polite', 'aria-label': `Question ${index + 1} of ${total}` }, `${index + 1} / ${total}`),
    el('button', { type: 'button', class: 'd-icon-btn', 'data-k': 'q-next', 'aria-label': 'Next question', 'aria-disabled': !next, onclick: () => next && goTo(next) }, '›'))
}
/** The recommendation, shown once, in the reply card. */
let recOpen = false
const recNode = (x: Decision, attrs: K = {}, pager: HTMLElement | null = null) => {
  if (!x.recommendation.trim()) return null
  const long = x.recommendation.length > 140 || x.recommendation.split('\n').length > 3
  return el('div', { class: `d-rec${recOpen ? ' open' : ''}` },
    el('div', { class: 'd-rec-head' }, el('span', { class: 'd-rec-label' }, 'Recommendation'), el('span', { class: 'd-spacer' }),
      ...(long ? [el('button', { type: 'button', class: 'd-icon-btn d-rec-more', 'data-k': 'rec-toggle', 'aria-expanded': recOpen, 'aria-label': recOpen ? 'Show less of the recommendation' : 'Show the whole recommendation', title: recOpen ? 'Show less' : 'Show all',
        onclick: () => { recOpen = !recOpen; render() } }, recOpen ? '⌃' : '⌄')] : []), ...(pager ? [pager] : [])),
    rich(x.recommendation, attrs))
}
/** Pager on the right of the card's first row. */
/** The card's top: the recommendation with the pager in its header, or the pager alone. */
const dockTop = (x: Decision, attrs: K = {}, left: HTMLElement | null = null): HTMLElement[] => {
  const p = pagerNode(x)
  const rec = recNode(x, attrs, p)
  if (rec) return left ? [el('div', { class: 'd-dock-row d-dock-head' }, left), rec] : [rec]
  return p || left ? [el('div', { class: 'd-dock-row d-dock-head' }, left ?? el('span'), ...(p ? [p] : []))] : []
}
/**
 * The canonical form of an allowed work-item URL, or null: https only, no credentials, and only
 * github.com/<owner>/<repo>/issues|pull/<n> or linear.app/<team>/issue/<ID>, matching its kind.
 * Case, a trailing slash, query and hash do not make a different link.
 */
function workItemKey(kind: string, url: string): string | null {
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  const host = u.hostname.toLowerCase(), path = u.pathname.replace(/\/+$/, '').toLowerCase()
  const gh = host === 'github.com' && /^\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+$/.exec(path)
  if (gh) return (kind === 'github-issue' && gh[1] === 'issues') || (kind === 'github-pr' && gh[1] === 'pull') ? `${host}${path}` : null
  if (host === 'linear.app' && kind === 'linear-issue' && /^\/[\w-]+\/issue\/[a-z][a-z0-9]*-\d+(\/[\w-]*)?$/.test(path)) return `${host}${path.split('/').slice(0, 4).join('/')}`
  return null
}
const WORK_ITEM: Record<string, [string, string]> = { 'github-issue': ['GitHub issue', '◎'], 'github-pr': ['GitHub pull request', '⑂'], 'linear-issue': ['Linear issue', '◇'] }
/**
 * Direct actions for the decision's sources: the GitHub issues, pull requests and Linear issues the
 * worker recognized in authorized source links (https only, deduplicated by URL), opened through
 * Orca's external-open API on a real click; and Copy session ID for the verified originating chat.
 * Orca exposes no verified way to focus that exact session, so none is offered.
 */
function sourceActions(x: Decision): HTMLElement[] {
  const seen = new Set<string>()
  const links = (x.workItemLinks ?? []).filter((l) => {
    const key = workItemKey(l.kind, l.url)
    return key !== null && !seen.has(key) && !!seen.add(key)
  })
  return [...links.map((l, i) => {
    const [kind, icon] = WORK_ITEM[l.kind]
    return el('a', { class: 'd-src-act', href: l.url, target: '_blank', rel: 'noopener noreferrer', 'data-k': `src-${i}`, 'aria-label': `Open ${kind} ${l.label}`, title: `Open ${kind}: ${l.label}`,
      onclick: (ev: Event) => { ev.preventDefault(); void openLink(l.url) } }, el('span', { 'aria-hidden': 'true' }, icon), ` ${l.label}`)
  }),
  ...(x.originalSessionId ? [el('button', { type: 'button', class: 'd-src-act', 'data-k': 'copy-session', 'aria-label': 'Copy session ID of the original chat', title: `Copy session ID (${x.originalSessionId})`,
    onclick: () => copy(x.originalSessionId!, 'Session ID') }, el('span', { 'aria-hidden': 'true' }, '⧉'), ' Copy session ID')] : [])]
}
/** Source line and the facts card under the title (Variant D's meta). */
function metaNode(x: Decision, status: string, stateCard?: HTMLElement): HTMLElement[] {
  const due = deadlineLabel(x, clock.now())
  const remote = x.origin.hostId !== 'local'
  const n = nativeOf(x)
  const dd = (k: string, v: Node | string) => [el('div', {}, el('dt', {}, k), el('dd', {}, v))]
  return [
    el('div', { class: 'd-srcline' }, el('span', {}, n && !n.workspaceAttributed ? 'No workspace attribution' : `${x.projectName} · ${x.workspaceName}`),
      el('span', {}, n ? `Bot Item${n.botName ? ` · ${n.botName}` : ''}${n.itemLabel ? ` · ${n.itemLabel}` : ''}` : 'Chat decision'),
      ...(remote ? [el('span', { class: 'chip' }, `host: ${x.origin.hostId}`)] : []),
      ...sourceActions(x)),
    ...(stateCard ? [stateCard] : []),
    el('dl', { class: 'd-meta' },
      ...dd('Priority', el('span', { class: `d-pill d-p-${x.priority}` }, x.priority)),
      ...dd('Status', el('span', { class: 'd-pill' }, status)),
      ...(x.deadline ? dd('Deadline', el('span', { class: due?.overdue ? 'd-due-over' : '' }, `${due!.text} · ${when(x.deadline)}`)) : []),
      ...dd(n?.observedAt ? 'As of' : 'Opened', when(n?.observedAt ?? x.createdAt)),
      ...(x.blockedWork.length ? dd('Blocks', x.blockedWork.join(', ')) : []))]
}
/**
 * Always-visible current state, under the title: the state, one sentence, and only the milestones
 * that were recorded (opened; the latest reply saved; mail hand-off, the chat's receipt, or why it
 * was not delivered), with at most one next step. Nothing is inferred: Agent received needs a
 * receipt that matches (replyState).
 */
function progressCard(x: Decision, state: ShownState): HTMLElement {
  const replies = x.answerState.state === 'answered' ? [x.answerState.initial, ...x.answerState.followUps] : []
  const latest = replies.at(-1)
  const n = nativeOf(x)
  const ms: [string, string][] = [['Opened', when(x.createdAt)]]
  let sentence: string, next: string | null = null
  if (n) {
    sentence = `Orca reports this Item as ${nativeStatusLabel(n.itemStatus).toLowerCase()}.`
    if (n.observedAt) ms.push(['Snapshot', when(n.observedAt)])
    next = "Answer it in Orca's Bot Items view."
  } else if (!latest) { sentence = 'No answer saved yet.'; next = 'Answer in the reply card below.' }
  else {
    const what = replies.length > 1 ? `Follow-up ${replies.length - 1} saved` : 'Answer saved'
    ms.push([what, when(latest.acceptedAt)])
    const st = replyState(latest, x), dl = latest.delivery
    if (st === 'agent-received' && dl.state === 'agent-received') { ms.push(['Agent received', `${when(dl.receipt.receivedAt)} · receipt ${dl.receipt.receiptId}`]); sentence = 'The original chat confirmed it received your answer.' }
    else if (dl.state === 'undelivered') { ms.push(['Delivery failed', REASON[dl.reason]]); sentence = 'Saved in Decision Inbox, but not delivered to the original chat.' }
    else if (dl.state === 'submitted' && dl.transport) { ms.push(['Submitted to Orca mail', `${when(dl.transport.acceptedAt)} · ${dl.transport.messageId}`]); sentence = 'Handed to Orca mail; waiting for the original chat to confirm.'; next = 'Agent received appears when the chat confirms.' }
    else { sentence = 'Saved in Decision Inbox; not yet handed to the original chat.'; next = 'Agent received appears only when the chat confirms.' }
  }
  const label = n ? nativeStatusLabel(n.itemStatus) : STATE_LABEL[state]
  return el('section', { class: 'd-progress', 'aria-label': 'Current state' },
    el('div', { class: 'd-progress-head' },
      el('span', { class: `step d-state-pill${state === 'undelivered' && !n ? ' bad' : ''}`, 'aria-current': 'step' }, `● ${label}`),
      el('span', { class: 'd-progress-say' }, sentence)),
    el('ul', { class: 'd-milestones', 'aria-label': 'Recorded milestones' }, ...ms.map(([k, v]) => el('li', {}, el('b', {}, k), ` · ${v}`)),
      ...(next ? [el('li', { class: 'd-next' }, `Next: ${next}`)] : [])))
}
/** Images: placed inline in the narrative when the agent placed them; all of them (with optional
 *  side-by-side compare and per-image notes) here, collapsed when they already appear inline. */
function imagesNode(x: Decision): HTMLElement[] {
  const imgs = x.evidence.filter((e): e is Img => e.kind === 'image-snapshot')
  if (!imgs.length) return []
  const pair = b !== null && imgs.length > 1
  if (a >= imgs.length) a = 0
  if (b !== null && b >= imgs.length) b = null
  const inner = [
    el('div', { class: 'film', role: 'group', 'aria-label': 'Snapshots' }, ...imgs.map((e, i) => el('button', {
      type: 'button', 'data-k': `thumb-${i}`, 'aria-pressed': a === i || b === i,
      onclick: (ev: MouseEvent) => { if (!pair) a = i; else if (ev.shiftKey || target === 'left') a = i; else b = i; render() }
    }, `${i + 1} · ${e.label}`))),
    el('div', { class: 'bar' }, el('button', { type: 'button', 'data-k': 'compare', 'aria-pressed': pair, onclick: () => { b = pair ? null : (a + 1) % imgs.length; target = 'right'; render() } }, 'Compare side by side'),
      ...(pair ? [el('span', { class: 'meta' }, 'Thumbnails fill:'),
        el('button', { type: 'button', 'data-k': 'target-left', 'aria-pressed': target === 'left', onclick: () => { target = 'left'; render() } }, 'Left'),
        el('button', { type: 'button', 'data-k': 'target-right', 'aria-pressed': target === 'right', onclick: () => { target = 'right'; render() } }, 'Right'),
        el('span', { class: 'meta' }, 'Shift-click fills the left.')] : [])),
    el('div', { class: `vp${pair ? ' pair' : ''}` }, viewer(imgs, a, pair ? 'Left' : 'Main'), ...(pair ? [viewer(imgs, b!, 'Right')] : []))]
  const inline = (x.inlineImages ?? []).length > 0
  return inline
    ? [el('details', { class: 'd-images', ...(pair || imgsOpen ? { open: true } : {}), ontoggle: (ev: Event) => { imgsOpen = (ev.target as HTMLDetailsElement).open } },
        el('summary', {}, `All images (${imgs.length}) · compare and annotate`), ...inner)]
    : [el('h2', { class: 'd-sec-h' }, `Images · ${imgs.length}`), ...inner]
}
let imgsOpen = false

function renderReview(questionId: string) {
  const x = d
  if (!x) {
    shownD = null
    readerHost.replaceChildren(sheet(null, [loadFail
      ? el('div', { class: 'callout', ...alertRole(`load:${questionId}:${loadFail.code}`) }, loadFail.code === 'not-found'
        ? `Decision "${questionId}" was not found. It may have been withdrawn, or you may not have access.`
        : loadFail.code === 'forbidden' ? `You do not have access to decision "${questionId}".`
        : `Could not load decision "${questionId}". ${failureText(loadFail)}`,
        ...(loadFail.code === 'unavailable' ? [' ', el('button', { type: 'button', onclick: () => loadReview(questionId) }, 'Try again')] : []))
      : el('p', { class: 'meta', role: 'status' }, 'Loading decision…')], null))
    return
  }
  const native = nativeOf(x)
  if (native) return renderNative(x, native)
  const state = shownState(x)
  const due = deadlineLabel(x, clock.now())
  const links = x.evidence.filter((e) => e.kind === 'link')
  const awaiting = !answered(x)
  const body: HTMLElement[] = [
    ...(x.context && x.context !== x.title ? [el('p', { class: 'ctx' }, x.context)] : []),
    el('h1', { id: 'sheetTitle', tabindex: -1 }, x.title),
    ...metaNode(x, STATE_LABEL[state], progressCard(x, state)),
    ...(due?.overdue ? [el('div', { class: 'callout', ...alertRole(`due:${due.text}`) }, `${due.text}.`)] : []),
    ...sections(x, { 'data-field': 'background', style: 'user-select:text' }),
    ...imagesNode(x),
    ...(links.length ? [el('h2', { class: 'd-sec-h' }, 'Linked evidence'), el('p', { style: 'margin:0' }, ...links.map((l) => l.kind === 'link'
      ? el('a', { href: l.url, onclick: (ev: Event) => { ev.preventDefault(); void openLink(l.url) } }, `${l.label} · v${l.version} ↗  `) : ''))] : []),
    ...(answered(x) ? [el('h2', { class: 'd-sec-h' }, 'Your answer and follow-ups'), ...thread(x)] : []),
    ...disclosures(x, [['Project', x.projectName], ['Workspace', x.workspaceName], ...(x.origin.hostId !== 'local' ? [['Host', x.origin.hostId] as [string, string]] : []),
      ['Priority', x.priority], ...(x.deadline ? [['Deadline', when(x.deadline)] as [string, string]] : []), ['Created', when(x.createdAt)],
      ...(x.blockedWork.length ? [['Blocks', x.blockedWork.join(', ')] as [string, string]] : []), ['Question ID', x.questionId]], packageNodes())
  ]
  const canReply = actionsOf(x).includes(awaiting ? 'reply' : 'follow-up')
  const dock = el('section', { class: 'd-dock dock', 'aria-label': 'Reply' },
    ...dockTop(x, { 'data-field': 'recommendation', style: 'user-select:text' }),
    ...(awaiting && canReply && !heldInitial(x) ? [x.options.length
      ? el('div', { role: 'radiogroup', 'aria-label': 'Options', class: 'd-opts' }, ...x.options.map((o) =>
          el('label', { class: 'opt d-opt', title: o.detail ?? '' }, el<HTMLInputElement>('input', { type: 'radio', name: 'opt', 'data-k': `opt-${o.optionId}`, checked: draft.optionId === o.optionId, disabled: sending, onchange: () => { draft.optionId = o.optionId; scheduleSave(); render() } }),
            el('span', {}, o.label, ...(o.detail ? [el('span', { class: 'meta' }, ` — ${o.detail}`)] : [])))))
      : el('p', { class: 'meta', style: 'margin:0' }, 'No fixed options. Answer in text.')] : []),
    ...(awaiting && canReply && !heldInitial(x) ? useRecNode(x) : []),
    ...(noteSaved === x.questionId && draft.annotations.length ? [el('div', { class: 'd-dock-row d-note-saved', role: 'status' },
      el('span', {}, `Note saved with your draft (${draft.annotations.length}). Not sent yet: notes go with your reply.`),
      el('button', { type: 'button', class: 'd-btn d-ghost', 'data-k': 'notes-edit', onclick: () => {
        noteSaved = null
        if (notesInDialog()) return openComposer(null)
        notesOpen = true; render(); root.querySelector<HTMLElement>('#notesPanel input, [data-k="notes-close"]')?.focus()
      } }, 'Edit notes'))] : []),
    ...(canReply ? composeArea(x) : [el('p', { class: 'meta', style: 'margin:0' }, 'Replying here is not available for this decision right now.')]),
    notesPanel(x))
  readerHost.replaceChildren(sheet(x, body, dock))
  for (const f of ['background', 'recommendation'] as const) { const box = readerHost.querySelector(`[data-field="${f}"]`); if (box) markNotes(box, f) }
  shownD = x
  if (focusNote !== null) { root.querySelector<HTMLInputElement>(`[data-note="${focusNote}"]`)?.focus(); focusNote = null }
}
/**
 * "Use PM recommendation": proposes the recommended answer in this question's draft; it is never
 * sent by this action. A recommended option is selected only by its exact ID (with no text); without
 * one, the recommendation's own text fills the reply box and no option is guessed. An existing draft
 * is replaced only after "Replace draft" (Keep my draft has focus), and Undo restores it.
 */
let recAsk: string | null = null
let recUndo: { questionId: string; optionId?: string; text: string } | null = null
function useRecNode(x: Decision): HTMLElement[] {
  const opt = x.recommendedOptionId ? x.options.find((o) => o.optionId === x.recommendedOptionId) : undefined
  const text = x.recommendation.trim()
  if (!opt && !text) return []
  const apply = () => {
    if (d !== x || sending) return
    recUndo = { questionId: x.questionId, optionId: draft.optionId, text: draft.text }
    recAsk = null
    if (opt) { draft.optionId = opt.optionId; draft.text = '' } else { draft.optionId = undefined; draft.text = text }
    scheduleSave(); render(); say(`Proposed from the PM recommendation${opt ? `: ${opt.label}` : ''}. Nothing is sent until you submit.`)
    root.querySelector<HTMLElement>('[data-k="rec-undo"]')?.focus()
  }
  if (recUndo?.questionId === x.questionId) {
    const u = recUndo
    return [el('div', { class: 'd-dock-row d-proposed', role: 'status' },
      el('span', {}, `Proposed from the PM recommendation${opt ? `: ${opt.label}` : ''}. Nothing is sent until you submit.`),
      el('button', { type: 'button', class: 'd-btn', 'data-k': 'rec-undo', onclick: () => {
        if (d !== x) return
        draft.optionId = u.optionId; draft.text = u.text; recUndo = null; scheduleSave(); render(); say('Your previous draft is back')
        root.querySelector<HTMLElement>('[data-k="use-rec"]')?.focus()
      } }, 'Undo'))]
  }
  if (recAsk === x.questionId) {
    return [el('div', { class: 'd-dock-row d-confirm', role: 'group', 'aria-labelledby': 'recAskQ' },
      el('span', { id: 'recAskQ' }, 'Replace your draft with the PM recommendation?'),
      el('button', { type: 'button', class: 'd-btn', 'data-k': 'rec-keep', onclick: () => { recAsk = null; render(); root.querySelector<HTMLElement>('[data-k="use-rec"]')?.focus() } }, 'Keep my draft'),
      el('button', { type: 'button', class: 'd-btn d-primary', 'data-k': 'rec-replace', onclick: apply }, 'Replace draft'))]
  }
  return [el('div', { class: 'd-dock-row d-use-rec' },
    el('button', { type: 'button', class: 'd-btn', 'data-k': 'use-rec', 'aria-disabled': sending,
      'aria-label': opt ? `Use PM recommendation: select ${opt.label}` : 'Use PM recommendation: put it in your reply', onclick: () => {
        if (sending || d !== x) return
        if (draft.optionId || draft.text.trim()) { recAsk = x.questionId; render(); root.querySelector<HTMLElement>('[data-k="rec-keep"]')?.focus() }
        else apply()
      } }, '✓ Use PM recommendation'),
    el('span', { class: 'd-hint' }, opt ? `Selects “${opt.label}”. Nothing is sent until you submit.` : 'Puts the recommendation in your reply. Nothing is sent until you submit.'))]
}
/**
 * Background (circumstances, motivation, evidence), then Description (what is proposed or decided),
 * each once, under its own heading, only when supplied. When the authored Markdown already opens
 * with that heading, ours is not added. Background keeps its raw text, so note anchors and inline
 * image offsets are unchanged; Description carries no anchors.
 */
type Described = Decision & { description?: string }
const opensWith = (md: string, name: string) => new RegExp(`^\\s*#{1,6}\\s+${name}\\s*#*\\s*(\\n|$)`, 'i').test(md)
function sections(x: Decision, bgAttrs: K): HTMLElement[] {
  const desc = (x as Described).description ?? ''
  const out: HTMLElement[] = []
  if (x.background.trim() || (x.inlineImages ?? []).length) out.push(...(opensWith(x.background, 'Background') ? [] : [el('h2', { class: 'd-sec-h', id: 'secBackground' }, 'Background')]), rich(x.background, bgAttrs, x.inlineImages ?? [], x))
  if (desc.trim()) out.push(...(opensWith(desc, 'Description') ? [] : [el('h2', { class: 'd-sec-h', id: 'secDescription' }, 'Description')]), rich(desc, { class: 'rich d-desc' }))
  return out
}
/** Same-package questions, each with its own state (paging itself lives in the reply card). */
function packageNodes(): HTMLElement[] {
  if (!pkg.length && !pkgFail) return []
  return [el('p', { class: 'meta', style: 'margin:6px 0 2px' }, 'Same package'), pkgFail ? el('p', { class: 'meta' }, `Could not load the other questions in this package. ${failureText(pkgFail)}`)
    : el('div', { class: 'pkg' }, ...pkg.map((s) => el('span', { class: 'chip' }, `${s.title} · ${STATE_LABEL[shownState(s)]} `,
      el('button', { type: 'button', 'data-k': `open-${s.questionId}`, 'aria-label': `Open ${s.title}`, onclick: () => openOther(s.questionId) }, 'Open'))))]
}

// ---- native Bot Item (read-only) ------------------------------------------------------------------
/**
 * A read-only copy of a native Orca Bot Item. The Inbox shows what Orca reported and where to
 * answer it; it offers no reply, notes, retry, resolve or deep link, because none is supported.
 */
function renderNative(x: Decision, n: NativeSource) {
  const links = x.evidence.filter((e) => e.kind === 'link')
  const item = [n.botName && `bot “${n.botName}”`, n.itemLabel && `item ${n.itemLabel}`].filter(Boolean).join(', ')
  const body: HTMLElement[] = [
    ...(x.context && x.context !== x.title ? [el('p', { class: 'ctx' }, x.context)] : []),
    el('h1', { id: 'sheetTitle', tabindex: -1 }, x.title),
    ...metaNode(x, nativeStatusLabel(n.itemStatus), progressCard(x, shownState(x))),
    ...sections(x, {}),
    ...(links.length ? [el('h2', { class: 'd-sec-h' }, 'Linked evidence'), el('p', { style: 'margin:0' }, ...links.map((l) => l.kind === 'link'
      ? el('a', { href: l.url, onclick: (ev: Event) => { ev.preventDefault(); void openLink(l.url) } }, `${l.label} · v${l.version} ↗  `) : ''))] : []),
    ...disclosures(x, [['Status in Orca', `${nativeStatusLabel(n.itemStatus)}${n.observedAt ? ` · as of ${when(n.observedAt)}` : ''}`],
      ...(n.botName ? [['Bot', n.botName] as [string, string]] : []), ...(n.itemLabel ? [['Item', n.itemLabel] as [string, string]] : []),
      ['Workspace', n.workspaceAttributed ? `${x.projectName} · ${x.workspaceName}` : 'No workspace attribution'],
      ...(x.origin.hostId && x.origin.hostId !== 'local' ? [['Host', n.hostLabel ?? x.origin.hostId] as [string, string]] : []),
      ['Priority', x.priority], ['Question ID', x.questionId]])
  ]
  // Native Items are answered in Orca: a compact read-only footer with the options, no reply controls.
  const dock = el('section', { class: 'd-dock d-ro-dock dock', 'aria-label': 'Where to answer' },
    ...dockTop(x),
    el('div', { class: 'd-dock-row' }, el('p', { style: 'margin:0;font-weight:600;flex:1' }, `Answer in Orca's Bot Items${item ? `: ${item}` : ''}`),
      ...(item ? [el('button', { type: 'button', class: 'd-btn', 'data-k': 'copy-location', onclick: () => copy(`${item}${n.observedAt ? ` (as of ${when(n.observedAt)})` : ''}`, 'Location') }, 'Copy location')] : [])),
    ...(x.options.length ? [el('ul', { class: 'd-opts', style: 'list-style:none;padding:0;margin:0' }, ...x.options.map((o) =>
      el('li', { class: 'd-opt' }, o.detail ? `${o.label} — ${o.detail}` : o.label)))] : []),
    el('p', { class: 'meta', style: 'margin:0' }, 'Read-only copy: Decision Inbox cannot answer, resolve or open this Item for you.'))
  readerHost.replaceChildren(sheet(x, body, dock))
  shownD = x
}

// ---- Inbox Settings (same editor, `{"view":"settings"}`) -----------------------------------------
const ANY_OTHER = '(any other repo)'
let settings: InboxSettings | null = null
let savedSettings = ''
let settingsFail: Failure | null = null
let repos: string[] = []
let reposFail: Failure | null = null
let previewRepo = ANY_OTHER
let effective: { repo: string; r: { ok: true; value: EffectivePolicy } | Failure } | null = null
let settingsNotice: Notice | null = null
let stale = false
const editable = (s: InboxSettings) => JSON.stringify({ defaultTemplate: s.defaultTemplate, exceptions: s.exceptions })

let previewChosen = false
async function loadSettings() {
  const [s, rp] = await Promise.all([call(req, 'settings.get'), call(req, 'settings.repos')])
  if (s.ok) { settings = s.value; savedSettings = editable(s.value); settingsFail = null; stale = false } else { settings = null; settingsFail = s }
  if (rp.ok) { repos = rp.value; reposFail = null } else { repos = []; reposFail = rp }
  if (previewRepo !== ANY_OTHER && !repos.includes(previewRepo)) previewRepo = ANY_OTHER
  // Start on the first repo once; afterwards keep the owner's choice, "(any other repo)" included.
  if (!previewChosen && previewRepo === ANY_OTHER && repos.length) previewRepo = repos[0]
  previewChosen = true
  effective = null
  render()
}
/**
 * An invalidation fires for drafts, replies and deliveries too. Settings count as changed
 * elsewhere only when the stored revision differs: then unsaved edits are kept and flagged, and a
 * clean form takes the new settings. The repo list refreshes quietly.
 */
async function settingsInvalidated() {
  if (!settings) return loadSettings()
  const [s, rp] = await Promise.all([call(req, 'settings.get'), call(req, 'settings.repos')])
  if (ref.view !== 'settings' || !settings) return
  let changed = false
  if (rp.ok && JSON.stringify(rp.value) !== JSON.stringify(repos)) { repos = rp.value; reposFail = null; changed = true }
  if (s.ok && s.value.revision !== settings.revision) {
    if (editable(settings) !== savedSettings) stale = true
    else { settings = s.value; savedSettings = editable(s.value); stale = false }
    effective = null; changed = true
  }
  if (changed) requestRender(true)
}
let effectiveLoading: string | null = null
async function loadEffective(repo: string) {
  if (effectiveLoading === repo) return
  effectiveLoading = repo
  const r = await call(req, 'settings.effective', { repo })
  effectiveLoading = null
  effective = { repo, r }
  render()
}
async function saveSettings() {
  if (!settings) return
  const r = await call(req, 'settings.save', settings)
  if (r.ok) { settings = r.value; savedSettings = editable(r.value); stale = false; effective = null; settingsNotice = { tone: 'info', text: 'Settings saved.' } }
  else if (r.code === 'conflict') settingsNotice = { tone: 'bad', text: 'Settings changed elsewhere since you opened them, so nothing was saved. Load the latest settings (your edits are discarded), then edit again.' }
  else settingsNotice = { tone: 'bad', text: `Not saved. ${failureText(r)}` }
  say(settingsNotice.text); render()
}

function renderSettings() {
  if (!settings) {
    root.replaceChildren(el('main', { class: 'set' }, el('h1', {}, 'Inbox settings'), settingsFail
      ? el('div', { class: 'callout', ...alertRole(`settings:${settingsFail.message}`) }, `Could not load Inbox settings. ${failureText(settingsFail)} `, el('button', { type: 'button', onclick: () => loadSettings() }, 'Try again'))
      : el('p', { class: 'meta', role: 'status' }, 'Loading settings…')))
    return
  }
  const s = settings
  const dirty = editable(s) !== savedSettings
  const used = new Set(s.exceptions.map((e) => e.repo))
  const free = repos.filter((r) => !used.has(r))
  const defaultEmpty = !s.defaultTemplate.trim()
  const select = (label: string, k: string, value: string, options: string[], onchange: (v: string) => void) =>
    el<HTMLSelectElement>('select', { 'aria-label': label, 'data-k': k, onchange: (ev: Event) => onchange((ev.target as HTMLSelectElement).value) },
      ...options.map((o) => el('option', { value: o, selected: o === value }, o)))
  // Unsaved edits preview locally; once saved, the worker's effective policy is the source of truth.
  let preview: HTMLElement
  if (previewRepo === ANY_OTHER || dirty) {
    const hit = previewRepo === ANY_OTHER ? undefined : s.exceptions.find((e) => e.repo === previewRepo)
    preview = el('div', { class: 'prev', style: 'margin-top:8px' },
      el('div', { class: 'meta' }, el('span', { class: 'chip' }, hit ? `Exception for ${hit.repo}` : 'Default'), dirty ? 'Preview of your unsaved changes.' : 'The saved default template.'),
      el('div', { class: 'raw' }, (hit ? hit.template : s.defaultTemplate) || '(empty)'))
  } else if (effective?.repo !== previewRepo) {
    void loadEffective(previewRepo)
    preview = el('p', { class: 'meta', role: 'status' }, 'Loading the effective rules…')
  } else if (!effective.r.ok) {
    preview = el('div', { class: 'callout', ...alertRole(`effective:${effective.r.message}`) }, `Could not load the effective rules. ${failureText(effective.r)}`)
  } else {
    const p = effective.r.value
    preview = el('div', { class: 'prev', style: 'margin-top:8px' },
      el('div', { class: 'meta' }, el('span', { class: 'chip' }, p.source === 'exception' ? `Exception for ${previewRepo}` : 'Default'), 'This is the template an agent in that repo is told to follow.'),
      el('div', { class: 'raw' }, p.template || '(empty)'))
  }
  root.replaceChildren(el('main', { class: 'set' },
    el('h1', {}, 'Inbox settings'),
    el('p', { class: 'meta' }, 'These rules guide agents in supported Orca Chats. Agents also read each repo’s AGENTS.md and the role file they are given; those are not edited here.'),
    ...(stale ? [el('div', { class: 'callout warn', role: 'status' }, 'Settings were changed elsewhere. ', el('button', { type: 'button', onclick: () => loadSettings() }, 'Load latest (discards your edits)'))] : []),
    el('h2', {}, 'Default question template'),
    field('textarea', { rows: 7, 'data-k': 'default', 'aria-label': 'Default question template', 'aria-invalid': defaultEmpty, 'aria-describedby': 'default-err',
      oninput: (ev: Event) => { s.defaultTemplate = (ev.target as HTMLTextAreaElement).value; settingsNotice = null; settingsChrome() } }, s.defaultTemplate),
    el('div', { class: 'err', id: 'default-err', 'data-k': 'default-err', 'aria-live': 'polite' }, defaultEmpty ? 'The default template cannot be empty.' : ''),
    el('h2', {}, `Repo exceptions (${s.exceptions.length})`),
    ...(reposFail ? [el('div', { class: 'callout warn', role: 'status' }, `Could not load the repo list. ${failureText(reposFail)}`)] : []),
    ...(s.exceptions.length ? [] : [el('p', { class: 'meta' }, 'No exceptions. Every repo uses the default template.')]),
    ...s.exceptions.map((e, i) => el('div', { class: 'row2' },
      select(`Repo for exception ${i + 1}`, `ex-repo-${i}`, e.repo, [e.repo, ...free], (v) => { e.repo = v; render() }),
      field('textarea', { rows: 3, 'data-k': `ex-tpl-${i}`, 'aria-label': `Template for ${e.repo}`, oninput: (ev: Event) => { e.template = (ev.target as HTMLTextAreaElement).value; settingsChrome() } }, e.template),
      el('button', { type: 'button', 'aria-label': `Remove exception for ${e.repo}`, onclick: () => { s.exceptions.splice(i, 1); render() } }, 'Remove'))),
    el('button', { type: 'button', 'data-k': 'add-ex', 'aria-disabled': free.length === 0, onclick: () => { if (free.length) { s.exceptions.push({ repo: free[0], template: s.defaultTemplate }); render() } } },
      free.length ? 'Add exception' : repos.length ? 'Every repo already has an exception' : 'No repos to add'),
    el('h2', {}, 'Effective rules preview'),
    select('Preview repo', 'preview-repo', previewRepo, [...repos, ANY_OTHER], (v) => { previewRepo = v; previewChosen = true; render() }),
    el('div', { 'data-k': 'preview' }, preview),
    el('div', { class: 'meta' }, previewRepo === ANY_OTHER ? 'Also read: that repo’s AGENTS.md and the selected role file.' : `Also read: ${previewRepo}/AGENTS.md and the selected role file.`),
    ...(settingsNotice ? [el('div', { class: `callout ${settingsNotice.tone === 'bad' ? '' : settingsNotice.tone}`, ...(settingsNotice.tone === 'bad' ? alertRole(`snotice:${settingsNotice.text}`) : {}) }, settingsNotice.text,
      ...(settingsNotice.tone === 'bad' && /changed elsewhere/.test(settingsNotice.text) ? [' ', el('button', { type: 'button', onclick: () => { settingsNotice = null; void loadSettings() } }, 'Load latest settings')] : []))] : []),
    el('div', { class: 'bar', style: 'margin-top:14px' },
      // State is read at click time: typing updates these controls in place, never by a rebuild
      // between mousedown and click.
      el('button', { type: 'button', class: 'pri', 'data-k': 'save', 'aria-disabled': !dirty || defaultEmpty, onclick: () => {
        const c = settingsState(); if (c && c.dirty && !c.defaultEmpty) void saveSettings()
      } }, 'Save'),
      el('button', { type: 'button', 'data-k': 'revert', 'aria-disabled': !dirty, onclick: () => {
        const c = settingsState(); if (c?.dirty && settings) { settings = { ...settings, ...JSON.parse(savedSettings) }; settingsNotice = null; render() }
      } }, 'Revert'),
      el('span', { class: 'meta', role: 'status', 'data-k': 'set-status' }, dirty ? 'Unsaved changes' : 'Saved'))))
}
const settingsState = () => settings && { dirty: editable(settings) !== savedSettings, defaultEmpty: !settings.defaultTemplate.trim() }
/** After typing in a settings field: update Save, Revert, status, the empty-default error and the
 *  unsaved preview in place, keeping the field, its caret and any IME composition intact. */
function settingsChrome() {
  const c = settingsState(); if (!c || !settings) return
  const q = (k: string) => root.querySelector<HTMLElement>(`[data-k="${k}"]`)
  q('save')?.setAttribute('aria-disabled', String(!c.dirty || c.defaultEmpty))
  q('revert')?.setAttribute('aria-disabled', String(!c.dirty))
  const st = q('set-status'); const want = c.dirty ? 'Unsaved changes' : 'Saved'
  if (st && st.textContent !== want) st.textContent = want
  q('default')?.setAttribute('aria-invalid', String(c.defaultEmpty))
  const err = q('default-err'); const msg = c.defaultEmpty ? 'The default template cannot be empty.' : ''
  if (err && err.textContent !== msg) err.textContent = msg
  const pv = q('preview')
  if (pv && (c.dirty || previewRepo === ANY_OTHER)) {
    const hit = previewRepo === ANY_OTHER ? undefined : settings.exceptions.find((e) => e.repo === previewRepo)
    pv.replaceChildren(el('div', { class: 'prev', style: 'margin-top:8px' },
      el('div', { class: 'meta' }, el('span', { class: 'chip' }, hit ? `Exception for ${hit.repo}` : 'Default'), c.dirty ? 'Preview of your unsaved changes.' : 'The saved default template.'),
      el('div', { class: 'raw' }, (hit ? hit.template : settings.defaultTemplate) || '(empty)')))
  }
}


// ---- dashboard: Variant D queue and detail sheet in one main-area tab (`{"view":"dashboard"}`) -----
// Pending / Answered / All tabs with the workspace selector at the right, filters, a grouped table, and
// the selected decision in a full-height sheet: beside the table when wide, modal when narrow (≤899px).
// Selecting another decision rebinds the reader in place (no new tab), flushing the previous draft
// under its own question ID first; late answers from an earlier selection or query are dropped.
let readerHost: HTMLElement = root
let dashSel: string | null = null
let dashSeq = 0
let dashTimer: ReturnType<typeof setTimeout> | null = null
const sheetNarrow = matchMedia('(max-width: 899px)')
type Tab = 'pending' | 'answered' | 'all'
const dash = {
  tab: 'pending' as Tab, scope: 'workspace' as 'workspace' | 'all', wsFilter: '', priority: '', status: '', group: 'urgency', term: '',
  focus: undefined as Workspace | null | undefined, focusFail: null as Failure | null,
  rows: [] as Decision[], next: undefined as string | undefined, sources: [] as SourceStatus[], mail: undefined as { state: 'available' | 'unavailable'; message?: string } | undefined,
  loading: false as false | 'first' | 'more', fail: null as Failure | null, loaded: false, filtersOpen: false
}
let shell: { el: HTMLElement; list: HTMLElement; tabs: HTMLElement; wsSel: HTMLSelectElement; status: HTMLSelectElement; sheet: HTMLElement; side: HTMLElement } | null = null

async function resolveFocus() {
  if (dash.focus !== undefined) return
  const host = (orca as unknown as { host?: { call?: (m: string, p?: unknown) => Promise<{ workspaceId?: string } | null> } }).host
  let ctx: { workspaceId?: string } | null = null
  try { ctx = host?.call ? await host.call('workspace.readContext') : null } catch { ctx = null }
  if (!ctx?.workspaceId) { dash.focus = null; return }
  const r = await call(req, 'workspace.resolve', { workspaceId: ctx.workspaceId })
  if (r.ok) dash.focus = r.value
  else { dash.focus = null; dash.focusFail = r }
}
function pageInput(cursor?: string) {
  return {
    scope: dash.scope === 'all' || !dash.focus ? { kind: 'all' as const } : { kind: 'workspace' as const, workspace: { hostId: dash.focus.hostId, workspaceId: dash.focus.workspaceId } },
    // Every view reads history too: Pending / Answered / All split the same rows.
    ...(dash.term.trim() ? { query: dash.term.trim() } : {}), includeHistory: true, timeZone: clock.zone(), ...(cursor ? { cursor } : {})
  }
}
async function loadQueue(more = false) {
  if (dash.scope === 'workspace') await resolveFocus()
  if (dash.scope === 'workspace' && !dash.focus) { dash.loaded = true; dash.rows = []; paintQueue(); return }
  const mine = ++dashSeq
  dash.loading = more ? 'more' : 'first'; paintQueue()
  const r = await call(req, 'listDecisionPage', pageInput(more ? dash.next : undefined))
  if (mine !== dashSeq) return
  dash.loading = false; dash.loaded = true
  if (r.ok) {
    const seen = new Set(more ? dash.rows.map((x) => x.questionId) : [])
    dash.rows = more ? [...dash.rows, ...r.value.rows.filter((x) => !seen.has(x.questionId))] : r.value.rows
    dash.next = r.value.nextCursor; dash.fail = null
    if (!more) { dash.sources = sourcesOf(r.value); dash.mail = r.value.mail }
  } else dash.fail = r
  paintQueue()
}
async function refreshQueue() {
  if (dash.scope === 'workspace' && !dash.focus) return
  const want = dash.rows.length
  const mine = ++dashSeq
  const rows: Decision[] = []; const seen = new Set<string>()
  let cursor: string | undefined; let pages = 0; let first: DecisionPage | null = null
  do {
    const r = await call(req, 'listDecisionPage', pageInput(cursor))
    if (mine !== dashSeq) return
    if (!r.ok) { dash.fail = r; paintQueue(); return }
    if (!first) first = r.value
    for (const x of r.value.rows) if (!seen.has(x.questionId)) { seen.add(x.questionId); rows.push(x) }
    cursor = r.value.nextCursor
  } while (cursor && rows.length < want && ++pages < 20)
  dash.rows = rows; dash.next = cursor; dash.fail = null
  if (first) { dash.sources = sourcesOf(first); dash.mail = first.mail }
  paintQueue()
}
async function selectInDashboard(questionId: string) {
  if (dashSel === questionId) { render(); return }
  if (draftFor && draftFor !== questionId) await flushDraft()
  draftFor = null; draft = emptyDraft(); draftRevision = null; draftFail = null; d = null; pkg = []; notice = null; notesOpen = false; recOpen = false; recAsk = null; noteSaved = null
  if (nc) { nc.remove(); nc = null; ncBack = null }
  dashSel = questionId
  render()
  root.querySelector<HTMLElement>('#sheetTitle')?.focus({ preventScroll: true })
  await loadReview(questionId)
}
function closeDashSheet() {
  if (!dashSel) return
  const id = dashSel
  void flushDraft()
  dashSel = null; notesOpen = false
  render()
  shell?.list.querySelector<HTMLElement>(`[data-q="${CSS.escape(id)}"]`)?.focus()
  say('Closed')
}

// ---- list model ----
const statusOf = (x: Decision) => { const n = nativeOf(x); return n ? nativeStatusLabel(n.itemStatus) : STATE_LABEL[shownState(x)] }
const wsKeyOf = (x: Decision) => { const n = nativeOf(x); return n && !n.workspaceAttributed ? '' : `${x.origin.hostId}:${x.origin.workspaceId}` }
const wsLabel = (x: Decision) => { const n = nativeOf(x); return n && !n.workspaceAttributed ? 'No workspace attribution' : `${x.projectName} · ${x.workspaceName}` }
function inTab(x: Decision, tab: Tab) { return tab === 'all' || (tab === 'pending') === isActionable(x) }
function visibleRows(tab: Tab = dash.tab) {
  return dash.rows.filter((x) => inTab(x, tab) && (!dash.priority || x.priority === dash.priority) && (!dash.status || statusOf(x) === dash.status) &&
    (!dash.wsFilter || wsKeyOf(x) === dash.wsFilter))
}
function grouped(rows: Decision[]): [string, Decision[]][] {
  const now = clock.now(), zone = clock.zone()
  const sorted = order(rows, now, zone)
  const out = new Map<string, Decision[]>()
  const add = (k: string, x: Decision) => { if (!out.has(k)) out.set(k, []); out.get(k)!.push(x) }
  if (dash.group === 'urgency') {
    const names = ['P0 — highest priority', 'Overdue or due today', 'Everything else']
    for (const x of sorted) add(names[group(x, now, zone)], x)
    return names.filter((k) => out.has(k)).map((k) => [k, out.get(k)!])
  }
  for (const x of sorted) add(dash.group === 'priority' ? x.priority : dash.group === 'status' ? statusOf(x) : wsLabel(x), x)
  return [...out.entries()].sort(([a], [b]) => (dash.group === 'status' ? 0 : a.localeCompare(b)))
}

const SRC_NAME: Record<SourceStatus['source'], string> = { plugin: 'Chat decisions', 'native-item': 'Bot Items' }
function rowNode(x: Decision, now: number): HTMLElement {
  const n = nativeOf(x)
  const due = deadlineLabel(x, now)
  const sel = dashSel === x.questionId
  const title = el('button', { type: 'button', class: 'd-title qrow', 'data-q': x.questionId, 'data-k': `row-${x.questionId}`, 'aria-current': sel ? 'true' : false,
    onclick: () => void selectInDashboard(x.questionId) }, el('span', { class: 'qt' }, x.title))
  // Arrow keys move between rows.
  title.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return
    const all = Array.from(shell!.list.querySelectorAll<HTMLElement>('.qrow')), i = all.indexOf(title)
    const nx = all[i + (ev.key === 'ArrowDown' ? 1 : -1)]
    if (nx) { ev.preventDefault(); nx.focus() }
  })
  const tr = el('tr', { class: 'd-row', ...(sel ? { 'data-sel': '' } : {}) },
    el('th', { scope: 'row' }, title),
    el('td', { class: 'd-col-bg' }, el('div', { class: 'd-bg-snip' }, x.background.replace(/```[^]*?(```|$)/g, ' ').replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1').replace(/https?:\/\/\S+/g, ' ').replace(/[#*`[\]()>_~-]+/g, ' ').replace(/\s+/g, ' ').trim())),
    el('td', { class: 'd-c-meta' }, el('span', { class: `d-pill d-p-${x.priority}` }, x.priority)),
    el('td', { class: 'd-c-meta' }, el('span', { class: 'd-pill' }, statusOf(x))),
    el('td', { class: 'd-c-src d-nm' }, n ? 'Bot Item' : 'Chat'),
    el('td', { class: 'd-c-ws d-nm' }, wsLabel(x)),
    el('td', { class: `d-c-meta d-nm d-c-due ${due?.overdue ? 'd-due-over' : ''}${due ? '' : ' d-no-due'}` }, due ? due.text : '—'))
  // The whole row opens the decision for pointers; the title button carries keyboard focus.
  tr.addEventListener('click', (ev) => { if ((ev.target as HTMLElement).closest('a,button')) return; if (String(getSelection?.() ?? '')) return; void selectInDashboard(x.questionId) })
  return tr
}
/** Repaints tabs, notices, chips and the table; the search field and selects keep focus and state. */
function paintQueue() {
  if (!shell) return
  const now = clock.now()
  // Tabs with counts (loaded rows; "+" while more pages exist).
  const more = dash.next ? '+' : ''
  shell.tabs.replaceChildren(...([['pending', 'Pending'], ['answered', 'Answered'], ['all', 'All']] as [Tab, string][]).map(([k, l]) =>
    el('button', { type: 'button', class: 'd-tab', role: 'tab', id: `tab-${k}`, 'data-k': `tab-${k}`, 'aria-selected': dash.tab === k ? 'true' : 'false', tabindex: dash.tab === k ? 0 : -1,
      onclick: () => { dash.tab = k; paintQueue(); shell?.tabs.querySelector<HTMLElement>(`#tab-${k}`)?.focus() } }, l, el('span', { class: 'd-n' }, `${visibleRows(k).length}${more}`))))
  // Workspace selector options: this workspace, all workspaces, and each workspace seen in the rows.
  const seen = new Map<string, string>()
  for (const x of dash.rows) { const k = wsKeyOf(x); if (k && !seen.has(k)) seen.set(k, wsLabel(x)) }
  const value = dash.scope === 'workspace' ? 'this' : dash.wsFilter || 'all'
  shell.wsSel.replaceChildren(...[['this', 'This workspace'], ['all', 'All workspaces'], ...[...seen.entries()]].map(([v, l]) => el('option', { value: v, selected: v === value }, l)))
  const statuses = [...new Set(dash.rows.map(statusOf))].sort()
  shell.status.replaceChildren(el('option', { value: '', selected: !dash.status }, 'All'), ...statuses.map((st) => el('option', { value: st, selected: st === dash.status }, st)))

  const rows = visibleRows()
  const kids: (HTMLElement | string)[] = []
  for (const x of dash.sources.filter((y) => y.state !== 'available')) {
    kids.push(el('div', { class: 'callout warn' }, `${x.state === 'partial' ? `Some ${SRC_NAME[x.source]} could not be read.` : `${SRC_NAME[x.source]} are unavailable.`} ${x.message ?? ''} ${x.source === 'plugin' ? 'Bot Items' : 'Chat decisions'} below are not affected.`))
  }
  if (dash.mail?.state === 'unavailable') kids.push(el('div', { class: 'callout info' }, dash.mail.message && /saved in Decision Inbox/i.test(dash.mail.message) ? dash.mail.message : 'Answers to Chat decisions are saved in Decision Inbox. Orca mail from this plugin is unavailable on this host, so saved answers are not delivered to the chat yet.'))
  if (dash.fail) kids.push(el('div', { class: 'callout', ...alertRole(`dash:${dash.fail.message}`) }, `${dash.rows.length ? 'Showing the last loaded list. ' : 'Could not load decisions. '}${failureText(dash.fail)} `,
    el('button', { type: 'button', onclick: () => void loadQueue() }, 'Retry loading')))
  const chips: [string, string, () => void][] = []
  if (dash.priority) chips.push(['priority', `Priority: ${dash.priority}`, () => { dash.priority = '' }])
  if (dash.status) chips.push(['status', `Status: ${dash.status}`, () => { dash.status = '' }])
  if (dash.term.trim()) chips.push(['search', `Search: “${dash.term.trim()}”`, () => { dash.term = ''; const f = shell!.el.querySelector<HTMLInputElement>('[data-k="dash-search"]'); if (f) f.value = ''; void loadQueue() }])
  if (chips.length) kids.push(el('div', { class: 'd-chips', 'aria-label': 'Active filters' }, ...chips.map(([k, t, clear]) =>
    el('span', { class: 'd-chip' }, t, el('button', { type: 'button', 'aria-label': `Remove filter ${t}`, 'data-k': `chip-${k}`, onclick: () => { clear(); paintQueue(); say('Filter removed') } }, '✕')))))
  const label = dash.scope === 'all' ? 'all workspaces' : 'this workspace'
  kids.push(el('div', { class: 'd-meta-line' },
    el('span', { role: 'status' }, dash.loading === 'first' ? 'Loading decisions…' : `${rows.length}${more} ${dash.term.trim() ? 'matching ' : ''}decision${rows.length === 1 ? '' : 's'} · ${label}`)))
  const degraded = dash.sources.some((x) => x.state !== 'available')
  if (dash.scope === 'workspace' && dash.focus === null) {
    kids.push(el('div', { class: 'd-empty' }, el('b', {}, dash.focusFail ? `Could not identify this workspace. ${failureText(dash.focusFail)}` : 'No workspace is focused.'),
      el('button', { type: 'button', class: 'd-btn', onclick: () => setScope('all') }, 'Show all workspaces')))
  } else if (dash.loaded && !rows.length && !dash.loading) {
    kids.push(el('div', { class: 'd-empty' }, el('b', {}, chips.length || dash.term.trim() ? 'No decisions match these filters.' : degraded ? `Nothing found in ${label} from the sources that could be read.` : dash.tab === 'pending' ? `Nothing needs you in ${label}.` : 'Nothing here yet.'),
      chips.length ? 'Remove a filter chip or reset to see more.' : dash.scope === 'workspace' ? '' : 'New questions from agents appear here.',
      ...(dash.scope === 'workspace' && !chips.length ? [el('button', { type: 'button', class: 'd-btn', onclick: () => setScope('all') }, 'Show all workspaces')] : [])))
  } else if (rows.length) {
    kids.push(el('div', { class: 'd-table-wrap', id: 'panel', role: 'tabpanel', 'aria-labelledby': `tab-${dash.tab}`, 'data-k': 'table-wrap', tabindex: -1 },
      el('table', {}, el('caption', { class: 'sr' }, `Decisions, grouped by ${dash.group}`),
        el('thead', {}, el('tr', {}, ...[['Question', ''], ['Background', 'd-col-bg'], ['Priority', ''], ['Status', ''], ['Source', 'd-c-src'], ['Workspace', 'd-c-wsh'], ['Due', '']].map(([t, c]) => el('th', { scope: 'col', class: c }, t)))),
        el('tbody', {}, ...grouped(rows).flatMap(([k, xs]) => [
          el('tr', { class: 'd-group' }, el('th', { colspan: 7, scope: 'colgroup' }, el('span', { class: 'd-gname' }, k), el('span', { class: 'd-gc', 'aria-label': `${xs.length} decision${xs.length === 1 ? '' : 's'}` }, String(xs.length)))),
          ...xs.map((x) => rowNode(x, now))])))))
  }
  if (dash.next) kids.push(el('button', { type: 'button', class: 'd-btn', 'data-k': 'dash-more', 'aria-disabled': dash.loading === 'more', onclick: () => dash.loading !== 'more' && void loadQueue(true) }, dash.loading === 'more' ? 'Loading more…' : 'Load more'))
  const focusedKey = document.activeElement && shell.list.contains(document.activeElement) ? document.activeElement.getAttribute('data-k') : null
  shell.list.replaceChildren(...kids)
  if (focusedKey) shell.list.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusedKey)}"]`)?.focus({ preventScroll: true })
}
function setScope(scope: 'workspace' | 'all', wsFilter = '') {
  dash.scope = scope; dash.wsFilter = wsFilter
  void loadQueue()
}
function buildShell() {
  const tabs = el('div', { class: 'd-tabs', role: 'tablist', 'aria-label': 'View' })
  tabs.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return
    const ks: Tab[] = ['pending', 'answered', 'all'], i = ks.indexOf(dash.tab)
    dash.tab = ks[(i + (ev.key === 'ArrowRight' ? 1 : 2)) % 3]; paintQueue(); tabs.querySelector<HTMLElement>(`#tab-${dash.tab}`)?.focus()
  })
  const wsSel = el<HTMLSelectElement>('select', { 'aria-label': 'Workspace', 'data-k': 'ws-select', class: 'd-ws-select',
    onchange: (ev: Event) => { const v = (ev.target as HTMLSelectElement).value; v === 'this' ? setScope('workspace') : v === 'all' ? setScope('all') : setScope('all', v) } })
  const sel = (label: string, k: string, opts: [string, string][], onchange: (v: string) => void) =>
    el('label', { class: 'd-field d-sel' }, el('span', {}, label), el('select', { 'data-k': k, onchange: (ev: Event) => onchange((ev.target as HTMLSelectElement).value) }, ...opts.map(([v, l]) => el('option', { value: v }, l))))
  const priority = sel('Priority', 'f-priority', [['', 'All'], ['P0', 'P0'], ['P1', 'P1'], ['P2', 'P2'], ['P3', 'P3']], (v) => { dash.priority = v; paintQueue() })
  const statusLabel = sel('Status', 'f-status', [['', 'All']], (v) => { dash.status = v; paintQueue() })
  const search = el<HTMLInputElement>('input', { type: 'search', 'aria-label': 'Search decisions', 'data-k': 'dash-search', placeholder: 'Title, background, option, ID, 中文…', autocomplete: 'off',
    oninput: (ev: Event) => { dash.term = (ev.target as HTMLInputElement).value; if (dashTimer) clearTimeout(dashTimer); dashTimer = setTimeout(() => { dashTimer = null; void loadQueue() }, 250) } })
  const filtersBtn = el('button', { type: 'button', class: 'd-btn d-ghost d-filters-btn', 'data-k': 'filters', 'aria-expanded': 'false', 'aria-controls': 'dFilters',
    onclick: () => { const open = toolbar.classList.toggle('d-open'); filtersBtn.setAttribute('aria-expanded', String(open)) } }, 'Filters')
  // Group by is a view setting, not a filter: its own labelled control at the end of the toolbar.
  const groupBy = el('label', { class: 'd-field d-groupby' }, el('span', {}, 'Group by'),
    el('select', { 'data-k': 'group-by', onchange: (ev: Event) => { dash.group = (ev.target as HTMLSelectElement).value; paintQueue(); say(`Grouped by ${dash.group}`) } },
      ...[['urgency', 'Urgency'], ['priority', 'Priority'], ['status', 'Status'], ['workspace', 'Workspace']].map(([v, l]) => el('option', { value: v, selected: dash.group === v }, l))))
  const toolbar = el('form', { class: 'd-toolbar', id: 'dFilters', role: 'search', 'aria-label': 'Filter decisions', onsubmit: (ev: Event) => ev.preventDefault() },
    priority, statusLabel, el('label', { class: 'd-field d-grow' }, el('span', {}, 'Search'), search),
    el('button', { type: 'button', class: 'd-btn d-ghost', 'data-k': 'reset', onclick: () => {
      dash.priority = ''; dash.status = ''; dash.term = ''; search.value = ''
      toolbar.querySelectorAll('select').forEach((s) => { (s as HTMLSelectElement).value = '' }); void loadQueue(); say('Filters reset')
    } }, 'Reset'), filtersBtn, groupBy)
  const list = el('div', { class: 'd-results' })
  const side = el('section', { class: 'd-list-side', 'aria-label': 'Decisions' },
    el('div', { class: 'd-tabs-row' }, tabs, el('label', { class: 'd-ws-pick' }, el('span', { class: 'd-ws-label' }, 'Workspace'), wsSel)),
    toolbar, list)
  const sheetSlot = el('div', { class: 'd-sheet-slot' })
  shell = { el: el('div', { class: 'd-workspace' }, side, divider(), sheetSlot), list, tabs, wsSel, status: statusLabel.querySelector('select')!, sheet: sheetSlot, side }
}
// ---- resizable sheet (wide only) ------------------------------------------------------------------
// A separator between the table and the sheet: drag (pointer or touch), or focus it and use the arrow
// keys (Shift for larger steps), Home/End for the limits, Enter or a double-click to reset. The table
// keeps at least SHEET_LIST_MIN pixels; below 900px the sheet is a full-screen modal instead.
const SHEET_MIN = 380, SHEET_LIST_MIN = 460
let sheetW: number | null = null
const sheetDefault = () => Math.min(780, Math.max(460, Math.round(vw() * 0.4)))
const sheetMax = () => Math.max(SHEET_MIN, Math.min(1200, (shell?.el.getBoundingClientRect?.().width || vw()) - SHEET_LIST_MIN))
function setSheetW(w: number | null, announce = true) {
  sheetW = w === null ? null : Math.round(Math.min(sheetMax(), Math.max(SHEET_MIN, w)))
  applySheetW()
  if (announce) say(sheetW === null ? 'Decision panel width reset' : `Decision panel ${sheetW} pixels wide`)
}
function applySheetW() {
  if (!shell) return
  if (sheetW === null) shell.el.style.removeProperty('--sheet-w'); else shell.el.style.setProperty('--sheet-w', `${sheetW}px`)
  const sep = shell.el.querySelector('.d-divider'); const now = sheetW ?? sheetDefault()
  sep?.setAttribute('aria-valuenow', String(now)); sep?.setAttribute('aria-valuemin', String(SHEET_MIN)); sep?.setAttribute('aria-valuemax', String(Math.round(sheetMax())))
  sep?.setAttribute('aria-valuetext', `Decision panel ${now} pixels wide${sheetW === null ? ' (default)' : ''}`)
  shell.el.querySelectorAll('[data-k="sheet-reset"]').forEach((b) => b.toggleAttribute('hidden', sheetW === null))
}
function divider(): HTMLElement {
  const sep = el('div', { class: 'd-divider', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the decision panel', 'aria-controls': 'dSheet', tabindex: 0, title: 'Drag to resize · double-click to reset', 'data-k': 'divider' })
  let drag: { x: number; w: number } | null = null
  sep.addEventListener('pointerdown', (ev) => { ev.preventDefault(); drag = { x: ev.clientX, w: sheetW ?? (shell?.sheet.getBoundingClientRect().width || sheetDefault()) }; sep.setPointerCapture?.(ev.pointerId); sep.classList.add('d-dragging') })
  sep.addEventListener('pointermove', (ev) => { if (drag) setSheetW(drag.w + (drag.x - ev.clientX), false) })
  const end = () => { if (drag) { drag = null; sep.classList.remove('d-dragging'); say(`Decision panel ${sheetW ?? sheetDefault()} pixels wide`) } }
  sep.addEventListener('pointerup', end); sep.addEventListener('pointercancel', end)
  sep.addEventListener('dblclick', () => setSheetW(null))
  sep.addEventListener('keydown', (ev) => {
    const cur = sheetW ?? sheetDefault(), step = ev.shiftKey ? 80 : 24
    if (ev.key === 'ArrowLeft') setSheetW(cur + step)
    else if (ev.key === 'ArrowRight') setSheetW(cur - step)
    else if (ev.key === 'Home') setSheetW(sheetMax())
    else if (ev.key === 'End') setSheetW(SHEET_MIN)
    else if (ev.key === 'Enter') setSheetW(null)
    else return
    ev.preventDefault()
  })
  return sep
}
window.addEventListener?.('resize', () => { if (sheetW !== null) setSheetW(sheetW, false) })
function renderDashboard() {
  if (!shell) buildShell()
  const s = shell!
  s.el.classList.toggle('d-has-sheet', !!dashSel)
  if (!root.contains(s.el)) root.replaceChildren(s.el)
  paintQueue()
  // Narrow: the sheet is a modal over the list.
  const modal = !!dashSel && sheetNarrow.matches
  s.side.toggleAttribute('inert', modal)
  if (!dashSel) { s.sheet.replaceChildren(); s.sheet.hidden = true; return }
  s.sheet.hidden = false
  readerHost = s.sheet
  try { renderReview(dashSel) } finally { readerHost = root }
  const sh = s.sheet.querySelector('.d-sheet')
  sh?.setAttribute('role', 'dialog'); sh?.setAttribute('aria-modal', String(modal)); sh?.setAttribute('id', 'dSheet')
  applySheetW()
}
sheetNarrow.addEventListener('change', () => { if (ref.view === 'dashboard') render() })

// ---- render with focus kept ---------------------------------------------------------------------
function render() {
  pendingRender = false; pendingAnnounced = false
  // Re-rendering replaces nodes; put focus, the caret and scroll positions back on the same
  // logical elements.
  const active = document.activeElement as (HTMLElement & { selectionStart?: number | null; selectionEnd?: number | null }) | null
  const k = active && root.contains(active) ? active.getAttribute('data-k') : null
  const caret = k && typeof active!.selectionStart === 'number' ? [active!.selectionStart, active!.selectionEnd ?? active!.selectionStart] as const : null
  const scrolls = Array.from(root.querySelectorAll<HTMLElement>('[data-k]')).filter((e) => e.scrollTop || e.scrollLeft)
    .map((e) => [e.getAttribute('data-k')!, e.scrollTop, e.scrollLeft] as const)
  const page = document.scrollingElement
  const pageTop = page?.scrollTop ?? 0
  nextAlerts = new Set()
  // Reader views use Variant D's sheet; settings keep the form layout.
  root.className = ref.view === 'dashboard' ? 'd-app d-dash' : ref.view === 'review' ? 'd-app d-solo' : 'layout'
  if (ref.view === 'settings') renderSettings()
  else if (ref.view === 'review') renderReview(ref.questionId)
  else if (ref.view === 'dashboard') renderDashboard()
  else root.replaceChildren(el('main', {}, el('div', { class: 'callout', role: 'alert' }, 'This review file does not name a decision.')))
  if (k) {
    const next = root.querySelector<HTMLElement & { setSelectionRange?: (s: number, e: number) => void }>(`[data-k="${CSS.escape(k)}"]`)
    if (next && document.activeElement !== next) {
      next.focus({ preventScroll: true })
      if (caret && next.setSelectionRange) try { next.setSelectionRange(caret[0], caret[1]) } catch { /* not a text field */ }
    }
  }
  for (const [key, top, left] of scrolls) {
    const e = root.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`)
    if (e) { e.scrollTop = top; e.scrollLeft = left }
  }
  if (page && page.scrollTop !== pageTop) page.scrollTop = pageTop
  shownAlerts = nextAlerts
}

/** Opens what the reference file names. A new question flushes the old draft under its own ID. */
async function bind() {
  if (ref.view === 'dashboard') {
    render()
    await loadQueue()
    return
  }
  if (ref.view === 'review') {
    if (draftFor && draftFor !== ref.questionId) { await flushDraft(); draftFor = null; draft = emptyDraft(); draftRevision = null; draftFail = null; d = null; pkg = []; notice = null }
    render()
    await loadReview(ref.questionId)
  } else if (ref.view === 'settings') {
    render()
    await loadSettings()
  } else render()
}

session?.onReplace((v) => { ref = readRef(v); void bind() })
// Empty invalidation from the worker: refetch through the authenticated requests.
// Bursts (each draft save, delivery, receipt) coalesce; the page changes only on real differences.
let invalidTimer: ReturnType<typeof setTimeout> | null = null
orca.plugin.on('inbox.changed', () => {
  if (invalidTimer) clearTimeout(invalidTimer)
  invalidTimer = setTimeout(() => {
    invalidTimer = null
    if (ref.view === 'review') void loadReview(ref.questionId, true, true)
    else if (ref.view === 'dashboard') { void refreshQueue(); if (dashSel) void loadReview(dashSel, true, true) }
    else if (ref.view === 'settings') void settingsInvalidated()
  }, 150)
})
// Live clock: deadlines and relative text stay current, without interrupting typing.
setInterval(() => { if ((ref.view === 'review' || ref.view === 'dashboard') && d) requestRender() }, 60_000)
await bind()
