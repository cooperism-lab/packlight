import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply, STALE_PICKS, type ApplyOptions } from '../src/archive/apply.js';
import { acquireLock } from '../src/archive/lock.js';
import { archiveList, restore } from '../src/archive/restore.js';
import type { Inventory, Item } from '../src/core/types.js';
import { buildHome, type FixtureHome } from './fixtures/home.js';
import { changedPaths, scanAndSave, snapshot, writePicks } from './helpers.js';

let dir: string;
let fx: FixtureHome;
let root: string;
let lines: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'packlight-a-'));
  fx = buildHome(dir);
  // A skill that is a link to a folder elsewhere: packlight moves the link, never the target.
  const shared = join(fx.home, 'shared', 'linked');
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, 'SKILL.md'), '---\ndescription: Linked skill.\n---\n');
  symlinkSync(shared, join(fx.home, '.claude', 'skills', 'linked'), 'junction');
  root = join(fx.home, '.packlight');
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const find = (inv: Inventory, kind: Item['kind'], name: string, source?: string): Item => {
  const it = inv.items.find(i => i.kind === kind && i.name === name && (!source || i.source === source));
  if (!it) throw new Error(`missing ${kind} ${name}`);
  return it;
};
const hookByCommand = (inv: Inventory, command: string, source: string): Item =>
  inv.items.find(i => i.kind === 'hook' && i.hook?.command === command && i.source === source)!;

const run = (picksFile: string, over: Partial<ApplyOptions> = {}) =>
  apply({ home: fx.home, picksFile, yes: true, confirm: async () => true, claudeRunning: () => false, out: l => lines.push(l), ...over });
const restoreAll = () => restore({ home: fx.home, ids: [], all: true, out: l => lines.push(l) });
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const userSettings = () => join(fx.home, '.claude', 'settings.json');

describe('archive and restore round trip (criteria 6 and 8)', () => {
  it('archives one item by every method and restores the home folder byte for byte', async () => {
    const inv = await scanAndSave(fx.home, fx.project, root);
    const picks = [
      find(inv, 'skill', 'alpha', 'personal'),
      find(inv, 'skill', 'linked', 'personal'),
      find(inv, 'agent', 'writer'),
      find(inv, 'command', 'ship'),
      hookByCommand(inv, '/usr/local/bin/notes.sh', 'user settings'),
      hookByCommand(inv, '/usr/local/bin/guard.sh check', 'user settings'),
      hookByCommand(inv, '/usr/local/bin/bell.sh', 'user local settings'),
      find(inv, 'mcp', 'github'),
      find(inv, 'mcp', 'localdb'),
      find(inv, 'mcp', 'projsrv'),
      find(inv, 'skill', 'kit:kit-a'),
      find(inv, 'plugin', 'solo'),
      find(inv, 'skill', 'anthropic-skills:docs'),
    ].map(i => ({ id: i.id, action: 'archive' }));
    picks.push({ id: find(inv, 'skill', 'beta').id, action: 'keep' });
    const before = snapshot(fx.home, ['.packlight']);

    const r = await run(writePicks(join(dir, 'picks.json'), inv.scanId, picks));
    expect(r.refused).toEqual([]);
    expect(r.stillEffective).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(r.kept).toBe(1);

    // Only the archived items and the settings files that declared them changed (criterion 8).
    const allowed = [
      '.claude/skills/alpha', '.claude/skills/linked', '.claude/agents/writer.md', '.claude/commands/ship.md',
      '.claude/settings.json', '.claude/settings.local.json', '.claude.json', 'code/proj/.mcp.json', 'code/proj/.claude/settings.json',
    ];
    const changed = changedPaths(before, snapshot(fx.home, ['.packlight']));
    expect(changed.filter(p => !allowed.some(a => p === a || p.startsWith(`${a}/`)))).toEqual([]);
    expect(existsSync(join(fx.home, 'shared', 'linked', 'SKILL.md'))).toBe(true);

    // The kit plugin, picked through one of its skills, is off in both files that switched it on (O3, X2).
    expect(json(userSettings()).enabledPlugins['kit@market']).toBe(false);
    expect(json(join(fx.project, '.claude', 'settings.json')).enabledPlugins['kit@market']).toBe(false);
    expect(json(userSettings()).hooks.SessionStart).toBeUndefined();
    expect(json(join(fx.home, '.claude.json')).projects[fx.project].mcpServers).toEqual({});

    const back = restoreAll();
    expect(back.refused).toEqual([]);
    expect(back.exitCode).toBe(0);
    expect(lines.join('\n')).toContain('removed by hand');
    expect(snapshot(fx.home, ['.packlight'])).toEqual(before);
  });

  it('turns off a plugin that no settings file declares by adding the flag, and restores by removing it', async () => {
    const settings = json(userSettings());
    delete settings.enabledPlugins['solo@market'];
    writeFileSync(userSettings(), JSON.stringify(settings, null, 2) + '\n');
    const inv = await scanAndSave(fx.home, fx.project, root);
    const before = snapshot(fx.home, ['.packlight']);
    await run(writePicks(join(dir, 'p.json'), inv.scanId, [{ id: find(inv, 'plugin', 'solo').id, action: 'archive' }]));
    expect(json(userSettings()).enabledPlugins['solo@market']).toBe(false);
    restoreAll();
    expect(snapshot(fx.home, ['.packlight'])).toEqual(before);
  });
});

