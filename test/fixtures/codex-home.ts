import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A hand-counted Codex home: 2 personal skills, 1 built-in skill, 2 plugins (one off, with 1 skill each),
// 2 MCP servers (one off), 1 custom prompt, a global AGENTS.md, and 22 sessions in one project.
export const CODEX_EXPECTED = { skill: 5, plugin: 2, mcp: 2, command: 1, instructions: 1 } as const;

const write = (p: string, s: string): void => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s); };
const skillMd = (d: string): string => `---\nname: x\ndescription: ${d}\n---\nBody.\n`;

export function buildCodexHome(dir: string, now = Date.parse('2026-10-01T12:00:00Z')): { home: string; project: string } {
  const home = join(dir, 'home');
  const codex = join(home, '.codex');
  const project = join(home, 'code', 'app');
  mkdirSync(join(project, '.git'), { recursive: true });

  write(join(codex, 'skills', 'release-notes', 'SKILL.md'), skillMd('Write release notes.'));
  write(join(codex, 'skills', 'old-helper', 'SKILL.md'), skillMd('An old helper nobody calls.'));
  write(join(codex, 'skills', '.system', 'imagegen', 'SKILL.md'), skillMd('Generate images.'));
  write(join(codex, 'plugins', 'cache', 'market', 'docs', '1.0.0', 'skills', 'docs', 'SKILL.md'), skillMd('Edit documents.'));
  write(join(codex, 'plugins', 'cache', 'market', 'docs', '1.0.0', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'docs', description: 'Documents.' }));
  write(join(codex, 'plugins', 'cache', 'market', 'slides', '2.0.0', 'skills', 'slides', 'SKILL.md'), skillMd('Make slides.'));
  write(join(codex, 'prompts', 'ship.md'), '---\ndescription: Ship it.\n---\nShip.\n');
  write(join(codex, 'AGENTS.md'), 'Be brief.\n');
  write(join(codex, 'config.toml'), [
    'model = "gpt-6"',
    '',
    '[plugins."docs@market"]',
    'enabled = true',
    '',
    '[plugins."slides@market"]',
    'enabled = false',
    '',
    '[mcp_servers.github]',
    'command = "gh-mcp"',
    '',
    '[mcp_servers.github.env]',
    'TOKEN_PATH = "/dev/null"',
    '',
    '[mcp_servers."old db"]',
    'command = "olddb"',
    'enabled = false',
    '',
    `[projects."${project}"]`,
    'trust_level = "trusted"',
    '',
  ].join('\n'));

  // Everything was installed 60 days before "now", so suggestion windows are long enough.
  const old = new Date(now - 60 * 86_400_000);
  for (const p of ['skills/release-notes', 'skills/old-helper', 'skills/.system/imagegen', 'plugins/cache/market/docs/1.0.0', 'plugins/cache/market/slides/2.0.0', 'prompts/ship.md']) {
    utimesSync(join(codex, p), old, old);
  }

  const listing = '## Skills\nA skill is a set of local instructions.\n### Available skills\n'
    + '- release-notes: Write release notes. (file: r1/release-notes/SKILL.md)\n'
    + '- old-helper: An old helper nobody calls. (file: r1/old-helper/SKILL.md)\n'
    + '- imagegen: Generate images. (file: r0/imagegen/SKILL.md)\n'
    + '- docs:docs: Edit documents. (file: r2/docs/SKILL.md)\n';
  for (let i = 0; i < 22; i++) {
    const t = new Date(now - (40 - i) * 86_400_000);
    const ts = (s: number): string => new Date(t.getTime() + s * 1000).toISOString();
    const rows: object[] = [
      { timestamp: ts(0), type: 'session_meta', payload: { id: `s${i}`, cwd: project, cli_version: '0.162.0' } },
      { timestamp: ts(1), type: 'world_state', payload: { full: true, state: { host_skills: { body: listing }, agents_md: { directory: project, text: 'Be brief.\n' }, plugins_instructions: false, apps_instructions: false } } },
      { timestamp: ts(2), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 20_000 + i * 100 } } } },
      { timestamp: ts(3), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 99_999 } } } },
    ];
    if (i % 3 === 0) rows.push({ timestamp: ts(4), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `sed -n 1,200p ${codex}/skills/release-notes/SKILL.md` }) } });
    if (i % 5 === 0) rows.push({ timestamp: ts(5), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: `text(await tools.mcp__github__list_issues({}))` } });
    if (i === 7) rows.push({ timestamp: ts(6), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `cat ${codex}/plugins/cache/market/docs/1.0.0/skills/docs/SKILL.md` }) } });
    const d = t.toISOString().slice(0, 10).split('-');
    write(join(codex, 'sessions', d[0]!, d[1]!, d[2]!, `rollout-${t.toISOString().replace(/[:.]/g, '-')}-s${i}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  return { home, project };
}
