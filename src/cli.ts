#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { apply, claudeCodeRunning, findPicksFile, readKeeps, STALE_PICKS } from './archive/apply.js';
import { downloadsDir, newestScan, packlightPaths, readScan } from './archive/paths.js';
import { archiveList, restore } from './archive/restore.js';
import { scan, scanCodex } from './core/scan.js';
import { codexPaths } from './adapters/codex/inventory.js';
import { INVOKE, MESSAGES, PASTE_COMMAND } from './core/messages.js';
import { summarize } from './core/summary.js';
import type { Agent, Inventory } from './core/types.js';
import { buildReport, CHARS_PER_TOKEN, loadTotal, sessionLoad } from './report/model.js';
import { fixPlan, type FixPlan } from './report/fix.js';
import { renderReport } from './report/render.js';
import { MIN_DAYS, MIN_SESSIONS, suggestions } from './report/suggest.js';

const USAGE = `packlight: see what your coding agent carries

Usage:
  packlight                 scan, write the report and open it
  packlight report [--scan <id>] [--no-open]
  packlight scan [--home <dir>] [--since <YYYY-MM-DD>] [--out <dir>] [--json]
  packlight fix [--yes]     archive everything suggested, after one question
  packlight apply [picks.json | --paste] [--yes] [--home <dir>] [--out <dir>]
  packlight restore <id…> | --all [--home <dir>] [--out <dir>]
  packlight archive list [--home <dir>] [--out <dir>]

  --agent  claude-code or codex (default: Claude Code when ~/.claude exists, else Codex)
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
  const withValue = new Set(['--home', '--out', '--since', '--agent']);
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
const AGENT_NAME: Record<Agent, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };
const setupDir = (agent: Agent, home: string): string => (agent === 'codex' ? codexPaths(home).root : join(home, '.claude'));

/** --agent, else Claude Code when its folder exists, else Codex when its folder exists. */
function pickAgent(argv: string[], home: string): Agent | null {
  const a = arg(argv, '--agent');
  if (a) return a === 'codex' || a === 'claude-code' ? a : null;
  return existsSync(join(home, '.claude')) || !existsSync(codexPaths(home).root) ? 'claude-code' : 'codex';
}

function noSetup(agent: Agent, home: string): number {
  console.error(`No ${AGENT_NAME[agent]} setup found: ${setupDir(agent, home)} does not exist. Pass --home to scan another folder${agent === 'codex' ? '' : ', or --agent codex for Codex'}.`);
  return 1;
}

function scopeFor(paths: ReturnType<typeof packlightPaths>, agent: Agent): string {
  try {
    const ids = readdirSync(paths.scans).sort().reverse();
    const scans = ids.map(i => readScan(paths, i)).filter((x): x is Inventory => !!x && x.agent === agent);
    const here = scans.find(s => s.projectScope !== 'global' && (process.cwd() === s.projectScope || process.cwd().startsWith(s.projectScope + sep)));
    return (here ?? scans[0])?.projectScope ?? 'global';
  } catch { return 'global'; }
}

/** One report file per agent, so a Codex scan never replaces the Claude Code report (or the other way round). */
const reportFile = (agent: Agent): string => (agent === 'codex' ? 'report-codex.html' : 'report-claude-code.html');

/** Writes the agent's report beside packlight's data and returns its path. */
function writeReport(home: string, packlightRoot: string, inv: Inventory): string {
  const paths = packlightPaths(home, packlightRoot);
  const file = join(packlightRoot, reportFile(inv.agent));
  mkdirSync(packlightRoot, { recursive: true });
  writeFileSync(file, renderReport(buildReport(inv, paths)));
  // Before 0.1, Claude Code's report was report.html: remove that copy so an old report is never opened by mistake.
  // Only packlight's own file goes (it carries packlight's data block); anything else at that name is left alone.
  const legacy = join(packlightRoot, 'report.html');
  if (inv.agent === 'claude-code' && existsSync(legacy)) {
    try { if (readFileSync(legacy, 'utf8').includes('id="packlight-data"')) unlinkSync(legacy); } catch { /* leave it */ }
  }
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

async function scanAndSave(home: string, packlightRoot: string, since: string | undefined, agent: Agent): Promise<{ inventory: Inventory; ms: number; file: string }> {
  const started = Date.now();
  const inventory = await (agent === 'codex' ? scanCodex : scan)({ home, cwd: process.cwd(), since });
  const dir = join(packlightRoot, 'scans', inventory.scanId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'inventory.json');
  writeFileSync(file, JSON.stringify(inventory));
  return { inventory, ms: Date.now() - started, file };
}

const KIND_WORD: Record<string, [string, string]> = { skill: ['skill', 'skills'], command: ['command', 'commands'], agent: ['agent', 'agents'], hook: ['hook', 'hooks'], plugin: ['plugin', 'plugins'], mcp: ['MCP server', 'MCP servers'] };
const count = (n: number, kind: string): string => `${n} ${KIND_WORD[kind]?.[n === 1 ? 0 : 1] ?? kind}`;
/** "about 2k tokens less per session (10% of your setup; 7.9k characters)": tokens estimated at CHARS_PER_TOKEN. */
const saving = (savedChars: number, setup: number): string => {
  const pct = setup ? Math.min(100, (savedChars / setup) * 100) : 0;
  return `about ${kchars(savedChars / CHARS_PER_TOKEN)} tokens less per session (${setup ? `${pct > 0 && pct < 1 ? 'under 1' : Math.round(pct)}% of your setup; ` : ''}${kchars(savedChars)} characters)`;
};
const kchars = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));

/** What the fix will do and buy, in the words the report uses for its Fix button. */
function fixSummary(plan: FixPlan, sessions: number, setup: number): string[] {
  if (!plan.ids.length) return ['Nothing to fix: no item passes the rules for archiving (unused since it was installed, over at least ' + `${MIN_SESSIONS} sessions and ${MIN_DAYS} days, not kept, not shared).`];
  const kinds = Object.entries(plan.byKind).map(([k, n]) => count(n!, k)).join(', ');
  const gains = [
    plan.descriptionsBack ? `${plan.descriptionsBack} skill${plan.descriptionsBack === 1 ? '' : 's'} get their description back in Claude's skill listing` : null,
    plan.sessionCharsSaved > 0 ? saving(plan.sessionCharsSaved, setup) : null,
  ].filter(Boolean);
  return [
    `\nFix: archive ${plan.ids.length} unused items (${kinds}${plan.turnsOff > plan.ids.length ? `; ${plan.turnsOff} items with plugin parts` : ''}).`,
    `None was used in the ${sessions} sessions scanned since it was installed. Everything can be restored.`,
    gains.length ? `Projected: ${gains.join('; ')}.` : 'Projected: little change in what Claude loads each session; this mostly clears unused items from your setup.',
  ];
}