describe('apply safety', () => {
  it('asks one question for the whole plan when fix runs it, and a no changes nothing', async () => {
    const inv = await scanAndSave(fx.home, fx.project, root);
    const picks = writePicks(join(dir, 'p.json'), inv.scanId, [
      { id: find(inv, 'skill', 'alpha').id, action: 'archive' },
      { id: hookByCommand(inv, '/usr/local/bin/notes.sh', 'user settings').id, action: 'archive' },
    ]);
    const before = snapshot(fx.home, ['.packlight']);
    const asked: string[] = [];
    const no = await run(picks, { yes: false, singleQuestion: 'Archive these 2 items?', claudeRunning: () => true, confirm: async q => { asked.push(q); return false; } });
    expect(asked).toEqual(['\nArchive these 2 items?']);
    expect(no.exitCode).toBe(1);
    expect(snapshot(fx.home, ['.packlight'])).toEqual(before);
    asked.length = 0;
    const yes = await run(picks, { yes: false, singleQuestion: 'Archive these 2 items?', confirm: async q => { asked.push(q); return true; } });
    expect(asked).toHaveLength(1);
    expect(yes.archived.map(a => a.item.name).sort()).toEqual(['alpha', expect.stringContaining('notes')]);
  });

  it('changes nothing when every group is declined, but still records keeps (criterion 7, DE3)', async () => {
    const inv = await scanAndSave(fx.home, fx.project, root);
    const before = snapshot(fx.home, ['.packlight']);
    const r = await run(writePicks(join(dir, 'p.json'), inv.scanId, [
      { id: find(inv, 'skill', 'alpha').id, action: 'archive' },
      { id: hookByCommand(inv, '/usr/local/bin/notes.sh', 'user settings').id, action: 'archive' },
      { id: find(inv, 'skill', 'beta').id, action: 'keep' },
    ]), { yes: false, confirm: async () => false });
    expect(r.declined.sort()).toEqual(['hook-extract', 'move']);
    expect(snapshot(fx.home, ['.packlight'])).toEqual(before);
    expect(Object.values(json(join(root, 'keeps.json')).keeps)).toEqual([expect.objectContaining({ name: 'beta' })]);
    expect(lines.join('\n')).toContain('Kept 1 item. Nothing archived.');
  });

  it('refuses picks from an older scan with the exact message', async () => {
    const old = await scanAndSave(fx.home, fx.project, root, new Date('2026-10-01T00:00:00Z'));
    await scanAndSave(fx.home, fx.project, root, new Date('2026-10-02T00:00:00Z'));
    await expect(run(writePicks(join(dir, 'p.json'), old.scanId, [{ id: find(old, 'skill', 'alpha').id, action: 'archive' }]))).rejects.toThrow(STALE_PICKS);
  });

  it('skips unknown ids and never reads a path from the picks file (F3)', async () => {
    const inv = await scanAndSave(fx.home, fx.project, root);
    const r = await run(writePicks(join(dir, 'p.json'), inv.scanId, [
      { id: 'skill-nope-00000000', action: 'archive' },
      { id: find(inv, 'skill', 'alpha').id, action: 'archive', path: '../../.ssh' },
    ]));
    expect(r.unknownIds).toEqual(['skill-nope-00000000']);
    expect(r.archived.map(a => a.item.name)).toEqual(['alpha']);
    expect(existsSync(join(fx.home, '.claude', 'skills', 'alpha'))).toBe(false);
  });

  it('refuses only the item that changed after the scan (X1)', async () => {
    const inv = await scanAndSave(fx.home, fx.project, root);
    writeFileSync(join(fx.home, '.claude', 'skills', 'alpha', 'SKILL.md'), '---\ndescription: Edited after the scan.\n---\n');
    const r = await run(writePicks(join(dir, 'p.json'), inv.scanId, [
      { id: find(inv, 'skill', 'alpha').id, action: 'archive' },
      { id: find(inv, 'skill', 'gamma').id, action: 'archive' },
    ]));
    expect(r.refused.map(x => [x.item.name, x.reason])).toEqual([['alpha', 'It changed since you reviewed it. Scan again and re-mark it.']]);
    expect(r.archived.map(a => a.item.name)).toEqual(['gamma']);
    expect(r.exitCode).toBe(1);
  });

  it('asks before editing settings while Claude Code is running, and stops on no (D21)', async () => {
    const inv = await scanAndSave(fx.home, fx.project, root);
    const before = snapshot(fx.home, ['.packlight']);
    const asked: string[] = [];
    const r = await run(writePicks(join(dir, 'p.json'), inv.scanId, [{ id: hookByCommand(inv, '/usr/local/bin/notes.sh', 'user settings').id, action: 'archive' }]),
      { yes: false, claudeRunning: () => true, confirm: async q => { asked.push(q); return false; } });
    expect(asked).toEqual(['Continue anyway?']);
    expect(r.exitCode).toBe(1);
    expect(snapshot(fx.home, ['.packlight'])).toEqual(before);
  });

  it('will not run while another packlight holds the lock', () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'lock'), String(process.ppid));
    expect(() => acquireLock(join(root, 'lock'))).toThrow(/Another packlight/);
  });
});

