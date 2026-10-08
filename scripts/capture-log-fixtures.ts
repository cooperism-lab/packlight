// Captures real Claude Code log lines as shape-only fixtures (eng A2): one folder per version under
// test/fixtures/logs/<version>/, with every piece of text replaced by same-length filler so no prompt,
// output or path leaves the machine. Run: npx tsx scripts/capture-log-fixtures.ts [maxPerShape]
import { mkdirSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { logFiles } from '../src/adapters/claude-code/logs.js';

const MAX = Number(process.argv[2] ?? 4);
const projects = join(homedir(), '.claude', 'projects');
const out = join(import.meta.dirname, '..', 'test', 'fixtures', 'logs');

const fill = (s: string): string => 'x'.repeat(Math.min(s.length, 40));
const KEEP = new Set(['type', 'hookEvent', 'hookName', 'version', 'timestamp', 'name', 'subagent_type', 'skill', 'isInitial', 'role']);

/** Keeps keys, types, numbers, booleans and identifying fields; replaces every other string with filler. */
function redact(v: unknown, key = ''): unknown {
  if (typeof v === 'string') {
    if (KEEP.has(key)) return v;
    if (key === 'cwd') return '/fixture/project';
    if (key === 'command') return v.replace(/\/Users\/[^/\s"]+|\/home\/[^/\s"]+|C:\\Users\\[^\\\s"]+/g, '~');
    return fill(v);
  }
  if (Array.isArray(v)) return v.map(x => redact(x, key === 'names' ? 'name' : ''));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]));
  return v;
}

function shapeOf(e: any): string | null {
  if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
    const t = e.message.content.find((b: any) => b?.type === 'tool_use');
    if (!t) return null;
    return t.name === 'Skill' ? 'tool:Skill' : t.name === 'Agent' || t.name === 'Task' ? 'tool:Agent' : String(t.name).startsWith('mcp__') ? 'tool:mcp' : null;
  }
  if (e.type === 'user' && JSON.stringify(e.message ?? '').includes('<command-name>')) return 'user:command';
  if (e.type === 'attachment' && /^(hook_|skill_listing)/.test(e.attachment?.type ?? '')) return `attachment:${e.attachment.type}`;
  return null;
}

const byVersion = new Map<string, Map<string, unknown[]>>();
for (const { file } of logFiles(projects)) {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const v = typeof e?.version === 'string' ? e.version : null;
    const shape = v ? shapeOf(e) : null;
    if (!v || !shape) continue;
    const shapes = byVersion.get(v) ?? new Map<string, unknown[]>();
    byVersion.set(v, shapes);
    const list = shapes.get(shape) ?? [];
    if (list.length < MAX) {
      // Commands keep only the command name, which is what the parser reads.
      if (shape === 'user:command') {
        const m = /<command-name>\/?([^<]+)<\/command-name>/.exec(JSON.stringify(e.message));
        e.message = { role: 'user', content: `<command-name>/${m?.[1] ?? 'x'}</command-name>` };
        list.push(redact({ ...e, message: undefined }, ''));
        (list[list.length - 1] as any).message = e.message;
      } else if (shape === 'attachment:skill_listing') {
        // Keep the listing's structure (name, with or without description) and drop the descriptions.
        const content = String(e.attachment.content ?? '').split('\n').filter((l: string) => l.startsWith('- '))
          .map((l: string) => { const i = l.indexOf(': '); return i > 0 ? `${l.slice(0, i)}: x` : l; }).join('\n');
        const r = redact(e) as any;
        r.attachment.content = content;
        list.push(r);
      } else list.push(redact(e));
    }
    shapes.set(shape, list);
  }
}

for (const [version, shapes] of byVersion) {
  const dir = join(out, version);
  mkdirSync(dir, { recursive: true });
  const lines = [...shapes.values()].flat();
  writeFileSync(join(dir, 'session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  writeFileSync(join(dir, 'shapes.json'), JSON.stringify(Object.fromEntries([...shapes].map(([k, v]) => [k, v.length])), null, 1) + '\n');
}
console.log(`Captured ${byVersion.size} versions into ${out}`);
