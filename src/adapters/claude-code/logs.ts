import { createReadStream, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { BudgetObservation, ListingLine, SessionRecord, ToolListing } from '../../core/types.js';

/** Top-level line types seen in Claude Code logs up to 2.1.293 (eng A2). Anything else is counted as an unknown shape. */
export const KNOWN_LINE_TYPES = new Set([
  'agent-name', 'ai-title', 'artifact-autoreact-ledger', 'artifact-comment-monitor', 'assistant', 'atis-latch', 'attachment',
  'bridge-session', 'cost-state', 'custom-title', 'dev-mods', 'failed', 'file-history-delta', 'file-history-snapshot',
  'frame-link', 'last-prompt', 'launched', 'mode', 'pr-link', 'queue-operation', 'relocated', 'result', 'started',
  'summary', 'system', 'user',
]);
const HOOK_ATTACHMENTS = new Set(['hook_success', 'hook_additional_context', 'hook_system_message']);

export interface Use { ts: string | null; project: string | null }

export interface HookFiring {
  event: string;
  command: string;
  ts: string | null;
  project: string | null;
  durationMs: number | null;
  /** Output Claude Code recorded on the success line (used when no separate context line follows). */
  ownChars: number;
  /** Characters from additional-context/system-message lines linked to this firing. */
  linkedChars: number;
  /** Linked text was shared with other hooks on the same tool call and could not be split. */
  shared: boolean;
}

export interface LogScan {
  sessions: SessionRecord[];
  skillUses: Map<string, Use[]>;
  agentUses: Map<string, Use[]>;
  mcpUses: Map<string, Use[]>;
  hookFirings: HookFiring[];
  /** Initial skill listings, oldest first. */
  listings: BudgetObservation[];
  /** One per main session file that logged a tool list, oldest first. */
  toolListings: ToolListing[];
  unattributedHookChars: number;
  linesTotal: number;
  linesUnknownShape: number;
  /** Unknown-shape lines that looked like usage evidence (tool calls, hooks, listings). */
  linesUnknownRelevant: number;
  linesUnreadable: number;
  unknownByVersion: Record<string, number>;
  versions: string[];
}

export interface LogOptions {
  /** Maps a working directory to its project root, or null when it belongs to no known project. */
  projectOf: (cwd: string) => string | null;
  since?: string;
}

/** Text length of an attachment's content, which is a string or a list of strings/text blocks. */
function contentChars(c: unknown): number {
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) return c.reduce((n: number, x) => n + (typeof x === 'string' ? x.length : typeof x?.text === 'string' ? x.text.length : 0), 0);
  return 0;
}

function push(map: Map<string, Use[]>, key: string, use: Use): void {
  const list = map.get(key);
  if (list) list.push(use); else map.set(key, [use]);
}

function listingSplit(content: string, names: string[]): { withDescription: string[]; dropped: string[]; entries: ListingLine[] } {
  const byLength = [...names].sort((a, b) => b.length - a.length);
  const withDescription: string[] = [];
  const dropped: string[] = [];
  const entries: ListingLine[] = [];
  let current: ListingLine | null = null;
  for (const line of content.split('\n')) {
    if (!line.startsWith('- ')) {
      // A description that runs over several lines: its size belongs to the entry above.
      if (current) current.chars += line.length + 1;
      continue;
    }
    const body = line.slice(2);
    const name = byLength.find(n => body === n || body.startsWith(`${n}:`) || body.startsWith(`${n} (`));
    if (!name) { current = null; continue; }
    const rest = body.slice(name.length).replace(/^ \([^)]*\)/, '');
    const described = rest.startsWith(': ');
    (described ? withDescription : dropped).push(name);
    current = { name, chars: line.length + 1, described };
    entries.push(current);
  }
  return { withDescription, dropped, entries };
}

