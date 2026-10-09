import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudePaths, collectInventory } from '../../src/adapters/claude-code/inventory.js';

const tmp: string[] = [];
const mk = (): string => { const d = mkdtempSync(join(tmpdir(), 'packlight-i-')); tmp.push(d); return d; };
afterEach(() => { while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true }); });
const write = (p: string, s: string): void => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s); };

describe('inventory edge cases found on a real setup (2026-10-09)', () => {
  it('reads a plugin .mcp.json that lists servers without the mcpServers wrapper', () => {
    const home = mk();
    const root = join(home, '.claude', 'plugins', 'cache', 'm', 'playwright', '1');
    write(join(root, '.mcp.json'), JSON.stringify({ playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } }));
    write(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'playwright@m': [{ installPath: root }] } }));
    const items = collectInventory(claudePaths(home), []);
    const server = items.find(i => i.kind === 'mcp');
    expect(server).toMatchObject({ name: 'playwright', logKeys: ['plugin_playwright_playwright'], declarations: [{ pointer: '/playwright' }] });
    expect(items.find(i => i.kind === 'plugin')!.members).toEqual({ mcp: 1 });
  });

  it('treats the skills a suite installed as part of the suite, never as loose skills', () => {
    // gstack installs each skill as its own folder whose SKILL.md links back into ~/.claude/skills/gstack
    // (packlight fix archived 39 of them on 2026-10-09 before this rule existed).
    const home = mk();
    const skills = join(home, '.claude', 'skills');
    const suite = join(skills, 'gstack');
    write(join(suite, 'SKILL.md'), '---\ndescription: Router for the suite.\n---\n');
    write(join(suite, 'bin', 'helper'), '#!/bin/sh\n');
    write(join(suite, 'canary', 'SKILL.md'), '---\ndescription: Canary. (gstack)\n---\n');
    mkdirSync(join(skills, 'canary'), { recursive: true });
    try { symlinkSync(join(suite, 'canary', 'SKILL.md'), join(skills, 'canary', 'SKILL.md')); } catch { return; }
    write(join(suite, 'browser', 'SKILL.md'), '---\ndescription: Browser.\n---\n');
    write(join(skills, 'browser', 'SKILL.md'), '---\ndescription: A copy the suite generated.\n---\n');
    write(join(skills, '_gstack-command', 'SKILL.md'), '---\ndescription: Router for the gstack skill suite. (gstack)\n---\n');
    write(join(skills, 'plain', 'SKILL.md'), '---\ndescription: Mentions gstack (gstack) in the middle, then more.\n---\n');
    const items = collectInventory(claudePaths(home), []).filter(i => i.kind === 'skill');
    const removal = (name: string) => items.find(i => i.name === name)!.removal;
    for (const name of ['canary', 'browser', '_gstack-command']) expect(removal(name)).toMatchObject({ method: 'manual', suite: true });
    expect(removal('plain')).toEqual({ method: 'move' });
  });

  it('never offers to move a skill suite that other skills depend on', () => {
    const home = mk();
    const suite = join(home, '.claude', 'skills', 'gstack');
    write(join(suite, 'SKILL.md'), '---\ndescription: Router for the suite.\n---\n');
    write(join(suite, 'bin', 'helper'), '#!/bin/sh\n');
    write(join(suite, 'review', 'SKILL.md'), '---\ndescription: Nested skill.\n---\n');
    write(join(home, '.claude', 'skills', 'plain', 'SKILL.md'), '---\ndescription: Plain.\n---\n');
    const items = collectInventory(claudePaths(home), []);
    expect(items.find(i => i.name === 'gstack')!.removal.method).toBe('manual');
    expect(items.find(i => i.name === 'plain')!.removal.method).toBe('move');
  });
});
