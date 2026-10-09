import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readKeeps, findPicksFile, parsePicks } from '../archive/apply.js';
import { listManifests } from '../archive/journal.js';
import { downloadsDir, readScan, type PacklightPaths } from '../archive/paths.js';
import { MESSAGES, APPLY_COMMAND, FIX_COMMAND, INVOKE, PASTE_COMMAND, REPORT_COMMAND } from '../core/messages.js';
import type { Inventory, Item } from '../core/types.js';
import { fixPlan, newestBudget, type FixPlan } from './fix.js';
import { MIN_DAYS, MIN_SESSIONS, suggestions, type Suggestion } from './suggest.js';

export interface ReportItem extends Omit<Item, 'declarations' | 'descHash' | 'targetFingerprint' | 'logKeys'> {
  logKeys: string[];
  suggestion: Suggestion;
  keptAt?: string;
  /** Kept, but its files changed since (design-delta D2 correction). */
  keptUpdatedSince?: boolean;
  /** Archived by packlight and installed again since (doctor check 8). */
  cameBack?: string;
}

export interface Finding { level: 'high' | 'medium' | 'good'; title: string; body: string }

export interface ReportData {
  version: 1;
  scanId: string;
  createdAt: string;
  agent: string;
  scope: string;
  home: string;
  window: Inventory['window'];
  sessions: number;
  linesUnreadable: number;
  coverage: Inventory['coverage'];
  hasLogs: boolean;
  projects: { root: string; name: string; sessions: number }[];
  items: ReportItem[];
  budget: Inventory['budget'];
  listingPriority: string[];
  /** What the scope's newest session started with, by source (characters). */
  sessionLoad: { skillListing: number; mcpTools: number; mcpToolCount: number; mcpInstructions: number; hookStart: number; observedAt: string | null } | null;
  /** The one-click fix: every suggested item, and what archiving them buys. */
  fix: FixPlan;
  thresholds: { sessions: number; days: number };
  previous?: { scanId: string; createdAt: string; hookStartChars: number; dropped: number | null; budgetTimestamp: string | null };
  current: { hookStartChars: number };
  archived: { opId: string; itemId: string; itemName: string; kind: string; method: string; status: string; archivedAt: string; where: string }[];
  /** Marks from the newest picks file saved for the previous scan (design-delta DE4 reopened). */
  savedPicks?: { scanId: string; file: string; marks: Record<string, 'archive' | 'keep'> };
  findings: Finding[];
  messages: typeof MESSAGES & { applyCommand: string; reportCommand: string; pasteCommand: string; fixCommand: string; invoke: string };
}

/** Characters hooks add at each session start: the sum of each start hook's average injection. */
export function hookStartChars(inv: Inventory): number {
  return Math.round(inv.items
    .filter(i => i.kind === 'hook' && i.enabled && i.hook?.event === 'SessionStart' && i.usage.hook && i.usage.hook.firings > 0)
    .reduce((n, i) => n + i.usage.hook!.injectedChars / i.usage.hook!.firings, 0));
}

function sessionLoad(inv: Inventory): ReportData['sessionLoad'] {
  const tl = inv.toolListing?.[inv.projectScope] ?? Object.values(inv.toolListing ?? {}).sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '')).at(-1);
  const b = newestBudget(inv);
  if (!tl && !b) return null;
  const servers = Object.values(tl?.servers ?? {});
  return {
    skillListing: b?.listingChars ?? 0,
    mcpTools: servers.reduce((n, s) => n + s.chars, 0),
    mcpToolCount: servers.reduce((n, s) => n + s.tools, 0),
    mcpInstructions: servers.reduce((n, s) => n + s.instructionChars, 0),
    hookStart: hookStartChars(inv),
    observedAt: tl?.timestamp ?? b?.timestamp ?? null,
  };
}

function previousScan(paths: PacklightPaths, inv: Inventory): Inventory | undefined {
  let ids: string[];
  try { ids = readdirSync(paths.scans).filter(id => id < inv.scanId).sort().reverse(); } catch { return undefined; }
  for (const id of ids) {
    const s = readScan(paths, id);
    if (s && s.agent === inv.agent && s.projectScope === inv.projectScope) return s;
  }
  return undefined;
}


