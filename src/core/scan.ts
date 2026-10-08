import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { claudePaths, collectInventory, registeredProjects } from '../adapters/claude-code/inventory.js';
import { compareVersions, scanLogs, type HookFiring, type LogScan, type Use } from '../adapters/claude-code/logs.js';
import { itemId, valueFingerprint } from './hash.js';
import { SCHEMA_VERSION, type BudgetObservation, type Inventory, type Item, type Usage } from './types.js';

export interface ScanOptions {
  home: string;
  /** Working directory the scan runs from; sets projectScope when it is inside a known project. */
  cwd: string;
  now?: Date;
  since?: string;
}

const DAY = 86_400_000;
/** A session with more than this share of unrecognised usage lines makes all usage "uncertain" (eng A2). */
const UNKNOWN_SHARE_LIMIT = 0.01;

const isUnder = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Maps working directories to project roots: Claude Code's own project registry first, then the nearest git root.
 * A folder neither claims belongs to no project, and the home folder is never a project (its .claude is the user's).
 */
export function projectResolver(registered: string[], home: string): (cwd: string) => string | null {
  const roots = registered.filter(r => r !== home).sort((a, b) => b.length - a.length);
  const cache = new Map<string, string | null>();
  return (cwd: string) => {
    const hit = cache.get(cwd);
    if (hit !== undefined) return hit;
    let root: string | null = roots.find(r => isUnder(cwd, r)) ?? null;
    if (!root) {
      for (let d = cwd; d !== home; d = dirname(d)) {
        if (existsSync(join(d, '.git'))) { root = d; break; }
        if (dirname(d) === d) break;
      }
    }
    cache.set(cwd, root);
    return root;
  };
}

function addUse(u: Usage, use: Use, now: number): void {
  u.total++;
  if (use.ts && now - Date.parse(use.ts) < 30 * DAY) u.last30++;
  if (use.ts && (!u.lastUsed || use.ts > u.lastUsed)) u.lastUsed = use.ts;
  const key = use.project ?? 'global';
  const p = (u.byProject[key] ??= { total: 0, lastUsed: null });
  p.total++;
  if (use.ts && (!p.lastUsed || use.ts > p.lastUsed)) p.lastUsed = use.ts;
}

/** Items a use could belong to: global ones plus the ones scoped to the project the use happened in. */
const visibleIn = (items: Item[], project: string | null): Item[] => items.filter(i => i.projectRoot === null || i.projectRoot === project);

function creditUses(index: Map<string, Item[]>, uses: Map<string, Use[]>, now: number, onUnmatched?: (key: string, list: Use[]) => void): void {
  for (const [key, list] of uses) {
    const owners = index.get(key);
    if (!owners) { onUnmatched?.(key, list); continue; }
    for (const use of list) {
      const candidates = visibleIn(owners, use.project);
      // Shared names cannot be split: every candidate gets the use and is marked ambiguous (CEO O2).
      if (candidates.length > 1) for (const c of candidates) c.usage.ambiguous = true;
      for (const c of candidates) addUse(c.usage, use, now);
    }
  }
}

function indexBy(items: Item[], kinds: Item['kind'][]): Map<string, Item[]> {
  const idx = new Map<string, Item[]>();
  for (const it of items) {
    if (!kinds.includes(it.kind)) continue;
    for (const k of it.logKeys) {
      const list = idx.get(k);
      if (list) list.push(it); else idx.set(k, [it]);
    }
  }
  return idx;
}

const INJECTING_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);

function creditHooks(items: Item[], firings: HookFiring[], now: number): void {
  const hooks = items.filter(i => i.kind === 'hook' && i.hook);
  const byKey = new Map<string, Item[]>();
  for (const h of hooks) {
    const k = `${h.hook!.event}\u0000${h.hook!.command}`;
    const list = byKey.get(k);
    if (list) list.push(h); else byKey.set(k, [h]);
  }
  const durations = new Map<Item, number[]>();
  for (const f of firings) {
    const owners = byKey.get(`${f.event}\u0000${f.command}`);
    if (!owners) continue;
    const candidates = visibleIn(owners, f.project);
    if (!candidates.length) continue;
    if (candidates.length > 1) for (const c of candidates) c.usage.ambiguous = true;
    // Text from a linked context line was injected; otherwise only session-start and prompt hooks inject their output.
    const injected = f.linkedChars > 0 ? f.linkedChars : INJECTING_EVENTS.has(f.event) ? f.ownChars : 0;
    for (const c of candidates) {
      addUse(c.usage, { ts: f.ts, project: f.project }, now);
      const h = (c.usage.hook ??= { firings: 0, injectedChars: 0, avgDurationMs: 0, p95DurationMs: 0, injectionShared: false });
      h.firings++;
      h.injectedChars += Math.round(injected / candidates.length);
      if (f.shared) h.injectionShared = true;
      if (f.durationMs !== null) {
        const d = durations.get(c);
        if (d) d.push(f.durationMs); else durations.set(c, [f.durationMs]);
      }
    }
  }
  for (const [item, ds] of durations) {
    ds.sort((a, b) => a - b);
    item.usage.hook!.avgDurationMs = Math.round(ds.reduce((a, b) => a + b, 0) / ds.length);
    item.usage.hook!.p95DurationMs = ds[Math.min(ds.length - 1, Math.ceil(ds.length * 0.95) - 1)] ?? 0;
  }
}

