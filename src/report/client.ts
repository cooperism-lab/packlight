// The report's in-page code. It is serialised into report.html with Function.prototype.toString, so it must be
// self-contained: no imports, no closures over module scope. Every piece of third-party text reaches the page as
// a text node through h() (CEO F4); nothing is ever assigned to innerHTML.
import type { ReportData, ReportItem } from './model.js';

declare const simulateListing: (entries: { name: string; fullChars: number; nameChars: number; priority: boolean }[], budgetChars: number) => { chars: number; described: number; dropped: number; describedNames: string[] };

export function clientMain(): void {
  type Mark = 'archive' | 'keep' | 'unkeep';
  type Kind = ReportItem['kind'];
  const data = JSON.parse(document.getElementById('packlight-data')!.textContent!) as ReportData;
  const KINDS: [Kind, string][] = [['skill', 'Skills'], ['command', 'Commands'], ['agent', 'Agents'], ['hook', 'Hooks'], ['plugin', 'Plugins'], ['mcp', 'MCP servers'], ['instructions', 'Instructions']];
  const AGENT = data.agent === 'codex' ? 'Codex' : 'Claude Code';
  const KIND_TEXT: Record<Kind, string> = data.agent === 'codex' ? {
    skill: 'Each skill\'s name, description and path sit in a listing Codex sees every session. Codex opens a skill\'s SKILL.md when it uses it.',
    command: 'Custom prompts you type as slash commands.',
    agent: 'Subagents Codex can hand work to.',
    hook: 'Programs Codex runs on events.',
    plugin: 'Bundles of skills and tools. Switch one off in Codex\'s plugin settings, or with enabled = false in ~/.codex/config.toml.',
    mcp: 'Tool servers Codex can call. Switch one off with enabled = false under its [mcp_servers] table in ~/.codex/config.toml.',
    instructions: 'AGENTS.md files, loaded in full in their project. packlight never changes these.',
  } : {
    skill: 'Each skill\'s name and description sit in a listing Claude sees every session. When the listing runs out of room, descriptions are dropped.',
    command: 'Slash commands you type. Their descriptions share the skill listing.',
    agent: 'Subagents Claude can hand work to. Their descriptions load every session.',
    hook: 'Scripts that run on events. Some add text to the session each time they fire.',
    plugin: 'Bundles of the other kinds. Archiving a plugin turns off every part of it.',
    mcp: 'Tool servers Claude can call. Claude Code lists every tool\'s name at the start of each session, and some servers add instructions too, so an unused server still costs its load.',
    instructions: 'CLAUDE.md and similar files, loaded in full in their project. packlight never changes these.',
  };
  const ONE: Record<string, string> = { skill: 'skill', command: 'command', agent: 'agent', hook: 'hook', plugin: 'plugin', mcp: 'MCP server' };
  const METHOD_TEXT: Record<string, string> = {
    move: 'Moved into packlight\'s archive', 'hook-extract': 'Cut out of their settings files', 'mcp-extract': 'Cut out of their config files',
    'plugin-disable': 'Plugins turned off', manual: 'Removed by hand (packlight records them)',
  };

  // ------------------------------------------------------------------ helpers
  type Child = Node | string | number | null | undefined | false | Child[];
  function h(tag: string, props: Record<string, unknown> | null, ...kids: Child[]): HTMLElement {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props ?? {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    const add = (c: Child): void => {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { c.forEach(add); return; }
      el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    };
    kids.forEach(add);
    return el;
  }
  const svg = (path: string): Element => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 12 12'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.6');
    s.append(p);
    return s;
  };
  const chars = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(n)));
  const date = (s: string | null | undefined): string => (s ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(s).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : '—');
  // Tokens are estimated from characters (logs record characters): about 4 per token, the same as CHARS_PER_TOKEN in model.ts.
  const tokens = (c: number): string => chars(c / 4);
  const setupTotal = (): number => { const l = data.sessionLoad; return !l ? 0 : l.measuredTokens ? l.measuredTokens * 4 : l.skillListing + l.mcpTools + l.mcpInstructions + l.hookStart + l.agents + (l.agentsMd ?? 0) + (l.pluginInstructions ?? 0); };
  const share = (part: number, whole: number): string => { const p = Math.min(100, (part / whole) * 100); return p > 0 && p < 1 ? 'under 1%' : `${Math.round(p)}%`; };
  const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
  const tildify = (p: string): string => (p.startsWith(data.home) ? `~${p.slice(data.home.length)}` : p);
  const live = document.getElementById('live')!;
  const say = (text: string): void => { live.textContent = ''; window.setTimeout(() => { live.textContent = text; }, 30); };

  // ------------------------------------------------------------------ state
  const byId = new Map(data.items.map(i => [i.id, i]));
  const pluginItem = (key: string | undefined): ReportItem | undefined => data.items.find(i => i.kind === 'plugin' && i.plugin === key);
  const projectName = (root: string): string => data.projects.find(p => p.root === root)?.name ?? root.split(/[\\/]/).pop() ?? root;
  const fromHash = new URLSearchParams(location.hash.slice(1));
  const state = {
    tab: fromHash.get('tab') ?? 'items',
    view: fromHash.get('project') ?? (data.scope !== 'global' ? data.scope : 'global'),
    kind: 'skill' as Kind,
    suggestedOnly: false,
    pushedOutOnly: false,
    q: '',
    sort: 'cost',
    open: new Set<string>(),
    confirmPlugin: null as string | null,
    fixOpen: false,
    marks: {} as Record<string, Mark>,
    saved: false,
    downloadFailed: null as string | null,
    storage: 'ok' as 'ok' | 'blocked',
    carry: null as null | { source: 'storage' | 'saved'; scanId: string; marks: Record<string, Mark>; createdAt?: string },
  };
  if (state.view !== 'global' && !data.projects.some(p => p.root === state.view)) state.view = 'global';

  // Marks are stored per project scope and scan id; a newer report offers to bring them over (design DR5, DE4).
  const storeKey = `packlight:marks:${data.agent}:${data.scope}`;
  try {
    const raw = window.localStorage.getItem(storeKey);
    const stored = raw ? JSON.parse(raw) as { scanId: string; marks: Record<string, Mark> } : null;
    if (stored && stored.scanId === data.scanId) state.marks = stored.marks;
    else if (stored && stored.scanId < data.scanId && Object.keys(stored.marks).length) state.carry = { source: 'storage', scanId: stored.scanId, marks: stored.marks };
  } catch { state.storage = 'blocked'; }
  if (!state.carry && !Object.keys(state.marks).length && data.savedPicks && Object.keys(data.savedPicks.marks).length) {
    state.carry = { source: 'saved', scanId: data.savedPicks.scanId, marks: data.savedPicks.marks };
  }
  const persist = (): void => {
    if (state.storage === 'blocked') return;
    try { window.localStorage.setItem(storeKey, JSON.stringify({ scanId: data.scanId, marks: state.marks })); } catch { state.storage = 'blocked'; }
  };

  // ------------------------------------------------------------------ derived values
  const inView = (i: ReportItem): boolean => state.view === 'global' || i.projectRoot === null || i.projectRoot === state.view;
  const budget = () => (state.view === 'global' ? undefined : data.budget[state.view]);
  const listingStatus = (i: ReportItem): 'listed' | 'pushed out' | null => {
    const b = budget();
    if (!b || (i.kind !== 'skill' && i.kind !== 'command')) return null;
    if (i.logKeys.some(k => b.dropped.includes(k))) return 'pushed out';
    if (i.logKeys.some(k => b.withDescription.includes(k))) return 'listed';
    return null;
  };
  /** The item a mark lands on: plugin children are marked through their plugin (CEO O3, DR7). */
  const markTarget = (i: ReportItem): ReportItem => (i.plugin && i.kind !== 'plugin' ? pluginItem(i.plugin) ?? i : i);
  const markOf = (i: ReportItem): Mark | undefined => state.marks[markTarget(i).id];
  // Suites and built-in skills are never archived (their own uninstaller or the app owns them).
  const markable = (i: ReportItem): boolean => i.kind !== 'instructions' && !i.removal.suite;
  const archived = (): ReportItem[] => Object.entries(state.marks).filter(([, m]) => m === 'archive').map(([id]) => byId.get(id)).filter((x): x is ReportItem => !!x);
  const usageCell = (i: ReportItem): string => {
    if (!data.hasLogs) return 'Unavailable';
    if (i.usage.ambiguous) return `ambiguous: ${i.usage.total} shared`;
    return i.usage.total ? String(i.usage.total) : 'not observed';
  };
  const reasonText = (i: ReportItem): string => {
    const s = i.suggestion;
    if (s.suggested) return `Suggested: not observed in any of ${s.windowSessions} sessions over ${s.windowDays} days.`;
    switch (s.reason) {
      case 'used': return `Used ${plural(i.usage.total, 'time')}.`;
      case 'too-new': return `Installed ${plural(s.windowDays, 'day')} ago: too new to judge.`;
      case 'too-few-sessions': return `Only ${s.windowSessions} of the ${data.thresholds.sessions} sessions needed to judge it.`;
      case 'ambiguous': return 'Shares a name or command with another item, so its usage cannot be told apart.';
      case 'uncertain': return 'Usage may be incomplete: packlight could not read some log lines.';
      case 'parse-gaps': return `Usage uncertain: ${plural(s.unreadableLines, 'unreadable line')} in the sessions since it was installed.`;
      case 'manual': return `Only removable by hand: ${i.removal.where ?? ''}`;
      case 'kept': return `You kept it on ${date(i.keptAt)}.`;
      case 'off': return 'Turned off already.';
      case 'plugin-in-use': return 'Another part of its plugin is in use.';
      default: return '';
    }
  };
  const loadOf = (i: ReportItem): { value: number; unit: string } | null => {
    if (i.standingChars) return { value: i.standingChars, unit: i.kind === 'instructions' ? 'in its project' : 'every session' };
    if (i.usage.hook && i.usage.hook.firings) return { value: i.usage.hook.injectedChars / i.usage.hook.firings, unit: 'per firing' };
    if (i.kind === 'plugin') {
      const sum = data.items.filter(c => c.plugin === i.plugin && c.kind !== 'plugin').reduce((n, c) => n + c.standingChars, 0);
      return sum ? { value: sum, unit: 'every session' } : null;
    }
    return null;
  };
  const visibleItems = (): ReportItem[] => data.items.filter(inView);
  const suggestedInView = (): ReportItem[] => visibleItems().filter(i => i.suggestion.suggested);

  /** Projected listing after archiving `gone` (a projection, always labelled so). */
  function projected(gone: Set<string>): number | null {
    const b = budget();
    if (!b) return null;
    // Same model as the CLI's fix plan (report/fix.ts listingEntries): logged order, Claude Code's used skills first.
    const byKey = new Map<string, ReportItem>();
    for (const i of data.items) for (const k of i.logKeys) if (!byKey.has(k)) byKey.set(k, i);
    const priority = new Set(data.listingPriority);
    const lines = b.entries ?? [...b.withDescription.map(name => ({ name, chars: 0, described: true })), ...b.dropped.map(name => ({ name, chars: 0, described: false }))];
    const entries = lines.map(l => {
      const it = byKey.get(l.name);
      const nameChars = l.name.length + 3;
      const full = l.described && l.chars ? l.chars : it?.standingChars ? it.standingChars : l.chars || nameChars;
      return { name: l.name, it, nameChars, fullChars: Math.max(full, nameChars), priority: priority.has(l.name) || !it };
    }).filter(e => !(e.it && (gone.has(e.it.id) || (e.it.plugin && gone.has(markTarget(e.it).id)))));
    return simulateListing(entries, b.dropped.length ? b.listingChars : Number.MAX_SAFE_INTEGER).dropped;
  }

  // ------------------------------------------------------------------ rendering
  const root = document.getElementById('app')!;
  const keyOf = (el: Element | null): string | null => (el instanceof HTMLElement ? el.dataset.key ?? null : null);

  function render(): void {
    const focusKey = keyOf(document.activeElement);
    location.replace(`#${new URLSearchParams({ tab: state.tab, ...(state.view !== data.scope ? { project: state.view } : {}) }).toString()}`);
    root.replaceChildren(masthead(), tabs(), h('main', { id: 'main' }, h('div', { class: 'wrap' }, panel())), footer(), picksBar());
    const again = focusKey ? root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`) : null;
    if (again) {
      again.focus();
      if (again instanceof HTMLInputElement) again.setSelectionRange(again.value.length, again.value.length);
    }
  }

  function footer(): HTMLElement {
    return h('footer', { class: 'foot' }, h('div', { class: 'wrap' },
      h('span', null, 'packlight, built by Cooper Kao'),
      h('a', { href: 'https://github.com/cooperism-lab/packlight', rel: 'noreferrer', target: '_blank' }, 'github.com/cooperism-lab/packlight'),
      h('span', null, 'This page runs only on your computer and sends nothing.')));
  }

  // The mark from report/logo.ts, drawn with DOM calls (no markup strings in the page, CEO F4).
  function logo(): Element {
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag: string, attrs: Record<string, string>, ...kids: Element[]): Element => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      e.append(...kids);
      return e;
    };
    const cut = { stroke: '#000' };
    return el('svg', { viewBox: '0 0 64 64', 'aria-hidden': 'true' },
      el('defs', {}, el('mask', { id: 'pl-cut', maskUnits: 'userSpaceOnUse', x: '0', y: '0', width: '64', height: '64' },
        el('rect', { width: '64', height: '64', fill: '#fff' }),
        el('path', { d: 'M15.5 34v19M48.5 34v19', ...cut, 'stroke-width': '2.5' }),
        el('path', { d: 'M22 15.5v7.5a5 5 0 0 0 5 5h10a5 5 0 0 0 5-5v-7.5', fill: 'none', ...cut, 'stroke-width': '3' }),
        el('rect', { x: '29', y: '23', width: '6', height: '8', rx: '2', fill: '#000' }),
        el('rect', { x: '22', y: '39', width: '20', height: '20', rx: '4', fill: 'none', ...cut, 'stroke-width': '3' }))),
      el('g', { mask: 'url(#pl-cut)', fill: 'currentColor' },
        el('path', { d: 'M28 13v-2a4 4 0 0 1 8 0v2', fill: 'none', stroke: 'currentColor', 'stroke-width': '4' }),
        el('rect', { x: '10', y: '35', width: '10', height: '17', rx: '3.5' }),
        el('rect', { x: '44', y: '35', width: '10', height: '17', rx: '3.5' }),
        el('rect', { x: '16', y: '12', width: '32', height: '47', rx: '7' })),
      el('rect', { x: '24.5', y: '41.5', width: '15', height: '17.5', rx: '2', fill: '#3fae6e' }));
  }

  function masthead(): HTMLElement {
    const select = h('select', { 'aria-label': 'Project', 'data-key': 'project', onchange: (e: Event) => { state.view = (e.target as HTMLSelectElement).value; state.pushedOutOnly = false; render(); say(`Showing ${state.view === 'global' ? 'all projects' : projectName(state.view)}`); } },
      h('option', { value: 'global', selected: state.view === 'global' }, 'All projects'),
      data.projects.map(p => h('option', { value: p.root, selected: state.view === p.root }, `${p.name} (${plural(p.sessions, 'session')})`)));
    return h('header', { class: 'mast' }, h('div', { class: 'wrap' },
      h('span', { class: 'brand' }, logo(), 'packlight'),
      h('span', { class: 'meta' }, select, h('span', null, AGENT), h('span', null, `scanned ${date(data.createdAt)}`))));
  }

  function tabs(): HTMLElement {
    const picks = Object.keys(state.marks).length;
    const open = data.archived.filter(a => a.status !== 'restored').length;
    const list: [string, string][] = [['items', 'Items'], ['findings', `Findings (${data.findings.length})`], ['picks', `Picks (${picks})`], ['archived', `Archived (${open})`]];
    const nav = h('nav', { class: 'tabs', 'aria-label': 'Sections' }, h('div', { class: 'wrap', role: 'tablist' },
      list.map(([id, label]) => h('button', {
        role: 'tab', id: `tab-${id}`, 'aria-selected': String(state.tab === id), 'aria-controls': 'main', tabindex: state.tab === id ? 0 : -1, 'data-key': `tab-${id}`,
        onclick: () => { state.tab = id; render(); },
        onkeydown: (e: KeyboardEvent) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          const i = list.findIndex(([x]) => x === state.tab);
          state.tab = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length]![0];
          render();
          (document.getElementById(`tab-${state.tab}`) as HTMLElement | null)?.focus();
        },
      }, label))));
    return nav;
  }

  function panel(): Child {
    const body = state.tab === 'findings' ? findingsPanel() : state.tab === 'picks' ? picksPanel() : state.tab === 'archived' ? archivedPanel() : itemsPanel();
    return h('section', { role: 'tabpanel', 'aria-labelledby': `tab-${state.tab}` }, body);
  }

  // ------------------------------------------------------------------ Items
  function banners(): Child[] {
    const out: Child[] = [];
    if (!data.hasLogs) out.push(h('p', { class: 'banner warn' }, `No session logs at ${tildify(data.home)}/.claude/projects. Usage is unknown, not zero, so nothing is suggested for archive.`));
    if (state.carry) {
      const still = Object.keys(state.carry.marks).filter(id => byId.has(id));
      out.push(h('div', { class: 'banner' },
        h('span', null, state.carry.source === 'saved'
          ? `Your saved picks from the ${date(state.carry.scanId.slice(0, 10))} scan hold ${plural(Object.keys(state.carry.marks).length, 'mark')}; ${still.length} still match this scan. Only marks you saved with Save my picks carry over in this browser.`
          : `You marked ${plural(Object.keys(state.carry.marks).length, 'item')} in the ${date(state.carry.scanId.slice(0, 10))} scan. ${still.length} still match this scan.`),
        h('button', { class: 'btn small', 'data-key': 'carry-yes', onclick: () => { for (const id of still) state.marks[id] = state.carry!.marks[id]!; state.carry = null; persist(); render(); say(`Brought over ${plural(still.length, 'mark')}`); } }, 'Bring them over'),
        h('button', { class: 'btn small', 'data-key': 'carry-no', onclick: () => { state.carry = null; persist(); render(); } }, 'Discard')));
    }
    if (state.storage === 'blocked') out.push(h('p', { class: 'banner' }, 'Marks last until you close this page (this browser blocks saved marks).'));
    return out;
  }

  // The top of the report: one headline, one bar, one action. Details live in each kind's section.
  function hero(): Child {
    const context = h('p', { class: 'context' },
      h('span', null, state.view === 'global' ? 'All projects' : projectName(state.view)),
      h('span', null, AGENT),
      h('span', null, `${date(data.window.from)} to ${date(data.window.to)}`),
      h('span', null, plural(data.sessions, 'session')),
      data.linesUnreadable ? h('span', null, `parse gaps: ${plural(data.linesUnreadable, 'line')}`) : null);
    const go = (kind: Kind, pushed = false) => (): void => { state.kind = kind; state.sort = 'cost'; state.suggestedOnly = false; state.pushedOutOnly = pushed; render(); document.querySelector('.kindhead')?.scrollIntoView({ block: 'start' }); };

    // Codex sessions mostly run outside a project, so its all-projects view keeps the measured headline.
    if (state.view === 'global' && !(data.agent === 'codex' && data.sessionLoad)) {
      const top = [...data.projects].sort((a, b) => b.sessions - a.sessions).slice(0, 5);
      return h('div', { class: 'hero' }, context, h('h1', null, 'Pick a project to see what its sessions start with'),
        h('p', { class: 'hero-line' }, top.map(p => h('button', { class: 'btn', 'data-key': `pick-${p.root}`, onclick: () => { state.view = p.root; render(); } }, p.name))));
    }

    // What each session starts with, by source. Measured for the scanned project only.
    const L = state.view === data.scope ? data.sessionLoad : null;
    const b = budget();
    const parts: { key: string; label: string; value: number; kind: Kind; pushed?: boolean; fixed?: boolean }[] = L ? [
      { key: 'mcp', label: 'MCP tool names', value: L.mcpTools, kind: 'mcp' as Kind },
      { key: 'skills', label: 'skill listing', value: L.skillListing, kind: 'skill' as Kind },
      { key: 'hooks', label: 'hook text', value: L.hookStart, kind: 'hook' as Kind },
      { key: 'instr', label: 'MCP instructions', value: L.mcpInstructions, kind: 'mcp' as Kind },
      { key: 'agents', label: 'agent descriptions', value: L.agents, kind: 'agent' as Kind },
      { key: 'agentsmd', label: 'AGENTS.md', value: L.agentsMd ?? 0, kind: 'instructions' as Kind },
      { key: 'plugins', label: 'plugin and app instructions', value: L.pluginInstructions ?? 0, kind: 'plugin' as Kind },
    ].filter(p => p.value > 0).sort((x, y) => y.value - x.value) : [];
    // Codex measures the whole first request; what packlight cannot attribute is Codex's own prompt and tools.
    if (L?.measuredTokens) {
      const rest = L.measuredTokens * 4 - parts.reduce((n, p) => n + p.value, 0);
      if (rest > 0) parts.push({ key: 'base', label: `${AGENT} itself (its prompt and tools)`, value: rest, kind: 'skill' as Kind, fixed: true } as typeof parts[number]);
    }
    const total = parts.reduce((n, p) => n + p.value, 0);
    if (!total) {
      if (!b) return h('div', { class: 'hero' }, context, h('h1', null, `Nothing measured for ${projectName(state.view)} yet`),
        h('p', { class: 'lede' }, `${AGENT} records what a session starts with when it begins. None of the scanned sessions in this project did, so packlight cannot measure it.`));
      const n = b.dropped.length;
      return h('div', { class: 'hero' }, context,
        h('h1', null, n ? `${n} skills pushed out of ${projectName(state.view)}'s skill listing` : `All ${n + b.withDescription.length} skills fit in ${projectName(state.view)}'s listing`),
        n ? h('p', { class: 'hero-line' }, h('button', { class: 'btn', 'data-key': 'review-pushed', onclick: go('skill', true) }, `Show the ${n}`)) : null);
    }
    // What the fix could take off, drawn over the end of the bar (projected).
    const f = data.fix;
    const saved = f.ids.length ? f.sessionCharsSaved : f.byHand?.sessionCharsSaved ?? 0;
    const bar = h('div', { class: 'loadbar', role: 'img', 'aria-label': `Each session starts with about ${tokens(total)} tokens (${chars(total)} characters): ${parts.map(p => `${tokens(p.value)} tokens of ${p.label}`).join(', ')}${saved > 0 ? `. About ${tokens(saved)} tokens could go` : ''}` },
      parts.map(p => h('i', { class: `seg seg-${p.key}`, style: `width:${(p.value / total) * 100}%` })),
      saved > 0 ? h('i', { class: 'save', style: `width:${Math.min(100, (saved / total) * 100)}%` }) : null);
    const legend = h('div', { class: 'legend' }, parts.map(p => (p.fixed
      ? h('span', { class: 'legend-item static' }, h('i', { class: `sw seg-${p.key}`, 'aria-hidden': 'true' }), h('b', { class: 'num' }, tokens(p.value)), ` ${p.label}`)
      : h('button', { class: 'legend-item', 'data-key': `load-${p.key}`, title: `${chars(p.value)} characters`, onclick: go(p.kind, false) },
        h('i', { class: `sw seg-${p.key}`, 'aria-hidden': 'true' }), h('b', { class: 'num' }, tokens(p.value)), ` ${p.label}`))),
      saved > 0 ? h('span', { class: 'legend-item static' }, h('i', { class: 'sw save', 'aria-hidden': 'true' }), h('b', { class: 'num' }, tokens(saved)), ' could go') : null);
    return h('div', { class: 'hero' }, context,
      h('h1', null, `${state.view === 'global' ? `Each ${AGENT} session` : `Each session in ${projectName(state.view)}`} starts with about ${tokens(total)} tokens of setup`),
      bar, legend,
      L?.measuredTokens ? h('p', { class: 'measured' }, `Measured by ${AGENT}: the median first request across ${plural(L.measuredSessions ?? 0, 'session')}, including your first message. The parts are estimated at about 4 characters per token.`) : null,
      fixRow(parts.filter(p => !p.fixed)[0]));
  }

  // The one-click fix (report/fix.ts) as one line; everything else opens below it on demand.
  // Always one clear next step: fix, see what to remove by hand, or look at the biggest cost.
  function fixRow(top?: { label: string; kind: Kind }): Child {
    const f = data.fix;
    if (state.view !== data.scope) return null;
    if (!f.ids.length && !f.byHand?.items.length) {
      const target = top ?? { label: 'your skills', kind: 'skill' as Kind };
      return h('section', { class: 'fix', 'aria-label': 'Fix' },
        h('div', { class: 'fix-row' },
          h('p', null, h('b', null, 'Nothing unused to remove.'), ` Your biggest cost is ${target.label}.`),
          h('button', { class: 'btn primary', 'data-key': 'fix', onclick: () => {
            state.kind = target.kind; state.sort = 'cost'; state.suggestedOnly = false; state.pushedOutOnly = false; render();
            document.querySelector('.kindhead')?.scrollIntoView({ block: 'start' });
          } }, 'See the biggest cost')));
    }
    const hand = f.byHand;
    const total = setupTotal();
    const gains = (back: number, saved: number): string[] => [
      saved > 0 ? `saves about ${tokens(saved)} tokens per session${total ? ` (${share(saved, total)} of your setup)` : ''}` : null,
      back ? `${plural(back, 'skill description')} back` : null,
    ].filter((x): x is string => !!x);
    const exact = (saved: number): Child => (saved > 0 ? h('p', { class: 'muted' }, `Projected: ${chars(saved)} fewer characters per session, about ${tokens(saved)} tokens at roughly 4 characters per token.`) : null);
    const headline = f.ids.length
      ? [h('b', null, `Archive ${plural(f.ids.length, 'unused item')}`), gains(f.descriptionsBack, f.sessionCharsSaved).map(g => ` · ${g}`)]
      : [h('b', null, `${plural(hand!.items.length, 'unused item')} only you can remove`), gains(hand!.descriptionsBack, hand!.sessionCharsSaved).map(g => ` · ${g}`)];
    const kinds = KINDS.filter(([k]) => f.byKind[k]).map(([k, label]) => (f.byKind[k] === 1 ? `1 ${ONE[k]}` : `${f.byKind[k]} ${k === 'mcp' ? label : label.toLowerCase()}`)).join(', ');
    const groups = new Map<string, NonNullable<typeof hand>['items']>();
    for (const i of hand?.items ?? []) groups.set(i.where, [...(groups.get(i.where) ?? []), i]);
    return h('section', { class: 'fix', 'aria-label': 'Fix' },
      h('div', { class: 'fix-row' },
        h('p', null, ...headline, (f.ids.length ? gains(f.descriptionsBack, f.sessionCharsSaved) : gains(hand!.descriptionsBack, hand!.sessionCharsSaved)).length
          ? h('span', { class: 'muted' }, ' (projected)')
          : h('span', { class: 'muted' }, ' · they load nothing in these sessions, so removing them only tidies up')),
        h('button', { class: 'btn primary', 'data-key': 'fix', 'aria-expanded': String(state.fixOpen), onclick: () => { state.fixOpen = !state.fixOpen; render(); } }, f.ids.length ? 'Fix it' : state.fixOpen ? 'Hide the list' : 'Show me what to remove')),
      state.fixOpen ? h('div', { class: 'fix-run', role: 'region', 'aria-label': 'Run the fix' },
        f.ids.length ? [
          h('p', { class: 'muted' }, `${kinds}. None was used since it was installed, over at least ${data.thresholds.sessions} sessions and ${data.thresholds.days} days. Everything can be restored.`),
          exact(f.sessionCharsSaved),
          h('p', null, 'Run this in your terminal. It scans again, shows the plan and asks once before changing anything.'),
          h('div', { class: 'codebox' }, h('code', null, data.messages.fixCommand), h('button', { class: 'btn small', 'data-key': 'copy-fix', onclick: copy(data.messages.fixCommand, 'the fix command') }, 'Copy')),
          h('button', { class: 'linkish', 'data-key': 'fix-review', onclick: () => {
            for (const id of f.ids) state.marks[id] = 'archive';
            persist(); state.tab = 'picks'; render(); say(`Marked ${plural(f.ids.length, 'item')} for archive`);
          } }, 'Review them one by one instead'),
        ] : null,
        hand?.items.length ? h('div', { class: 'byhand' },
          h('p', null, h('b', null, f.ids.length ? `Also unused, but only you can remove: ${plural(hand.items.length, 'item')}` : 'Remove these where they were added'),
            f.ids.length && gains(hand.descriptionsBack, hand.sessionCharsSaved).length ? h('span', { class: 'muted' }, ` (with them: ${gains(hand.descriptionsBack, hand.sessionCharsSaved).join(', ')})`) : null),
          f.ids.length ? null : exact(hand.sessionCharsSaved),
          [...groups].map(([where, list]) => h('p', null, h('b', null, where), ` ${list.map(i => i.kind === 'plugin' ? `${i.name} (${plural(i.turnsOff, 'part')})` : i.name).join(', ')}`))) : null) : null);
  }

  function sinceStrip(): Child {
    const p = data.previous;
    if (!p) return null;
    const archivedSince = data.archived.filter(a => a.archivedAt > p.createdAt && a.status !== 'restored').length;
    const b = budget();
    const predicted = b && p.budgetTimestamp && b.timestamp && b.timestamp <= p.createdAt;
    if (!archivedSince && p.hookStartChars === data.current.hookStartChars && (!b || p.dropped === b.dropped.length)) return null;
    return h('p', { class: 'strip', 'aria-label': 'Since the last scan' },
      h('span', null, `Since the ${date(p.createdAt)} scan:`),
      h('span', null, 'hook chars per session start ', h('b', null, `${chars(p.hookStartChars)} → ${chars(data.current.hookStartChars)}`)),
      b && p.dropped !== null ? h('span', null, 'pushed out ', h('b', null, `${p.dropped} → ${b.dropped.length}`), predicted ? ' predicted' : '') : null,
      archivedSince ? h('span', null, h('b', null, String(archivedSince)), ' items archived') : null);
  }

  function itemsPanel(): Child[] {
    return [...banners(), hero(), sinceStrip(), h('div', { class: 'browse' }, kindNav(), h('div', { class: 'kindpane' }, kindHeader(), filters(), table()))];
  }

  // A sidebar of kinds on wide screens; the same buttons wrap into a row on narrow ones.
  function kindNav(): HTMLElement {
    const items = visibleItems();
    return h('nav', { class: 'kinds', 'aria-label': 'Kinds' }, KINDS.map(([k, label]) => {
      const of = items.filter(i => i.kind === k);
      if (!of.length) return null;
      const sug = of.filter(i => i.suggestion.suggested).length;
      return h('button', { class: 'kind', 'aria-pressed': String(state.kind === k), 'data-key': `kind-${k}`, onclick: () => { state.kind = k; state.pushedOutOnly = false; render(); } },
        h('span', { class: 'kl' }, label), h('span', { class: 'kn num' }, String(of.length)),
        sug ? h('span', { class: 'ks' }, `${sug} suggested`) : null);
    }));
  }

  function kindHeader(): HTMLElement {
    const of = visibleItems().filter(i => i.kind === state.kind);
    const label = KINDS.find(([k]) => k === state.kind)?.[1] ?? '';
    const standing = state.kind === 'plugin' ? 0 : of.reduce((n, i) => n + (i.standingChars || 0), 0);
    const unseen = of.filter(i => !i.usage.total).length;
    const sug = of.filter(i => i.suggestion.suggested).length;
    const pushed = state.kind === 'skill' || state.kind === 'command' ? of.filter(i => listingStatus(i) === 'pushed out').length : 0;
    const toolHooks = state.kind === 'hook' ? of.filter(i => i.enabled && /ToolUse$/.test(i.hook?.event ?? '') && i.usage.hook?.firings) : [];
    const toolHookChars = toolHooks.reduce((n, i) => n + i.usage.hook!.injectedChars / i.usage.hook!.firings, 0);
    const stat = (n: number | string, text: string): HTMLElement => h('span', null, h('b', { class: 'num' }, String(n)), ` ${text}`);
    return h('div', { class: 'kindhead' },
      h('h2', null, label, h('span', { class: 'kc num' }, String(of.length))),
      h('p', { class: 'kinddesc' }, KIND_TEXT[state.kind]),
      h('p', { class: 'kindstats' },
        state.kind === 'skill' && data.agent === 'codex' && data.sessionLoad
          ? stat(`${chars(data.sessionLoad.skillListing)} chars`, 'in the skill listing every session')
          : state.kind === 'skill' && budget()
          ? stat(`${chars(budget()!.listingChars)} chars`, `in the listing every session (full text would be ${chars(standing)})`)
          : standing ? stat(`${chars(standing)} chars`, state.kind === 'instructions' ? 'loaded in their projects' : 'loaded every session') : null,
        state.kind !== 'instructions' && data.hasLogs ? stat(unseen, 'not observed') : null,
        pushed ? h('span', null, h('b', { class: 'num' }, String(pushed)), ' listed by name only (the listing is full) ',
          h('button', { class: 'linkish', 'data-key': 'review-pushed', 'aria-pressed': String(state.pushedOutOnly), onclick: () => { state.pushedOutOnly = !state.pushedOutOnly; state.suggestedOnly = false; render(); say(state.pushedOutOnly ? `Showing ${plural(pushed, 'skill')} listed by name only` : 'Showing all skills'); } }, state.pushedOutOnly ? 'Show all' : `Show the ${pushed}`)) : null,
        toolHookChars ? stat(`${chars(toolHookChars)} chars`, 'added per tool call') : null,
        sug ? stat(sug, 'suggested') : null));
  }

  function filters(): HTMLElement {
    const items = visibleItems();
    const suggested = items.filter(i => i.kind === state.kind && i.suggestion.suggested);
    const sugChip = h('button', { class: 'chip', 'aria-pressed': String(state.suggestedOnly), 'data-key': 'suggested', onclick: () => { state.suggestedOnly = !state.suggestedOnly; render(); } }, `Suggested (${suggested.length})`);
    const pushedChip = state.pushedOutOnly ? h('button', { class: 'chip', 'aria-pressed': 'true', 'data-key': 'pushed', onclick: () => { state.pushedOutOnly = false; render(); } }, 'Pushed out') : null;
    const search = h('input', { class: 'search', type: 'search', placeholder: 'Search names, descriptions', 'aria-label': 'Search names and descriptions', value: state.q, 'data-key': 'search',
      oninput: (e: Event) => { state.q = (e.target as HTMLInputElement).value; render(); } });
    const sort = h('select', { class: 'sortsel', 'aria-label': 'Sort', 'data-key': 'sort', onchange: (e: Event) => { state.sort = (e.target as HTMLSelectElement).value; render(); } },
      [['cost', 'Load, highest first'], ['uses', 'Uses, most first'], ['least', 'Uses, fewest first'], ['name', 'Name, A to Z']].map(([v, l]) => h('option', { value: v, selected: state.sort === v }, l)));
    const shown = rows();
    const total = items.filter(i => i.kind === state.kind).length;
    const active = [state.suggestedOnly, state.pushedOutOnly, state.q !== ''].filter(Boolean).length;
    const tooFew = data.sessions < data.thresholds.sessions;
    return h('div', { class: 'filters' },
      search,
      h('button', { class: 'btn filters-toggle', 'aria-expanded': String(document.body.classList.contains('filters-open')), 'data-key': 'filters-toggle', onclick: () => { document.body.classList.toggle('filters-open'); render(); } }, `Filters (${active})`),
      h('div', { class: 'more chips' }, sugChip, pushedChip, sort),
      h('p', { class: 'countline' },
        h('span', { role: 'status' }, `Showing ${shown.length} of ${total}`),
        active ? h('button', { class: 'linkish', 'data-key': 'clear', onclick: () => { state.suggestedOnly = false; state.pushedOutOnly = false; state.q = ''; render(); } }, 'Clear filters') : null),
      state.suggestedOnly ? h('p', { class: 'countline' },
        h('span', null, tooFew
          ? `Too few sessions to suggest (${data.sessions} of ${data.thresholds.sessions} needed).`
          : `Suggested: not observed in any session since it was installed, over at least ${data.thresholds.sessions} sessions and ${data.thresholds.days} days. Excludes items with shared usage, items only removable by hand, and items you kept.`),
        suggested.length ? h('button', { class: 'btn small', 'data-key': 'mark-all', onclick: () => {
          for (const i of shown.filter(x => x.suggestion.suggested)) state.marks[markTarget(i).id] = 'archive';
          persist(); render(); say(`Marked ${plural(shown.length, 'item')} for archive`);
        } }, `Mark all ${shown.length} shown`) : null) : null);
  }

  function rows(): ReportItem[] {
    const q = state.q.toLowerCase();
    const list = visibleItems().filter(i => i.kind === state.kind
      && (!state.suggestedOnly || i.suggestion.suggested)
      && (!state.pushedOutOnly || listingStatus(i) === 'pushed out')
      && (!q || `${i.name} ${i.description} ${i.source}`.toLowerCase().includes(q)));
    const load = (i: ReportItem) => loadOf(i)?.value ?? 0;
    const sorters: Record<string, (a: ReportItem, b: ReportItem) => number> = {
      cost: (a, b) => load(b) - load(a) || a.name.localeCompare(b.name),
      uses: (a, b) => b.usage.total - a.usage.total || a.name.localeCompare(b.name),
      least: (a, b) => a.usage.total - b.usage.total || load(b) - load(a),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return list.sort(sorters[state.sort] ?? sorters.cost);
  }

  function markControl(i: ReportItem): Child {
    if (!markable(i)) return null;
    if (i.plugin && i.kind !== 'plugin') {
      const p = pluginItem(i.plugin);
      if (!p) return null;
      if (state.marks[p.id] === 'archive') return h('button', { class: 'btn small', 'data-key': `unmark-${i.id}`, onclick: () => { delete state.marks[p.id]; persist(); render(); say(`Unmarked ${p.name}`); } }, 'Unmark plugin');
      return h('button', { class: 'btn small', 'aria-expanded': String(state.confirmPlugin === i.id), 'data-key': `markplugin-${i.id}`, onclick: () => { state.confirmPlugin = state.confirmPlugin === i.id ? null : i.id; render(); } }, 'Mark plugin…');
    }
    if (i.keptAt && state.marks[i.id] !== 'unkeep') {
      return h('button', { class: 'btn small', 'data-key': `unkeep-${i.id}`, onclick: () => { state.marks[i.id] = 'unkeep'; persist(); render(); say(`Clear keep of ${i.name} saved with your picks`); } }, 'Clear keep');
    }
    const m = state.marks[i.id];
    const set = (mark: Mark) => () => {
      if (m === mark) delete state.marks[i.id]; else state.marks[i.id] = mark;
      persist(); render();
      say(m === mark ? `Unmarked ${i.name}` : mark === 'archive' ? `Marked ${i.name} for archive${i.kind === 'plugin' ? `, ${plural(memberCount(i), 'item')}` : ''}` : `Kept ${i.name}`);
    };
    return h('span', { class: 'seg', role: 'group', 'aria-label': `Mark ${i.name}` },
      h('button', { class: 'a', 'aria-pressed': String(m === 'archive'), 'data-key': `a-${i.id}`, onclick: set('archive') }, 'Archive'),
      h('button', { class: 'k', 'aria-pressed': String(m === 'keep'), 'data-key': `k-${i.id}`, onclick: set('keep') }, 'Keep'));
  }
  const memberCount = (p: ReportItem): number => Object.values(p.members ?? {}).reduce((n, x) => n + (x ?? 0), 0);
  const impactText = (p: ReportItem): string => {
    const ONE: Record<string, string> = { skill: 'skill', command: 'command', agent: 'agent', hook: 'hook', plugin: 'plugin', mcp: 'MCP server', instructions: 'instruction file' };
    const MANY: Record<string, string> = { skill: 'skills', command: 'commands', agent: 'agents', hook: 'hooks', plugin: 'plugins', mcp: 'MCP servers', instructions: 'instruction files' };
    const parts = Object.entries(p.members ?? {}).map(([k, n]) => `${n} ${n === 1 ? ONE[k] ?? k : MANY[k] ?? k}`);
    return `Archiving ${p.name} turns off ${plural(memberCount(p), 'item')}: ${parts.join(', ')}.`;
  };

  function table(): Child {
    const list = rows();
    if (!list.length) {
      return h('p', { class: 'banner' }, state.q ? `No items match "${state.q}" in ${KINDS.find(k => k[0] === state.kind)?.[1]}.` : 'Nothing to show with these filters.',
        h('button', { class: 'btn small', 'data-key': 'clear-empty', onclick: () => { state.suggestedOnly = false; state.pushedOutOnly = false; state.q = ''; render(); } }, 'Clear filters'));
    }
    const cols = state.kind === 'hook'
      ? ['Firings', 'Chars per firing', 'p95']
      : state.kind === 'plugin' ? ['Items', 'Last observed', 'Load'] : state.kind === 'mcp' ? ['Last observed', 'Tool calls', 'Load'] : state.kind === 'instructions' ? ['Load'] : ['Last observed', 'Uses', 'Listing', 'Load'];
    const head = h('thead', null, h('tr', null, h('th', null, h('span', { class: 'sr' }, 'Details')), h('th', null, 'Mark'), h('th', { scope: 'col' }, 'Name'), h('th', { scope: 'col', class: 'col-2nd col-source' }, 'Source'), cols.map(c => h('th', { scope: 'col', class: `r col-2nd${c === 'Last observed' && cols.length === 4 ? ' col-last' : ''}` }, c))));
    const cells = (i: ReportItem): Child[] => {
      const ld = loadOf(i);
      const loadCell = h('td', { class: 'r num col-2nd' }, ld ? [`${chars(ld.value)} chars`, h('span', { class: 'unit' }, ld.unit)] : '—');
      const uses = h('td', { class: 'r num col-2nd' }, usageCell(i), i.usage.uncertain && data.hasLogs ? h('span', { class: 'unit' }, 'may be low') : null);
      if (state.kind === 'hook') {
        const u = i.usage.hook;
        return [h('td', { class: 'r num col-2nd' }, u ? String(u.firings) : usageCell(i)), h('td', { class: 'r num col-2nd' }, u && u.firings ? `${chars(u.injectedChars / u.firings)} chars` : '—', u?.injectionShared ? h('span', { class: 'unit' }, 'shared') : null), h('td', { class: 'r num col-2nd' }, u && u.firings ? `${u.p95DurationMs} ms` : '—')];
      }
      if (state.kind === 'plugin') return [h('td', { class: 'r num col-2nd' }, String(memberCount(i))), h('td', { class: 'r col-2nd' }, date(i.usage.lastUsed)), loadCell];
      if (state.kind === 'mcp') return [h('td', { class: 'r col-2nd' }, date(i.usage.lastUsed)), uses, loadCell];
      if (state.kind === 'instructions') return [loadCell];
      const ls = listingStatus(i);
      return [h('td', { class: 'r col-2nd col-last' }, date(i.usage.lastUsed)), uses, h('td', { class: 'r col-2nd' }, ls ? h('span', { class: `tag ${ls === 'pushed out' ? 'red' : ''}` }, ls) : '—'), loadCell];
    };
    const body = h('tbody', null);
    const rowFor = (i: ReportItem): HTMLElement[] => {
      const open = state.open.has(i.id);
      const m = markOf(i);
      const ld = loadOf(i);
      const tags: Child[] = [];
      if (i.plugin && i.kind !== 'plugin') tags.push(h('span', { class: 'tag' }, m === 'archive' ? `archived with ${pluginItem(i.plugin)?.name ?? 'its plugin'}` : `part of ${pluginItem(i.plugin)?.name ?? 'a plugin'}`));
      if (i.suggestion.suggested) tags.push(h('span', { class: 'tag amber' }, 'suggested'));
      if (i.keptAt) tags.push(h('span', { class: 'tag green' }, `kept ${date(i.keptAt)}${i.keptUpdatedSince ? ' · updated since' : ''}`));
      if (i.cameBack) tags.push(h('span', { class: 'tag red' }, 'came back'));
      if (!i.enabled) tags.push(h('span', { class: 'tag' }, 'off'));
      const tr = h('tr', { class: m === 'archive' ? 'marked-archive' : '' },
        h('td', null, h('button', { class: 'disclose', 'aria-expanded': String(open), 'aria-controls': `d-${i.id}`, 'aria-label': `Details for ${i.name}`, 'data-key': `open-${i.id}`, onclick: () => { open ? state.open.delete(i.id) : state.open.add(i.id); render(); } }, svg('M4 2l4 4-4 4'))),
        h('td', null, markControl(i)),
        h('td', { class: 'name' }, h('div', { class: 'nm' }, i.name, tags), h('div', { class: 'sub' }, i.hook ? `${i.hook.event}${i.hook.matcher ? ` (${i.hook.matcher})` : ''} · ${i.source}` : i.source === 'claude.ai connector' && i.description ? `${i.source} · ${i.description}` : i.source),
          h('div', { class: 'narrow-meta' }, `${ld ? `${chars(ld.value)} chars ${ld.unit}` : usageCell(i)} · ${i.usage.lastUsed ? `last observed ${date(i.usage.lastUsed)}` : data.hasLogs ? 'not observed' : 'usage unavailable'}`),
          state.confirmPlugin === i.id && i.plugin ? impactBox(pluginItem(i.plugin)) : null),
        h('td', { class: 'col-2nd col-source muted' }, i.source),
        cells(i));
      const out = [tr];
      if (open) {
        const facts: [string, Child][] = [
          ['Path', i.path ? h('code', null, tildify(i.path)) : 'Only in the app it came from'],
          ['Description', i.description || 'No description.'],
          ...(i.hook ? [['Command', h('code', null, i.hook.command)] as [string, Child]] : []),
          ['Why', reasonText(i) || '—'],
          ['Last observed', date(i.usage.lastUsed)],
          ['Installed', i.firstSeen ? date(i.firstSeen) : 'Unknown'],
          ['Removal', i.removal.method === 'manual' ? `By hand: ${i.removal.where ?? ''}` : i.removal.method],
        ];
        out.push(h('tr', { class: 'detail', id: `d-${i.id}` }, h('td', { colspan: 9 }, h('dl', null, facts.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])))));
      }
      return out;
    };
    // First paint: 50 rows now, the rest in idle time (design DR5).
    list.slice(0, 50).forEach(i => body.append(...rowFor(i)));
    const rest = list.slice(50);
    const tableEl = h('table', { class: 'items' }, head, body);
    if (rest.length) {
      const status = h('p', { class: 'countline', role: 'status' }, `Showing 50 of ${list.length}, loading the rest`);
      const idle = (cb: () => void): void => { const w = window as unknown as { requestIdleCallback?: (f: () => void) => void }; if (w.requestIdleCallback) w.requestIdleCallback(cb); else setTimeout(cb, 16); };
      const step = (): void => {
        rest.splice(0, 100).forEach(i => body.append(...rowFor(i)));
        if (rest.length) idle(step); else status.remove();
      };
      idle(step);
      return [tableEl, status];
    }
    return tableEl;
  }

  function impactBox(p: ReportItem | undefined): Child {
    if (!p) return null;
    return h('div', { class: 'impact', role: 'group', 'aria-label': `Archive ${p.name}` },
      h('span', null, impactText(p)),
      h('button', { class: 'btn small primary', 'data-key': `confirm-plugin-${p.id}`, onclick: () => { state.marks[p.id] = 'archive'; state.confirmPlugin = null; persist(); render(); say(`Marked ${p.name} for archive, ${plural(memberCount(p), 'item')}`); } }, 'Archive plugin'),
      h('button', { class: 'btn small', 'data-key': `cancel-plugin-${p.id}`, onclick: () => { state.confirmPlugin = null; render(); } }, 'Cancel'));
  }

  // ------------------------------------------------------------------ Picks
  function picksJson(): string {
    return JSON.stringify({ scanId: data.scanId, createdAt: new Date().toISOString(), picks: Object.entries(state.marks).map(([id, action]) => ({ id, action, note: '' })) }, null, 1);
  }
  function savePicks(): void {
    const json = picksJson();
    try {
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = h('a', { href: url, download: `packlight-picks-${data.scanId}.json` }) as HTMLAnchorElement;
      document.body.append(a); a.click(); a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      state.saved = true;
      state.downloadFailed = null;
      say(`Picks saved, not applied yet`);
    } catch {
      state.downloadFailed = json;
    }
    render();
  }
  const copy = (text: string, label: string) => (): void => {
    void navigator.clipboard?.writeText(text).then(() => say(`Copied ${label}`), () => say('Copy failed: select the text and copy it yourself'));
  };
  const codebox = (cmd: string, key: string): HTMLElement => h('div', { class: 'codebox' }, h('code', null, cmd), h('button', { class: 'btn small', 'data-key': key, onclick: copy(cmd, 'command') }, 'Copy'));

  function picksPanel(): Child[] {
    const marks = Object.entries(state.marks);
    const toArchive = archived();
    const keeps = marks.filter(([, m]) => m === 'keep').length;
    const unkeeps = marks.filter(([, m]) => m === 'unkeep').length;
    const groups = new Map<string, ReportItem[]>();
    for (const i of toArchive) groups.set(i.removal.method, [...(groups.get(i.removal.method) ?? []), i]);
    const out: Child[] = [h('h1', { class: 'panel-title' }, 'Picks: not applied yet'), ...banners()];
    if (!marks.length) {
      out.push(h('p', { class: 'lede' }, 'Nothing marked yet. In Items, mark the rows you want to archive; they collect here.'),
        h('button', { class: 'btn primary', disabled: true }, 'Save my picks'), h('p', { class: 'muted' }, 'Mark at least one item to save your picks.'));
      return out;
    }
    const b = budget();
    const after = projected(new Set(toArchive.map(i => i.id)));
    const startNow = visibleItems().filter(i => i.kind === 'hook' && i.enabled && i.hook?.event === 'SessionStart' && i.usage.hook?.firings);
    const startAfter = startNow.filter(i => !toArchive.some(t => t.id === markTarget(i).id));
    const per = (l: ReportItem[]) => l.reduce((n, i) => n + i.usage.hook!.injectedChars / i.usage.hook!.firings, 0);
    out.push(h('p', { class: 'strip' }, h('span', null, 'Projected after apply:'),
      b && after !== null ? h('span', null, h('b', null, `${b.dropped.length} → ${after}`), ' skills pushed out') : null,
      h('span', null, h('b', null, `${chars(per(startNow))} → ${chars(per(startAfter))}`), ' chars per session start')));
    for (const [method, list] of groups) {
      out.push(h('div', { class: 'group' }, h('h2', null, `${METHOD_TEXT[method] ?? method} (${list.length})`),
        h('ul', null, list.map(i => h('li', null, i.name, i.kind === 'plugin' ? h('span', { class: 'muted' }, ` (${impactText(i)})`) : null, i.usage.ambiguous ? h('span', { class: 'muted' }, ` · ${usageCell(i)}`) : null)))));
    }
    if (keeps || unkeeps) out.push(h('div', { class: 'group' }, h('h2', null, 'Keep (no change to your setup)'), h('p', { class: 'muted' }, `${plural(keeps, 'item')} to keep${unkeeps ? `, ${plural(unkeeps, 'keep')} to clear` : ''}.`)));
    // A download can be blocked without any error reaching the page, so copying is always offered too.
    out.push(h('p', { class: 'hero-line' },
      h('button', { class: 'btn primary', 'data-key': 'save', onclick: savePicks }, 'Save my picks'),
      h('button', { class: 'btn', 'data-key': 'copy-picks', onclick: () => { copy(picksJson(), 'picks')(); state.saved = true; render(); } }, 'Copy picks')));
    if (state.downloadFailed) {
      out.push(h('div', { class: 'next' }, h('p', null, `Save this as packlight-picks-${data.scanId}.json, then run the command below.`),
        h('textarea', { class: 'picksjson', readonly: true, 'aria-label': 'Picks file contents' }, state.downloadFailed),
        h('button', { class: 'btn small', 'data-key': 'copy-json', onclick: copy(state.downloadFailed, 'picks') }, 'Copy')));
    }
    if (state.saved || state.downloadFailed) {
      out.push(h('div', { class: 'next', role: 'region', 'aria-label': 'Next step' },
        h('p', null, data.messages.picksSaved),
        h('ol', null, h('li', null, data.messages.stepApply, codebox(data.messages.applyCommand, 'copy-apply')), h('li', null, data.messages.stepReport, codebox(data.messages.reportCommand, 'copy-report'))),
        h('p', { class: 'muted' }, data.messages.noFile)));
    }
    return out;
  }

  // ------------------------------------------------------------------ Archived and Findings
  function archivedPanel(): Child[] {
    const open = data.archived.filter(a => a.status === 'archived');
    const waiting = data.archived.filter(a => a.status === 'waiting');
    const out: Child[] = [h('h1', { class: 'panel-title' }, 'Archived by packlight')];
    if (!open.length && !waiting.length) {
      out.push(h('p', { class: 'lede' }, `Nothing archived yet. Items you apply with \`${data.messages.applyCommand}\` appear here, each with its restore command.`));
      return out;
    }
    if (open.length) out.push(codebox(`${data.messages.invoke} restore --all`, 'copy-restore-all'));
    for (const a of [...open].reverse()) {
      const back = data.items.find(i => i.id === a.itemId);
      out.push(h('div', { class: 'group' }, h('h2', null, a.itemName, back ? h('span', { class: 'tag red' }, 'came back') : null),
        h('p', { class: 'muted' }, `${METHOD_TEXT[a.method] ?? a.method} · ${date(a.archivedAt)} · ${tildify(a.where)}`),
        back ? h('p', { class: 'muted' }, `Archived ${date(a.archivedAt)}, reinstalled since (probably by an updater).`) : null,
        codebox(`${data.messages.invoke} restore ${a.opId}`, `copy-${a.opId}`)));
    }
    if (waiting.length) {
      out.push(h('div', { class: 'group' }, h('h2', null, 'Waiting for you'),
        h('ul', null, waiting.map(w => h('li', null, w.itemName, h('span', { class: 'muted' }, ` · ${w.where} ${data.items.some(i => i.id === w.itemId) ? '(still installed)' : '(done)'}`))))));
    }
    return out;
  }

  function findingsPanel(): Child[] {
    const out: Child[] = [h('h1', { class: 'panel-title' }, 'Setup checks')];
    if (!data.findings.length) return [...out, h('p', { class: 'lede' }, 'No setup problems found in this scan.')];
    return [...out, data.findings.map(f => h('div', { class: `finding ${f.level}` }, h('i', { 'aria-hidden': 'true' }), h('h2', null, f.title), h('p', null, f.body)))];
  }

  function picksBar(): HTMLElement {
    const marks = Object.values(state.marks);
    const a = marks.filter(m => m === 'archive').length;
    const k = marks.filter(m => m === 'keep').length;
    return h('div', { class: 'picksbar', hidden: !marks.length || state.tab === 'picks', role: 'region', 'aria-label': 'Picks' },
      h('span', { class: 'count num' }, `${a} to archive${k ? ` · ${k} to keep` : ''}`),
      state.saved ? h('span', { class: 'muted' }, 'Saved, not applied') : null,
      h('button', { class: 'btn primary', 'data-key': 'review-picks', onclick: () => { state.tab = 'picks'; render(); window.scrollTo(0, 0); } }, 'Review picks'));
  }

  document.addEventListener('keydown', e => {
    if (e.key === '/' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
      const s = document.querySelector<HTMLInputElement>('.search');
      if (s) { e.preventDefault(); s.focus(); }
    }
    if (e.key === 'Escape') {
      if (state.confirmPlugin) { const k = `markplugin-${state.confirmPlugin}`; state.confirmPlugin = null; render(); (root.querySelector(`[data-key="${CSS.escape(k)}"]`) as HTMLElement | null)?.focus(); }
      else if (document.body.classList.contains('filters-open')) { document.body.classList.remove('filters-open'); render(); }
    }
  });
  render();
}