function findings(inv: Inventory, items: ReportItem[]): Finding[] {
  const out: Finding[] = [];
  const settings = (() => { try { return JSON.parse(readFileSync(join(inv.home, '.claude', 'settings.json'), 'utf8')); } catch { return {}; } })();
  if (typeof settings.model === 'string' && /sonnet|haiku/i.test(settings.model)) {
    out.push({ level: 'high', title: `Your default model is set to "${settings.model}"`, body: 'Every new session starts on a smaller model unless you pick another one. Remove "model" from ~/.claude/settings.json, or set it to the model you mean.' });
  }
  const perSession = (i: ReportItem) => (inv.sessionsInWindow ? i.usage.total / inv.sessionsInWindow : 0);
  // Heavy servers barely used: their tool list loads every session whether or not a tool is called.
  const heavy = items.filter(i => i.kind === 'mcp' && i.standingChars >= 2000 && i.usage.total > 0 && i.usage.total <= Math.max(2, inv.sessionsInWindow / 50))
    .sort((a, b) => b.standingChars - a.standingChars);
  if (heavy.length && inv.sessionsInWindow) {
    const name = (i: ReportItem) => (i.source === 'claude.ai connector' && i.description ? `${i.name.slice(0, 8)}… (${i.description})` : i.name);
    out.push({ level: 'medium', title: `${heavy.length} MCP server${heavy.length === 1 ? ' loads' : 's load'} a lot every session and ${heavy.length === 1 ? 'is' : 'are'} rarely called`,
      body: heavy.map(i => `${name(i)}: ${(i.standingChars / 1000).toFixed(1)}k chars every session, called ${i.usage.total === 1 ? 'once' : `${i.usage.total} times`} in ${inv.sessionsInWindow} sessions.`).join(' ') + ' Turn one off where you added it and back on when you need it.' });
  }
  for (const h of items.filter(i => i.kind === 'hook' && i.usage.hook && i.usage.hook.firings > 0)) {
    const u = h.usage.hook!;
    const per = u.injectedChars / u.firings;
    if (h.hook?.event === 'SessionStart' && per > 5000) out.push({ level: 'high', title: `${h.name} adds ${Math.round(per / 100) / 10}k characters at every session start`, body: `It fired ${u.firings} times in this scan. That text sits in the context of every session.` });
    if (perSession(h) > 50) out.push({ level: 'medium', title: `${h.name} fires about ${Math.round(perSession(h))} times per session`, body: `Each firing adds about ${Math.round(per)} characters and takes ${u.avgDurationMs} ms on average.` });
    if (u.p95DurationMs > 1000) out.push({ level: 'medium', title: `${h.name} is slow`, body: `One in twenty runs takes ${(u.p95DurationMs / 1000).toFixed(1)} s or longer.` });
  }
  const off = items.filter(i => i.kind === 'plugin' && !i.enabled && i.path);
  if (off.length) out.push({ level: 'medium', title: `${off.length} plugin${off.length === 1 ? ' is' : 's are'} turned off but still installed`, body: `${off.map(p => p.name).join(', ')}. They load nothing, but stay in the plugin cache.` });
  const broken: string[] = [];
  const skillsDir = join(inv.home, '.claude', 'skills');
  try {
    for (const name of readdirSync(skillsDir)) {
      const p = join(skillsDir, name);
      if (lstatSync(p).isSymbolicLink()) { try { statSync(p); } catch { broken.push(name); } }
    }
  } catch { /* no skills folder */ }
  if (broken.length) out.push({ level: 'medium', title: `${broken.length} skill link${broken.length === 1 ? ' points' : 's point'} nowhere`, body: `${broken.join(', ')} in ~/.claude/skills ${broken.length === 1 ? 'is a link' : 'are links'} to a folder that no longer exists.` });
  const shared = items.filter(i => i.usage.ambiguous);
  if (shared.length) out.push({ level: 'medium', title: `${shared.length} items share a name or command with another item`, body: 'Their usage cannot be told apart, so packlight never suggests them. Compare them in the Items tab.' });
  const mcpNames = new Map<string, number>();
  for (const m of items.filter(i => i.kind === 'mcp' && !i.plugin)) mcpNames.set(m.name, (mcpNames.get(m.name) ?? 0) + 1);
  const twice = [...mcpNames].filter(([, n]) => n > 1).map(([n]) => n);
  if (twice.length) out.push({ level: 'medium', title: `${twice.length} MCP server${twice.length === 1 ? ' is' : 's are'} configured more than once`, body: twice.join(', ') });
  const back = items.filter(i => i.cameBack);
  if (back.length) out.push({ level: 'medium', title: `${back.length} archived item${back.length === 1 ? ' came' : 's came'} back`, body: `${back.map(i => i.name).join(', ')}: archived by packlight and installed again since, probably by an updater.` });
  if (inv.coverage.uncertain) out.push({ level: 'high', title: 'Usage may be incomplete', body: `${inv.coverage.reasons.join('; ')}. Nothing is suggested from usage until packlight can read these logs.` });
  return out;
}

