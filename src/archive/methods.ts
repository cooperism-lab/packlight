import { lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sha256, valueFingerprint } from '../core/hash.js';
import type { Item } from '../core/types.js';
import { atomicWrite, ChangedWhileMoving, exists, fileHash, moveTree, SourceNotRemoved, stagingPathFor, stateOf } from './fsops.js';
import { journalBegin, journalEnd, setManifestStatus, writeManifest } from './journal.js';
import { newOpId, type Manifest } from './manifest.js';
import type { PacklightPaths } from './paths.js';

export type Step =
  | { method: 'move'; item: Item; path: string }
  | { method: 'hook-extract' | 'mcp-extract'; item: Item; file: string; pointer: string }
  | { method: 'plugin-disable'; item: Item; file: string; pointer: string; key: string }
  | { method: 'manual'; item: Item; where: string };

export interface StepContext {
  paths: PacklightPaths;
  scanId: string;
  now: () => Date;
  /** Hash each settings file is expected to have before packlight's next write to it (CEO F2). */
  expectedHash: Map<string, string | null>;
  /** Test hook that stops the process at a named point, as a kill -9 would (eng X3 fault injection). */
  crash: (point: string) => void;
}

export type Outcome = { ok: true; opId: string } | { ok: false; reason: string; fragment?: unknown; file?: string };

// ---------------------------------------------------------------- JSON pointers

export const parsePointer = (p: string): string[] => p.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));

/** Sorts pointers so later array indices come first: removing them never shifts the ones still to do. */
export function comparePointersDesc(a: string, b: string): number {
  const pa = parsePointer(a);
  const pb = parsePointer(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isInteger(nx) && Number.isInteger(ny)) return ny - nx;
    return y.localeCompare(x);
  }
  return 0;
}

