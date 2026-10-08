#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { apply, claudeCodeRunning, findPicksFile, STALE_PICKS } from './archive/apply.js';
import { downloadsDir, newestScan, packlightPaths, readScan } from './archive/paths.js';
import { archiveList, restore } from './archive/restore.js';
import { scan } from './core/scan.js';
import { INVOKE, MESSAGES, PASTE_COMMAND } from './core/messages.js';
import { summarize } from './core/summary.js';
import type { Inventory } from './core/types.js';
import { buildReport } from './report/model.js';
import { renderReport } from './report/render.js';

const USAGE = `packlight: see what your coding agent carries

Usage:
  packlight                 scan, write the report and open it
  packlight report [--scan <id>] [--no-open]
  packlight scan [--home <dir>] [--since <YYYY-MM-DD>] [--out <dir>] [--json]
  packlight apply [picks.json | --paste] [--yes] [--home <dir>] [--out <dir>]
  packlight restore <id…> | --all [--home <dir>] [--out <dir>]
  packlight archive list [--home <dir>] [--out <dir>]

  --home   home folder to work on (default: your home folder)
  --out    packlight's own folder (default: <home>/.packlight)
  --since  only count sessions from this date
  --json   print the inventory to stdout instead of a summary
  --yes    apply without asking (it still prints the plan)
  --no-open  write the report without opening it`;

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

/** The newest scan's scope: the current folder's project if it has a scan, else the newest scan of any scope. */
function scopeFor(paths: ReturnType<typeof packlightPaths>): string {
  try {
    const ids = readdirSync(paths.scans).sort().reverse();
    const scans = ids.map(i => readScan(paths, i)).filter((x): x is Inventory => !!x);
    const here = scans.find(s => s.projectScope !== 'global' && (process.cwd() === s.projectScope || process.cwd().startsWith(s.projectScope + sep)));
    return (here ?? scans[0])?.projectScope ?? 'global';
  } catch { return 'global'; }
}

/** Writes report.html beside packlight's data and returns its path. */
function writeReport(home: string, packlightRoot: string, inv: Inventory): string {
  const paths = packlightPaths(home, packlightRoot);
  const file = join(packlightRoot, 'report.html');
  mkdirSync(packlightRoot, { recursive: true });
  writeFileSync(file, renderReport(buildReport(inv, paths)));
  return file;
}

function readClipboard(): string | undefined {
  const [cmd, args] = process.platform === 'darwin' ? ['pbpaste', []] : process.platform === 'win32' ? ['powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']] : ['xclip', ['-selection', 'clipboard', '-o']];
  try { return execFileSync(cmd as string, args as string[], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }); } catch { return undefined; }
}

function openFile(file: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [file]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', file]] : ['xdg-open', [file]];
  try { spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* the path is printed anyway */ }
}

async function scanAndSave(home: string, packlightRoot: string, since?: string): Promise<{ inventory: Inventory; ms: number; file: string }> {
  const started = Date.now();
  const inventory = await scan({ home, cwd: process.cwd(), since });
  const dir = join(packlightRoot, 'scans', inventory.scanId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'inventory.json');
  writeFileSync(file, JSON.stringify(inventory));
  return { inventory, ms: Date.now() - started, file };
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === '--help' || command === '-h' || command === 'help') { console.log(USAGE); return 0; }
  const home = arg(argv, '--home') ?? homedir();
  const packlightRoot = arg(argv, '--out') ?? join(home, '.packlight');
  const out = (line: string): void => console.log(line);

  if (!command || command.startsWith('--')) {
    if (!existsSync(join(home, '.claude'))) {
      console.error(`No Claude Code setup found: ${join(home, '.claude')} does not exist. Pass --home to scan another folder.`);
      return 1;
    }
    const { inventory, ms } = await scanAndSave(home, packlightRoot, arg(argv, '--since'));
    console.log(summarize(inventory, ms));
    const report = writeReport(home, packlightRoot, inventory);
    console.log(`\nReport: ${report}\n${MESSAGES.afterScan}`);
    if (!argv.includes('--no-open')) openFile(report);
    return 0;
  }

  if (command === 'report') {
    const id = arg(argv, '--scan');
    const paths = packlightPaths(home, packlightRoot);
    const inv = id ? readScan(paths, id) : newestScan(paths, 'claude-code', scopeFor(paths));
    if (!inv) { console.error(id ? `No scan ${id} in ${paths.scans}.` : `No scan yet. Run \`${INVOKE}\` first.`); return 1; }
    const report = writeReport(home, packlightRoot, inv);
    console.log(`Report: ${report}`);
    if (!argv.includes('--no-open')) openFile(report);
    return 0;
  }

  if (command === 'scan') {
    const since = arg(argv, '--since');
    if (since && !/^\d{4}-\d{2}-\d{2}/.test(since)) { console.error('--since takes a date like 2026-08-01.'); return 2; }
    if (!existsSync(join(home, '.claude'))) {
      console.error(`No Claude Code setup found: ${join(home, '.claude')} does not exist. Pass --home to scan another folder.`);
      return 1;
    }
    if (argv.includes('--json')) { process.stdout.write(JSON.stringify(await scan({ home, cwd: process.cwd(), since }), null, 1) + '\n'); return 0; }
    const { inventory, ms, file } = await scanAndSave(home, packlightRoot, since);
    console.log(summarize(inventory, ms));
    console.log(`\nInventory written to ${file}`);
    return 0;
  }

  if (command === 'apply') {
    let picksFile = positional(argv)[0] ?? (argv.includes('--paste') ? undefined : findPicksFile(downloadsDir(home)));
    if (argv.includes('--paste')) {
      // Picks copied from the report: written to packlight's own folder, then read like any picks file (still untrusted).
      const text = readClipboard();
      if (!text?.trim().startsWith('{')) { console.error('The clipboard holds no picks. In the report, press Copy picks, then run this again.'); return 2; }
      mkdirSync(packlightRoot, { recursive: true });
      picksFile = join(packlightRoot, 'pasted-picks.json');
      writeFileSync(picksFile, text);
    }
    if (picksFile && !existsSync(picksFile)) {
      console.error(`There is no file at ${picksFile}. Run \`${INVOKE} apply\` with no path to use the newest picks file in your downloads folder.`);
      return 2;
    }
    if (!picksFile) {
      console.error(`No picks file found in your downloads folder. Pass its path (packlight apply <file>), or press Copy picks in the report and run: ${PASTE_COMMAND}`);
      return 2;
    }
    const yes = argv.includes('--yes');
    if (!yes && !process.stdin.isTTY) { console.error('apply asks before it changes anything. Run it in a terminal, or pass --yes.'); return 2; }
    out(`Picks: ${picksFile}`);
    try {
      const r = await apply({ home, packlightRoot, picksFile, yes, confirm, claudeRunning: claudeCodeRunning, out, crash });
      if (r.archived.length || r.kept || r.unkept) out(`\n${MESSAGES.stepReport}`);
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
