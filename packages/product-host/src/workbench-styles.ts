/** Visual system for the public retrieval workspace. */
export const WORKBENCH_STYLES = String.raw`
:root {
  color-scheme: light;
  --bg: #fff; --paper: #fff; --soft: #f8f7f7; --sidebar: #fcf9f8;
  --text: #292427; --muted: #756d70; --line: #ebe5e4;
  --accent: #c73538; --accent-hover: #aa272c; --tint: #fff0ef; --mark: #ffe0cf;
  --nav-width: 248px; --content-width: 1020px; --gutter: 40px;
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
button:hover:not(:disabled) { background: var(--soft); border-color: #cccaca; }
button:active:not(:disabled) { transform: translateY(1px); }
button:disabled { color: #a6a4a4; background: var(--soft); cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
button.primary:disabled { background: #d7d5d5; border-color: #d7d5d5; color: #fff; }
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
.icon-button:hover { background: #e7e5e5; color: var(--text); }
.shell { display: grid; grid-template-columns: var(--nav-width) minmax(0,1fr); min-height: 100dvh; }
.sidebar { background: var(--sidebar); border-right: 1px solid var(--line); padding: 30px 18px 20px; position: sticky; top: 0; height: 100dvh; display: flex; flex-direction: column; gap: 30px; min-width: 0; }
.sidebar-heading { display: flex; align-items: center; justify-content: space-between; padding: 0 8px; }
.brand { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 600; color: var(--text); letter-spacing: .3px; }
.brand-mark { width: 28px; height: 28px; stroke-width: 1.4; flex-shrink: 0; }
.brand-name { display: grid; gap: 3px; line-height: 1.15; }
.brand-name small { font-size: 10px; font-weight: 500; letter-spacing: .5px; color: var(--muted); }
.new-task { display: flex; align-items: center; gap: 9px; border: 1px solid #efc9c7; border-radius: 10px; padding: 12px; color: var(--accent); background: var(--tint); font-size: 13px; font-weight: 600; }
.new-task:hover { background: #ffe6e3; border-color: #dba3a0; }
.new-task kbd { font: 10px/1.5 inherit; margin-left: auto; color: #8f8d8d; white-space: nowrap; }
.side-history { min-height: 0; overflow: auto; scrollbar-width: thin; }
.sidebar-bottom { margin-top: auto; display: grid; gap: 12px; flex-shrink: 0; }
.history-item { display: flex; align-items: center; min-width: 0; border-radius: 9px; }
.history-item a { min-width: 0; flex: 1; }
.history-remove { width: 30px; height: 30px; min-height: 30px; margin-right: 4px; opacity: 0; color: #8d8b8b; }
.history-item:hover .history-remove,.history-item:focus-within .history-remove { opacity: 1; }
.history-item:has(a[aria-current]) { background: var(--tint); }
.history-remove:hover { background: #f0e4e5; color: #aa4e56; }
.history-notice { position: fixed; left: 20px; bottom: 22px; z-index: 90; display: flex; align-items: center; gap: 16px; padding: 12px 16px; max-width: calc(100vw - 40px); background: #fff; border: 1px solid #dfdddd; border-radius: 12px; box-shadow: 0 8px 28px #3223241c; font-size: 12px; }
@media (hover:none) { .history-remove { opacity: 1; } }
.side-label { color: #868484; font-size: 11px; margin: 0 10px 12px; }
.history-list { display: grid; gap: 4px; }
.history-list a { padding: 10px 12px; border-radius: 9px; font-size: 12px; display: block; overflow-wrap: anywhere; color: #595757; }
.history-list a:hover { background: #e8e6e6; }
.history-list a[aria-current] { background: var(--tint); color: var(--accent-hover); }
.history-list strong { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-weight: 400; }
.history-list small { display: block; font-size: 10px; color: #848282; margin-top: 4px; }
.history-list > p { padding: 0 10px; color: #8c8a8a; }
.sidebar-foot { margin-top: auto; display: flex; align-items: center; gap: 10px; padding: 0 9px; color: #8c8a8a; font-size: 11px; }
.sidebar-foot svg { width: 15px; height: 15px; }
.main { min-width: 0; }
.topbar { height: 72px; padding: 0 32px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: center; gap: 12px; color: var(--muted); font-size: 12px; }
#connection { font-size: 11px; }
#connection:empty { display: none; }
#open-nav, #close-nav, .mobile-brand, .nav-scrim { display: none; }
.home { width: min(100%, 880px); margin: clamp(40px, 7vh, 84px) auto 0; padding: 0 var(--gutter) 50px; }
.home-intro { text-align: left; margin-bottom: 32px; }
.home-symbol { display: inline-flex; justify-content: center; color: var(--accent); }
.home-symbol svg { width: 23px; height: 23px; stroke-width: 1.6; }
.home h1 { font-size: clamp(30px, 3.5vw, 44px); line-height: 1.5; font-weight: 650; letter-spacing: -1.1px; }
.home-lead { color: var(--muted); font-size: 14px; margin-top: 14px; }
.query-box { padding: 23px 23px 16px; background: var(--paper); border: 1px solid #dfc8c6; border-radius: 18px; box-shadow: 0 6px 28px #87352e08; transition: box-shadow 180ms, border-color 180ms; }
.query-box:focus-within, .composer form:focus-within { border-color: #a49293; box-shadow: 0 0 0 3px #7d262d0b, 0 5px 18px #3b2e2f07; }
textarea { display: block; width: 100%; min-height: 80px; resize: vertical; border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: var(--paper); line-height: 1.7; }
textarea::placeholder { color: #9a9898; }
.query-box textarea { min-height: 70px; max-height: 260px; resize: none; padding: 0; border: 0; border-radius: 0; font-size: 15px; background: transparent; outline: none; }
.query-footer { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; }
.search-mode { display: inline-flex; align-items: center; gap: 7px; color: #747272; font-size: 12px; padding: 5px 9px; background: var(--soft); border-radius: 7px; }
.search-mode svg { width: 14px; height: 14px; }
.send-button { width: 36px; height: 36px; padding: 0; min-height: 36px; border-radius: 50%; }
.send-button svg { width: 19px; height: 19px; }
.examples { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 12px 0 24px; }
.examples button { justify-content: flex-start; text-align: left; padding: 18px; border-radius: 12px; color: var(--text); border-color: var(--line); background: var(--paper); gap: 13px; }
.examples svg { width: 20px; height: 20px; }
.recent { padding-top: 24px; border-top: 1px solid var(--line); }
.recent h2 { font-size: 13px; color: #6b6969; font-weight: 500; }
.recent .history-list { margin-top: 12px; }
.recent .history-list a { padding: 12px 0; border-radius: 0; border-bottom: 1px solid #eceaea; display: flex; justify-content: space-between; align-items: center; gap: 20px; }
.recent .history-list strong { -webkit-line-clamp: 1; }
.recent .history-list small { white-space: nowrap; flex-shrink: 0; }
.task { display: flex; flex-direction: column; min-height: calc(100dvh - 64px); width: min(100%, calc(var(--content-width) + var(--gutter)*2)); margin: 0 auto; padding: 14px var(--gutter) 0; }
.task-heading h1 { font-size: 24px; line-height: 1.6; letter-spacing: -.4px; }
#query-title { font-size: 22px; font-weight: 500; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
#query-title:focus, #detail-title:focus { outline: none; }
.scope { position: relative; font-size: 12px; color: var(--muted); margin-top: 10px; }
summary { cursor: pointer; width: fit-content; }
.scope summary { color: #807e7e; }
.scope[open] { background: var(--soft); padding: 12px 16px; border-radius: 10px; }
.scope p { margin-top: 12px; }
.task-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 42px; margin: 12px 0 8px; font-size: 12px; color: var(--muted); }
.task-status p { margin: 0; }
.status-dot { width: 6px; height: 6px; background: var(--accent); border-radius: 50%; flex: none; }
.task-status[data-state=running] .status-dot { box-shadow: 0 0 0 4px #7d262d10; }
.task-status[data-state=error] .status-dot { background: #bf4b56; }
#counts { margin-left: auto; color: #8c8a8a; }
.task-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 18px; border-bottom: 1px solid var(--line); }
.tabs { display: flex; gap: 26px; min-width: 0; }
.tabs button { border: 0; border-radius: 0; background: transparent; color: #8c8a8a; padding: 14px 0 13px; border-bottom: 2px solid transparent; font-size: 13px; white-space: nowrap; }
.tabs button:hover:not(:disabled):not([aria-selected=true]) { background: transparent; color: var(--text); border-color: #bebcbc; }
.tabs button[aria-selected=true] { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.download-trigger { background: transparent; border: 0; color: #6c6a6a; font-size: 12px; padding: 8px; }
.download-trigger svg { width: 15px; height: 15px; }
.workspace { flex: 1; min-width: 0; }
.primary-pane { padding: 24px 0 32px; min-width: 0; }
.list-heading { margin-bottom: 16px; }
.list-heading h2 { font-size: 14px; font-weight: 500; }
.count { display: inline-flex; min-width: 23px; height: 22px; align-items: center; justify-content: center; padding: 0 6px; border-radius: 6px; margin-left: 6px; color: var(--accent); background: var(--tint); font-size: 12px; font-variant-numeric: tabular-nums; }
.result-summary { padding: 10px 14px; border: 1px solid #e5e3e3; border-radius: 9px; font-size: 12px; color: var(--muted); margin-bottom: 12px; }
.result-summary summary { color: #777575; }
.result-summary p { padding-top: 6px; }
#cards { overflow-anchor: none; border-radius: 10px; }
.card { padding: 22px 0; border-bottom: 1px solid var(--line); min-width: 0; overflow-wrap: anywhere; }
.ticket-card { position: relative; padding: 24px; border: 1px solid var(--line); border-radius: 12px; margin-bottom: 12px; background: var(--paper); }
.ticket-card h3 { margin: 7px 0 9px; }
.ticket-meta { display: flex; align-items: center; gap: 10px; min-height: 20px; }
.ticket-id { font-size: 11px; color: #757373; font-variant-numeric: tabular-nums; letter-spacing: .3px; }
.ticket-card .ticket-title { font-size: 16px; font-weight: 600; line-height: 1.6; color: var(--text); min-height: auto; }
.ticket-card .ticket-title:hover { color: var(--accent); background: transparent; }
.ticket-card .summary { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: #7e7c7c; font-size: 13px; margin: 0 0 12px; line-height: 1.8; }
.ticket-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ticket-footer small { font-size: 11px; color: #757373; }
.ticket-footer button { font-size: 12px; }
.badge { display: inline-block; padding: 2px 7px; background: var(--tint); color: var(--accent); border-radius: 5px; font-size: 10px; line-height: 1.6; }
.badge[data-verdict=exclude] { background: #eeecec; color: #8a797b; }
.pagination { padding-top: 20px; justify-content: space-between; font-size: 11px; color: var(--muted); }
.pagination button { min-height: 32px; font-size: 11px; padding: 6px 10px; background: transparent; }
.notice { padding: 12px 15px; background: var(--tint); border: 1px solid #e3e1e1; border-radius: 10px; overflow-wrap: anywhere; font-size: 13px; }
.error { color: #a73f48; }
.notice.error { background: #f8eeef; border-color: #e9d2d4; }
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
.process-block > summary { font-size: 13px; color: #6a6767; }
.process-block > div { padding-top: 12px; font-size: 13px; }
.process-block select { margin-top: 16px; }
#timeline { max-height: 440px; overflow: auto; scrollbar-width: thin; }
#timeline p { border-left: 2px solid #dbd9d9; padding-left: 15px; margin: 16px 0; font-size: 13px; }
.composer { position: sticky; bottom: 0; z-index: 5; padding: 16px 0 10px; background: linear-gradient(0deg,var(--bg) 78%,#ffffff00); }
.composer form { display: flex; align-items: flex-end; gap: 12px; background: var(--paper); border: 1px solid #d9d7d7; border-radius: 17px; padding: 12px 14px 12px 18px; box-shadow: 0 3px 14px #3b2e2f08; transition: box-shadow 180ms,border-color 180ms; }
.composer textarea { border: 0; border-radius: 0; background: transparent; padding: 5px 0; min-height: 36px; height: 36px; max-height: 160px; resize: none; outline: none; font-size: 13px; }
.composer .send-button { flex: none; }
.composer .send-button[data-mode=stop] { position: relative; background: #101211; border-color: #101211; border-radius: 50%; }
.composer .send-button[data-mode=stop] svg { visibility: hidden; }
.composer .send-button[data-mode=stop]::after { content: ''; position: absolute; width: 11px; height: 11px; border-radius: 2px; background: white; inset: 0; margin: auto; }
.composer-meta { display: flex; align-items: center; gap: 12px; min-height: 25px; padding: 3px 6px 0; }
.composer-meta p { margin: 0; font-size: 10px; }
.composer-meta small { font-size: 10px; }
#cancel { margin-left: auto; color: #8d8b8b; font-size: 10px; min-height: 24px; }
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
blockquote { margin: 12px 0; padding: 12px 15px; border-left: 2px solid #a69192; border-radius: 0 7px 7px 0; background: #f3f1f1; white-space: pre-wrap; font-size: 13px; overflow-wrap: anywhere; line-height: 1.85; }
mark { background: var(--mark); color: inherit; padding: 1px 0; }
dialog { width: min(500px,calc(100% - 32px)); max-height: calc(100dvh - 48px); border: 1px solid var(--line); border-radius: 20px; padding: 26px; color: var(--text); background: var(--paper); box-shadow: 0 20px 80px #2e2b2b26; overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; }
dialog::backdrop { background: #25232326; }
dialog[open] { animation: dialog-in 180ms var(--ease); }
dialog h2 { font-size: 19px; font-weight: 550; }
dialog label { display: block; margin: 20px 0 8px; font-size: 12px; }
dialog select { width: 100%; }
.dialog-actions { margin-top: 22px; justify-content: flex-end; }
.evidence { position: fixed; inset: 0 calc(100% - 100vw) 0 auto; width: min(530px,100vw); max-width: 100vw; height: 100dvh; max-height: 100dvh; margin: 0; border: 0; border-left: 1px solid var(--line); border-radius: 18px 0 0 18px; padding: 0; }
.evidence[open] { animation: drawer-in 230ms var(--ease); }
.evidence-head { position: sticky; top: 0; background: #fffffff5; backdrop-filter: blur(10px); border-bottom: 1px solid #eae8e8; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 19px 28px; z-index: 1; }
.evidence-head strong { display: block; font-size: 12px; font-weight: 500; overflow-wrap: anywhere; margin-top: 3px; }
.eyebrow { font-size: 10px; color: #8f8586; }
#detail { padding: 24px 28px 40px; }
.evidence h2 { font-size: 20px; line-height: 1.6; margin-bottom: 22px; }
.evidence h3 { margin: 24px 0 10px; }
.evidence p { font-size: 13px; line-height: 1.9; white-space: pre-wrap; }
.evidence small { font-size: 10px; }
.evidence .link { font-size: 11px; }
.evidence .field, .evidence .citation { scroll-margin-top: 110px; }
.evidence .field { padding-top: 8px; }
.speaker { display: block; color: var(--accent); margin-bottom: 4px; font-weight: 500; }
.dialogue-part { border-bottom: 1px solid #eeecec; padding: 10px 0; }
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
.brand > .brand-mark { width: 36px; height: 36px; padding: 6px; border-radius: 10px; background: var(--accent); color: white; }
.topbar-label { font: 10px/1.5 ui-monospace, Consolas, monospace; letter-spacing: 1.2px; border-left: 1px solid var(--line); padding-left: 16px; margin-left: 6px; color: #84787a; }
.home-kicker { display: flex; align-items: center; gap: 9px; color: var(--accent); font-size: 12px; font-weight: 600; letter-spacing: 1px; margin-bottom: 22px; }
.home h1 span { color: var(--accent); }
.examples-heading { display: flex; justify-content: space-between; margin-top: 28px; font-size: 12px; color: var(--text); }
.examples-heading > span { color: var(--muted); font-size: 11px; }
.example-icon { display: grid; place-items: center; width: 38px; height: 42px; background: var(--tint); color: var(--accent); border-radius: 9px; flex: none; }
.examples small, .examples strong { display: block; }
.examples small { font-size: 10px; margin-bottom: 4px; }
.examples strong { font-size: 13px; font-weight: 500; }
.example-arrow { margin-left: auto; color: var(--muted); font-size: 18px; }
.home-workflow { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 0 30px; font-size: 11px; color: var(--muted); }
.home-workflow b { font: 11px ui-monospace, Consolas, monospace; color: var(--accent); margin-right: 6px; }
.home-workflow i { font-style: normal; color: #c4b5b4; }
.task-kicker { display: block; font-size: 11px; color: var(--accent); margin: 10px 0 8px; letter-spacing: 1px; }
.ticket-index { font: 11px ui-monospace, Consolas, monospace; color: var(--accent); border-right: 1px solid var(--line); padding-right: 10px; }
.ticket-meta { flex-wrap: wrap; }
.ticket-card:hover { border-color: #dfc1bf; }
.plan-panel { padding: 22px; border: 1px solid var(--line); border-radius: 12px; margin-bottom: 16px; }
.plan-panel h2, .learning-progress h2 { font-size: 14px; }
#plan-predicate { font-size: 14px; line-height: 1.9; margin: 15px 0; }
.plan-panel > small { display: block; margin-top: 14px; }
.terms { display: flex; gap: 8px; flex-wrap: wrap; }
.term { padding: 3px 9px; border-radius: 5px; background: var(--soft); font-size: 12px; color: var(--muted); }
#plan-rewrites { font-size: 12px; margin-top: 14px; }
#plan-expressions { padding-left: 20px; color: var(--muted); }
.recall-channels { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 18px; }
.recall-card { padding: 18px 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--soft); }
.recall-card h3 { font-size: 12px; }
.recall-card p { font-size: 11px; margin-bottom: 0; }
.channel-state { font-size: 10px; color: var(--muted); }
.recall-card[data-state=running] .channel-state { color: var(--accent); }
.recall-card[data-state=failed] { border-style: dashed; }
.recall-count { display: inline-block; font-size: 25px; font-weight: 550; margin-top: 12px; font-variant-numeric: tabular-nums; }
.learning-progress { padding: 20px; border: 1px solid var(--line); border-radius: 12px; margin-bottom: 26px; }
.learning-metrics { display: grid; grid-template-columns: repeat(4,1fr); gap: 14px; padding: 18px 0; }
.learning-metrics strong, .learning-metrics span { display: block; }
.learning-metrics strong { font-size: 20px; font-weight: 550; font-variant-numeric: tabular-nums; }
.learning-metrics span { color: var(--muted); font-size: 11px; }
.learning-progress[data-state=quality_not_met] { border-left: 3px solid var(--accent); }
.result-method { padding: 18px 20px; border: 1px solid #f0d3d0; background: #fff8f7; border-radius: 12px; margin-bottom: 20px; }
.result-method > strong { font-size: 13px; }
.result-method p { font-size: 12px; color: var(--muted); line-height: 1.8; }
.method-quality { font-size: 11px; color: var(--muted); margin-top: 10px; }
.method-quality summary { color: var(--accent); }
.quality-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; border-top: 1px solid var(--line); padding-top: 14px; margin: 12px 0; }
.quality-grid > div { display: flex; align-items: baseline; flex-wrap: wrap; gap: 7px 12px; }
.quality-grid span { font-size: 11px; color: var(--muted); }
.quality-grid strong { color: var(--accent); font-size: 19px; font-weight: 550; font-variant-numeric: tabular-nums; }
.quality-grid small { font-size: 10px; }
@keyframes drawer-in { from { opacity: .5; transform: translateX(28px); } to { opacity: 1; transform: translateX(0); } }
@keyframes dialog-in { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }
@media (min-width: 1600px) { :root { --content-width: 1080px; --nav-width: 264px; } .home { margin-top: 10vh; } }
@media (max-width: 1100px) { :root { --nav-width: 194px; --gutter: 30px; } .sidebar { padding-inline: 12px; } .new-task kbd { display: none; } }
@media (max-width: 820px) {
  :root { --gutter: 28px; }
  .shell { display: block; }
  .sidebar { position: fixed; left: 0; z-index: 21; width: 260px; transform: translateX(-100%); visibility: hidden; transition: transform 200ms var(--ease); }
  body[data-nav=open] .sidebar { transform: translateX(0); visibility: visible; }
  #open-nav, #close-nav, .mobile-brand { display: inline-flex; }
  .nav-scrim { display: block; position: fixed; inset: 0; z-index: 20; width: 100%; height: 100%; background: #25232335; border: 0; border-radius: 0; }
  .nav-scrim:hover:not(:disabled) { background: #25232335; }
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
  .home-symbol { margin-bottom: 0; }
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
  .ticket-card { padding: 18px; }
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
  .topbar-label { display: none; }
  .home-kicker { margin-bottom: 18px; font-size: 11px; }
  .examples { grid-template-columns: 1fr; gap: 9px; }
  .examples button { padding: 13px; gap: 12px; }
  .examples svg { width: 20px; }
  .home-workflow { gap: 6px; font-size: 10px; }
  .home-workflow b { display: block; margin-bottom: 5px; }
  .composer-meta { flex-wrap: wrap; gap: 4px 10px; }
  .plan-panel, .learning-progress, .result-method { padding: 16px; }
  .recall-channels { gap: 9px; }
  .recall-card { padding: 14px; }
  .recall-card .row { gap: 3px; }
  .learning-metrics { grid-template-columns: 1fr 1fr; }
  .quality-grid { gap: 12px; }
  .quality-grid > div { display: grid; gap: 4px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
`
