/** Visual system for the public retrieval workspace. */
export const WORKBENCH_STYLES = String.raw`
:root {
  color-scheme: light;
  --bg: #faf9f6; --paper: #fff; --soft: #f3f2ee; --sidebar: #f0efeb;
  --text: #282d2b; --muted: #717772; --line: #e3e4de;
  --accent: #216f64; --tint: #eaf2ee; --mark: #f3eccb;
  --nav-width: 224px; --content-width: 860px; --gutter: 40px;
  --ease: cubic-bezier(.22,1,.36,1);
  font: 14px/1.65 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', sans-serif;
  color: var(--text); background: var(--bg);
}
* { box-sizing: border-box; }
html { scrollbar-gutter: stable; overflow-anchor: none; }
html:has(dialog[open]), html:has(body[data-nav=open]) { overflow: hidden; }
body { margin: 0; }
button, input, textarea, select { font: inherit; color: inherit; }
button, a, summary, select { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
button, a, summary { transition: color 150ms, background-color 150ms, border-color 150ms, box-shadow 150ms; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; cursor: pointer; border: 1px solid var(--line); background: var(--paper); padding: 7px 13px; border-radius: 9px; line-height: 1.45; }
button:hover:not(:disabled) { background: var(--soft); border-color: #c9cec7; }
button:active:not(:disabled) { transform: translateY(1px); }
button:disabled { color: #a3a8a2; background: var(--soft); cursor: default; }
button.primary { background: var(--text); border-color: var(--text); color: #fff; }
button.primary:hover:not(:disabled) { background: #434a45; border-color: #434a45; }
button.primary:disabled { background: #d5d9d2; border-color: #d5d9d2; color: #fff; }
button.secondary { color: var(--accent); background: var(--paper); }
button.link { border: 0; padding: 0; min-height: 28px; color: var(--accent); text-align: left; justify-content: flex-start; background: transparent; }
a { color: var(--accent); text-decoration: none; }
:where(button,a,textarea,select,summary,[tabindex]):focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
:where(h1,h2,h3,p) { margin: 0; overflow-wrap: anywhere; }
h1 { font-size: 27px; line-height: 1.5; font-weight: 600; letter-spacing: -.6px; }
h2 { font-size: 17px; line-height: 1.5; font-weight: 600; }
h3 { font-size: 14px; line-height: 1.6; font-weight: 600; }
p { margin: 8px 0; }
small, .muted { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
svg { width: 19px; height: 19px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.65; stroke-linecap: round; stroke-linejoin: round; }
[hidden] { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.between { justify-content: space-between; }
.icon-button { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; flex-shrink: 0; color: var(--muted); background: transparent; border: 0; border-radius: 9px; }
.icon-button:hover { background: #e8e9e3; color: var(--text); }
.shell { display: grid; grid-template-columns: var(--nav-width) minmax(0,1fr); min-height: 100dvh; }
.sidebar { background: var(--sidebar); padding: 28px 16px 20px; position: sticky; top: 0; height: 100dvh; display: flex; flex-direction: column; gap: 28px; min-width: 0; }
.sidebar-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 8px; }
.brand { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 600; color: var(--text); letter-spacing: .3px; }
.brand-mark { width: 28px; height: 28px; stroke-width: 1.4; }
.new-task { display: flex; align-items: center; gap: 9px; border: 1px solid #dddfd7; border-radius: 10px; padding: 10px 12px; color: var(--text); background: #fafaf7; font-size: 13px; box-shadow: 0 1px 2px #252e2904; }
.new-task:hover { background: #fff; border-color: #b9c6ba; }
.new-task kbd { font: 10px/1.5 inherit; margin-left: auto; color: #8b918a; white-space: nowrap; }
.side-history { min-height: 0; overflow: auto; scrollbar-width: thin; }
.side-label { color: #838980; font-size: 11px; margin: 0 10px 12px; }
.history-list { display: grid; gap: 4px; }
.history-list a { padding: 10px 12px; border-radius: 9px; font-size: 12px; display: block; overflow-wrap: anywhere; color: #545c54; }
.history-list a:hover { background: #e8eae3; }
.history-list a[aria-current] { background: #e3e9e1; color: #2d574b; }
.history-list strong { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-weight: 400; }
.history-list small { display: block; font-size: 10px; color: #81877f; margin-top: 4px; }
.history-list > p { padding: 0 10px; color: #8a8f87; }
.sidebar-foot { margin-top: auto; display: flex; align-items: center; gap: 10px; padding: 0 9px; color: #8a9086; font-size: 11px; }
.sidebar-foot svg { width: 15px; height: 15px; }
.main { min-width: 0; }
.topbar { height: 64px; padding: 0 28px; display: flex; justify-content: space-between; align-items: center; gap: 12px; color: #858a83; font-size: 12px; }
#connection { font-size: 11px; }
#connection:empty { display: none; }
#open-nav, #close-nav, .mobile-brand, .nav-scrim { display: none; }
.home { width: min(100%, 780px); margin: clamp(40px, 10vh, 112px) auto 0; padding: 0 var(--gutter) 50px; }
.home-intro { text-align: center; margin-bottom: 30px; }
.home-symbol { display: flex; justify-content: center; color: var(--accent); margin-bottom: 18px; }
.home-symbol svg { width: 40px; height: 40px; stroke-width: 1.15; }
.home h1 { font-size: 32px; font-weight: 500; letter-spacing: -.7px; }
.home-lead { color: #8a8e87; font-size: 13px; margin-top: 10px; }
.query-box { padding: 20px 20px 14px; background: var(--paper); border: 1px solid #d9dcd4; border-radius: 20px; box-shadow: 0 3px 5px #273e3010, 0 10px 30px #273e3004; transition: box-shadow 180ms, border-color 180ms; }
.query-box:focus-within, .composer form:focus-within { border-color: #8aa89a; box-shadow: 0 0 0 3px #216f640b, 0 5px 18px #273e3007; }
textarea { display: block; width: 100%; min-height: 80px; resize: vertical; border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: var(--paper); line-height: 1.7; }
textarea::placeholder { color: #999d95; }
.query-box textarea { min-height: 70px; max-height: 260px; resize: none; padding: 0; border: 0; border-radius: 0; font-size: 15px; background: transparent; outline: none; }
.query-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
.search-mode { display: inline-flex; align-items: center; gap: 7px; color: #70786e; font-size: 12px; padding: 5px 9px; background: var(--soft); border-radius: 7px; }
.search-mode svg { width: 14px; height: 14px; }
.send-button { width: 36px; height: 36px; padding: 0; min-height: 36px; border-radius: 50%; }
.send-button svg { width: 19px; height: 19px; }
.examples { display: flex; justify-content: center; flex-wrap: wrap; gap: 10px; margin: 20px 0 48px; }
.examples button { padding: 8px 12px; border-radius: 9px; color: #767d72; border-color: #e1e4da; background: transparent; font-size: 12px; }
.examples svg { width: 15px; height: 15px; }
.recent { padding-top: 24px; border-top: 1px solid var(--line); }
.recent h2 { font-size: 13px; color: #696f65; font-weight: 500; }
.recent .history-list { margin-top: 12px; }
.recent .history-list a { padding: 12px 0; border-radius: 0; border-bottom: 1px solid #eeeee7; display: flex; justify-content: space-between; align-items: center; gap: 20px; }
.recent .history-list strong { -webkit-line-clamp: 1; }
.recent .history-list small { white-space: nowrap; flex-shrink: 0; }
.task { display: flex; flex-direction: column; min-height: calc(100dvh - 64px); width: min(100%, calc(var(--content-width) + var(--gutter)*2)); margin: 0 auto; padding: 14px var(--gutter) 0; }
.task-heading h1 { font-size: 24px; line-height: 1.6; letter-spacing: -.4px; }
#query-title { font-size: 22px; font-weight: 500; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
#query-title:focus, #detail-title:focus { outline: none; }
.scope { position: relative; font-size: 12px; color: var(--muted); margin-top: 10px; }
summary { cursor: pointer; width: fit-content; }
.scope summary { color: #7d8578; }
.scope[open] { background: var(--soft); padding: 12px 16px; border-radius: 10px; }
.scope p { margin-top: 12px; }
.task-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 42px; margin: 12px 0 8px; font-size: 12px; color: var(--muted); }
.task-status p { margin: 0; }
.status-dot { width: 6px; height: 6px; background: var(--accent); border-radius: 50%; flex: none; }
.task-status[data-state=running] .status-dot { box-shadow: 0 0 0 4px #216f6410; }
.task-status[data-state=error] .status-dot { background: #ac6745; }
#counts { margin-left: auto; color: #8a9086; }
.task-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--line); }
.tabs { display: flex; gap: 26px; min-width: 0; }
.tabs button { border: 0; border-radius: 0; background: transparent; color: #8a9086; padding: 14px 0 13px; border-bottom: 2px solid transparent; font-size: 13px; white-space: nowrap; }
.tabs button:hover:not(:disabled) { background: transparent; color: var(--text); border-color: #b8c4b6; }
.tabs button[aria-selected=true] { color: var(--text); border-bottom-color: var(--text); font-weight: 600; }
.download-trigger { background: transparent; border: 0; color: #697165; font-size: 12px; padding: 8px; }
.download-trigger svg { width: 15px; height: 15px; }
.workspace { flex: 1; min-width: 0; }
.primary-pane { padding: 24px 0 32px; min-width: 0; }
.list-heading { margin-bottom: 16px; }
.list-heading h2 { font-size: 14px; font-weight: 500; }
.count { display: inline-flex; min-width: 23px; height: 22px; align-items: center; justify-content: center; padding: 0 6px; border-radius: 6px; margin-left: 6px; color: var(--accent); background: var(--tint); font-size: 12px; font-variant-numeric: tabular-nums; }
.result-summary { padding: 10px 14px; border: 1px solid #e6e8df; border-radius: 9px; font-size: 12px; color: var(--muted); margin-bottom: 12px; }
.result-summary summary { color: #747d6f; }
.result-summary p { padding-top: 6px; }
#cards { overflow-anchor: none; border-radius: 10px; }
.card { padding: 22px 0; border-bottom: 1px solid var(--line); min-width: 0; overflow-wrap: anywhere; }
.ticket-card { position: relative; }
.ticket-card h3 { margin: 7px 0 9px; }
.ticket-meta { display: flex; align-items: center; gap: 10px; min-height: 20px; }
.ticket-id { font-size: 11px; color: #727a6d; font-variant-numeric: tabular-nums; letter-spacing: .3px; }
.ticket-card .ticket-title { font-size: 16px; font-weight: 550; line-height: 1.6; color: var(--text); min-height: auto; }
.ticket-card .ticket-title:hover { color: var(--accent); background: transparent; }
.ticket-card .summary { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: #7b8277; font-size: 13px; margin: 0 0 12px; line-height: 1.8; }
.ticket-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ticket-footer small { font-size: 11px; color: #727a6d; }
.ticket-footer button { font-size: 12px; }
.badge { display: inline-block; padding: 2px 7px; background: var(--tint); color: var(--accent); border-radius: 5px; font-size: 10px; line-height: 1.6; }
.badge[data-verdict=exclude] { background: #f0eee9; color: #8d8172; }
.pagination { padding-top: 20px; justify-content: space-between; font-size: 11px; color: var(--muted); }
.pagination button { min-height: 32px; font-size: 11px; padding: 6px 10px; background: transparent; }
.notice { padding: 12px 15px; background: var(--tint); border: 1px solid #dce8de; border-radius: 10px; overflow-wrap: anywhere; font-size: 13px; }
.error { color: #964f3a; }
.notice.error { background: #fbefe9; border-color: #eed5c7; }
#error { margin: 10px var(--gutter); }
.empty { padding: 30px 22px; background: var(--soft); border-radius: 12px; margin: 18px 0; }
.empty h3 { font-weight: 500; }
.empty > p { font-size: 12px; color: var(--muted); margin: 7px 0 20px; }
.clue { padding: 14px 0; border-top: 1px solid var(--line); }
.clue small { display: block; margin-bottom: 5px; }
.clue button { font-size: 13px; }
.clue p { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
#new-results { margin: 10px 0; width: 100%; }
#candidate-note:empty, #receipt:empty, #input-hint:empty, #question-options:empty { display: none; }
.process-block { border-bottom: 1px solid var(--line); padding: 18px 0; }
.process-block > summary { font-size: 13px; color: #666f60; }
.process-block > div { padding-top: 12px; font-size: 13px; }
.process-block select { margin-top: 16px; }
#timeline { max-height: 440px; overflow: auto; scrollbar-width: thin; }
#timeline p { border-left: 2px solid #d9e0d3; padding-left: 15px; margin: 16px 0; font-size: 13px; }
.composer { position: sticky; bottom: 0; z-index: 5; padding: 16px 0 10px; background: linear-gradient(0deg,var(--bg) 78%,#faf9f600); }
.composer form { display: flex; align-items: flex-end; gap: 12px; background: var(--paper); border: 1px solid #d9dcd4; border-radius: 17px; padding: 12px 14px 12px 18px; box-shadow: 0 3px 14px #273e3008; transition: box-shadow 180ms,border-color 180ms; }
.composer textarea { border: 0; border-radius: 0; background: transparent; padding: 5px 0; min-height: 36px; height: 36px; max-height: 160px; resize: none; outline: none; font-size: 13px; }
.composer .send-button { flex: none; }
.composer-meta { display: flex; align-items: center; gap: 12px; min-height: 25px; padding: 3px 6px 0; }
.composer-meta p { margin: 0; font-size: 10px; }
.composer-meta small { font-size: 10px; }
#cancel { margin-left: auto; color: #8b9186; font-size: 10px; min-height: 24px; }
#cancel:disabled { display: none; }
#question { margin-bottom: 10px; }
#question-options { margin: 8px 0; }
#question-options button { font-size: 12px; background: var(--paper); }
select { max-width: 100%; background: var(--paper); padding: 8px 11px; border: 1px solid var(--line); border-radius: 8px; }
.report-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 16px; padding: 3px 0 24px; border-bottom: 1px solid var(--line); margin-bottom: 24px; }
.report-heading h2 { font-size: 21px; font-weight: 500; }
.report-tools { gap: 8px; }
.report-tools button, .report-tools select { font-size: 12px; }
.report h3 { margin: 28px 0 10px; }
.report p { line-height: 1.95; font-size: 13px; }
.report blockquote { margin-top: 15px; }
.report .link { font-size: 12px; }
.report-audit { margin-top: 24px; padding-top: 14px; border-top: 1px solid var(--line); font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.report-audit small { display: block; margin-top: 10px; }
blockquote { margin: 12px 0; padding: 12px 15px; border-left: 2px solid #87ab91; border-radius: 0 7px 7px 0; background: #f2f5ee; white-space: pre-wrap; font-size: 13px; overflow-wrap: anywhere; line-height: 1.85; }
mark { background: var(--mark); color: inherit; padding: 1px 0; }
dialog { width: min(500px,calc(100% - 32px)); max-height: calc(100dvh - 48px); border: 1px solid var(--line); border-radius: 20px; padding: 26px; color: var(--text); background: var(--paper); box-shadow: 0 20px 80px #24342b26; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
dialog::backdrop { background: #20291f26; }
dialog[open] { animation: dialog-in 180ms var(--ease); }
dialog h2 { font-size: 19px; font-weight: 550; }
dialog label { display: block; margin: 20px 0 8px; font-size: 12px; }
dialog select { width: 100%; }
.dialog-actions { margin-top: 22px; justify-content: flex-end; }
.evidence { position: fixed; inset: 0 calc(100% - 100vw) 0 auto; width: min(530px,100vw); max-width: 100vw; height: 100dvh; max-height: 100dvh; margin: 0; border: 0; border-left: 1px solid var(--line); border-radius: 18px 0 0 18px; padding: 0; }
.evidence[open] { animation: drawer-in 230ms var(--ease); }
.evidence-head { position: sticky; top: 0; background: #fffffff5; backdrop-filter: blur(10px); border-bottom: 1px solid #eaede5; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 19px 28px; z-index: 1; }
.evidence-head strong { display: block; font-size: 12px; font-weight: 500; overflow-wrap: anywhere; margin-top: 3px; }
.eyebrow { font-size: 10px; color: #899180; }
#detail { padding: 24px 28px 40px; }
.evidence h2 { font-size: 20px; line-height: 1.6; margin-bottom: 22px; }
.evidence h3 { margin: 24px 0 10px; }
.evidence p { font-size: 13px; line-height: 1.9; white-space: pre-wrap; }
.evidence small { font-size: 10px; }
.evidence .link { font-size: 11px; }
.evidence .field, .evidence .citation { scroll-margin-top: 110px; }
.evidence .field { padding-top: 8px; }
.speaker { display: block; color: var(--accent); margin-bottom: 4px; font-weight: 500; }
.dialogue-part { border-bottom: 1px solid #eef0e9; padding: 10px 0; }
.evidence .feedback-entry { margin-top: 28px; padding-top: 18px; border-top: 1px solid var(--line); }
.evidence .feedback-entry button { font-size: 12px; }
.delivery-controls { display: grid; gap: 12px; margin: 22px 0; }
.delivery-controls label { margin: 0; }
.delivery-controls .row { margin-top: 6px; }
#delivery-note { margin-top: 12px; }
#delivery-state { font-size: 11px; color: var(--muted); }
#download-receipt { font-size: 12px; color: var(--accent); }
#artifacts .card { padding: 16px 0; font-size: 12px; }
#artifacts .card strong { font-weight: 500; }
#artifacts .card button { margin: 7px 8px 0 0; font-size: 11px; }
#artifacts .card small { display: block; font-size: 10px; margin-top: 8px; }
.loading { color: var(--muted); padding: 26px 0; font-size: 12px; }
.skip { position: absolute; top: -60px; left: 20px; z-index: 100; background: #fff; padding: 10px; }
.skip:focus { top: 8px; }
@keyframes drawer-in { from { opacity: .5; transform: translateX(28px); } to { opacity: 1; transform: translateX(0); } }
@keyframes dialog-in { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }
@media (min-width: 1600px) { :root { --content-width: 900px; --nav-width: 240px; } .home { margin-top: 14vh; } }
@media (max-width: 1100px) { :root { --nav-width: 194px; --gutter: 30px; } .sidebar { padding-inline: 12px; } .new-task kbd { display: none; } }
@media (max-width: 820px) {
  :root { --gutter: 28px; }
  .shell { display: block; }
  .sidebar { position: fixed; left: 0; z-index: 21; width: 260px; transform: translateX(-100%); visibility: hidden; transition: transform 200ms var(--ease); }
  body[data-nav=open] .sidebar { transform: translateX(0); visibility: visible; }
  #open-nav, #close-nav, .mobile-brand { display: inline-flex; }
  .nav-scrim { display: block; position: fixed; inset: 0; z-index: 20; width: 100%; height: 100%; background: #20291f35; border: 0; border-radius: 0; }
  .nav-scrim:hover:not(:disabled) { background: #20291f35; }
  .topbar { padding: 0 18px; height: 58px; }
  .task { min-height: calc(100dvh - 58px); padding-top: 12px; }
  .home { margin-top: clamp(30px,8vh,80px); }
  .evidence { width: min(560px,100vw); }
  .task-heading h1 { font-size: 22px; }
}
@media (max-width: 480px) {
  :root { --gutter: 20px; }
  .topbar { padding: 0 12px; }
  .home { margin-top: 34px; padding-bottom: 32px; }
  .home-intro { margin-bottom: 24px; }
  .home h1 { font-size: 27px; }
  .home-lead { font-size: 12px; }
  .home-symbol { margin-bottom: 14px; }
  .query-box { padding: 17px 16px 12px; border-radius: 17px; }
  .query-box textarea { font-size: 14px; min-height: 86px; }
  .examples { gap: 7px; margin-top: 16px; }
  .examples button { padding: 7px 9px; font-size: 11px; gap: 5px; }
  .examples svg { width: 13px; }
  .task-heading h1 { font-size: 19px; line-height: 1.65; }
  #query-title { font-size: 19px; }
  .task-status { gap: 7px; font-size: 11px; }
  #counts { font-size: 10px; }
  .task-toolbar { gap: 8px; }
  .tabs { gap: 21px; }
  .tabs button { font-size: 12px; }
  .download-trigger { padding: 8px 3px; }
  .download-trigger span { display: none; }
  .primary-pane { padding-top: 20px; }
  .ticket-card { padding: 19px 0; }
  .ticket-card .ticket-title { font-size: 15px; }
  .composer form { padding: 10px 11px 10px 14px; border-radius: 15px; gap: 8px; }
  .composer { padding-top: 12px; }
  .evidence { border-radius: 0; }
  .evidence-head { padding: 16px 20px; }
  #detail { padding: 22px 20px 34px; }
  .report-heading { align-items: flex-start; }
  .report-tools { gap: 6px; }
  .report-tools select { width: auto; }
  dialog { padding: 20px; }
  dialog.evidence { padding: 0; }
  .recent .history-list small { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
`
