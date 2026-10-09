import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { frontmatter } from '../../core/frontmatter.js';
import { itemId, pathFingerprint, sha256, valueFingerprint } from '../../core/hash.js';
import type { Declaration, DeclScope, Item, Kind, RemovalMethod } from '../../core/types.js';

const AGENT = 'claude-code' as const;

export interface ClaudePaths {
  home: string;
  claude: string;
  claudeJson: string;
  projectsLogDir: string;
  desktopExtensions: string;
  /** Claude desktop app folder holding claude.ai organisation plugins (macOS). */
  appSessions: string;
}

export function claudePaths(home: string): ClaudePaths {
  const claude = join(home, '.claude');
  return {
    home,
    claude,
    claudeJson: join(home, '.claude.json'),
    projectsLogDir: join(claude, 'projects'),
    desktopExtensions: join(home, 'Library', 'Application Support', 'Claude', 'Claude Extensions'),
    appSessions: join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
  };
}

const readJson = (p: string): any => {
  try { return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return undefined; }
};
const readText = (p: string): string => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const dirs = (p: string): string[] => {
  try { return readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory() || d.isSymbolicLink()).map(d => d.name).sort(); } catch { return []; }
};
const files = (p: string, ext: string): string[] => {
  try { return readdirSync(p, { withFileTypes: true }).filter(d => !d.isDirectory() && d.name.endsWith(ext)).map(d => d.name).sort(); } catch { return []; }
};
/** Pointer segment escaping per RFC 6901. */
const ptr = (...parts: (string | number)[]): string => '/' + parts.map(p => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

function firstSeenOf(path: string): { firstSeen: string | null; firstSeenSource: Item['firstSeenSource'] } {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return { firstSeen: null, firstSeenSource: null };
  if (st.birthtimeMs > 0) return { firstSeen: new Date(st.birthtimeMs).toISOString(), firstSeenSource: 'birthtime' };
  return { firstSeen: new Date(st.mtimeMs).toISOString(), firstSeenSource: 'mtime' };
}

interface ItemInput {
  kind: Kind;
  name: string;
  source: string;
  path: string | null;
  projectRoot?: string | null;
  enabled?: boolean;
  description?: string;
  standingChars?: number;
  fingerprint: string;
  firstSeen?: string | null;
  firstSeenSource?: Item['firstSeenSource'];
  logKeys?: string[];
  plugin?: string;
  hook?: Item['hook'];
  members?: Item['members'];
  declarations?: Declaration[];
  removal: Item['removal'];
  pointer?: string;
}

function makeItem(i: ItemInput): Item {
  const description = i.description ?? '';
  return {
    id: itemId({ agent: AGENT, kind: i.kind, source: i.source, name: i.name, path: i.path, pointer: i.pointer }),
    agent: AGENT,
    kind: i.kind,
    name: i.name,
    source: i.source,
    path: i.path,
    projectRoot: i.projectRoot ?? null,
    enabled: i.enabled ?? true,
    description,
    descHash: sha256(`${i.name}\u0000${description}`),
    standingChars: i.standingChars ?? 0,
    targetFingerprint: i.fingerprint,
    firstSeen: i.firstSeen ?? null,
    firstSeenSource: i.firstSeenSource ?? null,
    logKeys: i.logKeys ?? [],
    ...(i.plugin ? { plugin: i.plugin } : {}),
    ...(i.hook ? { hook: i.hook } : {}),
    ...(i.members ? { members: i.members } : {}),
    declarations: i.declarations ?? (i.path ? [{ file: i.path, scope: 'user' }] : []),
    removal: i.removal,
    usage: { total: 0, last30: 0, lastUsed: null, byProject: {}, ambiguous: false, uncertain: false },
  };
}

/** What an item contributes to every session: its line in the skill or agent listing. */
const listingChars = (name: string, description: string): number => `- ${name}: ${description}\n`.length;

// ---------------------------------------------------------------- skills, commands, agents

function skillsIn(root: string, opts: { source: string; projectRoot: string | null; plugin?: string; enabled: boolean; method: RemovalMethod; where?: string; firstSeen?: string | null }): Item[] {
  const out: Item[] = [];
  for (const d of dirs(root)) {
    if (d === 'synced' && !opts.plugin && !opts.projectRoot) continue;
    const dir = join(root, d);
    const file = join(dir, 'SKILL.md');
    if (!existsSync(file)) continue;
    const fm = frontmatter(readText(file));
    const name = opts.plugin ? `${pluginShortName(opts.plugin)}:${d}` : d;
    const description = fm.description ?? '';
    const seen = opts.firstSeen !== undefined ? { firstSeen: opts.firstSeen, firstSeenSource: opts.firstSeen ? 'installedAt' as const : null } : firstSeenOf(dir);
    // A folder that holds other skills or shared scripts is a suite (gstack is one): moving it would break the
    // skills that depend on it, so it is only removable through the suite's own uninstaller.
    const suite = !opts.plugin && (existsSync(join(dir, 'bin')) || dirs(dir).some(c => existsSync(join(dir, c, 'SKILL.md'))));
    out.push(makeItem({
      kind: 'skill', name, source: opts.source, path: dir, projectRoot: opts.projectRoot, enabled: opts.enabled,
      description, standingChars: opts.enabled ? listingChars(name, description) : 0,
      fingerprint: suite ? valueFingerprint({ dir, description }) : pathFingerprint(dir), ...seen, logKeys: [name], plugin: opts.plugin,
      removal: suite ? { method: 'manual', where: `the ${name} suite's own uninstaller (other skills depend on ${dir})`, suite: true } : { method: opts.method, where: opts.where },
    }));
  }
  return out;
}

function commandsIn(root: string, opts: { source: string; projectRoot: string | null; plugin?: string; enabled: boolean; method: RemovalMethod; where?: string; firstSeen?: string | null }, prefix = ''): Item[] {
  const out: Item[] = [];
  for (const f of files(root, '.md')) {
    const path = join(root, f);
    const fm = frontmatter(readText(path));
    const base = prefix + f.slice(0, -3);
    const name = opts.plugin ? `${pluginShortName(opts.plugin)}:${base}` : base;
    const description = fm.description ?? '';
    const seen = opts.firstSeen !== undefined ? { firstSeen: opts.firstSeen, firstSeenSource: opts.firstSeen ? 'installedAt' as const : null } : firstSeenOf(path);
    out.push(makeItem({
      kind: 'command', name, source: opts.source, path, projectRoot: opts.projectRoot, enabled: opts.enabled,
      description, standingChars: opts.enabled ? listingChars(name, description) : 0,
      fingerprint: pathFingerprint(path), ...seen, logKeys: [name], plugin: opts.plugin,
      removal: { method: opts.method, where: opts.where },
    }));
  }
  // Commands in subfolders are invoked as "folder:name".
  for (const d of dirs(root)) out.push(...commandsIn(join(root, d), opts, `${prefix}${d}:`));
  return out;
}

function agentsIn(root: string, opts: { source: string; projectRoot: string | null; plugin?: string; enabled: boolean; method: RemovalMethod; where?: string; firstSeen?: string | null }): Item[] {
  const out: Item[] = [];
  for (const f of files(root, '.md')) {
    const path = join(root, f);
    const fm = frontmatter(readText(path));
    const base = fm.name || f.slice(0, -3);
    const name = opts.plugin ? `${pluginShortName(opts.plugin)}:${base}` : base;
    const description = fm.description ?? '';
    const seen = opts.firstSeen !== undefined ? { firstSeen: opts.firstSeen, firstSeenSource: opts.firstSeen ? 'installedAt' as const : null } : firstSeenOf(path);
    out.push(makeItem({
      kind: 'agent', name, source: opts.source, path, projectRoot: opts.projectRoot, enabled: opts.enabled,
      description, standingChars: opts.enabled ? listingChars(name, description) : 0,
      fingerprint: pathFingerprint(path), ...seen, logKeys: [name], plugin: opts.plugin,
      removal: { method: opts.method, where: opts.where },
    }));
  }
  return out;
}

// ---------------------------------------------------------------- hooks and MCP declared in settings

type HookConfig = Record<string, { matcher?: string; hooks?: { type?: string; command?: string }[] }[]>;

function hooksFrom(config: HookConfig | undefined, ctx: { file: string; scope: DeclScope; source: string; projectRoot: string | null; plugin?: string; enabled: boolean; method: RemovalMethod; where?: string; firstSeen?: string | null }): Item[] {
  const out: Item[] = [];
  if (!config || typeof config !== 'object') return out;
  for (const [event, groups] of Object.entries(config)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((g, gi) => {
      (g?.hooks ?? []).forEach((h, hi) => {
        const command = typeof h?.command === 'string' ? h.command : '';
        if (!command) return;
        const pointer = ptr('hooks', event, gi, 'hooks', hi);
        const label = hookLabel(command, ctx.plugin);
        const matcher = g?.matcher ?? null;
        out.push(makeItem({
          kind: 'hook', name: `${label} · ${event}${matcher ? ` (${matcher})` : ''}`, source: ctx.source, path: ctx.file,
          projectRoot: ctx.projectRoot, enabled: ctx.enabled, fingerprint: valueFingerprint({ event, matcher, command }),
          firstSeen: ctx.firstSeen ?? null, firstSeenSource: ctx.firstSeen ? 'installedAt' : null,
          plugin: ctx.plugin, hook: { event, matcher, command },
          declarations: [{ file: ctx.file, scope: ctx.scope, pointer }], pointer,
          removal: { method: ctx.method, where: ctx.where ?? ctx.file },
        }));
      });
    });
  }
  return out;
}

function hookLabel(command: string, plugin?: string): string {
  if (plugin) {
    // Name a plugin hook by its script so two hooks on one event stay distinguishable.
    const script = /([\w.-]+\.(?:m?js|cjs|ts|sh|py|cmd))\b/.exec(command)?.[1];
    const arg = command.trim().split(/\s+/).slice(1).find(w => /^[a-z][\w-]*$/.test(w));
    return [pluginShortName(plugin), script, script ? undefined : arg].filter(Boolean).join(' ');
  }
  const first = command.trim().split(/\s+/)[0] ?? command;
  const tool = basename(first.replace(/^["']|["']$/g, ''));
  const rest = command.trim().split(/\s+/).slice(1, 3).join(' ');
  return (tool + (rest && !rest.startsWith('-c') ? ` ${rest}` : '')).slice(0, 60);
}

function mcpFrom(servers: Record<string, unknown> | undefined, ctx: { file: string; scope: DeclScope; source: string; projectRoot: string | null; pointerBase: string[]; plugin?: string; enabled: boolean; method: RemovalMethod; where?: string; firstSeen?: string | null }): Item[] {
  const out: Item[] = [];
  if (!servers || typeof servers !== 'object') return out;
  for (const [name, config] of Object.entries(servers)) {
    const pointer = ptr(...ctx.pointerBase, name);
    const logKey = ctx.plugin ? `plugin_${pluginShortName(ctx.plugin)}_${name}` : name;
    out.push(makeItem({
      kind: 'mcp', name, source: ctx.source, path: ctx.file, projectRoot: ctx.projectRoot, enabled: ctx.enabled,
      fingerprint: valueFingerprint(config), firstSeen: ctx.firstSeen ?? null, firstSeenSource: ctx.firstSeen ? 'installedAt' : null,
      logKeys: [logKey], plugin: ctx.plugin, declarations: [{ file: ctx.file, scope: ctx.scope, pointer }], pointer,
      removal: { method: ctx.method, where: ctx.where ?? ctx.file },
    }));
  }
  return out;
}

// ---------------------------------------------------------------- plugins

const pluginShortName = (key: string): string => key.split('@')[0] ?? key;

interface SettingsFile { file: string; scope: DeclScope; projectRoot: string | null; json: any }

function settingsFiles(paths: ClaudePaths, projectRoots: string[]): SettingsFile[] {
  const out: SettingsFile[] = [];
  const add = (file: string, scope: DeclScope, projectRoot: string | null): void => {
    const json = readJson(file);
    if (json && typeof json === 'object') out.push({ file, scope, projectRoot, json });
  };
  add(join(paths.claude, 'settings.json'), 'user', null);
  add(join(paths.claude, 'settings.local.json'), 'local', null);
  for (const root of projectRoots) {
    add(join(root, '.claude', 'settings.json'), 'project', root);
    add(join(root, '.claude', 'settings.local.json'), 'project-local', root);
  }
  return out;
}

function pluginItems(paths: ClaudePaths, settings: SettingsFile[]): Item[] {
  const installed = readJson(join(paths.claude, 'plugins', 'installed_plugins.json'))?.plugins ?? {};
  const out: Item[] = [];
  for (const [key, installs] of Object.entries<any[]>(installed)) {
    const install = Array.isArray(installs) ? installs[0] : undefined;
    const root: string | undefined = install?.installPath;
    if (!root || !existsSync(root)) continue;
    const declarations: Declaration[] = settings
      .filter(s => s.json?.enabledPlugins && key in s.json.enabledPlugins)
      .map(s => ({ file: s.file, scope: s.scope, pointer: ptr('enabledPlugins', key), enabled: s.json.enabledPlugins[key] !== false }));
    // Effective state outside any project: local settings beat user settings; undeclared means enabled.
    const enabled = (declarations.find(d => d.scope === 'local') ?? declarations.find(d => d.scope === 'user'))?.enabled ?? true;
    const firstSeen: string | null = install?.installedAt ?? null;
    const childOpts = { source: `plugin:${pluginShortName(key)}`, projectRoot: null, plugin: key, enabled, method: 'plugin-disable' as const, where: key, firstSeen };
    const children = [
      ...skillsIn(join(root, 'skills'), childOpts),
      ...commandsIn(join(root, 'commands'), childOpts),
      ...agentsIn(join(root, 'agents'), childOpts),
      ...hooksFrom(readJson(join(root, 'hooks', 'hooks.json'))?.hooks, { ...childOpts, file: join(root, 'hooks', 'hooks.json'), scope: 'plugin' }),
      ...(() => { const m = mcpFile(join(root, '.mcp.json')); return mcpFrom(m.servers, { ...childOpts, file: join(root, '.mcp.json'), scope: 'plugin', pointerBase: m.pointerBase }); })(),
    ];
    const members: Partial<Record<Kind, number>> = {};
    for (const c of children) members[c.kind] = (members[c.kind] ?? 0) + 1;
    const manifest = readJson(join(root, '.claude-plugin', 'plugin.json')) ?? readJson(join(root, 'package.json')) ?? {};
    out.push(makeItem({
      kind: 'plugin', name: pluginShortName(key), source: key.includes('@') ? `marketplace:${key.split('@')[1]}` : 'plugin', path: root,
      enabled, description: typeof manifest.description === 'string' ? manifest.description : '',
      fingerprint: valueFingerprint({ key, version: install?.version, members: children.map(c => c.id).sort() }),
      firstSeen, firstSeenSource: firstSeen ? 'installedAt' : null, plugin: key, members,
      declarations: declarations.length ? declarations : [{ file: join(paths.claude, 'plugins', 'installed_plugins.json'), scope: 'user', pointer: ptr('plugins', key), enabled: true }],
      removal: { method: 'plugin-disable', where: key },
    }));
    out.push(...children);
  }
  return out;
}

const mcpServersOf = (json: any): Record<string, unknown> | undefined =>
  json && typeof json === 'object' ? (json.mcpServers && typeof json.mcpServers === 'object' ? json.mcpServers : undefined) : undefined;

/** A .mcp.json may list servers under "mcpServers" or, as some plugins ship it, at the top level. */
function mcpFile(path: string): { servers: Record<string, unknown> | undefined; pointerBase: string[] } {
  const json = readJson(path);
  const wrapped = mcpServersOf(json);
  if (wrapped) return { servers: wrapped, pointerBase: ['mcpServers'] };
  const isServer = (v: any): boolean => !!v && typeof v === 'object' && (typeof v.command === 'string' || typeof v.url === 'string' || typeof v.type === 'string');
  if (json && typeof json === 'object' && Object.values(json).length && Object.values(json).every(isServer)) return { servers: json, pointerBase: [] };
  return { servers: undefined, pointerBase: ['mcpServers'] };
}

/** claude.ai organisation plugins the desktop app syncs: their skills load into Claude Code, removable only in the app. */
function desktopPlugins(paths: ClaudePaths): Item[] {
  const out: Item[] = [];
  for (const account of dirs(paths.appSessions)) {
    for (const org of dirs(join(paths.appSessions, account))) {
      const rpm = join(paths.appSessions, account, org, 'rpm');
      const manifest = readJson(join(rpm, 'manifest.json'));
      const entries: any[] = Array.isArray(manifest?.plugins) ? manifest.plugins : [];
      for (const entry of entries) {
        const root = join(rpm, String(entry.id ?? ''));
        const name: string = readJson(join(root, '.claude-plugin', 'plugin.json'))?.name ?? entry.name;
        if (!name || !existsSync(root)) continue;
        const key = `${name}@claude.ai`;
        const where = 'Claude desktop app › Customize › Plugins';
        const opts = { source: `plugin:${name}`, projectRoot: null, plugin: key, enabled: true, method: 'manual' as const, where };
        const children = [
          ...skillsIn(join(root, 'skills'), opts),
          ...commandsIn(join(root, 'commands'), opts),
          ...agentsIn(join(root, 'agents'), opts),
          ...(() => { const m = mcpFile(join(root, '.mcp.json')); return mcpFrom(m.servers, { ...opts, file: join(root, '.mcp.json'), scope: 'app', pointerBase: m.pointerBase }); })(),
        ];
        const members: Partial<Record<Kind, number>> = {};
        for (const c of children) members[c.kind] = (members[c.kind] ?? 0) + 1;
        out.push(makeItem({
          kind: 'plugin', name, source: 'claude.ai plugin', path: root, description: entry.displayName ?? '',
          fingerprint: valueFingerprint({ key, updatedAt: entry.updatedAt, members: children.map(c => c.id).sort() }),
          ...firstSeenOf(root), plugin: key, members, declarations: [{ file: join(rpm, 'manifest.json'), scope: 'app' }],
          removal: { method: 'manual', where },
        }));
        out.push(...children);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- always-loaded instructions

function instructionItem(path: string, source: string, projectRoot: string | null): Item | null {
  if (!existsSync(path)) return null;
  const text = readText(path);
  return makeItem({
    kind: 'instructions', name: projectRoot ? `${basename(projectRoot)}/${path.slice(projectRoot.length + 1)}` : basename(path),
    source, path, projectRoot, standingChars: text.length, fingerprint: pathFingerprint(path), ...firstSeenOf(path),
    removal: { method: 'manual', where: path },
  });
}

// ---------------------------------------------------------------- entry point

export function collectInventory(paths: ClaudePaths, projectRoots: string[]): Item[] {
  const items: Item[] = [];
  const claudeJson = readJson(paths.claudeJson) ?? {};
  const settings = settingsFiles(paths, projectRoots);

  // Personal skills, commands, agents.
  const personal = { source: 'personal', projectRoot: null, enabled: true, method: 'move' as const };
  items.push(...skillsIn(join(paths.claude, 'skills'), personal));
  items.push(...commandsIn(join(paths.claude, 'commands'), personal));
  items.push(...agentsIn(join(paths.claude, 'agents'), personal));

  // claude.ai skills synced into Claude Code: removable only on claude.ai.
  for (const org of dirs(join(paths.claude, 'skills', 'synced'))) {
    for (const s of dirs(join(paths.claude, 'skills', 'synced', org))) {
      const dir = join(paths.claude, 'skills', 'synced', org, s);
      const file = join(dir, 'SKILL.md');
      if (!existsSync(file)) continue;
      const description = frontmatter(readText(file)).description ?? '';
      const name = `anthropic-skills:${s}`;
      items.push(makeItem({
        kind: 'skill', name, source: 'claude.ai synced', path: dir, description, standingChars: listingChars(name, description),
        fingerprint: pathFingerprint(dir), ...firstSeenOf(dir), logKeys: [name],
        removal: { method: 'manual', where: 'claude.ai › Settings › Capabilities › Skills' },
      }));
    }
  }

  items.push(...pluginItems(paths, settings));
  items.push(...desktopPlugins(paths));

  // Hooks declared in user and project settings files.
  for (const s of settings) {
    items.push(...hooksFrom(s.json.hooks, {
      file: s.file, scope: s.scope, projectRoot: s.projectRoot, enabled: true, method: 'hook-extract',
      source: s.projectRoot ? `project:${basename(s.projectRoot)}` : s.scope === 'local' ? 'user local settings' : 'user settings',
    }));
  }

  // MCP servers: user scope in ~/.claude.json, local scope per project there, project scope in .mcp.json.
  items.push(...mcpFrom(mcpServersOf(claudeJson), { file: paths.claudeJson, scope: 'user', source: 'user config', projectRoot: null, pointerBase: ['mcpServers'], enabled: true, method: 'mcp-extract' }));
  for (const root of projectRoots) {
    const local = claudeJson.projects?.[root];
    items.push(...mcpFrom(mcpServersOf(local), { file: paths.claudeJson, scope: 'project-local', source: `project:${basename(root)}`, projectRoot: root, pointerBase: ['projects', root, 'mcpServers'], enabled: true, method: 'mcp-extract' }));
    const projMcp = mcpFile(join(root, '.mcp.json'));
    items.push(...mcpFrom(projMcp.servers, { file: join(root, '.mcp.json'), scope: 'project', source: `project:${basename(root)}`, projectRoot: root, pointerBase: projMcp.pointerBase, enabled: true, method: 'mcp-extract' }));

    // Project skills, commands, agents and instructions.
    const proj = { source: `project:${basename(root)}`, projectRoot: root, enabled: true, method: 'move' as const };
    items.push(...skillsIn(join(root, '.claude', 'skills'), proj));
    items.push(...commandsIn(join(root, '.claude', 'commands'), proj));
    items.push(...agentsIn(join(root, '.claude', 'agents'), proj));
    for (const f of ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md']) {
      const it = instructionItem(join(root, f), `project:${basename(root)}`, root);
      if (it) items.push(it);
    }
  }
  const userInstructions = instructionItem(join(paths.claude, 'CLAUDE.md'), 'personal', null);
  if (userInstructions) items.push(userInstructions);

  // Desktop app extensions (macOS app folder): removable only in the app.
  for (const d of dirs(paths.desktopExtensions)) {
    const manifest = readJson(join(paths.desktopExtensions, d, 'manifest.json'));
    if (!manifest) continue;
    const name: string = manifest.display_name || manifest.name || d;
    items.push(makeItem({
      kind: 'mcp', name, source: 'desktop extension', path: join(paths.desktopExtensions, d),
      description: typeof manifest.description === 'string' ? manifest.description : '',
      fingerprint: valueFingerprint(manifest), ...firstSeenOf(join(paths.desktopExtensions, d)),
      logKeys: [name.replace(/[^A-Za-z0-9]+/g, '_')],
      removal: { method: 'manual', where: 'Claude desktop app › Settings › Extensions' },
    }));
  }

  return items;
}

/** Skills Claude Code counts as used in ~/.claude.json: their descriptions go into the listing first. */
export function skillUsageNames(paths: ClaudePaths): string[] {
  const usage = readJson(paths.claudeJson)?.skillUsage;
  return usage && typeof usage === 'object' ? Object.keys(usage) : [];
}

/** Project roots Claude Code itself registered in ~/.claude.json. */
export function registeredProjects(paths: ClaudePaths): string[] {
  const projects = readJson(paths.claudeJson)?.projects;
  return projects && typeof projects === 'object' ? Object.keys(projects) : [];
}

export const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
export { dirname };
