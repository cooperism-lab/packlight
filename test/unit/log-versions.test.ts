import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scanLogs } from '../../src/adapters/claude-code/logs.js';

// Shape-only lines captured from real logs, one folder per Claude Code version (eng A2).
// Refresh with: npx tsx scripts/capture-log-fixtures.ts
const root = join(import.meta.dirname, '..', 'fixtures', 'logs');
const versions = readdirSync(root).sort();
const tmp = mkdtempSync(join(tmpdir(), 'packlight-v-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.each(versions)('Claude Code %s log lines', version => {
  it('parse with no unrecognised usage lines and every captured use counted', async () => {
    const dir = join(tmp, version);
    cpSync(join(root, version), join(dir, 'p'), { recursive: true });
    const shapes: Record<string, number> = JSON.parse(readFileSync(join(root, version, 'shapes.json'), 'utf8'));
    const logs = await scanLogs(dir, { projectOf: () => null });

    expect(logs.linesUnreadable).toBe(0);
    expect(logs.linesUnknownRelevant).toBe(0);
    const count = (m: Map<string, unknown[]>) => [...m.values()].reduce((n, l) => n + l.length, 0);
    expect(count(logs.agentUses)).toBe(shapes['tool:Agent'] ?? 0);
    expect(count(logs.mcpUses)).toBeGreaterThanOrEqual(shapes['tool:mcp'] ?? 0);
    expect(count(logs.skillUses)).toBe((shapes['tool:Skill'] ?? 0) + (shapes['user:command'] ?? 0));
    expect(logs.hookFirings).toHaveLength(shapes['attachment:hook_success'] ?? 0);
    const listings = shapes['attachment:skill_listing'] ?? 0;
    if (listings) expect(logs.listings.every(l => l.withDescription.length + l.dropped.length === l.skillCount)).toBe(true);
  });
});