/** A plugin's usage is its parts' usage. */
function rollUpPlugins(items: Item[]): void {
  for (const p of items.filter(i => i.kind === 'plugin')) {
    for (const c of items.filter(i => i.plugin === p.plugin && i.kind !== 'plugin')) {
      p.usage.total += c.usage.total;
      p.usage.last30 += c.usage.last30;
      if (c.usage.lastUsed && (!p.usage.lastUsed || c.usage.lastUsed > p.usage.lastUsed)) p.usage.lastUsed = c.usage.lastUsed;
      for (const [proj, v] of Object.entries(c.usage.byProject)) {
        const t = (p.usage.byProject[proj] ??= { total: 0, lastUsed: null });
        t.total += v.total;
        if (v.lastUsed && (!t.lastUsed || v.lastUsed > t.lastUsed)) t.lastUsed = v.lastUsed;
      }
    }
  }
}

function coverage(logs: LogScan): Inventory['coverage'] {
  const reasons: string[] = [];
  const over = logs.sessions.filter(s => s.lines > 0 && s.unknownShapeLines / s.lines > UNKNOWN_SHARE_LIMIT);
  if (over.length) reasons.push(`${over.length} session(s) have more than 1% unrecognised usage lines`);
  const newest = logs.versions[logs.versions.length - 1];
  if (newest && (logs.unknownByVersion[newest] ?? 0) > 0) reasons.push(`Claude Code ${newest} wrote ${logs.unknownByVersion[newest]} unrecognised usage line(s)`);
  if (!logs.sessions.length) reasons.push('no session logs found');
  return { uncertain: reasons.length > 0, reasons };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function scan(opts: ScanOptions): Promise<Inventory> {
  const now = opts.now ?? new Date();
  const paths = claudePaths(opts.home);
  const registered = registeredProjects(paths);
  const projectOf = projectResolver(registered, opts.home);
  const logs = await scanLogs(paths.projectsLogDir, { projectOf, since: opts.since });

  const sessionsByRoot = new Map<string, number>();
  for (const s of logs.sessions) if (s.projectRoot) sessionsByRoot.set(s.projectRoot, (sessionsByRoot.get(s.projectRoot) ?? 0) + 1);
  const roots = [...new Set([...registered, ...sessionsByRoot.keys()])].filter(r => r !== opts.home).sort();
  const existing = roots.filter(r => existsSync(r));

  const items = collectInventory(paths, existing);
  const t = now.getTime();
  creditUses(indexBy(items, ['skill', 'command']), logs.skillUses, t);
  creditUses(indexBy(items, ['agent']), logs.agentUses, t);
  creditUses(indexBy(items, ['mcp']), logs.mcpUses, t, (key, list) => {
    // claude.ai connectors appear only as opaque ids in the logs; they are listed, and removable only on claude.ai.
    if (!UUID.test(key)) return;
    const it: Item = {
      id: itemId({ agent: 'claude-code', kind: 'mcp', source: 'claude.ai connector', name: key, path: null }),
      agent: 'claude-code', kind: 'mcp', name: key, source: 'claude.ai connector', path: null, projectRoot: null, enabled: true,
      description: '', descHash: '', standingChars: 0, targetFingerprint: valueFingerprint(key), firstSeen: null, firstSeenSource: null,
      logKeys: [key], declarations: [], removal: { method: 'manual', where: 'claude.ai › Settings › Connectors' },
      usage: { total: 0, last30: 0, lastUsed: null, byProject: {}, ambiguous: false, uncertain: false },
    };
    for (const use of list) addUse(it.usage, use, t);
    items.push(it);
  });
  creditHooks(items, logs.hookFirings, t);
  rollUpPlugins(items);

  const cov = coverage(logs);
  if (cov.uncertain) for (const it of items) it.usage.uncertain = true;

  // Ids must be unique; a collision means two declarations hash alike and packlight cannot act safely (eng A1).
  const seen = new Map<string, Item>();
  for (const it of items) {
    const prev = seen.get(it.id);
    if (prev) throw new Error(`Two items share the id ${it.id}: ${prev.path ?? prev.name} and ${it.path ?? it.name}`);
    seen.set(it.id, it);
  }

  const budget: Record<string, BudgetObservation> = {};
  for (const l of logs.listings) budget[l.projectRoot ?? 'global'] = l;

  const starts = logs.sessions.map(s => s.start).filter((x): x is string => !!x).sort();
  const scope = projectOf(opts.cwd);
  return {
    schemaVersion: SCHEMA_VERSION,
    scanId: now.toISOString().replace(/[:.]/g, '-'),
    agent: 'claude-code',
    createdAt: now.toISOString(),
    home: opts.home,
    projectScope: scope && roots.includes(scope) ? scope : 'global',
    window: { from: opts.since ?? starts[0] ?? null, to: now.toISOString() },
    sessionsInWindow: logs.sessions.filter(s => s.start).length,
    linesTotal: logs.linesTotal,
    linesUnknownShape: logs.linesUnknownShape,
    linesUnreadable: logs.linesUnreadable,
    claudeCodeVersions: logs.versions.sort(compareVersions),
    coverage: cov,
    projects: roots.map(root => ({ root, sessions: sessionsByRoot.get(root) ?? 0, exists: existing.includes(root) })),
    sessions: logs.sessions,
    budget,
    unattributedHookChars: Math.round(logs.unattributedHookChars),
    items,
  };
}
