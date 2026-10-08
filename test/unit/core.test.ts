import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { usageBucket } from '../../src/core/buckets.js';
import { frontmatter } from '../../src/core/frontmatter.js';
import { itemId, pathFingerprint } from '../../src/core/hash.js';

const tmp: string[] = [];
const mk = (): string => { const d = mkdtempSync(join(tmpdir(), 'packlight-u-')); tmp.push(d); return d; };
afterEach(() => { while (tmp.length) rmSync(tmp.pop()!, { recursive: true, force: true }); });

describe('item ids (eng A1, X5)', () => {
  const base = { agent: 'claude-code', kind: 'skill', source: 'personal', path: '/h/.claude/skills/a' };

  it('gives names that slug alike distinct ids', () => {
    expect(itemId({ ...base, name: 'my skill' })).not.toBe(itemId({ ...base, name: 'my-skill' }));
  });

  it('is stable for the same declaration', () => {
    expect(itemId({ ...base, name: 'a' })).toBe(itemId({ ...base, name: 'a' }));
  });

  it('separates identical declarations by their JSON pointer', () => {
    const hook = { agent: 'claude-code', kind: 'hook', source: 'user settings', name: 'guard', path: '/h/.claude/settings.json' };
    expect(itemId({ ...hook, pointer: '/hooks/PreToolUse/0/hooks/0' })).not.toBe(itemId({ ...hook, pointer: '/hooks/PreToolUse/1/hooks/0' }));
  });
});

describe('fingerprints (eng X1)', () => {
  it('changes when any file in a skill folder changes', () => {
    const d = mk();
    mkdirSync(join(d, 's', 'refs'), { recursive: true });
    writeFileSync(join(d, 's', 'SKILL.md'), 'a');
    writeFileSync(join(d, 's', 'refs', 'x.md'), 'b');
    const before = pathFingerprint(join(d, 's'));
    writeFileSync(join(d, 's', 'refs', 'x.md'), 'c');
    expect(pathFingerprint(join(d, 's'))).not.toBe(before);
  });

  it('hashes a symlink by its target, not the target contents', () => {
    const d = mk();
    mkdirSync(join(d, 'real'));
    writeFileSync(join(d, 'real', 'SKILL.md'), 'a');
    try { symlinkSync(join(d, 'real'), join(d, 'link'), 'junction'); } catch { return; }
    const before = pathFingerprint(join(d, 'link'));
    writeFileSync(join(d, 'real', 'SKILL.md'), 'changed');
    expect(pathFingerprint(join(d, 'link'))).toBe(before);
  });
});

describe('frontmatter', () => {
  it('reads plain, quoted and folded descriptions', () => {
    expect(frontmatter('---\nname: a\ndescription: "Quoted: yes"\n---\n')).toEqual({ name: 'a', description: 'Quoted: yes' });
    expect(frontmatter('---\ndescription: >\n  Folded line one\n  and two.\nmodel: opus\n---\n')).toEqual({ description: 'Folded line one and two.', model: 'opus' });
    expect(frontmatter('---\r\ndescription: Windows line endings\r\n---\r\n')).toEqual({ description: 'Windows line endings' });
    expect(frontmatter('# no frontmatter')).toEqual({});
  });
});

describe('usage buckets (eng Q1)', () => {
  it('scales with the number of sessions', () => {
    expect(usageBucket(0, 20)).toBe('unused');
    expect(usageBucket(2, 20)).toBe('rare');
    expect(usageBucket(50, 500)).toBe('rare');
    expect(usageBucket(3, 20)).toBe('regular');
    expect(usageBucket(51, 500)).toBe('regular');
  });
});
