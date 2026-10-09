// What a Codex setup holds: skills (personal, built-in, from plugins), plugins, MCP servers, custom prompts and
// AGENTS.md files. Read from ~/.codex (or $CODEX_HOME). Plugins and MCP servers are switched off in config.toml,
// which packlight does not edit: their removal is "manual" with the exact line to change.
import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { dirs, files, firstSeenOf, makeItem, readText, type ItemInput } from '../claude-code/inventory.js';
import { frontmatter } from '../../core/frontmatter.js';
import { pathFingerprint, valueFingerprint } from '../../core/hash.js';
import type { Item } from '../../core/types.js';
import { readToml, type TomlTable } from './toml.js';

export interface CodexPaths { home: string; root: string; config: string; skills: string; pluginCache: string; prompts: string; sessions: string; agentsMd: string }

export function codexPaths(home: string): CodexPaths {
  const root = process.env.CODEX_HOME && home === process.env.HOME ? process.env.CODEX_HOME : join(home, '.codex');
  return {
    home, root, config: join(root, 'config.toml'), skills: join(root, 'skills'), pluginCache: join(root, 'plugins', 'cache'),
    prompts: join(root, 'prompts'), sessions: join(root, 'sessions'), agentsMd: join(root, 'AGENTS.md'),
  };
}

const item = (i: ItemInput): Item => makeItem({ ...i, agent: 'codex' });
const tilde = (p: string, home: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
/** A skill's line in Codex's skill listing: "- name: description (file: rN/…/SKILL.md)". */
const listingChars = (name: string, description: string): number => `- ${name}: ${description} (file: r0/${name}/SKILL.md)\n`.length;

const newestDir = (p: string): string | null => {
  const ds = dirs(p).map(d => join(p, d));
  ds.sort((a, b) => { try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; } });
  return ds[0] ?? null;
};

function skill(dir: string, name: string, opts: Pick<ItemInput, 'source' | 'enabled' | 'plugin' | 'removal'> & { firstSeen?: ReturnType<typeof firstSeenOf> }): Item | null {
  const file = join(dir, 'SKILL.md');
  if (!existsSync(file)) return null;
  const description = frontmatter(readText(file)).description ?? '';
  return item({
    kind: 'skill', name, source: opts.source, path: dir, enabled: opts.enabled, description,
    standingChars: opts.enabled === false ? 0 : listingChars(name, description), fingerprint: pathFingerprint(dir),
    ...(opts.firstSeen ?? firstSeenOf(dir)), logKeys: [name], plugin: opts.plugin, removal: opts.removal,
  });
}

export function readCodexConfig(paths: CodexPaths): TomlTable[] {
  return readToml(readText(paths.config));
}

/** Project roots Codex knows: its [projects."<path>"] tables. */
export function codexProjects(paths: CodexPaths): string[] {
  return readCodexConfig(paths).filter(t => t.path[0] === 'projects' && t.path.length === 2).map(t => t.path[1]!);
}

export function collectCodexInventory(paths: CodexPaths, projectRoots: string[]): Item[] {
  const items: Item[] = [];
  const config = readCodexConfig(paths);
  const cfgFile = tilde(paths.config, paths.home);

  // Personal skills move into packlight's archive like Claude Code's; built-in ones ship with Codex.
  for (const d of dirs(paths.skills)) {
    if (d.startsWith('.')) continue;
    const s = skill(join(paths.skills, d), d, { source: 'personal', removal: { method: 'move' } });
    if (s) items.push(s);
  }
  for (const d of dirs(join(paths.skills, '.system'))) {
    const s = skill(join(paths.skills, '.system', d), d, { source: 'built into Codex', removal: { method: 'manual', where: 'built into Codex', suite: true } });
    if (s) items.push(s);
  }

  // Plugins: every cached plugin, newest version; on unless config.toml says enabled = false.
  const pluginCfg = new Map(config.filter(t => t.path[0] === 'plugins' && t.path.length === 2).map(t => [t.path[1]!, t]));
  for (const market of dirs(paths.pluginCache)) {
    for (const name of dirs(join(paths.pluginCache, market))) {
      const key = `${name}@${market}`;
      const version = newestDir(join(paths.pluginCache, market, name));
      if (!version) continue;
      const cfg = pluginCfg.get(key);
      const enabled = cfg?.values.enabled !== false;
      const where = cfg ? `${cfgFile}, under [plugins."${key}"]: set enabled = false` : `Codex › Plugins (or add [plugins."${key}"] enabled = false to ${cfgFile})`;
      const removal: Item['removal'] = { method: 'manual', where };
      const seen = firstSeenOf(version);
      const parts: Item[] = [];
      for (const s of dirs(join(version, 'skills'))) {
        const it = skill(join(version, 'skills', s), `${name}:${s}`, { source: `plugin:${name}`, enabled, plugin: key, removal, firstSeen: seen });
        if (it) parts.push(it);
      }
      const manifest = readText(join(version, '.codex-plugin', 'plugin.json'));
      let description = '';
      try { description = String(JSON.parse(manifest).description ?? ''); } catch { /* no manifest */ }
      items.push(item({
        kind: 'plugin', name, source: `marketplace:${market}`, path: version, enabled, description,
        fingerprint: valueFingerprint({ key, version: basename(version), enabled }), ...seen, logKeys: [name], plugin: key,
        members: parts.length ? { skill: parts.length } : {}, removal,
        declarations: cfg ? [{ file: paths.config, scope: 'user', enabled }] : [],
      }), ...parts);
    }
  }

  // MCP servers: [mcp_servers.<name>]; enabled = false keeps them listed but off.
  for (const t of config.filter(t => t.path[0] === 'mcp_servers' && t.path.length === 2)) {
    const name = t.path[1]!;
    const enabled = t.values.enabled !== false;
    items.push(item({
      kind: 'mcp', name, source: 'user config', path: paths.config, enabled,
      description: typeof t.values.command === 'string' ? `${t.values.command}` : typeof t.values.url === 'string' ? `${t.values.url}` : '',
      fingerprint: valueFingerprint(t.values), logKeys: [name.replace(/[^A-Za-z0-9_-]/g, '_')],
      removal: { method: 'manual', where: `${cfgFile}, under [mcp_servers.${name}]: set enabled = false` },
      declarations: [{ file: paths.config, scope: 'user', enabled }],
    }));
  }

  // Custom prompts (slash commands) live as markdown files.
  for (const f of files(paths.prompts, '.md')) {
    const path = join(paths.prompts, f);
    const name = f.replace(/\.md$/, '');
    const description = frontmatter(readText(path)).description ?? '';
    items.push(item({ kind: 'command', name, source: 'personal', path, description, fingerprint: pathFingerprint(path), ...firstSeenOf(path), logKeys: [name], removal: { method: 'move' } }));
  }

  // AGENTS.md: the global one and each known project's; loaded in full, edited by hand.
  const agents = [[paths.agentsMd, null] as const, ...projectRoots.map(r => [join(r, 'AGENTS.md'), r] as const)];
  for (const [path, root] of agents) {
    const text = readText(path);
    if (!text.trim()) continue;
    items.push(item({
      kind: 'instructions', name: root ? `${basename(root)}/AGENTS.md` : 'AGENTS.md', source: root ? 'project' : 'personal', path, projectRoot: root,
      standingChars: text.length, fingerprint: pathFingerprint(path), ...firstSeenOf(path), removal: { method: 'manual', where: tilde(path, paths.home) },
    }));
  }
  return items;
}