describe('restore refusals (D12)', () => {
  it('leaves a settings file that changed since the archive alone and prints the fragment', async () => {
    const inv = await scanAndSave(fx.home, fx.project, root);
    await run(writePicks(join(dir, 'p.json'), inv.scanId, [{ id: hookByCommand(inv, '/usr/local/bin/notes.sh', 'user settings').id, action: 'archive' }]));
    const edited = { ...json(userSettings()), model: 'opus' };
    writeFileSync(userSettings(), JSON.stringify(edited, null, 2));
    const r = restoreAll();
    expect(r.exitCode).toBe(1);
    expect(json(userSettings())).toEqual(edited);
    const out = lines.join('\n');
    expect(out).toContain('has changed since packlight archived this');
    expect(out).toContain('/usr/local/bin/notes.sh');
  });

  it('will not restore over something now at the original path', async () => {
    const inv = await scanAndSave(fx.home, fx.project, root);
    await run(writePicks(join(dir, 'p.json'), inv.scanId, [{ id: find(inv, 'skill', 'alpha').id, action: 'archive' }]));
    mkdirSync(join(fx.home, '.claude', 'skills', 'alpha'));
    const r = restoreAll();
    expect(r.refused.map(x => x.manifest.itemName)).toEqual(['alpha']);
    expect(lines.join('\n')).toContain('Something is already at');
  });

  it('restores by item id and lists the archive', async () => {
    const inv = await scanAndSave(fx.home, fx.project, root);
    const alpha = find(inv, 'skill', 'alpha');
    await run(writePicks(join(dir, 'p.json'), inv.scanId, [{ id: alpha.id, action: 'archive' }]));
    archiveList({ home: fx.home, out: l => lines.push(l) });
    expect(lines.at(-1)).toMatch(/archived\s+move\s+alpha/);
    expect(restore({ home: fx.home, ids: [alpha.id], all: false, out: l => lines.push(l) }).restored).toHaveLength(1);
    expect(existsSync(join(fx.home, '.claude', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('file modes (SC2)', () => {
  it('keeps a 0600 settings file at 0600 through archive and restore', async () => {
    chmodSync(userSettings(), 0o600);
    const inv = await scanAndSave(fx.home, fx.project, root);
    await run(writePicks(join(dir, 'p.json'), inv.scanId, [{ id: hookByCommand(inv, '/usr/local/bin/notes.sh', 'user settings').id, action: 'archive' }]));
    expect(statSync(userSettings()).mode & 0o777).toBe(0o600);
    restoreAll();
    expect(statSync(userSettings()).mode & 0o777).toBe(0o600);
  });
});
