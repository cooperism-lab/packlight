import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Inventory } from '../core/types.js';

/** Everything packlight writes lives under <home>/.packlight (acceptance criterion 8). */
export interface PacklightPaths {
  home: string;
  root: string;
  scans: string;
  archive: string;
  journal: string;
  lock: string;
  keeps: string;
  log: string;
}

export function packlightPaths(home: string, root = join(home, '.packlight')): PacklightPaths {
  return {
    home,
    root,
    scans: join(root, 'scans'),
    archive: join(root, 'archive'),
    journal: join(root, 'journal.json'),
    lock: join(root, 'lock'),
    keeps: join(root, 'keeps.json'),
    log: join(root, 'packlight.log'),
  };
}

export function readScan(paths: PacklightPaths, scanId: string): Inventory | undefined {
  if (!/^[\w.-]+$/.test(scanId)) return undefined;
  const file = join(paths.scans, scanId, 'inventory.json');
  if (!existsSync(file)) return undefined;
  try { return JSON.parse(readFileSync(file, 'utf8')) as Inventory; } catch { return undefined; }
}

/** Newest scan for one agent and project scope (eng X6 correction to F3). */
export function newestScan(paths: PacklightPaths, agent: string, projectScope: string): Inventory | undefined {
  let ids: string[];
  try { ids = readdirSync(paths.scans).sort().reverse(); } catch { return undefined; }
  for (const id of ids) {
    const inv = readScan(paths, id);
    if (inv && inv.agent === agent && inv.projectScope === projectScope) return inv;
  }
  return undefined;
}

/** The browser download folder per OS (eng SC1); undefined when it cannot be found. */
export function downloadsDir(home = homedir(), platform = process.platform): string | undefined {
  if (platform === 'linux') {
    try {
      const dirs = readFileSync(join(home, '.config', 'user-dirs.dirs'), 'utf8');
      const m = /^XDG_DOWNLOAD_DIR="?([^"\n]+)"?/m.exec(dirs);
      if (m?.[1]) {
        const p = m[1].replace(/^\$HOME/, home);
        if (existsSync(p)) return p;
      }
    } catch { /* fall through to ~/Downloads */ }
  }
  const p = join(home, 'Downloads');
  return existsSync(p) ? p : undefined;
}