/** Every .jsonl under the projects folder; subagent transcripts belong to their parent session. */
export function logFiles(projectsDir: string): { file: string; sessionId: string; isSubagent: boolean }[] {
  const out: { file: string; sessionId: string; isSubagent: boolean }[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        const parts = relative(projectsDir, p).split(sep);
        // <project>/<session>.jsonl, or <project>/<session>/subagents/<agent>.jsonl
        const isSubagent = parts.length > 2;
        out.push({ file: p, sessionId: isSubagent ? parts[1]! : basename(e.name, '.jsonl'), isSubagent });
      }
    }
  };
  walk(projectsDir);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export async function scanLogs(projectsDir: string, opts: LogOptions): Promise<LogScan> {
  const scan: LogScan = {
    sessions: [], skillUses: new Map(), agentUses: new Map(), mcpUses: new Map(), hookFirings: [], listings: [], toolListings: [],
    unattributedHookChars: 0, linesTotal: 0, linesUnknownShape: 0, linesUnknownRelevant: 0, linesUnreadable: 0,
    unknownByVersion: {}, versions: [],
  };
  const versions = new Set<string>();
  const sessions = new Map<string, SessionRecord & { versionSet: Set<string> }>();

  for (const { file, sessionId, isSubagent } of logFiles(projectsDir)) {
    let s = sessions.get(sessionId);
    if (!s) {
      s = { id: sessionId, file, projectRoot: null, start: null, end: null, lines: 0, unknownShapeLines: 0, unreadableLines: 0, versions: [], versionSet: new Set() };
      sessions.set(sessionId, s);
    }
    if (!isSubagent) s.file = file;
    // Lines without a cwd inherit the last one seen in this file (eng A3).
    let cwd: string | null = null;
    let version: string | null = null;
    // Hook success lines waiting for their context lines, keyed by tool call and hook name.
    const pending = new Map<string, HookFiring[]>();
    // This session's tool list, built from its deltas (main session files only: subagents get their own lists).
    let tools: ToolListing | null = null;
    const toolLines = new Map<string, { key: string | null; chars: number }>();
    const server = (key: string) => (tools!.servers[key] ??= { tools: 0, chars: 0, instructionChars: 0 });

    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      scan.linesTotal++;
      s.lines++;
      let e: any;
      try { e = JSON.parse(line); } catch { scan.linesUnreadable++; s.unreadableLines++; continue; }
      if (!e || typeof e !== 'object') { scan.linesUnreadable++; s.unreadableLines++; continue; }

      if (typeof e.cwd === 'string') cwd = e.cwd;
      if (typeof e.version === 'string') { const v: string = e.version; version = v; versions.add(v); s.versionSet.add(v); }
      const ts: string | null = typeof e.timestamp === 'string' ? e.timestamp : null;
      if (ts && opts.since && ts < opts.since) continue;
      if (ts) {
        if (!s.start || ts < s.start) s.start = ts;
        if (!s.end || ts > s.end) s.end = ts;
      }
      const project = cwd ? opts.projectOf(cwd) : null;
      if (project && !isSubagent && !s.projectRoot) s.projectRoot = project;
      const use: Use = { ts, project };

      // Session counts hold only unknown lines that looked like usage evidence; they drive "usage uncertain".
      const unknown = (relevant: boolean): void => {
        scan.linesUnknownShape++;
        if (relevant) {
          s!.unknownShapeLines++;
          scan.linesUnknownRelevant++;
          const v = version ?? 'unknown';
          scan.unknownByVersion[v] = (scan.unknownByVersion[v] ?? 0) + 1;
        }
      };

      const type = e.type;
      if (typeof type !== 'string' || !KNOWN_LINE_TYPES.has(type)) {
        unknown(/"tool_use"|"hook[A-Z_]|skill_listing/.test(line));
        continue;
      }

      if (type === 'assistant') {
        const content = e.message?.content;
        if (!Array.isArray(content)) { if (line.includes('"tool_use"')) unknown(true); continue; }
        for (const b of content) {
          if (b?.type !== 'tool_use') continue;
          if (typeof b.name !== 'string') { unknown(true); continue; }
          const input = b.input ?? {};
          if (b.name === 'Skill') {
            if (typeof input.skill === 'string') push(scan.skillUses, input.skill.replace(/^\//, ''), use); else unknown(true);
          } else if (b.name === 'Agent' || b.name === 'Task') {
            push(scan.agentUses, typeof input.subagent_type === 'string' ? input.subagent_type : 'general-purpose', use);
          } else if (b.name.startsWith('mcp__')) {
            const server = b.name.split('__')[1];
            if (server) push(scan.mcpUses, server, use);
          }
        }
      } else if (type === 'user') {
        if (!line.includes('<command-name>')) continue;
        const c = e.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('') : '';
        const m = /<command-name>\/?([^<]+)<\/command-name>/.exec(text);
        if (m?.[1]) push(scan.skillUses, m[1].trim(), use);
      } else if (type === 'attachment') {
        const a = e.attachment;
        if (!a || typeof a !== 'object') continue;
        const at = a.type;
        if (typeof at === 'string' && at.startsWith('hook_') && !HOOK_ATTACHMENTS.has(at)) { unknown(true); continue; }
        if (at === 'hook_success') {
          if (typeof a.command !== 'string' || typeof a.hookEvent !== 'string') { unknown(true); continue; }
          const firing: HookFiring = {
            event: a.hookEvent, command: a.command, ts, project,
            durationMs: typeof a.durationMs === 'number' ? a.durationMs : null,
            ownChars: contentChars(a.content) || (typeof a.stdout === 'string' ? a.stdout.length : 0),
            linkedChars: 0, shared: false,
          };
          scan.hookFirings.push(firing);
          const key = `${a.toolUseID ?? ''}|${a.hookName ?? ''}`;
          const list = pending.get(key);
          if (list) list.push(firing); else pending.set(key, [firing]);
        } else if (at === 'hook_additional_context' || at === 'hook_system_message') {
          const chars = contentChars(a.content);
          const firings = pending.get(`${a.toolUseID ?? ''}|${a.hookName ?? ''}`);
          if (!firings?.length) { scan.unattributedHookChars += chars; continue; }
          // Only hooks that printed something can have produced the text.
          const producers = firings.filter(f => f.ownChars > 0);
          const targets = producers.length ? producers : firings;
          if (targets.length === 1) targets[0]!.linkedChars += chars;
          else for (const f of targets) { f.linkedChars += chars / targets.length; f.shared = true; }
        } else if ((at === 'deferred_tools_delta' || at === 'mcp_instructions_delta') && !isSubagent) {
          tools ??= { sessionId, timestamp: ts, version, projectRoot: project, servers: {}, builtIn: { tools: 0, chars: 0 } };
          const added: unknown[] = Array.isArray(a.addedNames) ? a.addedNames : [];
          const removed: unknown[] = Array.isArray(a.removedNames) ? a.removedNames : [];
          if (at === 'deferred_tools_delta') {
            const lines: unknown[] = Array.isArray(a.addedLines) ? a.addedLines : [];
            added.forEach((n, i) => {
              if (typeof n !== 'string') return;
              const text = typeof lines[i] === 'string' ? (lines[i] as string) : n;
              const key = n.startsWith('mcp__') ? n.split('__')[1] ?? null : null;
              const prev = toolLines.get(n);
              if (prev) { if (prev.key) { server(prev.key).tools--; server(prev.key).chars -= prev.chars; } else { tools!.builtIn.tools--; tools!.builtIn.chars -= prev.chars; } }
              toolLines.set(n, { key, chars: text.length + 1 });
              if (key) {
                const s = server(key);
                s.tools++;
                s.chars += text.length + 1;
                const short = n.split('__').slice(2).join('__');
                if (short && (s.sample ??= []).length < 4 && !s.sample.includes(short)) s.sample.push(short);
              } else { tools!.builtIn.tools++; tools!.builtIn.chars += text.length + 1; }
            });
            for (const n of removed) {
              const prev = typeof n === 'string' ? toolLines.get(n) : undefined;
              if (!prev) continue;
              toolLines.delete(n as string);
              if (prev.key) { server(prev.key).tools--; server(prev.key).chars -= prev.chars; } else { tools!.builtIn.tools--; tools!.builtIn.chars -= prev.chars; }
            }
          } else {
            const blocks: unknown[] = Array.isArray(a.addedBlocks) ? a.addedBlocks : [];
            added.forEach((n, i) => {
              if (typeof n !== 'string') return;
              const block = typeof blocks[i] === 'string' ? (blocks[i] as string) : '';
              const s = server(toolKey(n));
              s.instructionChars = block.length;
              // Connectors are named by id; their block's first line after the heading names the service.
              const label = /^[^\n]*\n([^:\n]{1,60})[:\n]/.exec(block)?.[1]?.trim();
              if (label) s.label = label;
            });
            for (const n of removed) if (typeof n === 'string' && tools.servers[toolKey(n)]) tools.servers[toolKey(n)]!.instructionChars = 0;
          }
        } else if (at === 'skill_listing') {
          if (!Array.isArray(a.names) || typeof a.content !== 'string') { unknown(true); continue; }
          if (a.isInitial === false) continue;
          scan.listings.push({
            sessionId, timestamp: ts, version, projectRoot: project, skillCount: typeof a.skillCount === 'number' ? a.skillCount : a.names.length,
            listingChars: a.content.length, ...listingSplit(a.content, a.names),
          });
        }
      }
    }
    if (tools) {
      for (const [k, v] of Object.entries(tools.servers)) if (v.tools <= 0 && v.instructionChars <= 0) delete tools.servers[k];
      scan.toolListings.push(tools);
    }
  }

  scan.toolListings.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  for (const s of sessions.values()) {
    const { versionSet, ...rest } = s;
    scan.sessions.push({ ...rest, versions: [...versionSet].sort() });
  }
  scan.listings.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  scan.versions = [...versions].sort(compareVersions);
  return scan;
}

/** A server name in the form tool names use: "plugin:x:y" and "My Server" become "plugin_x_y" and "My_Server". */
export const toolKey = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_');

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
