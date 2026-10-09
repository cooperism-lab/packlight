import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpServersIn, skillsIn } from '../src/adapters/codex/logs.js';
import { headerKeys, readToml } from '../src/adapters/codex/toml.js';
import { apply } from '../src/archive/apply.js';
import { restore } from '../src/archive/restore.js';
import { scanCodex } from '../src/core/scan.js';
import type { Inventory, Item } from '../src/core/types.js';
import { fixPlan } from '../src/report/fix.js';
import { buildReport, sessionLoad } from '../src/report/model.js';
import { packlightPaths } from '../src/archive/paths.js';
import { suggestions } from '../src/report/suggest.js';
import { buildCodexHome, CODEX_EXPECTED } from './fixtures/codex-home.js';
import { snapshot, writePicks } from './helpers.js';

const NOW = new Date('2026-10-01T12:00:00Z');
let dir: string;
let home: string;
let project: string;
let inv: Inventory;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'packlight-codex-'));
  ({ home, project } = buildCodexHome(dir, NOW.getTime()));
  inv = await scanCodex({ home, cwd: project, now: NOW });
  // Install dates come from file birth times, which only macOS lets a test move back; set them on the scan instead.
  for (const i of inv.items) i.firstSeen = new Date(NOW.getTime() - 60 * 86_400_000).toISOString();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const find = (kind: Item['kind'], name: string): Item => {
  const it = inv.items.find(i => i.kind === kind && i.name === name);
  if (!it) throw new Error(`missing ${kind} ${name}`);
  return it;
};

describe('config.toml reader', () => {
  it('reads quoted and dotted table headers and simple values', () => {
    expect(headerKeys('plugins."pdf@openai-primary-runtime"')).toEqual(['plugins', 'pdf@openai-primary-runtime']);
    expect(headerKeys('mcp_servers.node_repl.env')).toEqual(['mcp_servers', 'node_repl', 'env']);
    const t = readToml('a = 1\n[x."y z"]\nenabled = false # off\nargs = ["a", "b"]\nname = "q"\n');
    expect(t[0]!.values).toEqual({ a: 1 });
    expect(t[1]).toMatchObject({ path: ['x', 'y z'], values: { enabled: false, args: ['a', 'b'], name: 'q' } });
  });
});

describe('Codex log signals', () => {
  it('finds skills by the SKILL.md a tool call opened, plugin skills as plugin:skill', () => {
    expect(skillsIn('sed -n 1,9p /Users/a/.codex/skills/release-notes/SKILL.md')).toEqual(['release-notes']);
    expect(skillsIn('cat /Users/a/.codex/skills/.system/imagegen/SKILL.md')).toEqual(['imagegen']);
    expect(skillsIn('cat /Users/a/.codex/plugins/cache/m/pdf/26.1/skills/pdf/SKILL.md')).toEqual(['pdf:pdf']);
    expect(skillsIn('cat README.md')).toEqual([]);
    // Windows, inside JSON-encoded arguments.
    expect(skillsIn(JSON.stringify({ cmd: 'type C:\\Users\\a\\.codex\\skills\\release-notes\\SKILL.md' }))).toEqual(['release-notes']);
    expect(skillsIn('C:\\Users\\a\\.codex\\plugins\\cache\\m\\pdf\\1\\skills\\pdf\\SKILL.md')).toEqual(['pdf:pdf']);
  });

  it('finds MCP servers by tool name or a code-mode call', () => {
    expect(mcpServersIn('mcp__github__list_issues', '')).toEqual(['github']);
    expect(mcpServersIn('exec', 'await tools.mcp__node_repl__js({}); tools.web__run()')).toEqual(['node_repl']);
  });
});

