import { describe, expect, it } from 'vitest';
import type { Inventory, Item, SessionRecord } from '../../src/core/types.js';
import { simulateListing, suggestions } from '../../src/report/suggest.js';

const SCAN = '2026-10-01T00:00:00.000Z';
const DAY = 86_400_000;
const daysBefore = (d: number): string => new Date(Date.parse(SCAN) - d * DAY).toISOString();

const session = (i: number, daysAgo: number, projectRoot: string | null = null, unreadableLines = 0): SessionRecord => ({
  id: `s${i}`, file: `s${i}.jsonl`, projectRoot, start: daysBefore(daysAgo), end: daysBefore(daysAgo), lines: 10, unknownShapeLines: 0, unreadableLines, versions: [],
});

let n = 0;
const item = (over: Partial<Item> = {}): Item => ({
  id: `i${n++}`, agent: 'claude-code', kind: 'skill', name: `skill-${n}`, source: 'personal', path: '/x', projectRoot: null, enabled: true,
  description: '', descHash: '', standingChars: 50, targetFingerprint: '', firstSeen: daysBefore(60), firstSeenSource: 'birthtime', logKeys: [],
  declarations: [], removal: { method: 'move' }, usage: { total: 0, last30: 0, lastUsed: null, byProject: {}, ambiguous: false, uncertain: false }, ...over,
});

const inventory = (items: Item[], sessions: SessionRecord[]): Inventory => ({
  schemaVersion: 1, scanId: 's', agent: 'claude-code', createdAt: SCAN, home: '/h', projectScope: 'global', window: { from: daysBefore(60), to: SCAN },
  sessionsInWindow: sessions.length, linesTotal: 0, linesUnknownShape: 0, linesUnreadable: 0, claudeCodeVersions: [], coverage: { uncertain: false, reasons: [] },
  projects: [], sessions, budget: {}, unattributedHookChars: 0, items,
});

const thirtySessions = Array.from({ length: 30 }, (_, i) => session(i, 50 - i));