function printByHand(plan: FixPlan, out: (line: string) => void, setup: number): void {
  const h = plan.byHand;
  if (!h?.items.length) return;
  const gains = [h.sessionCharsSaved > plan.sessionCharsSaved ? saving(h.sessionCharsSaved, setup) : null, h.descriptionsBack > plan.descriptionsBack ? `${h.descriptionsBack} skill descriptions back` : null].filter(Boolean);
  out(`\nAlso unused, but only you can remove these.${gains.length ? ` Removing them${plan.ids.length ? ' too' : ''}: ${gains.join(', ')}${plan.ids.length ? ' in all' : ''}.` : ''}`);
  const byWhere = new Map<string, typeof h.items>();
  for (const i of h.items) byWhere.set(i.where, [...(byWhere.get(i.where) ?? []), i]);
  for (const [where, list] of byWhere) out(`  ${where}: ${list.map(i => i.kind === 'plugin' ? `${i.name} (${i.turnsOff} parts)` : i.name).join(', ')}`);
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === '--help' || command === '-h' || command === 'help') { console.log(USAGE); return 0; }
  const home = arg(argv, '--home') ?? homedir();
  const packlightRoot = arg(argv, '--out') ?? join(home, '.packlight');
  const out = (line: string): void => console.log(line);
  const agent = pickAgent(argv, home);
  if (!agent) { console.error('--agent takes claude-code or codex.'); return 2; }

  if (!command || command.startsWith('--')) {
    if (!existsSync(setupDir(agent, home))) return noSetup(agent, home);
    const { inventory, ms } = await scanAndSave(home, packlightRoot, arg(argv, '--since'), agent);
    console.log(summarize(inventory, ms));
    const report = writeReport(home, packlightRoot, inventory);
    console.log(`\nReport: ${report}\n${MESSAGES.afterScan}`);
    if (!argv.includes('--no-open')) openFile(report);
    return 0;
  }

  if (command === 'report') {
    const id = arg(argv, '--scan');
    const paths = packlightPaths(home, packlightRoot);
    const inv = id ? readScan(paths, id) : newestScan(paths, agent, scopeFor(paths, agent));
    if (!inv) { console.error(id ? `No scan ${id} in ${paths.scans}.` : `No scan yet. Run \`${INVOKE}\` first.`); return 1; }
    const report = writeReport(home, packlightRoot, inv);
    console.log(`Report: ${report}`);
    if (!argv.includes('--no-open')) openFile(report);
    return 0;
  }

  if (command === 'scan') {
    const since = arg(argv, '--since');
    if (since && !/^\d{4}-\d{2}-\d{2}/.test(since)) { console.error('--since takes a date like 2026-08-01.'); return 2; }
    if (!existsSync(setupDir(agent, home))) return noSetup(agent, home);
    if (argv.includes('--json')) { process.stdout.write(JSON.stringify(await (agent === 'codex' ? scanCodex : scan)({ home, cwd: process.cwd(), since }), null, 1) + '\n'); return 0; }
    const { inventory, ms, file } = await scanAndSave(home, packlightRoot, since, agent);
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

  if (command === 'fix') {
    if (!existsSync(setupDir(agent, home))) return noSetup(agent, home);
    const yes = argv.includes('--yes');
    if (!yes && !process.stdin.isTTY) { console.error('fix asks before it changes anything. Run it in a terminal, or pass --yes.'); return 2; }
    // Always from a fresh scan: the plan never acts on an old picture of your setup.
    const { inventory } = await scanAndSave(home, packlightRoot, arg(argv, '--since'), agent);
    const paths = packlightPaths(home, packlightRoot);
    const kept = new Set(Object.keys(readKeeps(paths).keeps));
    const plan = fixPlan(inventory, suggestions(inventory, kept), kept);
    writeReport(home, packlightRoot, inventory);
    const load = sessionLoad(inventory);
    const setup = load ? loadTotal(load) : 0;
    if (load) out(`Each session starts with about ${kchars(setup / CHARS_PER_TOKEN)} tokens of setup (${kchars(setup)} characters).`);
    for (const line of fixSummary(plan, inventory.sessionsInWindow, setup)) out(line);
    if (!plan.ids.length) { printByHand(plan, out, setup); return 0; }
    mkdirSync(packlightRoot, { recursive: true });
    const picksFile = join(packlightRoot, `fix-picks-${inventory.scanId}.json`);
    writeFileSync(picksFile, JSON.stringify({ scanId: inventory.scanId, picks: plan.ids.map(id => ({ id, action: 'archive' })) }, null, 1));
    out('');
    try {
      const r = await apply({ home, packlightRoot, picksFile, yes, confirm, claudeRunning: claudeCodeRunning, out, crash, singleQuestion: `Archive these ${plan.ids.length} items?` });
      if (r.archived.length) {
        out(`\nDone. Undo everything with \`${INVOKE} restore --all\`, or one item with the restore command above.`);
        out(`${AGENT_NAME[agent]} reads its setup when a session starts: start a new session, then run \`${INVOKE}${agent === 'codex' ? ' --agent codex' : ''}\` to measure the result.`);
      }
      printByHand(plan, out, setup);
      return r.exitCode;
    } catch (err) {
      console.error(`packlight: ${(err as Error).message}`);
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
