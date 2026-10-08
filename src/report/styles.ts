// Report styles: tokens and type from design DR10, layout from DR2/DR4/DR11. Native fonts only (the CSP blocks downloads).
export const STYLES = String.raw`
:root {
  --bg: #ffffff; --bg-2: #f6f7f8; --ink: #111318; --ink-2: #535b67; --ink-3: #9aa1ab; --line: #e6e8eb; --accent: #111318; --on-accent: #ffffff;
  --green: #15803d; --green-soft: #e9f7ee; --amber: #b45309; --amber-soft: #fff4e0; --red: #b91c1c; --red-soft: #fdecec;
  --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
  --mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121317; --bg-2: #1a1c21; --ink: #eef0f3; --ink-2: #aab1bc; --ink-3: #6b7280; --line: #262a31; --accent: #eef0f3; --on-accent: #121317;
    --green: #34d070; --green-soft: #13261b; --amber: #f5b14b; --amber-soft: #2e2414; --red: #f87171; --red-soft: #2f1a1a;
  }
}
@media (prefers-contrast: more) { :root { --ink-2: var(--ink); --line: var(--ink-3); } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 var(--font); font-optical-sizing: auto; -webkit-font-smoothing: antialiased; accent-color: var(--accent); caret-color: var(--accent); scrollbar-color: var(--ink-3) transparent; }
::selection { background: var(--red-soft); color: var(--ink); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
button:disabled { cursor: default; opacity: .5; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
h1, h2, h3, p { margin: 0; }
.num { font-variant-numeric: tabular-nums; }
.muted { color: var(--ink-2); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
a { color: inherit; text-underline-offset: .15em; } a:visited { color: var(--ink-2); }

.wrap { max-width: 1200px; margin: 0 auto; padding: 0 24px; }
header.mast { border-bottom: 1px solid var(--line); }
.mast .wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding-top: 14px; padding-bottom: 14px; }
.brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 650; font-size: 17px; letter-spacing: -0.02em; }
.brand svg { width: 26px; height: 26px; }
.mast .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; color: var(--ink-2); font-size: 14px; }
.mast select { font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; max-width: 60vw; }
nav.tabs { border-bottom: 1px solid var(--line); }
nav.tabs .wrap { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; }
nav.tabs .wrap::-webkit-scrollbar { display: none; }
[role="tab"] { padding: 12px 12px 10px; border-bottom: 2px solid transparent; color: var(--ink-2); white-space: nowrap; font-weight: 500; }
[role="tab"][aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
main .wrap { padding-top: 28px; padding-bottom: 120px; }
.panel-title { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 8px 0 6px; }
.lede { color: var(--ink-2); font-size: 16px; max-width: 70ch; margin-bottom: 20px; }

.banner { border: 1px solid var(--line); background: var(--bg-2); border-radius: 8px; padding: 12px 14px; margin-bottom: 16px; font-size: 16px; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.banner.warn { border-color: var(--amber); }
.context { color: var(--ink-2); font-size: 14px; display: flex; flex-wrap: wrap; gap: 4px 12px; }
.linkish { text-decoration: underline; text-underline-offset: .15em; color: var(--ink-2); }

.hero { padding: 8px 0 24px; border-bottom: 1px solid var(--line); }
.hero h1 { font-size: 30px; line-height: 1.15; font-weight: 650; letter-spacing: -0.02em; margin: 10px 0 14px; max-width: 30ch; }
.budget { position: relative; height: 22px; border-radius: 6px; background: var(--bg-2); overflow: hidden; display: flex; border: 1px solid var(--line); }
.budget .listed { background: var(--ink); }
.budget .dropped { background: repeating-linear-gradient(135deg, var(--red) 0 4px, var(--red-soft) 4px 8px); }
.budget .edge { position: absolute; top: -4px; bottom: -4px; width: 2px; background: var(--ink); }
.budget-legend { display: flex; justify-content: space-between; gap: 8px; color: var(--ink-2); font-size: 13px; margin-top: 6px; }
.hero-line { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 14px; font-size: 16px; }
.hero-line b { font-weight: 600; }
.btn { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); font-weight: 500; white-space: nowrap; }
.btn:hover:not(:disabled) { background: var(--bg-2); }
.btn.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.btn.small { min-height: 30px; padding: 0 10px; font-size: 13px; }
.strip { display: flex; flex-wrap: wrap; gap: 4px 18px; padding: 14px 0; border-bottom: 1px solid var(--line); color: var(--ink-2); }
.strip b { color: var(--ink); font-weight: 600; }

.filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 16px 0 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { border: 1px solid var(--line); border-radius: 6px; padding: 5px 10px; font-size: 13px; color: var(--ink-2); }
.chip[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.search { flex: 1 1 220px; max-width: 360px; height: 36px; border: 1px solid var(--line); border-radius: 6px; padding: 0 10px; font: inherit; color: var(--ink); background: var(--bg); }
.sortsel { height: 36px; border: 1px solid var(--line); border-radius: 6px; padding: 0 8px; font: inherit; color: var(--ink); background: var(--bg); }
.countline { width: 100%; display: flex; gap: 12px; align-items: center; color: var(--ink-2); font-size: 13px; }
.filters-toggle { display: none; }

table.items { width: 100%; border-collapse: collapse; }
.items th { text-align: left; font-size: 13px; font-weight: 500; color: var(--ink-2); padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.items th.r, .items td.r { text-align: right; white-space: nowrap; }
.items td { padding: 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
.items td.name { width: 100%; min-width: 180px; }
.items .nm { font-weight: 500; overflow-wrap: break-word; }
.items .sub { color: var(--ink-2); font-size: 13px; }
.items .unit { display: block; color: var(--ink-2); font-size: 12px; }
.items tr.marked-archive td { background: var(--red-soft); }
.items tr.detail td { background: var(--bg-2); padding: 14px 16px 16px 48px; font-size: 14px; }
.detail dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; max-width: 100ch; }
.detail dt { color: var(--ink-2); }
.detail dd { margin: 0; overflow-wrap: anywhere; }
.disclose { width: 28px; height: 28px; border-radius: 6px; display: inline-grid; place-items: center; color: var(--ink-2); }
.disclose svg { width: 12px; height: 12px; transition: transform 120ms ease-out; }
[aria-expanded="true"] > svg { transform: rotate(90deg); }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.seg button { padding: 4px 8px; font-size: 12.5px; font-weight: 500; color: var(--ink-2); min-height: 28px; }
.seg button + button { border-left: 1px solid var(--line); }
.seg button[aria-pressed="true"].a { background: var(--red); color: #fff; }
.seg button[aria-pressed="true"].k { background: var(--green); color: #fff; }
.tag { display: inline-block; border-radius: 4px; padding: 0 6px; font-size: 12px; font-weight: 500; background: var(--bg-2); color: var(--ink-2); margin-left: 6px; white-space: nowrap; }
.tag.red { background: var(--red-soft); color: var(--red); } .tag.green { background: var(--green-soft); color: var(--green); } .tag.amber { background: var(--amber-soft); color: var(--amber); }
.narrow-meta { display: none; }
.impact { background: var(--bg-2); border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; margin-top: 8px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

.group { border-top: 1px solid var(--line); padding: 14px 0; }
.group h2 { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
.group ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
.codebox { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 6px 0; }
.codebox code { flex: 1 1 240px; overflow-wrap: anywhere; }
.next { border: 1px solid var(--ink); border-radius: 8px; padding: 14px 16px; margin: 16px 0; font-size: 16px; }
.next ol { margin: 8px 0 0; padding-left: 20px; display: grid; gap: 6px; }
textarea.picksjson { width: 100%; min-height: 120px; font: 12.5px var(--mono); }
.finding { border-top: 1px solid var(--line); padding: 14px 0; display: grid; grid-template-columns: 12px 1fr; gap: 4px 12px; }
.finding i { width: 8px; height: 8px; border-radius: 50%; margin-top: 7px; background: var(--amber); }
.finding.high i { background: var(--red); } .finding.good i { background: var(--green); }
.finding h2 { font-size: 16px; font-weight: 600; } .finding p { grid-column: 2; color: var(--ink-2); max-width: 80ch; }

.picksbar { position: fixed; left: 0; right: 0; bottom: 0; background: var(--bg); border-top: 1px solid var(--line); box-shadow: 0 2px 8px rgba(0,0,0,.12); padding: 10px 24px calc(10px + env(safe-area-inset-bottom, 0px)); display: flex; align-items: center; gap: 12px; z-index: 5; }
.picksbar[hidden] { display: none; }
.picksbar .count { font-weight: 600; }
@media (prefers-reduced-motion: reduce) { .disclose svg { transition: none; } }

@media (max-width: 1099px) { .col-source, .col-last { display: none; } .items td.name { min-width: 140px; } }
@media (max-width: 719px) {
  .wrap { padding: 0 16px; }
  .hero h1 { font-size: 24px; }
  .filters .more { display: none; width: 100%; }
  body.filters-open .filters .more { display: flex; flex-wrap: wrap; gap: 8px; }
  .filters-toggle { display: inline-flex; }
  .items thead { display: none; }
  .items .col-2nd { display: none; }
  .items td.name { min-width: 0; }
  .narrow-meta { display: block; color: var(--ink-2); font-size: 13px; }
  .items td { padding: 10px 6px; }
  .items tr.detail td { padding-left: 12px; }
  .btn, .chip, .seg button, .disclose, [role="tab"], .search, .sortsel { min-height: 44px; }
  .disclose { width: 44px; }
  main .wrap { padding-bottom: 140px; }
  .picksbar { padding-left: 16px; padding-right: 16px; }
}
`;