describe('suggestions (design DR6, eng delta DE1, DE5-DE7)', () => {
  it('suggests an unused item installed long enough ago', () => {
    const it0 = item();
    expect(suggestions(inventory([it0], thirtySessions), new Set()).get(it0.id)).toMatchObject({ suggested: true, windowSessions: 30 });
  });

  it('counts only sessions since the item was installed (DE5)', () => {
    const fresh = item({ firstSeen: daysBefore(3) });
    expect(suggestions(inventory([fresh], thirtySessions), new Set()).get(fresh.id)).toMatchObject({ suggested: false, reason: 'too-new' });
    const fewSessions = item({ firstSeen: daysBefore(25) });
    expect(suggestions(inventory([fewSessions], thirtySessions), new Set()).get(fewSessions.id)).toMatchObject({ suggested: false, reason: 'too-few-sessions' });
  });

  it('never suggests an item with unreadable lines inside its window (DE6)', () => {
    const it0 = item();
    const gappy = [...thirtySessions.slice(1), session(99, 10, null, 2)];
    expect(suggestions(inventory([it0], gappy), new Set()).get(it0.id)).toMatchObject({ suggested: false, reason: 'parse-gaps', unreadableLines: 2 });
  });

  it('judges a global item by its use in any project (DE1)', () => {
    const usedElsewhere = item({ usage: { total: 3, last30: 3, lastUsed: SCAN, byProject: { '/other': { total: 3, lastUsed: SCAN } }, ambiguous: false, uncertain: false } });
    expect(suggestions(inventory([usedElsewhere], thirtySessions), new Set()).get(usedElsewhere.id)).toMatchObject({ suggested: false, reason: 'used' });
  });

  it('judges a project item only by the sessions in its project', () => {
    const proj = item({ projectRoot: '/p' });
    const sessions = [...thirtySessions, ...Array.from({ length: 5 }, (_, i) => session(100 + i, 40 - i, '/p'))];
    expect(suggestions(inventory([proj], sessions), new Set()).get(proj.id)).toMatchObject({ suggested: false, reason: 'too-few-sessions', windowSessions: 5 });
  });

  it('suggests a plugin child only when the whole plugin could go (DE7)', () => {
    const plugin = item({ kind: 'plugin', name: 'kit', plugin: 'kit@m', removal: { method: 'plugin-disable' } });
    const unused = item({ plugin: 'kit@m', removal: { method: 'plugin-disable' } });
    const used = item({ plugin: 'kit@m', removal: { method: 'plugin-disable' }, usage: { total: 1, last30: 1, lastUsed: SCAN, byProject: {}, ambiguous: false, uncertain: false } });
    plugin.usage.total = 1;
    const s = suggestions(inventory([plugin, unused, used], thirtySessions), new Set());
    expect(s.get(unused.id)).toMatchObject({ suggested: false, reason: 'plugin-in-use' });
    expect(s.get(plugin.id)!.suggested).toBe(false);
  });

  it('a kept part protects its whole plugin from suggestion (DE7)', () => {
    const plugin = item({ kind: 'plugin', plugin: 'kit@m', removal: { method: 'plugin-disable' } });
    const kept = item({ plugin: 'kit@m', removal: { method: 'plugin-disable' } });
    const other = item({ plugin: 'kit@m', removal: { method: 'plugin-disable' } });
    const s = suggestions(inventory([plugin, kept, other], thirtySessions), new Set([kept.id]));
    expect(s.get(plugin.id)).toMatchObject({ suggested: false, reason: 'kept' });
    expect(s.get(other.id)!.suggested).toBe(false);
  });

  it('never suggests ambiguous, uncertain, kept, manual, off or always-loaded items', () => {
    const cases: [Partial<Item>, string][] = [
      [{ usage: { total: 0, last30: 0, lastUsed: null, byProject: {}, ambiguous: true, uncertain: false } }, 'ambiguous'],
      [{ usage: { total: 0, last30: 0, lastUsed: null, byProject: {}, ambiguous: false, uncertain: true } }, 'uncertain'],
      [{ removal: { method: 'manual', where: 'claude.ai' } }, 'manual'],
      [{ enabled: false }, 'off'],
      [{ kind: 'instructions' }, 'not-removable'],
      [{ name: 'packlight' }, 'not-removable'],
    ];
    for (const [over, reason] of cases) {
      const it0 = item(over);
      expect(suggestions(inventory([it0], thirtySessions), new Set()).get(it0.id)).toMatchObject({ suggested: false, reason });
    }
    const kept = item();
    expect(suggestions(inventory([kept], thirtySessions), new Set([kept.id])).get(kept.id)).toMatchObject({ suggested: false, reason: 'kept' });
  });
});

describe('listing projection (matches Claude Code 2.1.29x listings)', () => {
  const e = (name: string, fullChars: number, priority = false) => ({ name, fullChars, nameChars: 10, priority });

  it('counts every name, then fills descriptions for used skills first, then the rest in order while they fit', () => {
    // Names: 4 × 10 = 40. Budget 200 leaves 160: "d" (used, +90) first, then "a" (+50) fits, "b" (+90) does not, "c" (+10) still does.
    const r = simulateListing([e('a', 60), e('b', 100), e('c', 20), e('d', 100, true)], 200);
    expect(r.describedNames).toEqual(['d', 'a', 'c']);
    expect(r).toMatchObject({ chars: 190, described: 3, dropped: 1 });
  });

  it('brings descriptions back when skills ahead of them go', () => {
    expect(simulateListing([e('b', 100), e('c', 20)], 200).dropped).toBe(0);
  });

  it('never describes an entry with no description to show', () => {
    expect(simulateListing([e('init', 10)], 1000)).toMatchObject({ described: 0, dropped: 1 });
  });
});
