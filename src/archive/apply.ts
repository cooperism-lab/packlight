import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { claudePaths, collectInventory } from '../adapters/claude-code/inventory.js';
import { codexPaths, collectCodexInventory } from '../adapters/codex/inventory.js';
import type { Inventory, Item, Kind, RemovalMethod } from '../core/types.js';
import { INVOKE } from '../core/messages.js';
import { atomicWrite, fileHash } from './fsops.js';
import { recover, type RecoveryResult } from './journal.js';
import { acquireLock } from './lock.js';
import { archiveStep, comparePointersDesc, type Outcome, type Step, type StepContext } from './methods.js';
import { newestScan, packlightPaths, readScan, type PacklightPaths } from './paths.js';

export type PickAction = 'archive' | 'keep' | 'unkeep';
export interface Picks { scanId: string; picks: { id: string; action: PickAction }[] }

export const STALE_PICKS = 'These picks are from an older scan. Re-open the newest report and save again.';

/**
 * A picks file is untrusted input (CEO F3): only a scan id and item ids with an action are read.
 * Paths, commands or anything else in the file are ignored.
 */
export function parsePicks(text: string): Picks {
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw new Error('The picks file is not valid JSON.'); }
  if (!raw || typeof raw.scanId !== 'string' || !Array.isArray(raw.picks)) throw new Error('The picks file has no scanId or picks list.');
  const picks = raw.picks
    .filter((p: any) => p && typeof p.id === 'string' && ['archive', 'keep', 'unkeep'].includes(p.action))
    .map((p: any) => ({ id: p.id, action: p.action as PickAction }));
  return { scanId: raw.scanId, picks };
}

