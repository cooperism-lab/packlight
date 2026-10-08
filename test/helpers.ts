import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { scan } from '../src/core/scan.js';
import type { Inventory } from '../src/core/types.js';

export interface Entry { type: 'file' | 'dir' | 'link'; hash?: string; mode?: number; target?: string }

/** Every path under `root` with its bytes, mode and link target (links are not followed). */
export function snapshot(root: string, skip: string[] = []): Record<string, Entry> {
  const out: Record<string, Entry> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = relative(root, p).split(sep).join('/');
      if (skip.some(s => rel === s || rel.startsWith(`${s}/`))) continue;
      const st = lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = { type: 'link', target: readlinkSync(p) };
      else if (st.isDirectory()) { out[rel] = { type: 'dir' }; walk(p); }
      else out[rel] = { type: 'file', hash: createHash('sha256').update(readFileSync(p)).digest('hex'), mode: process.platform === 'win32' ? undefined : st.mode & 0o777 };
    }
  };
  walk(root);
  return out;
}

/** Paths whose entry differs between two snapshots. */
export function changedPaths(a: Record<string, Entry>, b: Record<string, Entry>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}

/** Scans and saves the inventory where `packlight scan` would, returning it. */
export async function scanAndSave(home: string, cwd: string, root: string, now = new Date()): Promise<Inventory> {
  const inv = await scan({ home, cwd, now });
  const dir = join(root, 'scans', inv.scanId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'inventory.json'), JSON.stringify(inv));
  return inv;
}

export function writePicks(file: string, scanId: string, picks: { id: string; action: string; [k: string]: unknown }[]): string {
  writeFileSync(file, JSON.stringify({ scanId, createdAt: new Date().toISOString(), picks }));
  return file;
}
