import { appendFileSync, mkdirSync } from 'node:fs';
import { listManifests, recover } from './journal.js';
import { acquireLock } from './lock.js';
import type { Manifest } from './manifest.js';
import { restoreManifest, type StepContext } from './methods.js';
import { packlightPaths } from './paths.js';
import { reportRecovery } from './apply.js';

export interface RestoreOptions {
  home: string;
  packlightRoot?: string;
  /** Operation ids or item ids; ignored when `all` is set. */
  ids: string[];
  all: boolean;
  out: (line: string) => void;
  now?: () => Date;
  crash?: (point: string) => void;
}

export interface RestoreResult { exitCode: number; restored: Manifest[]; refused: { manifest: Manifest; reason: string }[]; notFound: string[] }

/**
 * Puts archived items back, newest first, so several edits to one settings file unwind in order (D12).
 * One refusal never stops the rest; the exit code is non-zero if any item was refused.
 */
export function restore(opts: RestoreOptions): RestoreResult {
  const paths = packlightPaths(opts.home, opts.packlightRoot);
  const result: RestoreResult = { exitCode: 0, restored: [], refused: [], notFound: [] };
  const release = acquireLock(paths.lock);
  try { return restoreLocked(opts, paths, result); } finally { release(); }
}

function restoreLocked(opts: RestoreOptions, paths: ReturnType<typeof packlightPaths>, result: RestoreResult): RestoreResult {
  const recovery = recover(paths);
  reportRecovery(recovery, opts.out);
  if (recovery.refused.length) return { ...result, exitCode: 1 };

  const manifests = listManifests(paths);
  const open = manifests.filter(m => m.status !== 'restored');
  let chosen: Manifest[];
  // Items removed by hand cannot be put back by packlight; --all lists them instead of failing on them.
  if (opts.all) {
    chosen = open.filter(m => m.status === 'archived');
    const waiting = open.filter(m => m.status === 'waiting');
    if (waiting.length) opts.out(`${waiting.length} item${waiting.length === 1 ? ' was' : 's were'} removed by hand; add ${waiting.length === 1 ? 'it' : 'them'} back where ${waiting.length === 1 ? 'it was' : 'they were'} removed: ${waiting.map(m => m.itemName).join(', ')}.`);
  }
  else {
    chosen = [];
    for (const id of opts.ids) {
      // An operation id names one archive; an item id names every open archive of that item.
      const hits = open.filter(m => m.opId === id || m.itemId === id);
      if (hits.length) chosen.push(...hits); else result.notFound.push(id);
    }
  }
  chosen = [...new Map(chosen.map(m => [m.opId, m])).values()].sort((a, b) => b.opId.localeCompare(a.opId));
  for (const id of result.notFound) opts.out(`Nothing to restore for ${id}: no archive of it is open. Run \`packlight archive list\` to see what is archived.`);

  const now = opts.now ?? (() => new Date());
  {
    const ctx: StepContext = { paths, scanId: '', now, expectedHash: new Map(), crash: opts.crash ?? (() => {}) };
    for (const m of chosen) {
      const o = restoreManifest(ctx, m);
      mkdirSync(paths.root, { recursive: true });
      appendFileSync(paths.log, `${now().toISOString()} restore ${m.method} ${m.itemId} ${m.opId} ${o.ok ? 'ok' : `refused: ${o.reason}`}\n`);
      if (o.ok) { result.restored.push(m); opts.out(`Restored ${m.itemName} (${m.opId}).`); continue; }
      result.refused.push({ manifest: m, reason: o.reason });
      opts.out(`Not restored: ${m.itemName} (${m.opId}). ${o.reason}`);
      if (o.fragment !== undefined) opts.out(JSON.stringify(o.fragment, null, 2).split('\n').map(l => `    ${l}`).join('\n'));
    }
  }
  if (opts.all && !chosen.length) opts.out('Nothing is archived.');
  result.exitCode = result.refused.length || result.notFound.length ? 1 : 0;
  return result;
}

export function archiveList(opts: { home: string; packlightRoot?: string; out: (line: string) => void }): void {
  const manifests = listManifests(packlightPaths(opts.home, opts.packlightRoot));
  if (!manifests.length) { opts.out('Nothing archived yet.'); return; }
  for (const m of manifests) {
    const where = m.originalPath ?? (m.settingsFile ? `${m.settingsFile} ${m.jsonPointer}` : m.manualSteps ?? '');
    opts.out(`${m.opId}  ${m.status.padEnd(8)}  ${m.method.padEnd(14)}  ${m.itemName}  ${where}`);
  }
}
