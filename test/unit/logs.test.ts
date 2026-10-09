import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanLogs } from '../../src/adapters/claude-code/logs.js';
import { scan } from '../../src/core/scan.js';

const tmp: string[] = [];
const mk = (): string => { const d = mkdtempSync(join(tmpdir(), 'packlight-l-')); tmp.push(d); return d; };
afterEach(() => { while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true }); });

const jsonl = (rows: object[]): string => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const skillUse = (skill: string, cwd: string | undefined, version = '2.1.300') => ({
  type: 'assistant', timestamp: '2026-09-01T00:00:00Z', ...(cwd ? { cwd } : {}), version,
  message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill } }] },
});

describe('log shape drift (eng A2)', () => {
  it('marks usage uncertain, not zero, when the newest version renames a field', async () => {
    const d = mk();
    const home = join(d, 'home');
    mkdirSync(join(home, '.claude', 'skills', 'alpha'), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), '---\ndescription: A.\n---\n');
    mkdirSync(join(home, '.claude', 'projects', 'p'), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', 'p', 's.jsonl'), jsonl([
      skillUse('alpha', home, '2.1.299'),
      // 2.1.300 renamed hook_success.command to hook_success.cmd: packlight cannot attribute it.
      { type: 'attachment', timestamp: '2026-09-02T00:00:00Z', version: '2.1.300', attachment: { type: 'hook_success', hookEvent: 'Stop', cmd: 'x' } },
    ]));
    const inv = await scan({ home, cwd: home, now: new Date('2026-09-03T00:00:00Z') });
    expect(inv.coverage.uncertain).toBe(true);
    expect(inv.coverage.reasons.join(' ')).toContain('2.1.300');
    const alpha = inv.items.find(i => i.name === 'alpha')!;
    expect(alpha.usage.uncertain).toBe(true);
    expect(alpha.usage.total).toBe(1);
  });

  it('counts unreadable lines per session', async () => {
    const d = mk();
    mkdirSync(join(d, 'p'));
    writeFileSync(join(d, 'p', 's.jsonl'), '{"type":"user"\n' + jsonl([skillUse('a', '/x')]));
    const logs = await scanLogs(d, { projectOf: () => null });
    expect(logs.linesUnreadable).toBe(1);
    expect(logs.sessions[0]).toMatchObject({ id: 's', unreadableLines: 1, lines: 2 });
  });
});

describe('project attribution (eng A3)', () => {
  it('attributes by each line\'s cwd even when two projects share a log folder name', async () => {
    const d = mk();
    // Claude Code encodes both /a-b/c and /a/b-c as "-a-b-c": the folder name cannot tell them apart.
    mkdirSync(join(d, '-a-b-c'));
    writeFileSync(join(d, '-a-b-c', 's1.jsonl'), jsonl([skillUse('x', '/a-b/c')]));
    writeFileSync(join(d, '-a-b-c', 's2.jsonl'), jsonl([skillUse('x', '/a/b-c'), skillUse('x', undefined)]));
    const logs = await scanLogs(d, { projectOf: cwd => cwd });
    expect(logs.skillUses.get('x')!.map(u => u.project)).toEqual(['/a-b/c', '/a/b-c', '/a/b-c']);
  });
});

describe('skill listing (eng X8)', () => {
  it('separates skills listed with and without descriptions, including aliases and plugin names', async () => {
    const d = mk();
    mkdirSync(join(d, 'p'));
    writeFileSync(join(d, 'p', 's.jsonl'), jsonl([{
      type: 'attachment', timestamp: '2026-09-01T00:00:00Z', cwd: '/w', version: '2.1.293',
      attachment: { type: 'skill_listing', isInitial: true, skillCount: 4, names: ['a', 'p:b', 'c', 'p:b-long'],
        content: '- a: Does a.\n- p:b (bee): Does b.\n- c\n- p:b-long\nTRIGGER — free text that is not a list item' },
    }]));
    const logs = await scanLogs(d, { projectOf: () => '/w' });
    expect(logs.listings).toEqual([expect.objectContaining({ withDescription: ['a', 'p:b'], dropped: ['c', 'p:b-long'], projectRoot: '/w', skillCount: 4 })]);
    // In listing order, each with its size; a line that is not a list item belongs to the entry above it.
    expect(logs.listings[0]!.entries).toEqual([
      { name: 'a', chars: '- a: Does a.\n'.length, described: true },
      { name: 'p:b', chars: '- p:b (bee): Does b.\n'.length, described: true },
      { name: 'c', chars: '- c\n'.length, described: false },
      { name: 'p:b-long', chars: '- p:b-long\n'.length + 'TRIGGER — free text that is not a list item\n'.length, described: false },
    ]);
  });
});

describe('tool list (deferred tools and MCP instructions)', () => {
  it('sums a session\'s deltas per server, takes removed tools back out, and ignores subagents', async () => {
    const d = mk();
    mkdirSync(join(d, 'p', 's', 'subagents'), { recursive: true });
    const at = (attachment: object, ts: string) => ({ type: 'attachment', timestamp: ts, cwd: '/w', version: '2.1.293', attachment });
    writeFileSync(join(d, 'p', 's.jsonl'), jsonl([
      at({ type: 'deferred_tools_delta', addedNames: ['Read', 'mcp__a__x', 'mcp__a__y', 'mcp__plugin_b_b__z'], addedLines: ['Read', 'mcp__a__x', 'mcp__a__y', 'mcp__plugin_b_b__z'], removedNames: [] }, '2026-09-01T00:00:00Z'),
      at({ type: 'mcp_instructions_delta', addedNames: ['plugin:b:b'], addedBlocks: ['## plugin:b:b\nB Service: use it'], removedNames: [] }, '2026-09-01T00:00:01Z'),
      at({ type: 'deferred_tools_delta', addedNames: [], addedLines: [], removedNames: ['mcp__a__y'] }, '2026-09-01T00:00:02Z'),
    ]));
    writeFileSync(join(d, 'p', 's', 'subagents', 'agent-1.jsonl'), jsonl([
      at({ type: 'deferred_tools_delta', addedNames: ['mcp__c__q'], addedLines: ['mcp__c__q'], removedNames: [] }, '2026-09-01T00:00:03Z'),
    ]));
    const logs = await scanLogs(d, { projectOf: () => '/w' });
    expect(logs.toolListings).toHaveLength(1);
    // A block that opens with a sentence gives no label (it is instructions, not the service's name).
    const d2 = mk();
    mkdirSync(join(d2, 'p'));
    writeFileSync(join(d2, 'p', 's.jsonl'), jsonl([at({ type: 'mcp_instructions_delta', addedNames: ['x'], addedBlocks: ['## x\nUse Vercel tools and their input schemas. Always confirm: yes'], removedNames: [] }, '2026-09-01T00:00:00Z')]));
    expect((await scanLogs(d2, { projectOf: () => '/w' })).toolListings[0]!.servers.x!.label).toBeUndefined();
    const t = logs.toolListings[0]!;
    expect(t.builtIn).toEqual({ tools: 1, chars: 5 });
    expect(t.servers).toEqual({
      a: { tools: 1, chars: 'mcp__a__x'.length + 1, instructionChars: 0, sample: ['x', 'y'] },
      plugin_b_b: { tools: 1, chars: 'mcp__plugin_b_b__z'.length + 1, instructionChars: '## plugin:b:b\nB Service: use it'.length, sample: ['z'], label: 'B Service' },
    });
  });
});