export function buildReport(inv: Inventory, paths: PacklightPaths): ReportData {
  const keeps = readKeeps(paths).keeps;
  const sug = suggestions(inv, new Set(Object.keys(keeps)));
  const manifests = listManifests(paths);
  const openArchives = new Map(manifests.filter(m => m.status === 'archived').map(m => [m.itemId, m]));

  const items: ReportItem[] = inv.items.map(({ declarations, descHash, targetFingerprint, ...rest }) => {
    const k = keeps[rest.id];
    const m = openArchives.get(rest.id);
    return {
      ...rest,
      suggestion: sug.get(rest.id)!,
      ...(k ? { keptAt: k.keptAt, keptUpdatedSince: k.fingerprintAtKeep !== targetFingerprint } : {}),
      ...(m && m.method !== 'manual' ? { cameBack: m.archivedAt } : {}),
    };
  });

  const prev = previousScan(paths, inv);
  const prevBudget = prev ? newestBudget(prev) : undefined;

  let savedPicks: ReportData['savedPicks'];
  if (prev) {
    const file = findPicksFile(downloadsDir(inv.home));
    if (file) {
      try {
        const p = parsePicks(readFileSync(file, 'utf8'));
        if (p.scanId === prev.scanId) {
          const marks: Record<string, 'archive' | 'keep'> = {};
          for (const x of p.picks) if (x.action === 'archive' || x.action === 'keep') marks[x.id] = x.action;
          savedPicks = { scanId: p.scanId, file: basename(file), marks };
        }
      } catch { /* not a picks file packlight can read */ }
    }
  }

  return {
    version: 1,
    scanId: inv.scanId,
    createdAt: inv.createdAt,
    agent: inv.agent,
    scope: inv.projectScope,
    home: inv.home,
    window: inv.window,
    sessions: inv.sessionsInWindow,
    linesUnreadable: inv.linesUnreadable,
    coverage: inv.coverage,
    hasLogs: inv.sessions.length > 0,
    projects: inv.projects.filter(p => p.exists).map(p => ({ root: p.root, name: basename(p.root), sessions: p.sessions })),
    items,
    budget: inv.budget,
    listingPriority: inv.listingPriority ?? [],
    fix: fixPlan(inv, sug, new Set(Object.keys(keeps))),
    sessionLoad: sessionLoad(inv),
    thresholds: { sessions: MIN_SESSIONS, days: MIN_DAYS },
    ...(prev ? { previous: { scanId: prev.scanId, createdAt: prev.createdAt, hookStartChars: hookStartChars(prev), dropped: prevBudget?.dropped.length ?? null, budgetTimestamp: prevBudget?.timestamp ?? null } } : {}),
    current: { hookStartChars: hookStartChars(inv) },
    archived: manifests.map(m => ({
      opId: m.opId, itemId: m.itemId, itemName: m.itemName, kind: m.kind, method: m.method, status: m.status, archivedAt: m.archivedAt,
      where: m.originalPath ?? (m.settingsFile ? `${m.settingsFile} ${m.jsonPointer}` : m.manualSteps ?? ''),
    })),
    ...(savedPicks ? { savedPicks } : {}),
    findings: findings(inv, items),
    messages: { ...MESSAGES, applyCommand: APPLY_COMMAND, reportCommand: REPORT_COMMAND, pasteCommand: PASTE_COMMAND, fixCommand: FIX_COMMAND, invoke: INVOKE },
  };
}
