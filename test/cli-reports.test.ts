import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCodexHome } from './fixtures/codex-home.js';
import { buildHome } from './fixtures/home.js';

const repo = join(import.meta.dirname, '..');
const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(repo, 'src', 'cli.ts'), ...args], { cwd: repo, env: { ...process.env }, encoding: 'utf8' });
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('one report file per agent', () => {
  it('writes Claude Code to report-claude-code.html and Codex to report-codex.html, neither replacing the other', () => {
    dir = mkdtempSync(join(tmpdir(), 'packlight-two-'));
    const claude = buildHome(join(dir, 'a'));
    const codex = buildCodexHome(join(dir, 'b'));
    const out = join(dir, 'out');
    const a = cli(['--home', claude.home, '--out', out, '--no-open']);
    expect(a.status, a.stderr).toBe(0);
    expect(a.stdout).toContain(`Report: ${join(out, 'report-claude-code.html')}`);
    const b = cli(['--agent', 'codex', '--home', codex.home, '--out', out, '--no-open']);
    expect(b.status, b.stderr).toBe(0);
    expect(b.stdout).toContain(`Report: ${join(out, 'report-codex.html')}`);
    expect(readFileSync(join(out, 'report-claude-code.html'), 'utf8')).toContain('"agent":"claude-code"');
    expect(readFileSync(join(out, 'report-codex.html'), 'utf8')).toContain('"agent":"codex"');
    // `report` rebuilds each from its own newest scan.
    expect(cli(['report', '--agent', 'codex', '--home', codex.home, '--out', out, '--no-open']).stdout).toContain('report-codex.html');
    expect(existsSync(join(out, 'report-claude-code.html'))).toBe(true);
  });

  it('removes the old report.html only when packlight wrote it', () => {
    dir = mkdtempSync(join(tmpdir(), 'packlight-legacy-'));
    const claude = buildHome(join(dir, 'a'));
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'report.html'), '<script id="packlight-data" type="application/json">{}</script>');
    expect(cli(['--home', claude.home, '--out', out, '--no-open']).status).toBe(0);
    expect(existsSync(join(out, 'report.html'))).toBe(false);
    writeFileSync(join(out, 'report.html'), 'my own notes');
    expect(cli(['--home', claude.home, '--out', out, '--no-open']).status).toBe(0);
    expect(readFileSync(join(out, 'report.html'), 'utf8')).toBe('my own notes');
  });
});
