import { describe, expect, it } from 'vitest';
import type { BudgetObservation, Inventory, Item, SessionRecord } from '../../src/core/types.js';
import { fixPlan } from '../../src/report/fix.js';
import { suggestions } from '../../src/report/suggest.js';

const SCAN = '2026-10-01T00:00:00.000Z';
const DAY = 86_400_000;
const daysBefore = (d: number): string => new Date(Date.parse(SCAN) - d * DAY).toISOString();
const sessions: SessionRecord[] = Array.from({ length: 30 }, (_, i) => ({
  id: `s${i}`, file: `s${i}.jsonl`, projectRoot: null, start: daysBefore(50 - i), end: daysBefore(50 - i), lines: 10, unknownShapeLines: 0, unreadableLines: 0, versions: [],
}));

let n = 0;
const item = (name: string, over: Partial<Item> = {}): Item => ({
  id: `i${n++}`, agent: 'claude-code', kind: 'skill', name, source: 'personal', path: `/x/${name}`, projectRoot: null, enabled: true,
  description: 'd', descHash: '', standingChars: 50, targetFingerprint: '', firstSeen: daysBefore(60), firstSeenSource: 'birthtime', logKeys: [name],
  declarations: [], removal: { method: 'move' }, usage: { total: 0, last30: 0, lastUsed: null, byProject: {}, ambiguous: false, uncertain: false }, ...over,
});
const used = { total: 4, last30: 4, lastUsed: SCAN, byProject: {}, ambiguous: false, uncertain: false };

const inventory = (items: Item[], budget?: BudgetObservation, listingPriority: string[] = []): Inventory => ({
  schemaVersion: 1, scanId: 's', agent: 'claude-code', createdAt: SCAN, home: '/h', projectScope: 'global', window: { from: daysBefore(60), to: SCAN },
  sessionsInWindow: sessions.length, linesTotal: 0, linesUnknownShape: 0, linesUnreadable: 0, claudeCodeVersions: [], coverage: { uncertain: false, reasons: [] },
  projects: [], sessions, budget: budget ? { global: budget } : {}, listingPriority, unattributedHookChars: 0, items,
});

const plan = (inv: Inventory, kept: string[] = []) => fixPlan(inv, suggestions(inv, new Set(kept)), new Set(kept));

describe('one-click fix plan', () => {
  it('archives exactly the suggested items, with a plugin as one target', () => {
    const plugin = item('kit', { kind: 'plugin', plugin: 'kit@m', removal: { method: 'plugin-disable' }, logKeys: [] });
    const part = item('kit:a', { plugin: 'kit@m', removal: { method: 'plugin-disable' } });
    const unused = item('old');
    const busy = item('busy', { usage: used });
    const agent = item('helper', { kind: 'agent', standingChars: 300 });
    const server = item('bigdb', { kind: 'mcp', standingChars: 400, removal: { method: 'mcp-extract' } });
    const p = plan(inventory([plugin, part, unused, busy, agent, server]));
    expect(new Set(p.ids)).toEqual(new Set([plugin.id, unused.id, agent.id, server.id]));
    expect(p.byKind).toEqual({ plugin: 1, skill: 1, agent: 1, mcp: 1 });
    expect(p.turnsOff).toBe(5);
    // Agent descriptions and the server's tool list load every session in full.
    expect(p.sessionCharsSaved).toBe(700);
  });

  it('counts only skills that stay as descriptions coming back', () => {
    // Names cost 5 chars each ("- aa\n"), each description 43 more. Cap 110: 15 for names, then bb (used, so first)
    // to 58, aa to 101; cc would reach 144, so cc is listed by name only.
    const line = (name: string, described: boolean) => ({ name, chars: described ? 48 : 5, described });
    const budget: BudgetObservation = {
      sessionId: 'x', timestamp: SCAN, version: '2.1.293', projectRoot: null, skillCount: 3, listingChars: 110,
      withDescription: ['aa', 'bb'], dropped: ['cc'], entries: [line('aa', true), line('cc', false), line('bb', true)],
    };
    const [aa, cc, bb] = ['aa', 'cc', 'bb'].map(name => item(name, { standingChars: 48 }));
    bb!.usage = used;
    const inv = inventory([aa!, cc!, bb!], budget, ['bb']);

    // cc is unused too, so the fix archives it along with aa: it leaves the dropped count but does not "come back".
    const p = plan(inv);
    expect(p.ids.sort()).toEqual([aa!.id, cc!.id].sort());
    expect(p.listing).toMatchObject({ before: { described: 2, dropped: 1 }, after: { described: 1, dropped: 0 } });
    expect(p.descriptionsBack).toBe(0);

    // Keep cc: archiving aa alone gives cc its description back.
    const kept = plan(inv, [cc!.id]);
    expect(kept.ids).toEqual([aa!.id]);
    expect(kept.descriptionsBack).toBe(1);
    // cc's description fills the room aa's took; only aa's name line (5 chars) leaves the listing.
    expect(kept.sessionCharsSaved).toBe(5);
  });

  it('lists unused items only removable by hand, never suites, kept or used ones, or plugins with a used part', () => {
    const synced = item('anthropic-skills:art', { source: 'claude.ai synced', removal: { method: 'manual', where: 'claude.ai › Settings › Capabilities › Skills' } });
    const suite = item('gstack', { removal: { method: 'manual', where: 'the gstack suite', suite: true } });
    const keptOne = item('anthropic-skills:docs', { removal: { method: 'manual', where: 'claude.ai' } });
    const usedOne = item('anthropic-skills:log', { removal: { method: 'manual', where: 'claude.ai' }, usage: used });
    const appPlugin = item('legal', { kind: 'plugin', plugin: 'legal@inline', removal: { method: 'manual', where: 'Claude desktop app' }, logKeys: [] });
    const legalPart = item('legal:brief', { plugin: 'legal@inline', removal: { method: 'manual', where: 'Claude desktop app' } });
    const mixedPlugin = item('design', { kind: 'plugin', plugin: 'design@inline', removal: { method: 'manual', where: 'Claude desktop app' }, logKeys: [] });
    const usedPart = item('design:review', { plugin: 'design@inline', removal: { method: 'manual', where: 'Claude desktop app' }, usage: used });
    const p = plan(inventory([synced, suite, keptOne, usedOne, appPlugin, legalPart, mixedPlugin, usedPart]), [keptOne.id]);
    expect(p.ids).toEqual([]);
    expect(p.byHand!.items.map(i => i.name).sort()).toEqual(['anthropic-skills:art', 'legal']);
    expect(p.byHand!.items.find(i => i.name === 'legal')).toMatchObject({ kind: 'plugin', turnsOff: 1, where: 'Claude desktop app' });
  });

  it('offers nothing when nothing qualifies', () => {
    const p = plan(inventory([item('busy', { usage: used }), item('new', { firstSeen: daysBefore(2) })]));
    expect(p).toMatchObject({ ids: [], turnsOff: 0, descriptionsBack: 0, sessionCharsSaved: 0, byHand: null });
  });
});
