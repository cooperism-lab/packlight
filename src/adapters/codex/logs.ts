// Reads Codex session logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl): sessions, skill and MCP use, and what
// each session started with (its world_state record and the input tokens of its first request).
import { createReadStream, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { CodexStart, SessionRecord } from '../../core/types.js';
import type { Use } from '../claude-code/logs.js';

export interface CodexLogScan {
  sessions: SessionRecord[];
  skillUses: Map<string, Use[]>;
  mcpUses: Map<string, Use[]>;
  /** One per session that logged a world_state, oldest first; firstRequestTokens holds that session's only. */
  starts: CodexStart[];
  linesTotal: number;
  linesUnknownShape: number;
  linesUnreadable: number;
  unknownByVersion: Record<string, number>;
  versions: string[];
}

function rollouts(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let names: string[];
    try { names = readdirSync(d, { withFileTypes: true }).map(e => (e.isDirectory() ? `${e.name}/` : e.name)); } catch { return; }
    for (const n of names) {
      if (n.endsWith('/')) walk(join(d, n.slice(0, -1)));
      else if (/^rollout-.*\.jsonl$/.test(n)) out.push(join(d, n));
    }
  };
  walk(dir);
  return out.sort();
}

const push = (m: Map<string, Use[]>, k: string, u: Use): void => { const l = m.get(k); if (l) l.push(u); else m.set(k, [u]); };
const textOf = (v: unknown): number => (typeof v === 'string' ? v.length : v && typeof v === 'object' ? JSON.stringify(v).length : 0);

/** Skills a tool call opened: Codex reads a skill by reading its SKILL.md. Plugin skills are "<plugin>:<skill>". */
export function skillsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\/plugins\/cache\/[^/"'\s]+\/([^/"'\s]+)\/[^/"'\s]+\/skills\/([^/"'\s]+)\/SKILL\.md/g)) out.add(`${m[1]}:${m[2]}`);
  for (const m of text.matchAll(/\/\.codex\/skills\/(?:\.system\/)?([^/"'\s]+)\/SKILL\.md/g)) out.add(m[1]!);
  return [...out];
}

/** MCP servers a tool call used: "mcp__<server>__<tool>" as the tool name, or called from Codex's code mode. */
export function mcpServersIn(name: unknown, input: string): string[] {
  const out = new Set<string>();
  if (typeof name === 'string' && name.startsWith('mcp__')) out.add(name.split('__')[1]!);
  for (const m of input.matchAll(/\bmcp__([A-Za-z0-9_-]+?)__[A-Za-z0-9_]/g)) out.add(m[1]!);
  return [...out];
}

const KNOWN = new Set(['session_meta', 'response_item', 'event_msg', 'turn_context', 'world_state', 'token_usage_record', 'compacted']);

export async function scanCodexLogs(dir: string, opts: { projectOf: (cwd: string) => string | null; since?: string }): Promise<CodexLogScan> {
  const scan: CodexLogScan = { sessions: [], skillUses: new Map(), mcpUses: new Map(), starts: [], linesTotal: 0, linesUnknownShape: 0, linesUnreadable: 0, unknownByVersion: {}, versions: [] };
  const versions = new Set<string>();
  for (const file of rollouts(dir)) {
    const s: SessionRecord = { id: file, file, projectRoot: null, start: null, end: null, lines: 0, unknownShapeLines: 0, unreadableLines: 0, versions: [] };
    let version: string | null = null;
    let project: string | null = null;
    let start: CodexStart | null = null;
    let firstTokens: number | null = null;
    const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      scan.linesTotal++;
      s.lines++;
      let e: any;
      try { e = JSON.parse(line); } catch { scan.linesUnreadable++; s.unreadableLines++; continue; }
      const ts: string | null = typeof e?.timestamp === 'string' ? e.timestamp : null;
      if (ts && opts.since && ts < opts.since) continue;
      if (ts) { if (!s.start || ts < s.start) s.start = ts; if (!s.end || ts > s.end) s.end = ts; }
      const p = e?.payload ?? {};
      if (!KNOWN.has(e?.type)) {
        scan.linesUnknownShape++;
        if (version) scan.unknownByVersion[version] = (scan.unknownByVersion[version] ?? 0) + 1;
        continue;
      }
      if (e.type === 'session_meta') {
        if (typeof p.id === 'string') s.id = p.id;
        if (typeof p.cli_version === 'string') { version = p.cli_version; versions.add(p.cli_version); s.versions = [p.cli_version]; }
        if (typeof p.cwd === 'string') { project = opts.projectOf(p.cwd); s.projectRoot = project; }
      } else if (e.type === 'turn_context' && typeof p.cwd === 'string' && !project) {
        project = opts.projectOf(p.cwd);
        s.projectRoot = project;
      } else if (e.type === 'world_state' && !start) {
        const st = p.state ?? {};
        const skills = typeof st.host_skills?.body === 'string' ? st.host_skills.body : '';
        start = {
          sessionId: s.id, timestamp: ts, version, projectRoot: project,
          skillListingChars: skills.length,
          listedSkills: [...skills.matchAll(/^- ([^:\n]+(?::[^:\n ]+)?): /gm)].map(m => m[1]!.trim()),
          agentsMdChars: typeof st.agents_md?.text === 'string' ? st.agents_md.text.length : 0,
          pluginInstructionChars: st.plugins_instructions ? textOf(st.plugins_instructions) : 0,
          appInstructionChars: st.apps_instructions ? textOf(st.apps_instructions) : 0,
          firstRequestTokens: [],
        };
      } else if (e.type === 'event_msg' && p.type === 'token_count' && firstTokens === null) {
        const n = p.info?.last_token_usage?.input_tokens;
        if (typeof n === 'number') firstTokens = n;
      } else if (e.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call')) {
        const input = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.action ?? p.arguments ?? '');
        const use: Use = { ts, project };
        for (const k of skillsIn(input)) push(scan.skillUses, k, use);
        for (const k of mcpServersIn(p.name, input)) push(scan.mcpUses, k, use);
      }
    }
    if (start) {
      if (firstTokens !== null) start.firstRequestTokens.push(firstTokens);
      start.projectRoot = project;
      scan.starts.push(start);
    }
    if (s.start) scan.sessions.push(s);
  }
  scan.starts.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  scan.versions = [...versions].sort();
  return scan;
}