/** Re-serialises JSON in the file's own indentation and line ending, keeping a trailing newline if it had one. */
function serialize(value: unknown, original: string | null): string {
  const indent = original ? (/\n([ \t]+)"/.exec(original)?.[1] ?? '  ') : '  ';
  const eol = original?.includes('\r\n') ? '\r\n' : '\n';
  const text = JSON.stringify(value, null, indent).replace(/\n/g, eol);
  return original === null || /\r?\n$/.test(original) ? text + eol : text;
}

function edit(step: Exclude<Step, { method: 'move' | 'manual' }>, json: any): { next: any; fragment: unknown } {
  const seg = parsePointer(step.pointer);
  if (step.method === 'plugin-disable') {
    const next = json && typeof json === 'object' ? json : {};
    next.enabledPlugins ??= {};
    const was = step.key in next.enabledPlugins ? next.enabledPlugins[step.key] : null;
    next.enabledPlugins[step.key] = false;
    return { next, fragment: { [step.key]: was } };
  }
  if (step.method === 'mcp-extract') {
    let parent = json;
    for (const s of seg.slice(0, -1)) parent = parent?.[s];
    const name = seg[seg.length - 1]!;
    if (!parent || typeof parent !== 'object' || !(name in parent)) throw new Error(`${step.pointer} is no longer in ${step.file}`);
    if (valueFingerprint(parent[name]) !== step.item.targetFingerprint) throw new Error(NOT_THE_PICKED(step));
    const fragment = { [name]: parent[name] };
    delete parent[name];
    return { next: json, fragment };
  }
  // hook-extract: /hooks/<event>/<group>/hooks/<index>; empty groups and events are removed with it.
  const [, event, gi, , hi] = seg;
  const groups = json?.hooks?.[event!];
  const group = Array.isArray(groups) ? groups[Number(gi)] : undefined;
  const hooks = group?.hooks;
  if (!Array.isArray(hooks) || hooks[Number(hi)] === undefined) throw new Error(`${step.pointer} is no longer in ${step.file}`);
  // The entry at the pointer must still be the one that was picked: settings files get reordered by other programs.
  if (valueFingerprint({ event, matcher: group.matcher ?? null, command: hooks[Number(hi)]?.command }) !== step.item.targetFingerprint) throw new Error(NOT_THE_PICKED(step));
  const [removed] = hooks.splice(Number(hi), 1);
  if (!hooks.length) groups.splice(Number(gi), 1);
  if (!groups.length) delete json.hooks[event!];
  return { next: json, fragment: { event, matcher: group.matcher ?? null, hook: removed } };
}

const NOT_THE_PICKED = (step: { file: string; pointer: string }): string =>
  `The entry at ${step.pointer} in ${step.file} is no longer the one you picked (the file was reordered). Nothing was changed; scan and apply again.`;

const base = (ctx: StepContext, item: Item, method: Manifest['method'], opId: string): Manifest => ({
  manifestVersion: 1, opId, itemId: item.id, itemName: item.name, kind: item.kind, agent: item.agent, method,
  scanId: ctx.scanId, archivedAt: ctx.now().toISOString(), status: 'archived',
});

// ---------------------------------------------------------------- archive

export function archiveStep(ctx: StepContext, step: Step): Outcome {
  if (step.method === 'manual') {
    const opId = newOpId(ctx.now());
    writeManifest(ctx.paths, { ...base(ctx, step.item, 'manual', opId), status: 'waiting', manualSteps: `Remove it in ${step.where}.` });
    return { ok: true, opId };
  }
  return step.method === 'move' ? archiveMove(ctx, step) : archiveSettings(ctx, step);
}

function archiveMove(ctx: StepContext, step: Extract<Step, { method: 'move' }>): Outcome {
  if (!exists(step.path)) return { ok: false, reason: `It is no longer at ${step.path}.` };
  const opId = newOpId(ctx.now());
  const payloadPath = join(ctx.paths.archive, opId, 'payload', basename(step.path));
  const st = lstatSync(step.path);
  const fp = stateOf(step.path);
  journalBegin(ctx.paths, {
    opId, direction: 'archive',
    paths: [
      { path: step.path, kind: 'tree', before: fp, after: 'missing' },
      { path: payloadPath, kind: 'tree', before: 'missing', after: fp },
      { path: stagingPathFor(payloadPath), kind: 'tree', before: 'missing', after: 'missing', scratch: true },
    ],
  });
  ctx.crash('archive:after-journal');
  writeManifest(ctx.paths, {
    ...base(ctx, step.item, 'move', opId), originalPath: step.path, payloadPath, isSymlink: st.isSymbolicLink(),
    ...(st.isSymbolicLink() ? { symlinkTarget: readlinkSync(step.path) } : {}), fingerprint: fp,
  });
  ctx.crash('archive:after-manifest');
  try { moveTree(step.path, payloadPath); } catch (err) {
    if (err instanceof SourceNotRemoved) {
      // The archive holds a complete, verified copy; part of the original is still in place. Keep both.
      journalEnd(ctx.paths, opId, 'archive', 'done');
      return { ok: false, reason: `${err.message} Delete what is left at ${step.path} by hand, or restore with \`packlight restore ${opId}\` once it is gone.` };
    }
    journalEnd(ctx.paths, opId, 'archive', 'aborted');
    rmSync(join(ctx.paths.archive, opId), { recursive: true, force: true });
    return { ok: false, reason: err instanceof ChangedWhileMoving ? err.message : `Could not move it: ${(err as Error).message}` };
  }
  ctx.crash('archive:after-change');
  // A same-volume rename does not re-check content: record what actually arrived so restore can verify it.
  const arrived = stateOf(payloadPath);
  if (arrived !== fp) writeManifest(ctx.paths, { ...base(ctx, step.item, 'move', opId), originalPath: step.path, payloadPath, isSymlink: st.isSymbolicLink(), ...(st.isSymbolicLink() ? { symlinkTarget: readlinkSync(payloadPath) } : {}), fingerprint: arrived, note: 'It changed between the plan and the move; the archived copy is the changed version.' });
  journalEnd(ctx.paths, opId, 'archive', 'done');
  return { ok: true, opId };
}

function archiveSettings(ctx: StepContext, step: Exclude<Step, { method: 'move' | 'manual' }>): Outcome {
  const original = readOrNull(step.file);
  const h = original === null ? null : sha256(original);
  if (ctx.expectedHash.has(step.file) && ctx.expectedHash.get(step.file) !== h) {
    return { ok: false, reason: `${step.file} changed after packlight read it (another program wrote to it). Nothing was changed; scan and apply again.`, file: step.file };
  }
  let next: unknown;
  let fragment: unknown;
  try {
    ({ next, fragment } = edit(step, original === null ? {} : JSON.parse(original.toString('utf8').replace(/^﻿/, ''))));
  } catch (err) {
    return { ok: false, reason: (err as Error).message, file: step.file };
  }
  const text = serialize(next, original?.toString('utf8') ?? null);
  const h2 = sha256(text);
  const opId = newOpId(ctx.now());
  journalBegin(ctx.paths, { opId, direction: 'archive', paths: [{ path: step.file, kind: 'file', before: h, after: h2 }] });
  ctx.crash('archive:after-journal');
  writeManifest(ctx.paths, {
    ...base(ctx, step.item, step.method, opId), settingsFile: step.file, jsonPointer: step.pointer, fragment,
    originalFileBase64: original === null ? null : original.toString('base64'), fileHashBefore: h, fileHashAfter: h2,
    ...(step.method === 'plugin-disable' ? { plugin: { key: step.key, wasEnabled: (fragment as Record<string, boolean | null>)[step.key] ?? null } } : {}),
  });
  ctx.crash('archive:after-manifest');
  // Re-hash right before writing: this narrows, but cannot close, the window in which Claude Code itself writes (CEO O4).
  if (fileHash(step.file) !== h) {
    journalEnd(ctx.paths, opId, 'archive', 'aborted');
    rmSync(join(ctx.paths.archive, opId), { recursive: true, force: true });
    return { ok: false, reason: `${step.file} changed while packlight was preparing to edit it. Nothing was changed; apply again.`, file: step.file };
  }
  atomicWrite(step.file, text);
  ctx.crash('archive:after-change');
  journalEnd(ctx.paths, opId, 'archive', 'done');
  ctx.expectedHash.set(step.file, h2);
  return { ok: true, opId };
}

const readOrNull = (p: string): Buffer | null => {
  try { return readFileSync(p); } catch (err: any) { if (err?.code === 'ENOENT') return null; throw err; }
};

// ---------------------------------------------------------------- restore

export function restoreManifest(ctx: StepContext, m: Manifest): Outcome {
  if (m.status === 'restored') return { ok: false, reason: 'It was already restored.' };
  if (m.method === 'manual' || m.status === 'waiting') return { ok: false, reason: `It was removed by hand. Add it back where it was removed: ${m.manualSteps ?? 'see the manifest'}` };
  return m.method === 'move' ? restoreMove(ctx, m) : restoreSettings(ctx, m);
}

function restoreMove(ctx: StepContext, m: Manifest): Outcome {
  const orig = m.originalPath!;
  const payload = m.payloadPath!;
  if (exists(orig)) return { ok: false, reason: `Something is already at ${orig}. packlight will not overwrite it; move it aside and restore again.` };
  const fp = stateOf(payload);
  if (fp !== m.fingerprint) return { ok: false, reason: `The archived copy at ${payload} no longer matches its record, so it was not restored.` };
  journalBegin(ctx.paths, {
    opId: m.opId, direction: 'restore',
    paths: [
      { path: orig, kind: 'tree', before: 'missing', after: fp },
      { path: payload, kind: 'tree', before: fp, after: 'missing' },
      { path: stagingPathFor(orig), kind: 'tree', before: 'missing', after: 'missing', scratch: true },
    ],
  });
  ctx.crash('restore:after-journal');
  try { moveTree(payload, orig); } catch (err) {
    if (err instanceof SourceNotRemoved) {
      // The item is back and verified; only the archived copy could not be fully deleted.
      setManifestStatus(ctx.paths, m.opId, 'restored');
      journalEnd(ctx.paths, m.opId, 'restore', 'done');
      return { ok: true, opId: m.opId };
    }
    journalEnd(ctx.paths, m.opId, 'restore', 'aborted');
    return { ok: false, reason: `Could not move it back: ${(err as Error).message}` };
  }
  ctx.crash('restore:after-change');
  setManifestStatus(ctx.paths, m.opId, 'restored');
  journalEnd(ctx.paths, m.opId, 'restore', 'done');
  return { ok: true, opId: m.opId };
}

function restoreSettings(ctx: StepContext, m: Manifest): Outcome {
  const file = m.settingsFile!;
  const cur = fileHash(file);
  // Byte-exact restore only (D12): a file edited since the archive is left alone, and the fragment is printed.
  if (cur !== m.fileHashAfter) {
    return { ok: false, file, fragment: m.fragment, reason: `${file} has changed since packlight archived this, so packlight did not touch it. Put this back at ${m.jsonPointer} by hand:` };
  }
  journalBegin(ctx.paths, { opId: m.opId, direction: 'restore', paths: [{ path: file, kind: 'file', before: cur, after: m.fileHashBefore ?? null }] });
  ctx.crash('restore:after-journal');
  if (m.originalFileBase64 === null || m.originalFileBase64 === undefined) rmSync(file, { force: true });
  else atomicWrite(file, Buffer.from(m.originalFileBase64, 'base64'));
  ctx.crash('restore:after-change');
  setManifestStatus(ctx.paths, m.opId, 'restored');
  journalEnd(ctx.paths, m.opId, 'restore', 'done');
  return { ok: true, opId: m.opId };
}
