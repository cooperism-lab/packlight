import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apply } from '../src/archive/apply.js';
import { moveTree, stateOf } from '../src/archive/fsops.js';
import { journalBegin, recover } from '../src/archive/journal.js';
import { packlightPaths } from '../src/archive/paths.js';
import { restore } from '../src/archive/restore.js';
import { pathFingerprint } from '../src/core/hash.js';
import type { Inventory, Item } from '../src/core/types.js';
import { buildHome, type FixtureHome } from './fixtures/home.js';
import { scanAndSave, snapshot, writePicks } from './helpers.js';

const repo = join(import.meta.dirname, '..');
const cli = (args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, ['--import', 'tsx', join(repo, 'src', 'cli.ts'), ...args], { cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8' });

let dir: string;
let fx: FixtureHome;
let lines: string[];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'packlight-c-')); fx = buildHome(dir); lines = []; });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const root = () => join(fx.home, '.packlight');
const pick = (inv: Inventory, target: 'move' | 'settings'): Item =>
  target === 'move'
    ? inv.items.find(i => i.kind === 'skill' && i.name === 'alpha')!
    : inv.items.find(i => i.kind === 'hook' && i.hook?.command === '/usr/local/bin/notes.sh')!;
const restoreAll = () => restore({ home: fx.home, ids: [], all: true, out: l => lines.push(l) });

describe.each(['move', 'settings'] as const)('a crash during archive (%s)', target => {
  it.each(['archive:after-journal', 'archive:after-manifest', 'archive:after-change'])('at %s is recovered and fully restorable (X3)', async point => {
    const inv = await scanAndSave(fx.home, fx.project, root());
    const before = snapshot(fx.home, ['.packlight']);
    const picks = writePicks(join(dir, 'p.json'), inv.scanId, [{ id: pick(inv, target).id, action: 'archive' }]);
    const r = cli(['apply', picks, '--yes', '--home', fx.home], { PACKLIGHT_CRASH_AT: point });
    expect(r.status).toBe(137);

    const back = restoreAll();
    expect(lines.join('\n')).toMatch(/Recovered: (finished|rolled back) an interrupted archive/);
    expect(back.exitCode).toBe(0);
    expect(snapshot(fx.home, ['.packlight'])).toEqual(before);
  });
});

describe.each(['move', 'settings'] as const)('a crash during restore (%s)', target => {
  it.each(['restore:after-journal', 'restore:after-change'])('at %s is recovered (X3)', async point => {
    const inv = await scanAndSave(fx.home, fx.project, root());
    const before = snapshot(fx.home, ['.packlight']);
    await apply({ home: fx.home, picksFile: writePicks(join(dir, 'p.json'), inv.scanId, [{ id: pick(inv, target).id, action: 'archive' }]), yes: true, confirm: async () => true, claudeRunning: () => false, out: () => {} });
    const r = cli(['restore', '--all', '--home', fx.home], { PACKLIGHT_CRASH_AT: point });
    expect(r.status).toBe(137);

    expect(restoreAll().exitCode).toBe(0);
    expect(lines.join('\n')).toMatch(/Recovered: (finished|rolled back) an interrupted restore/);
    expect(snapshot(fx.home, ['.packlight'])).toEqual(before);
  });
});

describe('recovery refuses a file it does not recognise (X3)', () => {
  it('names the file and changes nothing when it was edited during an interrupted archive', async () => {
    const inv = await scanAndSave(fx.home, fx.project, root());
    const picks = writePicks(join(dir, 'p.json'), inv.scanId, [{ id: pick(inv, 'settings').id, action: 'archive' }]);
    expect(cli(['apply', picks, '--yes', '--home', fx.home], { PACKLIGHT_CRASH_AT: 'archive:after-journal' }).status).toBe(137);
    const settings = join(fx.home, '.claude', 'settings.json');
    writeFileSync(settings, readFileSync(settings, 'utf8').replace('"hooks"', '"model": "opus",\n  "hooks"'));
    const edited = readFileSync(settings, 'utf8');

    const r = restoreAll();
    expect(r.exitCode).toBe(1);
    expect(lines.join('\n')).toContain(`Recovery stopped: archive`);
    expect(lines.join('\n')).toContain(settings);
    expect(readFileSync(settings, 'utf8')).toBe(edited);
  });
});

describe('cross-volume moves (X4)', () => {
  const exdev = (): never => { const e: NodeJS.ErrnoException = new Error('cross-device link'); e.code = 'EXDEV'; throw e; };

  it('copies, verifies and then removes the source when rename fails across volumes', () => {
    const src = join(dir, 'src-skill');
    mkdirSync(join(src, 'refs'), { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), 'skill');
    writeFileSync(join(src, 'refs', 'a.md'), 'ref');
    const fp = pathFingerprint(src);
    moveTree(src, join(dir, 'dest', 'src-skill'), { rename: exdev });
    expect(existsSync(src)).toBe(false);
    expect(pathFingerprint(join(dir, 'dest', 'src-skill'))).toBe(fp);
    expect(existsSync(join(dir, 'dest', 'src-skill.staging'))).toBe(false);
  });

  it('moves a link as a link across volumes', () => {
    mkdirSync(join(dir, 'target'));
    symlinkSync(join(dir, 'target'), join(dir, 'link'), 'junction');
    const fp = stateOf(join(dir, 'link'));
    moveTree(join(dir, 'link'), join(dir, 'dest', 'link'), { rename: exdev });
    expect(stateOf(join(dir, 'dest', 'link'))).toBe(fp);
    expect(existsSync(join(dir, 'target'))).toBe(true);
  });

  it('drops the verified copy when an archive stopped before removing the source', () => {
    const paths = packlightPaths(fx.home);
    const orig = join(fx.home, '.claude', 'skills', 'alpha');
    const payload = join(paths.archive, 'op-1', 'payload', 'alpha');
    const fp = stateOf(orig);
    cpSync(orig, payload, { recursive: true });
    journalBegin(paths, { opId: 'op-1', direction: 'archive', paths: [
      { path: orig, kind: 'tree', before: fp, after: 'missing' },
      { path: payload, kind: 'tree', before: 'missing', after: fp },
    ] });
    expect(recover(paths).rolledBack).toEqual(['archive op-1']);
    expect(stateOf(orig)).toBe(fp);
    expect(existsSync(join(paths.archive, 'op-1'))).toBe(false);
  });

  // A real second volume where the runner has one (Linux: /dev/shm is tmpfs, separate from the temp folder).
  const shm = '/dev/shm';
  const secondVolume = existsSync(shm) && statSync(shm).dev !== statSync(tmpdir()).dev;
  it.skipIf(!secondVolume)('moves a folder between two real volumes', () => {
    const src = join(dir, 'vol-skill');
    mkdirSync(src);
    writeFileSync(join(src, 'SKILL.md'), 'skill');
    const fp = pathFingerprint(src);
    const dest = mkdtempSync(join(shm, 'packlight-'));
    try {
      moveTree(src, join(dest, 'vol-skill'));
      expect(pathFingerprint(join(dest, 'vol-skill'))).toBe(fp);
      expect(existsSync(src)).toBe(false);
    } finally { rmSync(dest, { recursive: true, force: true }); }
  });
});
