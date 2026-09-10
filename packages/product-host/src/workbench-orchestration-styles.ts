export const ORCHESTRATION_STYLES = String.raw`
.live-work { position: relative; border: 1px solid #dee8e2; border-radius: 17px; background: linear-gradient(115deg,#f0f6f2,#fcfdfa 75%); margin: 22px 0 24px; padding: 20px 22px 15px; overflow: hidden; }
.live-work::after { content: ''; position: absolute; bottom: 0; height: 2px; left: 0; right: 0; background: linear-gradient(90deg,transparent,#62ad97,transparent); opacity: 0; }
.live-work[data-state=running]::after { opacity: .7; animation: work-scan 3.4s ease-in-out infinite; }
.live-heading { display: flex; align-items: center; gap: 14px; }
.live-copy { flex: 1; min-width: 0; }
.live-copy .eyebrow { font-size: 10px; letter-spacing: 1.6px; color: #74847d; }
.live-copy p { margin: 2px 0 0; font-size: 14px; font-weight: 500; line-height: 1.65; }
.ai-orbit { position: relative; flex: 0 0 40px; height: 40px; display: grid; place-items: center; color: #307b6d; background: #e4f0e9; border-radius: 50%; }
.ai-orbit .brand-mark { width: 23px; height: 23px; }
.ai-orbit::before { content: ''; position: absolute; inset: -3px; border-radius: 50%; border: 1px solid #bfd9cd; border-top-color: #448c79; }
.live-work[data-state=running] .ai-orbit::before { animation: orbit-turn 3s linear infinite; }
.live-work[data-state=running] .ai-orbit .brand-mark { animation: soft-breathe 2.8s ease-in-out infinite; }
#elapsed { color: #7b8b83; font: 11px/1.4 ui-monospace,Consolas,monospace; white-space: nowrap; font-variant-numeric: tabular-nums; }
.stage-rail { display: flex; list-style: none; gap: 0; padding: 0; margin: 22px 0 0; }
.stage-rail li { position: relative; display: flex; align-items: center; gap: 7px; font-size: 11px; color: #949c97; flex: 1; min-width: 0; }
.stage-rail li:not(:last-child)::after { content: ''; height: 1px; background: #dce6df; flex: 1; margin: 0 12px; min-width: 5px; }
.stage-rail li:last-child { flex: 0 1 auto; }
.stage-number { display: grid; place-items: center; width: 20px; height: 20px; border: 1px solid #d9e2dc; border-radius: 50%; font-size: 10px; flex-shrink: 0; }
.stage-rail [data-state=active] { color: #216f64; font-weight: 600; }
.stage-rail [data-state=active] .stage-number { background: #2b7969; color: white; border-color: #2b7969; box-shadow: 0 0 0 4px #3d8b7010; }
.stage-rail [data-state=done] { color: #497b69; }
.stage-rail [data-state=done] .stage-number { background: #e3eee6; border-color: transparent; }
.stage-rail small { display: none; }
.live-metrics { display: flex; gap: 22px; margin-top: 17px; padding-top: 12px; border-top: 1px solid #e1e9e1; }
.live-metrics>span { display: inline-flex; gap: 6px; align-items: baseline; }
.live-metrics strong { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; color: #527367; }
.live-metrics small { font-size: 10px; color: #7a887e; }
.live-note { margin: 16px 0 0; padding: 10px 0 0; border-top: 1px solid #e1e9e1; color: #6b8376; font-size: 11px; line-height: 1.8; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.live-note:not([hidden])+.live-metrics { border-top: 0; padding-top: 0; margin-top: 10px; }
.task:has(#collaboration-view:not([hidden])) .live-work .stage-rail, .task:has(#collaboration-view:not([hidden])) .live-work .live-metrics, .task:has(#collaboration-view:not([hidden])) .live-work .live-note { display: none; }
.task:has(#collaboration-view:not([hidden])) .live-work { margin: 16px 0; padding-block: 15px; }
.live-work[data-state=done] { background: #f5f6f2; border-color: var(--line); }
.live-work[data-state=done] .stage-rail, .live-work[data-state=done] .live-metrics { display: none; }
.live-work[data-state=done] .ai-orbit::before { border-color: #d5e3d8; }
.live-work[data-state=error] { background: #faf3ef; border-color: #eaded5; }
.live-work[data-state=stopped] { background: #faf6ef; border-color: #e9dfcd; }
.task-heading h1 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.section-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin: 0 0 22px; }
.section-heading h2 { font-size: 19px; font-weight: 500; margin: 2px 0 0; letter-spacing: -.4px; }
.section-heading .eyebrow { letter-spacing: 1.5px; font-size: 10px; }
.section-heading>.muted { font-size: 11px; white-space: nowrap; }
.activity-log { padding: 4px 0 16px; }
.activity-item { display: flex; gap: 15px; position: relative; padding-bottom: 22px; }
.activity-item:not(:last-child)::before { content: ''; position: absolute; left: 13px; top: 28px; bottom: 0; width: 1px; background: #e0e7df; }
.activity-dot { display: grid; place-items: center; flex: 0 0 27px; height: 27px; border-radius: 9px; background: #edf1ea; color: #598773; font-size: 16px; }
.activity-dot svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.activity-item[data-kind=user] .activity-dot { background: #eeece7; color: #77796e; }
.activity-item[data-kind=delegate] .activity-dot { background: #eeedf5; color: #81739b; }
.activity-item[data-kind=finding] .activity-dot, .activity-item[data-kind=finish] .activity-dot { background: #dfefe5; color: #2d795c; }
.activity-log[data-busy=true] .activity-item:last-child .activity-dot { position: relative; }
.activity-log[data-busy=true] .activity-item:last-child .activity-dot::after { content: ''; position: absolute; inset: -4px; border: 1.5px solid #79ad9233; border-top-color: #4a9174; border-radius: 12px; animation: orbit-turn 2.6s linear infinite; }
.stage-rail [data-state=active] .stage-number { position: relative; }
.stage-rail [data-state=active] .stage-number::after { content: ''; position: absolute; inset: -4px; border: 1px solid transparent; border-top-color: #418d76; border-radius: 50%; animation: orbit-turn 2s linear infinite; }
.task-status[data-state=running] .status-dot { width: 12px; height: 12px; border: 2px solid #76a49344; border-top-color: var(--accent); background: transparent; box-shadow: none; animation: orbit-turn 1.5s linear infinite; }
.expert-node, .knowledge-card, .model-option, .card { transition: border-color .2s ease, box-shadow .2s ease, background-color .2s ease; }
.expert-node[data-state=running] .expert-avatar { animation: soft-breathe 2s ease-in-out infinite; }
.composer-meta { flex-wrap: wrap; }
@media (max-width: 600px) { .composer-meta .model-trigger { max-width: 180px; } .composer-meta #input-hint { display: none; } }
.activity-item>div { min-width: 0; padding-top: 1px; }
.activity-item small { color: #798479; font-size: 10px; }
.activity-item p { margin: 5px 0 0; font-size: 13px; line-height: 1.85; overflow-wrap: anywhere; white-space: pre-wrap; }
.orchestration-map { position: relative; border: 1px solid #e4e8e0; border-radius: 18px; padding: 25px 24px; background-color: #f5f6f2; background-image: radial-gradient(#c9d2c480 .7px, transparent .7px); background-size: 12px 12px; }
.coordinator-node, .synthesis-node { position: relative; display: flex; gap: 12px; align-items: center; width: fit-content; max-width: 100%; margin: auto; border: 1px solid #dae1d7; border-radius: 12px; padding: 13px 20px; background: #fcfdfb; z-index: 1; }
.coordinator-node strong, .synthesis-node strong { font-size: 13px; font-weight: 550; }
.coordinator-node small, .synthesis-node small { display: block; color: #8a9589; font-size: 10px; margin-top: 3px; }
.node-icon, .synthesis-node>span { display: grid; place-items: center; width: 30px; height: 30px; background: #e9f0e5; border-radius: 9px; color: #688359; flex-shrink: 0; }
.node-icon svg { width: 20px; height: 20px; }
.expert-lanes { position: relative; display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,200px),1fr)); gap: 14px; padding: 38px 0; }
.expert-lanes::before, .expert-lanes::after { content: ''; position: absolute; width: 1px; height: 38px; background: #cbd7c7; left: 50%; top: 0; }
.expert-lanes::after { top: auto; bottom: 0; }
.expert-node { position: relative; min-width: 0; border: 1px solid #dce3d7; border-radius: 12px; background: #fff; padding: 15px; box-shadow: 0 3px 8px #41503a04; }
.expert-node::before { content: ''; position: absolute; left: 50%; top: -20px; height: 20px; width: 1px; background: #cbd7c7; }
.expert-node::after { content: ''; position: absolute; top: -20px; left: -8px; right: -8px; height: 1px; background: #cbd7c7; }
.expert-node:first-child::after { left: 50%; }
.expert-node:last-child::after { right: 50%; }
.expert-node[data-state=running] { border-color: #85b8a6; box-shadow: 0 0 0 3px #5d9e8310; }
.expert-node[data-state=running]::before { background: linear-gradient(180deg,#cbd7c7,#4b927a,#cbd7c7); background-size: 100% 200%; animation: branch-flow 1.5s linear infinite; }
.expert-node-head { display: flex; align-items: center; gap: 8px; }
.expert-node-head strong { font-size: 12px; font-weight: 550; flex: 1; }
.expert-avatar { display: grid; place-items: center; flex: 0 0 28px; height: 28px; border-radius: 9px; background: #e9eee4; color: #6c825b; font-size: 11px; }
.expert-node:nth-child(3n + 2) .expert-avatar { color: #897451; background: #f4eee0; }
.expert-node:nth-child(3n) .expert-avatar { color: #6676a0; background: #eceff7; }
.expert-state { font-size: 9px; color: #798774; white-space: nowrap; }
.expert-node[data-state=running] .expert-state { color: #367f69; }
.expert-goal { font-size: 12px; line-height: 1.8; margin: 14px 0 12px; color: #5d685b; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.expert-action { display: flex; gap: 6px; align-items: center; font-size: 10px; color: #82907d; margin: 0 0 12px; }
.expert-node[data-state=running] .expert-action::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: #62a28d; animation: soft-breathe 1.5s ease-in-out infinite; }
.expert-knowledge { display: flex; flex-wrap: wrap; gap: 5px; font-size: 10px; margin-bottom: 15px; }
button.knowledge-chip { display: inline-block; min-height: 26px; border: 1px solid #e2e8db; background: #f7f9f3; border-radius: 6px; padding: 4px 7px; color: #6c815d; font-size: 10px; text-align: left; overflow-wrap: anywhere; }
.expert-counts { display: block; color: #9aA393; font-size: 10px; }
.expert-node>button.link { margin-top: 10px; font-size: 11px; }
.expert-lanes:has(.expert-node:nth-child(4)) { grid-template-columns: repeat(2,minmax(0,1fr)); }
.expert-lanes:has(.expert-node:nth-child(4)) .expert-node::after { display: none; }
.expert-lanes:has(.expert-node:nth-child(4)) .expert-node::before { height: 14px; top: -14px; }
.team-empty { grid-column: 1/-1; color: #84907e; text-align: center; font-size: 12px; line-height: 1.8; margin: 0; padding: 24px 16px; background: #f7f8f4; border-radius: 10px; }
.synthesis-node { padding: 11px 18px; }
.synthesis-node>span { width: 26px; height: 26px; }
.coordinator-node[data-state=running], .synthesis-node[data-state=running] { border-color: #9bbaa2; }
.library-heading { margin-top: 38px; margin-bottom: 20px; }
.library-toolbar { display: flex; gap: 15px; align-items: center; }
.library-toolbar input { width: min(100%,340px); background: #f2f3ed; border: 1px solid transparent; border-radius: 10px; padding: 10px 14px; font-size: 12px; outline-offset: 2px; }
.domain-filters { display: flex; flex-wrap: wrap; gap: 6px; margin: 16px 0 20px; }
button.domain-filter { font-size: 11px; padding: 6px 10px; min-height: 30px; border-radius: 7px; border-color: transparent; background: transparent; color: #88917e; }
button.domain-filter[aria-pressed=true] { color: #426e56; background: #e9eee3; border-color: #e1e7db; }
.knowledge-list { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 13px; }
button.knowledge-card { display: block; min-width: 0; text-align: left; padding: 18px 19px; border-radius: 12px; background: #fff; border-color: #e5e8df; }
button.knowledge-card:hover:not(:disabled) { background: #fbfcf8; border-color: #c4d4bb; box-shadow: 0 5px 18px #66714e08; }
.knowledge-card-meta { display: flex; justify-content: space-between; gap: 8px; color: #9da590; font-size: 9px; margin-bottom: 12px; }
.knowledge-card-meta .used-knowledge { color: #3e886b; }
.knowledge-card strong { display: block; font-size: 13px; font-weight: 550; color: #54604d; line-height: 1.8; }
.knowledge-card p { font-size: 11px; color: #89917f; margin: 8px 0 15px; line-height: 1.8; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.knowledge-card small { color: #9aa48d; font-size: 10px; }
.knowledge-body { padding: 25px 30px 35px; font-size: 13px; line-height: 1.9; overflow-wrap: anywhere; }
.knowledge-body h3 { margin: 25px 0 12px; font-size: 15px; font-weight: 550; }
.knowledge-body p { margin: 10px 0; }
.knowledge-body ul { padding-left: 21px; color: #677162; }
.knowledge-body li+li { margin-top: 8px; }
.knowledge-scope { font-size: 14px; color: #738269; padding-bottom: 17px; border-bottom: 1px solid #e9ede4; }
.knowledge-used { color: #41816a; background: #edf5ee; padding: 10px 12px; border-radius: 8px; font-size: 12px; }
.report-generating { margin: 24px 0; padding: 25px; border: 1px solid #e1e8df; background: #f7f9f4; border-radius: 12px; }
.report-generating p { margin: 0 0 20px; font-size: 13px; }
.skeleton-line { height: 10px; margin: 12px 0; border-radius: 5px; background: linear-gradient(90deg,#e7ede2,#f7faf2,#e7ede2); background-size: 200% 100%; animation: shimmer 2s linear infinite; }
.skeleton-line:last-child { width: 64%; }
.shimmer-text { color: #688069; animation: soft-breathe 1.8s ease-in-out infinite; }
.tabs { gap: 26px; }
@keyframes work-scan { 0%,100% { transform: translateX(-85%); } 50% { transform: translateX(85%); } }
@keyframes orbit-turn { to { transform: rotate(360deg); } }
@keyframes soft-breathe { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
@keyframes branch-flow { to { background-position: 0 -200%; } }
@keyframes shimmer { to { background-position: -200% 0; } }
@media (max-width: 600px) {
  .live-work { padding: 17px 15px 13px; margin-top: 18px; }
  .live-heading { gap: 11px; }
  .live-copy p { font-size: 12px; }
  .ai-orbit { flex-basis: 32px; height: 32px; }
  .ai-orbit .brand-mark { width: 20px; height: 20px; }
  .live-heading .icon-button { display: none; }
  .stage-rail { gap: 6px; margin-top: 20px; }
  .stage-rail li { flex-direction: column; align-items: flex-start; gap: 6px; font-size: 10px; flex: 1; }
  .stage-rail li:last-child { flex: 1; }
  .stage-rail li:not(:last-child)::after { position: absolute; top: 10px; left: 27px; right: 5px; margin: 0; }
  .live-metrics { gap: 19px; }
  .live-metrics strong { font-size: 12px; }
  .tabs { gap: 16px; }
  .tabs button { font-size: 11px; white-space: nowrap; }
  .section-heading { align-items: flex-start; gap: 8px; }
  .section-heading h2 { font-size: 17px; }
  .section-heading>.muted { font-size: 10px; }
  #team-count { max-width: 68px; white-space: normal; text-align: right; }
  .orchestration-map { padding: 20px 14px; }
  .expert-lanes { grid-template-columns: 1fr; gap: 18px; padding: 24px 0; }
  .expert-lanes:has(.expert-node:nth-child(4)) { grid-template-columns: 1fr; }
  .expert-lanes::before, .expert-lanes::after { height: 24px; }
  .expert-node::before { height: 18px; top: -18px; }
  .expert-node::after { display: none; }
  .expert-node-head strong { font-size: 13px; }
  .expert-goal { margin-top: 10px; }
  .knowledge-list { grid-template-columns: 1fr; }
  .knowledge-body { padding: 22px 20px 30px; }
  .library-heading { margin-top: 28px; }
  .library-heading h2 { font-size: 17px; }
}
@media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation: none !important; transition: none !important; } }
`