describe('Codex inventory on the fixture home', () => {
  it('finds exactly the hand-counted items by kind', () => {
    const counts: Record<string, number> = {};
    for (const i of inv.items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    expect(counts).toEqual(CODEX_EXPECTED);
    expect(inv.agent).toBe('codex');
    expect(inv.projectScope).toBe(project);
  });

  it('reads on and off from config.toml, and never offers built-in skills', () => {
    expect(find('plugin', 'slides')).toMatchObject({ enabled: false, removal: { method: 'manual', where: expect.stringContaining('[plugins."slides@market"]') } });
    expect(find('mcp', 'old db').enabled).toBe(false);
    expect(find('mcp', 'github')).toMatchObject({ enabled: true, removal: { where: expect.stringContaining('[mcp_servers.github]: set enabled = false') } });
    expect(find('skill', 'imagegen').removal).toMatchObject({ method: 'manual', suite: true });
    expect(find('skill', 'release-notes').removal).toEqual({ method: 'move' });
  });

  it('counts uses from SKILL.md reads and MCP calls, and rolls plugin skills up', () => {
    expect(find('skill', 'release-notes').usage.total).toBe(8);
    expect(find('mcp', 'github').usage.total).toBe(5);
    expect(find('skill', 'docs:docs').usage.total).toBe(1);
    expect(find('plugin', 'docs').usage.total).toBe(1);
    expect(find('skill', 'old-helper').usage.total).toBe(0);
  });

  it('charges no skill when sessions started with an empty listing', async () => {
    const { readdirSync, readFileSync, writeFileSync: write } = await import('node:fs');
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(join(home, '.codex', 'sessions'))) write(f, readFileSync(f, 'utf8').replace(/"host_skills":\{"body":"[^"]*"\}/, '"host_skills":{"body":""}'));
    const empty = await scanCodex({ home, cwd: project, now: NOW });
    expect(empty.codexStart!.listedSkills).toEqual([]);
    expect(empty.items.filter(i => i.kind === 'skill').every(i => i.standingChars === 0)).toBe(true);
  });

  it('charges only listed skills, and takes the median measured first request', () => {
    expect(find('skill', 'slides:slides').standingChars).toBe(0);
    expect(find('skill', 'old-helper').standingChars).toBeGreaterThan(0);
    expect(inv.codexStart).toMatchObject({ skillListingChars: expect.any(Number), agentsMdChars: 'Be brief.\n'.length });
    expect(inv.codexStart!.firstRequestTokens).toHaveLength(22);
    // Only each session's first token count counts (20,000 + 100 × i), never a later turn.
    expect(sessionLoad(inv)).toMatchObject({ measuredTokens: 21_100, measuredSessions: 22 });
  });

  it('suggests unused personal skills and prompts; unused plugins and servers are by hand', () => {
    const sug = suggestions(inv, new Set());
    expect(sug.get(find('skill', 'old-helper').id)!.suggested).toBe(true);
    expect(sug.get(find('command', 'ship').id)!.suggested).toBe(true);
    expect(sug.get(find('skill', 'imagegen').id)!.suggested).toBe(false);
    const plan = fixPlan(inv, sug);
    expect(plan.ids.sort()).toEqual([find('skill', 'old-helper').id, find('command', 'ship').id].sort());
    // Uncapped listing: the archived skill's whole line comes out of every session.
    expect(plan.sessionCharsSaved).toBe(find('skill', 'old-helper').standingChars);
  });
});

describe('Codex archive and restore', () => {
  it('moves a personal skill out and restores the home folder byte for byte', async () => {
    const root = join(home, '.packlight');
    mkdirSync(join(root, 'scans', inv.scanId), { recursive: true });
    writeFileSync(join(root, 'scans', inv.scanId, 'inventory.json'), JSON.stringify(inv));
    const before = snapshot(home, ['.packlight']);
    const lines: string[] = [];
    const r = await apply({
      home, packlightRoot: root, picksFile: writePicks(join(dir, 'p.json'), inv.scanId, [{ id: find('skill', 'old-helper').id, action: 'archive' }]),
      yes: true, confirm: async () => true, claudeRunning: () => false, out: l => lines.push(l),
    });
    expect(r.archived.map(a => a.item.name)).toEqual(['old-helper']);
    expect(existsSync(join(home, '.codex', 'skills', 'old-helper'))).toBe(false);
    expect(restore({ home, packlightRoot: root, ids: [], all: true, out: l => lines.push(l) }).exitCode).toBe(0);
    expect(snapshot(home, ['.packlight'])).toEqual(before);
  });

  it('shows only Codex archives in a Codex report', async () => {
    const data = buildReport(inv, packlightPaths(home));
    expect(data.agent).toBe('codex');
    expect(data.archived).toEqual([]);
  });
});
