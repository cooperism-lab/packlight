import { cpSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import { pathFingerprint, sha256 } from '../core/hash.js';

const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** rename with a bounded retry: Windows reports EPERM/EBUSY while another process briefly holds a file (eng SC1). */
export function renameWithRetry(from: string, to: string, rename: typeof renameSync = renameSync): void {
  for (let attempt = 0; ; attempt++) {
    try { rename(from, to); return; } catch (err: any) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err?.code) || attempt >= 9) throw err;
      sleep(50 * (attempt + 1));
    }
  }
}

/** Settings writes go through write-file-atomic, which keeps the file's mode and owner (eng SC2). */
export function atomicWrite(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic.sync(path, data);
}

export const fileHash = (path: string): string | null => {
  try { return sha256(readFileSync(path)); } catch (err: any) { if (err?.code === 'ENOENT') return null; throw err; }
};

export const exists = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

/** Fingerprint of a path, or "missing" (journal states compare these). */
export const stateOf = (path: string): string => (exists(path) ? pathFingerprint(path) : 'missing');

export class ChangedWhileMoving extends Error {}
/** The verified copy is in place but the source could not be fully removed: both must be kept. */
export class SourceNotRemoved extends Error {}

/** Where a cross-volume move stages its copy: hidden, beside the destination, and recorded in the journal as scratch. */
export const stagingPathFor = (to: string): string => join(dirname(to), `.${basename(to)}.packlight-staging`);

/**
 * Moves a file, folder or link. Same volume: one rename. Across volumes (EXDEV): copy into a staging path
 * beside the destination, check the copy against the source's fingerprint, re-check the source, then swap
 * the staging copy in and remove the source (eng X4). A link is moved as a link, never followed.
 */
export function moveTree(from: string, to: string, opts: { rename?: typeof renameSync } = {}): void {
  mkdirSync(dirname(to), { recursive: true });
  try { renameWithRetry(from, to, opts.rename); return; } catch (err: any) {
    if (err?.code !== 'EXDEV') throw err;
  }
  const before = pathFingerprint(from);
  const staging = stagingPathFor(to);
  rmSync(staging, { recursive: true, force: true });
  const st = lstatSync(from);
  try {
    if (st.isSymbolicLink()) symlinkSync(readlinkSync(from), staging, isDirTarget(from) ? 'junction' : 'file');
    else cpSync(from, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    if (pathFingerprint(staging) !== before || pathFingerprint(from) !== before) {
      throw new ChangedWhileMoving(`${from} changed while it was being copied; nothing was moved`);
    }
    renameWithRetry(staging, to);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  try {
    if (st.isSymbolicLink()) unlinkSync(from); else rmSync(from, { recursive: true, force: true });
  } catch (err) {
    throw new SourceNotRemoved(`A verified copy is at ${to}, but ${from} could not be fully removed (${(err as Error).message}). Both were kept.`);
  }
}

function isDirTarget(link: string): boolean {
  try { return statSync(link).isDirectory(); } catch { return false; }
}
