// Regression tests for the independent review of src/archive (2026-10-08), one per finding.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { moveTree, SourceNotRemoved, stagingPathFor } from '../src/archive/fsops.js';
import { journalBegin, recover } from '../src/archive/journal.js';
import { newOpId } from '../src/archive/manifest.js';
import { archiveStep, type StepContext } from '../src/archive/methods.js';
import { packlightPaths } from '../src/archive/paths.js';
import { restore } from '../src/archive/restore.js';
import { pathFingerprint, valueFingerprint } from '../src/core/hash.js';
import type { Item } from '../src/core/types.js';

const tmp: string[] = [];
const mk = (): string => { const d = mkdtempSync(join(tmpdir(), 'packlight-r-')); tmp.push(d); return d; };
afterEach(() => { while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true }); });

describe('review finding 1: recovery runs only under the lock', () => {
  it('does not touch a pending entry while another live packlight holds the lock', () => {
    const home = mk();
    const paths = packlightPaths(home);
    journalBegin(paths, { opId: 'op-x', direction: 'archive', paths: [{ path: join(home, 'gone'), kind: 'tree', before: 'missing', after: 'x' }] });
    writeFileSync(paths.lock, String(process.ppid));
    expect(() => restore({ home, ids: [], all: true, out: () => {} })).toThrow(/Another packlight/);
    expect(JSON.parse(readFileSync(paths.journal, 'utf8')).entries[0].state).toBe('pending');
  });
});

describe.skipIf(process.platform === 'win32')('review finding 2: a failed source removal keeps both copies', () => {
  it('reports SourceNotRemoved and leaves the verified copy in place', () => {
    const d = mk();
    const ro = join(d, 'ro');
    mkdirSync(join(ro, 'skill'), { recursive: true });
    writeFileSync(join(ro, 'skill', 'SKILL.md'), 'keep me');
    const fp = pathFingerprint(join(ro, 'skill'));
    chmodSync(ro, 0o555);
    const exdev = (): never => { const e: NodeJS.ErrnoException = new Error('x'); e.code = 'EXDEV'; throw e; };
    try {
      expect(() => moveTree(join(ro, 'skill'), join(d, 'archive', 'skill'), { rename: exdev })).toThrow(SourceNotRemoved);
      expect(pathFingerprint(join(d, 'archive', 'skill'))).toBe(fp);
      expect(existsSync(join(ro, 'skill'))).toBe(true);
    } finally { chmodSync(ro, 0o755); }
  });
});

describe('review finding 3: a reordered settings file never loses the wrong entry', () => {
  it('refuses when the entry at the pointer is not the picked hook', () => {
    const home = mk();
    const file = join(home, 'settings.json');
    const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'b.sh' }] }, { hooks: [{ type: 'command', command: 'a.sh' }] }] } };
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    const before = readFileSync(file, 'utf8');
    // Picked: a.sh, recorded at index 0 before something reordered the file.
    const item = { id: 'hook-a', name: 'a.sh · Stop', kind: 'hook', agent: 'claude-code', targetFingerprint: valueFingerprint({ event: 'Stop', matcher: null, command: 'a.sh' }) } as Item;
    const ctx: StepContext = { paths: packlightPaths(home), scanId: 's', now: () => new Date(), expectedHash: new Map(), crash: () => {} };
    const o = archiveStep(ctx, { method: 'hook-extract', item, file, pointer: '/hooks/Stop/0/hooks/0' });
    expect(o.ok).toBe(false);
    expect(!o.ok && o.reason).toContain('no longer the one you picked');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('review finding 5: staging copies are scratch the journal cleans up', () => {
  it('removes a leftover staging copy beside the user\'s path during recovery', () => {
    const home = mk();
    const paths = packlightPaths(home);
    const orig = join(home, '.claude', 'skills', 'foo');
    const staging = stagingPathFor(orig);
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'SKILL.md'), 'half copied');
    mkdirSync(join(paths.archive, 'op-y', 'payload', 'foo'), { recursive: true });
    const payloadFp = pathFingerprint(join(paths.archive, 'op-y', 'payload', 'foo'));
    journalBegin(paths, { opId: 'op-y', direction: 'restore', paths: [
      { path: orig, kind: 'tree', before: 'missing', after: payloadFp },
      { path: join(paths.archive, 'op-y', 'payload', 'foo'), kind: 'tree', before: payloadFp, after: 'missing' },
      { path: staging, kind: 'tree', before: 'missing', after: 'missing', scratch: true },
    ] });
    expect(recover(paths).rolledBack).toEqual(['restore op-y']);
    expect(existsSync(staging)).toBe(false);
    expect(staging.startsWith(join(home, '.claude', 'skills', '.'))).toBe(true);
  });
});

describe('review finding 6: operation ids are strictly increasing', () => {
  it('orders two ids made in the same millisecond', () => {
    const t = new Date('2026-10-08T00:00:00.000Z');
    const a = newOpId(t);
    const b = newOpId(t);
    expect(b > a).toBe(true);
  });
});
