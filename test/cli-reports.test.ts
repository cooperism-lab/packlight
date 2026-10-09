import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  it('writes Claude Code to report.html and Codex to report-codex.html, neither replacing the other', () => {
    dir = mkdtempSync(join(tmpdir(), 'packlight-two-'));
    const claude = buildHome(join(dir, 'a'));
    const codex = buildCodexHome(join(dir, 'b'));
    const out = join(dir, 'out');
    const a = cli(['--home', claude.home, '--out', out, '--no-open']);
    expect(a.status, a.stderr).toBe(0);
    expect(a.stdout).toContain(`Report: ${join(out, 'report.html')}`);
    const b = cli(['--agent', 'codex', '--home', codex.home, '--out', out, '--no-open']);
    expect(b.status, b.stderr).toBe(0);
    expect(b.stdout).toContain(`Report: ${join(out, 'report-codex.html')}`);
    expect(readFileSync(join(out, 'report.html'), 'utf8')).toContain('"agent":"claude-code"');
    expect(readFileSync(join(out, 'report-codex.html'), 'utf8')).toContain('"agent":"codex"');
    // `report` rebuilds each from its own newest scan.
    expect(cli(['report', '--agent', 'codex', '--home', codex.home, '--out', out, '--no-open']).stdout).toContain('report-codex.html');
    expect(existsSync(join(out, 'report.html'))).toBe(true);
  });
});