/** The newest packlight-picks-*.json in a folder (the report saves there). */
export function findPicksFile(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  let names: string[];
  try { names = readdirSync(dir).filter(n => /^packlight-picks-.*\.json$/.test(n)); } catch { return undefined; }
  return names.map(n => join(dir, n)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** Claude Code may rewrite settings.json while packlight edits it (D21): warn when it is running. */
export function claudeCodeRunning(): boolean {
  try {
    const out = process.platform === 'win32'
      ? execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' })
      : execFileSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8' });
    return /(^|[\\/"])claude(\.exe)?("|\s|$)/im.test(out);
  } catch { return false; }
}

export interface ApplyOptions {
  home: string;
  packlightRoot?: string;
  picksFile: string;
  yes: boolean;
  confirm: (question: string) => Promise<boolean>;
  claudeRunning: () => boolean;
  out: (line: string) => void;
  now?: () => Date;
  crash?: (point: string) => void;
  /** Ask this one question for the whole plan instead of one per method group (packlight fix). */
  singleQuestion?: string;
}

export interface ApplyResult {
  exitCode: number;
  archived: { item: Item; opIds: string[] }[];
  refused: { item: Item; reason: string }[];
  unknownIds: string[];
  declined: RemovalMethod[];
  stillEffective: Item[];
  kept: number;
  unkept: number;
}

const KIND_PLURAL: Record<Kind, string> = { skill: 'skills', command: 'commands', agent: 'agents', hook: 'hooks', plugin: 'plugins', mcp: 'MCP servers', instructions: 'instruction files' };

const GROUP_TEXT: Record<RemovalMethod, (n: number) => string> = {
  move: n => `Move ${n} item${n === 1 ? '' : 's'} into packlight's archive`,
  'hook-extract': n => `Cut ${n} hook${n === 1 ? '' : 's'} out of their settings files`,
  'mcp-extract': n => `Cut ${n} MCP server${n === 1 ? '' : 's'} out of their config files`,
  'plugin-disable': n => `Turn off ${n} plugin${n === 1 ? '' : 's'}`,
  manual: n => `Record ${n} item${n === 1 ? '' : 's'} you remove by hand`,
};

export function reportRecovery(r: RecoveryResult, out: (l: string) => void): void {
  for (const x of r.completed) out(`Recovered: finished an interrupted ${x}.`);
  for (const x of r.rolledBack) out(`Recovered: rolled back an interrupted ${x}.`);
  for (const x of r.refused) out(`Recovery stopped: ${x.direction} ${x.opId} left ${x.files.join(', ')} in a state packlight did not expect. Nothing was changed; check those files by hand.`);
}

const existingRoots = (inv: Inventory): string[] => inv.projects.filter(p => existsSync(p.root)).map(p => p.root);
/** The setup as it is now, read by the same adapter that made the scan. */
const readNow = (inv: Inventory, home: string): Item[] => (inv.agent === 'codex' ? collectCodexInventory(codexPaths(home), existingRoots(inv)) : collectInventory(claudePaths(home), existingRoots(inv)));

/** Builds the steps for one item from its current declarations (eng X2: every place it is switched on). */
function stepsFor(item: Item, home: string): Step[] {
  switch (item.removal.method) {
    case 'move': return item.path ? [{ method: 'move', item, path: item.path }] : [];
    case 'hook-extract':
    case 'mcp-extract':
      return item.declarations.filter(d => d.pointer).map(d => ({ method: item.removal.method as 'hook-extract' | 'mcp-extract', item, file: d.file, pointer: d.pointer! }));
    case 'plugin-disable': {
      const key = item.plugin ?? item.name;
      const on = item.declarations.filter(d => d.pointer?.startsWith('/enabledPlugins/') && d.enabled !== false);
      if (on.length) return on.map(d => ({ method: 'plugin-disable', item, file: d.file, pointer: d.pointer!, key }));
      // Installed but never declared means enabled: turn it off in user settings.
      return item.enabled ? [{ method: 'plugin-disable', item, file: join(claudePaths(home).claude, 'settings.json'), pointer: `/enabledPlugins/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, key }] : [];
    }
    case 'manual': return [{ method: 'manual', item, where: item.removal.where ?? 'the app it came from' }];
  }
}

export async function apply(opts: ApplyOptions): Promise<ApplyResult> {
  const paths = packlightPaths(opts.home, opts.packlightRoot);
  const now = opts.now ?? (() => new Date());
  const out = opts.out;
  const result: ApplyResult = { exitCode: 0, archived: [], refused: [], unknownIds: [], declined: [], stillEffective: [], kept: 0, unkept: 0 };

  // Recovery and every change happen under the lock, so one run never rolls back another's work in progress.
  const release = acquireLock(paths.lock);
  try {
    return await applyLocked(opts, paths, now, out, result);
  } finally { release(); }
}

async function applyLocked(opts: ApplyOptions, paths: PacklightPaths, now: () => Date, out: (l: string) => void, result: ApplyResult): Promise<ApplyResult> {
  const recovery = recover(paths);
  reportRecovery(recovery, out);
  if (recovery.refused.length) return { ...result, exitCode: 1 };

  const picks = parsePicks(readFileSync(opts.picksFile, 'utf8'));
  const inv = readScan(paths, picks.scanId);
  if (!inv) throw new Error(`These picks name scan ${picks.scanId}, which packlight does not have. Run \`${INVOKE}\` and save your picks again.`);
  if (newestScan(paths, inv.agent, inv.projectScope)?.scanId !== picks.scanId) throw new Error(STALE_PICKS);

  const byId = new Map(inv.items.map(i => [i.id, i]));
  result.unknownIds = picks.picks.filter(p => !byId.has(p.id)).map(p => p.id);
  for (const id of result.unknownIds) out(`Skipped ${id}: not an item in scan ${picks.scanId}.`);

  // The current state of every item, read fresh: a target that changed since the scan is refused (eng X1).
  const fresh = new Map(readNow(inv, opts.home).map(i => [i.id, i]));
  // Baseline hashes are taken now, with the inventory the plan is built from, not after the questions (CEO F2).
  const baseline = new Map<string, string | null>();
  for (const i of fresh.values()) for (const d of i.declarations) if (d.pointer && !baseline.has(d.file)) baseline.set(d.file, fileHash(d.file));
  baseline.set(join(claudePaths(opts.home).claude, 'settings.json'), fileHash(join(claudePaths(opts.home).claude, 'settings.json')));

  // Plugins are the removal unit for everything they bundle (CEO O3).
  const pluginOf = (i: Item): Item => (i.plugin && i.kind !== 'plugin' ? inv.items.find(p => p.kind === 'plugin' && p.plugin === i.plugin) ?? i : i);
  const targets = new Map<string, Item>();
  for (const p of picks.picks.filter(p => p.action === 'archive' && byId.has(p.id))) {
    const t = pluginOf(byId.get(p.id)!);
    targets.set(t.id, t);
  }

  const plan: { item: Item; steps: Step[] }[] = [];
  for (const t of targets.values()) {
    const cur = fresh.get(t.id);
    if (!cur) { result.refused.push({ item: t, reason: 'It is no longer installed (already archived or removed).' }); continue; }
    if (cur.targetFingerprint !== t.targetFingerprint) { result.refused.push({ item: t, reason: 'It changed since you reviewed it. Scan again and re-mark it.' }); continue; }
    const steps = stepsFor(cur, opts.home);
    if (!steps.length) { result.refused.push({ item: t, reason: 'It is already turned off everywhere.' }); continue; }
    plan.push({ item: cur, steps });
  }
  const keeps = picks.picks.filter(p => p.action === 'keep' && byId.has(p.id));
  const unkeeps = picks.picks.filter(p => p.action === 'unkeep' && byId.has(p.id));

  // Show the plan grouped by method.
  const groups = new Map<RemovalMethod, { item: Item; steps: Step[] }[]>();
  for (const p of plan) { const m = p.item.removal.method; groups.set(m, [...(groups.get(m) ?? []), p]); }
  out(`Plan for scan ${picks.scanId}:`);
  for (const [method, list] of groups) {
    out(`\n${GROUP_TEXT[method](list.length)}:`);
    for (const { item, steps } of list) {
      const impact = item.kind === 'plugin' && item.members && Object.keys(item.members).length ? ` (${Object.entries(item.members).map(([k, n]) => `${n} ${n === 1 ? k : KIND_PLURAL[k as Kind]}`).join(', ')})` : '';
      const where = steps.map(s => ('file' in s ? s.file : 'path' in s ? s.path : s.where)).join('; ');
      out(`  ${item.name}${impact}  ${where}`);
    }
  }
  if (keeps.length || unkeeps.length) out(`\nKeep: ${keeps.length} item${keeps.length === 1 ? '' : 's'}${unkeeps.length ? `, clear ${unkeeps.length} keep${unkeeps.length === 1 ? '' : 's'}` : ''} (no change to your setup)`);
  for (const r of result.refused) out(`\nNot archived: ${r.item.name}. ${r.reason}`);

  const touchesSettings = plan.some(p => p.steps.some(s => 'file' in s));
  if (touchesSettings && opts.claudeRunning()) {
    out(`\n${inv.agent === 'codex' ? 'Codex' : 'Claude Code'} is running. It can rewrite its settings files while packlight edits them; packlight checks each file just before writing, but a write in the same instant could still be lost.`);
    if (!opts.yes && !opts.singleQuestion && !(await opts.confirm('Continue anyway?'))) { out('Stopped. Nothing was changed.'); return { ...result, exitCode: 1 }; }
  }
  if (opts.singleQuestion && plan.length && !opts.yes && !(await opts.confirm(`\n${opts.singleQuestion}`))) {
    out('Stopped. Nothing was changed.');
    return { ...result, exitCode: 1 };
  }

  // One question per method group (acceptance criterion 7); "no" leaves that group untouched.
  const approved: { item: Item; steps: Step[] }[] = [];
  for (const [method, list] of groups) {
    if (opts.yes || opts.singleQuestion || (await opts.confirm(`${GROUP_TEXT[method](list.length)}?`))) approved.push(...list);
    else result.declined.push(method);
  }

  const refusedBeforeRun = result.refused.length;
  {
    const ctx: StepContext = { paths, scanId: picks.scanId, now, expectedHash: new Map(), crash: opts.crash ?? (() => {}) };
    const steps = approved.flatMap(p => p.steps);
    for (const s of steps) if ('file' in s && !ctx.expectedHash.has(s.file)) ctx.expectedHash.set(s.file, baseline.has(s.file) ? baseline.get(s.file)! : fileHash(s.file));
    // Settings edits first, per file with the deepest pointers first so array removals never shift later ones.
    const ordered = [
      ...steps.filter((s): s is Extract<Step, { file: string }> => 'file' in s).sort((a, b) => a.file.localeCompare(b.file) || comparePointersDesc(a.pointer, b.pointer)),
      ...steps.filter(s => s.method === 'move'),
      ...steps.filter(s => s.method === 'manual'),
    ];
    const outcomes = new Map<string, { item: Item; opIds: string[]; failures: string[] }>();
    for (const s of ordered) {
      const o: Outcome = archiveStep(ctx, s);
      const rec = outcomes.get(s.item.id) ?? { item: s.item, opIds: [], failures: [] };
      if (o.ok) rec.opIds.push(o.opId); else rec.failures.push(o.reason);
      outcomes.set(s.item.id, rec);
      log(paths, `${now().toISOString()} archive ${s.method} ${s.item.id} ${o.ok ? `ok ${o.opId}` : `refused: ${o.reason}`}`);
    }
    for (const r of outcomes.values()) {
      if (r.opIds.length) result.archived.push({ item: r.item, opIds: r.opIds });
      for (const f of r.failures) result.refused.push({ item: r.item, reason: f });
    }
    const k = writeKeeps(paths, keeps.map(p => byId.get(p.id)!), unkeeps.map(p => p.id), now());
    result.kept = k.kept;
    result.unkept = k.unkept;
  }

  // Verify against a fresh read that each archived item is no longer in effect (eng X2).
  const after = new Map(readNow(inv, opts.home).map(i => [i.id, i]));
  for (const { item } of result.archived) {
    const a = after.get(item.id);
    if (!a || item.removal.method === 'manual') continue;
    const stillOn = item.removal.method === 'plugin-disable' ? a.enabled || a.declarations.some(d => d.pointer?.startsWith('/enabledPlugins/') && d.enabled !== false) : true;
    if (stillOn) result.stillEffective.push(item);
  }

  out('');
  for (const a of result.archived) out(`Archived ${a.item.name}${a.item.removal.method === 'manual' ? ' (remove it by hand: ' + (a.item.removal.where ?? '') + ')' : ''}. Restore: ${INVOKE} restore ${a.opIds.join(' ')}`);
  for (const r of result.refused.slice(refusedBeforeRun)) out(`Refused ${r.item.name}: ${r.reason}`);
  for (const s of result.stillEffective) out(`Still in effect after apply: ${s.name}. Another settings file may switch it on; scan to see where.`);
  if (result.kept || result.unkept) out(`Kept ${result.kept} item${result.kept === 1 ? '' : 's'}${result.unkept ? `, cleared ${result.unkept} keep${result.unkept === 1 ? '' : 's'}` : ''}.${result.archived.length ? '' : ' Nothing archived.'}`);
  if (result.declined.length) out(`Skipped at your answer: ${result.declined.map(m => GROUP_TEXT[m](groups.get(m)!.length).toLowerCase()).join('; ')}.`);
  result.exitCode = result.refused.length || result.stillEffective.length ? 1 : 0;
  return result;
}

function log(paths: PacklightPaths, line: string): void {
  mkdirSync(paths.root, { recursive: true });
  appendFileSync(paths.log, line + '\n');
}

interface KeepsFile { version: 1; keeps: Record<string, { name: string; keptAt: string; fingerprintAtKeep: string }> }

export function readKeeps(paths: PacklightPaths): KeepsFile {
  try { return JSON.parse(readFileSync(paths.keeps, 'utf8')) as KeepsFile; } catch { return { version: 1, keeps: {} }; }
}

/** Keeps are written without a prompt (DE3), keyed by item id with the fingerprint at keep time (DE2), and cleared by unkeep (DE10). */
function writeKeeps(paths: PacklightPaths, keep: Item[], unkeep: string[], now: Date): { kept: number; unkept: number } {
  if (!keep.length && !unkeep.length) return { kept: 0, unkept: 0 };
  const f = readKeeps(paths);
  for (const i of keep) f.keeps[i.id] = { name: i.name, keptAt: now.toISOString(), fingerprintAtKeep: i.targetFingerprint };
  let unkept = 0;
  for (const id of unkeep) if (id in f.keeps) { delete f.keeps[id]; unkept++; }
  atomicWrite(paths.keeps, JSON.stringify(f, null, 1) + '\n');
  log(paths, `${now.toISOString()} keeps +${keep.length} -${unkept}`);
  return { kept: keep.length, unkept };
}
