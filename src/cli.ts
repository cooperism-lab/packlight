#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { apply, claudeCodeRunning, findPicksFile, STALE_PICKS } from './archive/apply.js';
import { downloadsDir } from './archive/paths.js';
import { archiveList, restore } from './archive/restore.js';
import { scan } from './core/scan.js';
import { summarize } from './core/summary.js';

const USAGE = `packlight: see what your coding agent carries

Usage:
  packlight scan [--home <dir>] [--since <YYYY-MM-DD>] [--out <dir>] [--json]
  packlight apply [picks.json] [--yes] [--home <dir>] [--out <dir>]
  packlight restore <id…> | --all [--home <dir>] [--out <dir>]
  packlight archive list [--home <dir>] [--out <dir>]

  --home   home folder to work on (default: your home folder)
  --out    packlight's own folder (default: <home>/.packlight)
  --since  only count sessions from this date
  --json   print the inventory to stdout instead of a summary
  --yes    apply without asking (it still prints the plan)`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Positional arguments after the command, skipping flags and their values. */
function positional(argv: string[]): string[] {
  const withValue = new Set(['--home', '--out', '--since']);
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (withValue.has(a)) { i++; continue; }
    if (!a.startsWith('--')) out.push(a);
  }
  return out;
}

/** Test hook: PACKLIGHT_CRASH_AT=<point> stops the process there, as kill -9 would (eng X3). */
const crash = (point: string): void => {
  if (process.env.PACKLIGHT_CRASH_AT === point) process.exit(137);
};

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (!command || command === '--help' || command === '-h') { console.log(USAGE); return 0; }
  const home = arg(argv, '--home') ?? homedir();
  const packlightRoot = arg(argv, '--out') ?? join(home, '.packlight');
  const out = (line: string): void => console.log(line);

  if (command === 'scan') {
    const since = arg(argv, '--since');
    if (since && !/^\d{4}-\d{2}-\d{2}/.test(since)) { console.error('--since takes a date like 2026-08-01.'); return 2; }
    if (!existsSync(join(home, '.claude'))) {
      console.error(`No Claude Code setup found: ${join(home, '.claude')} does not exist. Pass --home to scan another folder.`);
      return 1;
    }
    const started = Date.now();
    const inventory = await scan({ home, cwd: process.cwd(), since });
    if (argv.includes('--json')) { process.stdout.write(JSON.stringify(inventory, null, 1) + '\n'); return 0; }
    const dir = join(packlightRoot, 'scans', inventory.scanId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'inventory.json');
    writeFileSync(file, JSON.stringify(inventory));
    console.log(summarize(inventory, Date.now() - started));
    console.log(`\nInventory written to ${file}`);
    return 0;
  }

  if (command === 'apply') {
    const picksFile = positional(argv)[0] ?? findPicksFile(downloadsDir(home));
    if (!picksFile) {
      console.error('No picks file found in your downloads folder. Pass its path: packlight apply <file>.');
      return 2;
    }
    const yes = argv.includes('--yes');
    if (!yes && !process.stdin.isTTY) { console.error('apply asks before it changes anything. Run it in a terminal, or pass --yes.'); return 2; }
    out(`Picks: ${picksFile}`);
    try {
      const r = await apply({ home, packlightRoot, picksFile, yes, confirm, claudeRunning: claudeCodeRunning, out, crash });
      return r.exitCode;
    } catch (err) {
      console.error((err as Error).message === STALE_PICKS ? STALE_PICKS : `packlight: ${(err as Error).message}`);
      return 1;
    }
  }

  if (command === 'restore') {
    const all = argv.includes('--all');
    const ids = positional(argv);
    if (!all && !ids.length) { console.error('Name what to restore (an id from `packlight archive list`) or pass --all.'); return 2; }
    return restore({ home, packlightRoot, ids, all, out, crash }).exitCode;
  }

  if (command === 'archive' && positional(argv)[0] === 'list') {
    archiveList({ home, packlightRoot, out });
    return 0;
  }

  console.error(`Unknown command "${argv.join(' ')}".\n\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  console.error(`packlight: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
