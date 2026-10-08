import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * A fixture home folder with hand-counted contents (acceptance criterion 1):
 * 12 skills, 3 commands, 4 agents, 5 hooks, 3 plugins and 6 MCP servers.
 * It is generated so absolute paths are right on every OS.
 */
export const EXPECTED_COUNTS = { skill: 12, command: 3, agent: 4, hook: 5, plugin: 3, mcp: 6, instructions: 2 } as const;

export const EXPECTED_SKILLS_BY_SOURCE = {
  personal: 6,
  'claude.ai synced': 1,
  'project:proj': 2,
  'plugin:kit': 2,
  'plugin:tools': 1,
} as const;

/** Hand-counted usage from the fixture logs (acceptance criterion 2), keyed by "<kind> <name> <source>". */
export const EXPECTED_USAGE: Record<string, number> = {
  'skill alpha personal': 2,
  'skill beta personal': 1,
  'skill gamma personal': 1,
  'skill delta personal': 0,
  'skill epsilon personal': 0,
  'skill learn personal': 2,
  'skill learn project:proj': 1,
  'skill anthropic-skills:docs claude.ai synced': 0,
  'skill proj-skill project:proj': 0,
  'skill kit:kit-a plugin:kit': 1,
  'skill kit:kit-b plugin:kit': 0,
  'skill tools:tool-x plugin:tools': 0,
  'command ship personal': 1,
  'command git:sync personal': 0,
  'command kit:deploy plugin:kit': 0,
  'agent writer personal': 1,
  'agent researcher personal': 0,
  'agent proj-agent project:proj': 0,
  'agent kit:reviewer plugin:kit': 0,
  'mcp github user config': 0,
  'mcp files user config': 0,
  'mcp localdb project:proj': 1,
  'mcp projsrv project:proj': 0,
  'mcp kitdb plugin:kit': 1,
  'mcp solo-srv plugin:solo': 0,
};

export const FIXTURE_TIME = new Date('2026-10-01T12:00:00Z');

const write = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const json = (path: string, value: unknown): void => write(path, JSON.stringify(value, null, 2));
const skill = (dir: string, name: string, description: string): void =>
  write(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
const md = (path: string, description: string, name?: string): void =>
  write(path, `---\n${name ? `name: ${name}\n` : ''}description: ${description}\n---\n\nBody.\n`);

export interface FixtureHome { home: string; project: string }

export function buildHome(root: string): FixtureHome {
  const home = join(root, 'home');
  const claude = join(home, '.claude');
  const project = join(home, 'code', 'proj');

  // Personal skills (6), one of them sharing a name with a project skill.
  for (const n of ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'learn']) skill(join(claude, 'skills'), n, `The ${n} skill.`);
  // A claude.ai skill synced into Claude Code (1).
  skill(join(claude, 'skills', 'synced', 'org-1'), 'docs', 'Living docs.');
  // Project skills (2), agent (1), instructions.
  skill(join(project, '.claude', 'skills'), 'proj-skill', 'Project-only skill.');
  skill(join(project, '.claude', 'skills'), 'learn', 'Project flavour of learn.');
  md(join(project, '.claude', 'agents', 'proj-agent.md'), 'Project agent.', 'proj-agent');
  write(join(project, 'CLAUDE.md'), '# Project rules\n\nUse tabs.\n');
  write(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n');

  // Personal commands (2, one nested) and agents (2).
  md(join(claude, 'commands', 'ship.md'), 'Ship the branch.');
  md(join(claude, 'commands', 'git', 'sync.md'), 'Sync with origin.');
  md(join(claude, 'agents', 'researcher.md'), 'Finds things.', 'researcher');
  md(join(claude, 'agents', 'writer.md'), 'Writes things.', 'writer');
  write(join(claude, 'CLAUDE.md'), '# Global rules\n');

  // Plugins (3): kit bundles skills, a command, an agent, a hook and a server; tools is turned off; solo has one server.
  const cache = join(claude, 'plugins', 'cache', 'market');
  const kit = join(cache, 'kit', '1.0.0');
  skill(join(kit, 'skills'), 'kit-a', 'Kit skill A.');
  skill(join(kit, 'skills'), 'kit-b', 'Kit skill B.');
  md(join(kit, 'commands', 'deploy.md'), 'Deploy with kit.');
  md(join(kit, 'agents', 'reviewer.md'), 'Reviews with kit.', 'reviewer');
  json(join(kit, 'hooks', 'hooks.json'), { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/start.mjs"' }] }] } });
  json(join(kit, '.mcp.json'), { mcpServers: { kitdb: { command: 'kitdb' } } });
  json(join(kit, '.claude-plugin', 'plugin.json'), { name: 'kit', description: 'A kit of tools.' });
  const tools = join(cache, 'tools', '2.0.0');
  skill(join(tools, 'skills'), 'tool-x', 'Tool X.');
  json(join(tools, '.claude-plugin', 'plugin.json'), { name: 'tools' });
  const solo = join(cache, 'solo', '0.1.0');
  json(join(solo, '.mcp.json'), { mcpServers: { 'solo-srv': { command: 'solo' } } });
  json(join(claude, 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'kit@market': [{ scope: 'user', installPath: kit, version: '1.0.0', installedAt: '2026-09-01T00:00:00.000Z' }],
      'tools@market': [{ scope: 'user', installPath: tools, version: '2.0.0', installedAt: '2026-09-02T00:00:00.000Z' }],
      'solo@market': [{ scope: 'user', installPath: solo, version: '0.1.0', installedAt: '2026-09-03T00:00:00.000Z' }],
    },
  });

  // Settings hooks: user (2), user local (1), project (1, same command as a user hook).
  json(join(claude, 'settings.json'), {
    enabledPlugins: { 'kit@market': true, 'tools@market': false, 'solo@market': true },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/guard.sh check' }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: '/usr/local/bin/notes.sh' }] }],
    },
  });
  json(join(claude, 'settings.local.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/bell.sh' }] }] } });
  // kit is also switched on in the project's own settings: archiving it must turn it off in both (eng X2).
  json(join(project, '.claude', 'settings.json'), {
    enabledPlugins: { 'kit@market': true },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/guard.sh check' }] }] },
  });

  // MCP servers: user (2), project-local in ~/.claude.json (1), project .mcp.json (1); plus kitdb and solo-srv above.
  json(join(home, '.claude.json'), {
    mcpServers: { github: { command: 'gh-mcp' }, files: { command: 'files-mcp' } },
    projects: { [project]: { mcpServers: { localdb: { command: 'localdb' } } } },
  });
  json(join(project, '.mcp.json'), { mcpServers: { projsrv: { command: 'projsrv' } } });

  writeLogs(claude, home, project);
  return { home, project };
}

