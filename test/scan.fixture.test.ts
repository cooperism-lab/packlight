import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scan } from '../src/core/scan.js';
import type { Inventory, Item } from '../src/core/types.js';
import { buildHome, EXPECTED_COUNTS, EXPECTED_SKILLS_BY_SOURCE, EXPECTED_USAGE, FIXTURE_TIME, type FixtureHome } from './fixtures/home.js';

let dir: string;
let fx: FixtureHome;
let inv: Inventory;

const find = (kind: Item['kind'], name: string, source: string): Item => {
  const it = inv.items.find(i => i.kind === kind && i.name === name && i.source === source);
  if (!it) throw new Error(`missing ${kind} ${name} (${source})`);
  return it;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'packlight-'));
  fx = buildHome(dir);
  inv = await scan({ home: fx.home, cwd: fx.project, now: FIXTURE_TIME });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('inventory on the fixture home (criterion 1)', () => {
  it('finds exactly the hand-counted items by kind', () => {
    const counts: Record<string, number> = {};
    for (const i of inv.items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    expect(counts).toEqual(EXPECTED_COUNTS);
  });

  it('charges each MCP server its tool names and instructions from the session tool list', () => {
    const mcp = (name: string) => inv.items.filter(i => i.kind === 'mcp' && i.name === name);
    const line = (n: string) => n.length + 1;
    expect(mcp('localdb').map(i => i.standingChars)).toEqual([line('mcp__localdb__query') + line('mcp__localdb__write')]);
    expect(mcp('github').every(i => i.standingChars === line('mcp__github__issue') + '## github\nUse the issue tool for bugs.'.length)).toBe(true);
    expect(mcp('kitdb')[0]!.standingChars).toBe(line('mcp__plugin_kit_kitdb__get'));
    const connector = mcp('0a1b2c3d-0000-4000-8000-000000000001')[0]!;
    expect(connector).toMatchObject({ source: 'claude.ai connector', description: 'Tools: search_flows', usage: expect.objectContaining({ total: 0 }), removal: { method: 'manual', where: 'claude.ai › Settings › Connectors' } });
    const tl = Object.values(inv.toolListing ?? {})[0]!;
    expect(tl.builtIn).toEqual({ tools: 1, chars: line('WebFetch') });
  });

  it('finds skills by source', () => {
    const bySource: Record<string, number> = {};
    for (const i of inv.items.filter(i => i.kind === 'skill')) bySource[i.source] = (bySource[i.source] ?? 0) + 1;
    expect(bySource).toEqual(EXPECTED_SKILLS_BY_SOURCE);
  });

  it('scopes the scan to the project it ran in', () => {
    expect(inv.projectScope).toBe(fx.project);
    expect(inv.projects.map(p => p.root)).toEqual([fx.project]);
  });

  it('records every declaration of a plugin and its effective state', () => {
    const tools = find('plugin', 'tools', 'marketplace:market');
    expect(tools.enabled).toBe(false);
    expect(tools.declarations).toEqual([expect.objectContaining({ scope: 'user', pointer: '/enabledPlugins/tools@market', enabled: false })]);
    expect(find('skill', 'tools:tool-x', 'plugin:tools').standingChars).toBe(0);
    expect(find('plugin', 'kit', 'marketplace:market').members).toEqual({ skill: 2, command: 1, agent: 1, hook: 1, mcp: 1 });
  });

  it('gives plugin children the plugin as their removal unit', () => {
    const child = find('skill', 'kit:kit-a', 'plugin:kit');
    expect(child.removal).toEqual({ method: 'plugin-disable', where: 'kit@market' });
    expect(child.firstSeen).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('usage on the fixture logs (criterion 2)', () => {
  it('matches the hand-counted uses for every item', () => {
    const actual: Record<string, number> = {};
    for (const key of Object.keys(EXPECTED_USAGE)) {
      const [kind, name, ...source] = key.split(' ');
      actual[key] = find(kind as Item['kind'], name!, source.join(' ')).usage.total;
    }
    expect(actual).toEqual(EXPECTED_USAGE);
  });

  it('counts sessions, not subagent transcripts', () => {
    expect(inv.sessionsInWindow).toBe(2);
  });

  it('attributes lines without a cwd to the project of the line before (eng A3)', () => {
    expect(find('skill', 'beta', 'personal').usage.byProject).toEqual({ [fx.project]: { total: 1, lastUsed: '2026-09-28T10:08:00Z' } });
  });

  it('marks both items that share a name as ambiguous (CEO O2)', () => {
    expect(find('skill', 'learn', 'personal').usage.ambiguous).toBe(true);
    expect(find('skill', 'learn', 'project:proj').usage.ambiguous).toBe(true);
    expect(find('skill', 'alpha', 'personal').usage.ambiguous).toBe(false);
  });

  it('counts the last 30 days from the scan time', () => {
    expect(find('skill', 'alpha', 'personal').usage.last30).toBe(1);
  });

  it('rolls plugin usage up from its parts', () => {
    expect(find('plugin', 'kit', 'marketplace:market').usage.total).toBe(3);
  });

  it('does not flag usage as uncertain for an unknown line that carries no usage evidence', () => {
    expect(inv.linesUnknownShape).toBe(1);
    expect(inv.coverage.uncertain).toBe(false);
  });
});

describe('hook attribution by command (criterion 3)', () => {
  it('never merges two hooks on the same event', () => {
    const sessionStart = inv.items.filter(i => i.kind === 'hook' && i.hook?.event === 'SessionStart');
    expect(sessionStart.map(h => h.hook!.command).sort()).toEqual(['/usr/local/bin/notes.sh', 'node "${CLAUDE_PLUGIN_ROOT}/hooks/start.mjs"']);
    expect(sessionStart.find(h => h.plugin)!.usage.hook).toMatchObject({ firings: 1, injectedChars: 11 });
    expect(sessionStart.find(h => !h.plugin)!.usage.total).toBe(0);
  });

  it('splits a firing shared by two declarations of one command and marks both ambiguous', () => {
    const guards = inv.items.filter(i => i.kind === 'hook' && i.hook?.command === '/usr/local/bin/guard.sh check');
    expect(guards).toHaveLength(2);
    for (const g of guards) {
      expect(g.usage.ambiguous).toBe(true);
      expect(g.usage.hook).toMatchObject({ firings: 1, injectedChars: 5, avgDurationMs: 12, p95DurationMs: 12 });
    }
  });

  it('gives identical hook declarations in different files distinct ids (eng X5)', () => {
    const ids = inv.items.filter(i => i.kind === 'hook' && i.hook?.command === '/usr/local/bin/guard.sh check').map(i => i.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('skill listing budget (eng X8)', () => {
  it('reads which skills lost their description from the logged listing', () => {
    expect(inv.budget[fx.project]).toMatchObject({ skillCount: 3, withDescription: ['alpha', 'kit:kit-a'], dropped: ['beta'], sessionId: 'session-1' });
  });
});

describe('stability', () => {
  it('produces the same ids on a second scan', async () => {
    const again = await scan({ home: fx.home, cwd: fx.project, now: FIXTURE_TIME });
    expect(again.items.map(i => i.id).sort()).toEqual(inv.items.map(i => i.id).sort());
  });
});
