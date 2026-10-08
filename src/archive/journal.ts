import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, fileHash, stateOf } from './fsops.js';
import type { PacklightPaths } from './paths.js';
import type { Manifest } from './manifest.js';

/**
 * One journal for archive and restore (CEO F1, eng X3). Every change is recorded as pending with the
 * expected state of each path before and after it, then performed, then marked done. On every start,
 * a pending entry is finished or rolled back only when the disk matches one of those states exactly;
 * anything else is refused and named, and nothing is touched.
 */
export interface PathState {
  path: string;
  /** "tree": fingerprint of a file, folder or link (or "missing"); "file": sha256 of the bytes (or null). */
  kind: 'tree' | 'file';
  before: string | null;
  after: string | null;
  /** A temporary path packlight created (cross-volume staging): removed before recovery decides. */
  scratch?: boolean;
}

export interface JournalEntry {
  opId: string;
  direction: 'archive' | 'restore';
  state: 'pending' | 'done' | 'aborted';
  at: string;
  paths: PathState[];
}

interface JournalFile { version: 1; entries: JournalEntry[] }

const read = (paths: PacklightPaths): JournalFile => {
  if (!existsSync(paths.journal)) return { version: 1, entries: [] };
  return JSON.parse(readFileSync(paths.journal, 'utf8')) as JournalFile;
};
const write = (paths: PacklightPaths, j: JournalFile): void => atomicWrite(paths.journal, JSON.stringify(j, null, 1) + '\n');

export function journalBegin(paths: PacklightPaths, entry: Omit<JournalEntry, 'state' | 'at'>): void {
  const j = read(paths);
  j.entries.push({ ...entry, state: 'pending', at: new Date().toISOString() });
  write(paths, j);
}

export function journalEnd(paths: PacklightPaths, opId: string, direction: JournalEntry['direction'], state: 'done' | 'aborted'): void {
  const j = read(paths);
  const e = [...j.entries].reverse().find(x => x.opId === opId && x.direction === direction && x.state === 'pending');
  if (e) e.state = state;
  write(paths, j);
}

const current = (p: PathState): string | null => (p.kind === 'tree' ? stateOf(p.path) : fileHash(p.path));

export interface RecoveryResult { completed: string[]; rolledBack: string[]; refused: { opId: string; direction: string; files: string[] }[] }

/** Finishes or rolls back whatever a crash left pending. Runs before every command that changes the setup. */
export function recover(paths: PacklightPaths): RecoveryResult {
  const result: RecoveryResult = { completed: [], rolledBack: [], refused: [] };
  const j = read(paths);
  let changed = false;
  for (const e of j.entries.filter(x => x.state === 'pending')) {
    for (const p of e.paths.filter(p => p.scratch)) rmSync(p.path, { recursive: true, force: true });
    const real = e.paths.filter(p => !p.scratch);
    e.paths = real;
    let now = e.paths.map(current);
    // A cross-volume move that stopped after its verified copy but before removing the source leaves both
    // copies, each matching a known state (eng X4). An archive drops the copy; a restore drops the archive.
    const allBefore = e.paths.every((p, i) => now[i] === p.before);
    const allAfter = e.paths.every((p, i) => now[i] === p.after);
    const mixed = !allBefore && !allAfter && e.paths.every(p => p.kind === 'tree') && e.paths.every((p, i) => now[i] === p.before || now[i] === p.after);
    if (mixed) {
      for (const [i, p] of e.paths.entries()) {
        const extraCopy = e.direction === 'archive' ? now[i] === p.after && p.before === 'missing' : now[i] === p.before && p.after === 'missing';
        if (extraCopy && now[i] !== 'missing') rmSync(p.path, { recursive: true, force: true });
      }
      now = e.paths.map(current);
    }
    const isAfter = e.paths.every((p, i) => now[i] === p.after);
    const isBefore = e.paths.every((p, i) => now[i] === p.before);
    if (isAfter) {
      e.state = 'done';
      if (e.direction === 'restore') setManifestStatus(paths, e.opId, 'restored');
      result.completed.push(`${e.direction} ${e.opId}`);
    } else if (isBefore) {
      e.state = 'aborted';
      // An archive that never happened leaves no record behind; staging copies from cross-volume moves go too.
      if (e.direction === 'archive') rmSync(join(paths.archive, e.opId), { recursive: true, force: true });
      result.rolledBack.push(`${e.direction} ${e.opId}`);
    } else {
      result.refused.push({ opId: e.opId, direction: e.direction, files: e.paths.filter((p, i) => now[i] !== p.before && now[i] !== p.after).map(p => p.path) });
      continue;
    }
    changed = true;
  }
  if (changed) write(paths, j);
  return result;
}

export function readManifest(paths: PacklightPaths, opId: string): Manifest | undefined {
  const file = join(paths.archive, opId, 'manifest.json');
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
}

export function writeManifest(paths: PacklightPaths, m: Manifest): void {
  atomicWrite(join(paths.archive, m.opId, 'manifest.json'), JSON.stringify(m, null, 1) + '\n');
}

export function setManifestStatus(paths: PacklightPaths, opId: string, status: Manifest['status']): void {
  const m = readManifest(paths, opId);
  if (m && m.status !== status) writeManifest(paths, { ...m, status, ...(status === 'restored' ? { restoredAt: new Date().toISOString() } : {}) });
}

export function listManifests(paths: PacklightPaths): Manifest[] {
  let ids: string[];
  try { ids = readdirSync(paths.archive); } catch { return []; }
  return ids.map(id => readManifest(paths, id)).filter((m): m is Manifest => !!m).sort((a, b) => a.opId.localeCompare(b.opId));
}