function writeLogs(claude: string, home: string, project: string): void {
  const logDir = join(claude, 'projects');
  // Folder names are lossy on purpose: attribution must come from each line's cwd (eng A3).
  const folder = join(logDir, '-home-code-proj');
  const lines = (rows: object[]): string => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
  const tool = (name: string, input: object, ts: string, cwd?: string) => ({
    type: 'assistant', timestamp: ts, ...(cwd ? { cwd } : {}), version: '2.1.290',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${ts}`, name, input }] },
  });

  write(join(folder, 'session-1.jsonl'), lines([
    { type: 'user', timestamp: '2026-09-28T10:00:00Z', cwd: project, version: '2.1.290', message: { role: 'user', content: '<command-name>/ship</command-name>' } },
    tool('Skill', { skill: 'alpha' }, '2026-09-28T10:01:00Z', project),
    tool('Skill', { skill: 'kit:kit-a' }, '2026-09-28T10:02:00Z', project),
    tool('Skill', { skill: 'learn' }, '2026-09-28T10:03:00Z', project),
    tool('Agent', { subagent_type: 'writer', prompt: 'x' }, '2026-09-28T10:04:00Z', project),
    tool('mcp__localdb__query', {}, '2026-09-28T10:05:00Z', project),
    tool('mcp__plugin_kit_kitdb__get', {}, '2026-09-28T10:06:00Z', project),
    { type: 'attachment', timestamp: '2026-09-28T10:07:00Z', cwd: project, version: '2.1.290',
      attachment: { type: 'hook_success', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', toolUseID: 'tu-1', command: '/usr/local/bin/guard.sh check', stdout: '{"ok":true}', durationMs: 12, exitCode: 0 } },
    { type: 'attachment', timestamp: '2026-09-28T10:07:01Z', cwd: project, version: '2.1.290',
      attachment: { type: 'hook_additional_context', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', toolUseID: 'tu-1', content: ['abcdefghij'] } },
    { type: 'attachment', timestamp: '2026-09-28T09:59:00Z', cwd: project, version: '2.1.290',
      attachment: { type: 'skill_listing', isInitial: true, skillCount: 3, names: ['alpha', 'beta', 'kit:kit-a'], content: '- alpha: The alpha skill.\n- beta\n- kit:kit-a (kit-a): Kit skill A.' } },
    // No cwd: inherits the project from the line above (eng A3).
    tool('Skill', { skill: 'beta' }, '2026-09-28T10:08:00Z'),
  ]));
  // A subagent transcript counts toward usage but not as another session.
  write(join(folder, 'session-1', 'subagents', 'agent-1.jsonl'), lines([tool('Skill', { skill: 'gamma' }, '2026-09-28T10:09:00Z', project)]));

  write(join(logDir, '-home', 'session-2.jsonl'), lines([
    { type: 'attachment', timestamp: '2026-08-01T08:00:00Z', cwd: home, version: '2.1.291',
      attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', toolUseID: 'ss-1', command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/start.mjs"', stdout: '', content: 'hello world', durationMs: 40, exitCode: 0 } },
    tool('Skill', { skill: 'learn' }, '2026-08-01T08:01:00Z', home),
    tool('Skill', { skill: 'alpha' }, '2026-08-01T08:02:00Z', home),
    // A line type packlight has never seen and that carries no usage evidence.
    { type: 'brand-new-type', timestamp: '2026-08-01T08:03:00Z', cwd: home },
  ]));
}
