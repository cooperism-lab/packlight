#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scan } from './core/scan.js';
import { summarize } from './core/summary.js';

const USAGE = `packlight: see what your coding agent carries

Usage:
  packlight scan [--home <dir>] [--since <YYYY-MM-DD>] [--out <dir>] [--json]

  --home   home folder to scan (default: your home folder)
  --since  only count sessions from this date
  --out    where scans are written (default: <home>/.packlight)
  --json   print the inventory to stdout instead of a summary`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (!command || command === '--help' || command === '-h') { console.log(USAGE); return 0; }
  if (command !== 'scan') { console.error(`Unknown command "${command}".\n\n${USAGE}`); return 2; }

  const home = arg(argv, '--home') ?? homedir();
  const since = arg(argv, '--since');
  if (since && !/^\d{4}-\d{2}-\d{2}/.test(since)) { console.error('--since takes a date like 2026-08-01.'); return 2; }
  if (!existsSync(join(home, '.claude'))) {
    console.error(`No Claude Code setup found: ${join(home, '.claude')} does not exist. Pass --home to scan another folder.`);
    return 1;
  }
  const started = Date.now();
  const inventory = await scan({ home, cwd: process.cwd(), since });

  if (argv.includes('--json')) { process.stdout.write(JSON.stringify(inventory, null, 1) + '\n'); return 0; }

  const outRoot = arg(argv, '--out') ?? join(home, '.packlight');
  const dir = join(outRoot, 'scans', inventory.scanId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'inventory.json');
  writeFileSync(file, JSON.stringify(inventory));
  console.log(summarize(inventory, Date.now() - started));
  console.log(`\nInventory written to ${file}`);
  return 0;
}

main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => {
  console.error(`packlight: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
