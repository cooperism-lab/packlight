import type { Inventory, Kind } from './types.js';

const KIND_ORDER: Kind[] = ['skill', 'command', 'agent', 'hook', 'plugin', 'mcp', 'instructions'];
const KIND_LABEL: Record<Kind, string> = { skill: 'skills', command: 'commands', agent: 'agents', hook: 'hooks', plugin: 'plugins', mcp: 'MCP servers', instructions: 'instruction files' };

export const chars = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(n));

/** The text summary `packlight scan` prints: counts, the listing budget and the heaviest hooks. */
export function summarize(inv: Inventory, ms: number): string {
  const out: string[] = [];
  const from = inv.window.from ? inv.window.from.slice(0, 10) : 'the start';
  out.push(`Scanned ${inv.sessionsInWindow} sessions from ${from} to ${inv.window.to.slice(0, 10)} in ${(ms / 1000).toFixed(1)} s.`);
  out.push(`Scope: ${inv.projectScope}`);
  out.push('');
  const counts = KIND_ORDER.map(k => [k, inv.items.filter(i => i.kind === k)] as const).filter(([, l]) => l.length);
  for (const [k, list] of counts) {
    const detail = k === 'instructions'
      ? `${chars(list.reduce((n, i) => n + i.standingChars, 0))} chars loaded in their projects`
      : `${list.filter(i => i.usage.total === 0).length} not observed`;
    out.push(`  ${String(list.length).padStart(4)} ${KIND_LABEL[k].padEnd(18)} ${detail}`);
  }
  // A project scan reads that project's listing; a global scan reads the newest listing from any session.
  const newest = Object.values(inv.budget).sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '')).at(-1);
  const budget = inv.projectScope !== 'global' ? inv.budget[inv.projectScope] ?? newest : newest;
  out.push('');
  if (budget) {
    out.push(`Skill listing (${budget.timestamp?.slice(0, 10) ?? 'latest'}, Claude Code ${budget.version ?? '?'}): ${budget.dropped.length} of ${budget.skillCount} skills listed without their description (${chars(budget.listingChars)} chars).`);
  } else {
    out.push('Skill listing: no listing found in these logs.');
  }
  const tl = inv.toolListing?.[inv.projectScope] ?? Object.values(inv.toolListing ?? {}).sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? '')).at(-1);
  if (tl) {
    const servers = Object.values(tl.servers);
    const top = Object.entries(tl.servers).sort((a, b) => b[1].chars + b[1].instructionChars - a[1].chars - a[1].instructionChars).slice(0, 3)
      .map(([k, s]) => `${s.label ?? (inv.items.find(i => i.kind === 'mcp' && i.logKeys.includes(k))?.description?.startsWith('Tools:') ? `${k.slice(0, 8)}… (${s.sample?.slice(0, 2).join(', ')})` : k)} ${chars(s.chars + s.instructionChars)}`);
    out.push(`MCP tool list (${tl.timestamp?.slice(0, 10) ?? 'latest'}): ${servers.reduce((n, s) => n + s.tools, 0)} tools from ${servers.length} servers, ${chars(servers.reduce((n, s) => n + s.chars, 0))} chars of tool names and ${chars(servers.reduce((n, s) => n + s.instructionChars, 0))} of instructions every session. Largest: ${top.join(', ')}.`);
  }
  const hooks = inv.items.filter(i => i.usage.hook && i.usage.hook.firings > 0)
    .sort((a, b) => b.usage.hook!.injectedChars - a.usage.hook!.injectedChars).slice(0, 5);
  if (hooks.length) {
    out.push('Hooks by injected text:');
    for (const h of hooks) {
      const u = h.usage.hook!;
      out.push(`  ${h.name}  ${u.firings} firings, ${chars(u.injectedChars / u.firings)} chars per firing, p95 ${u.p95DurationMs} ms${u.injectionShared ? ' (shared)' : ''}${h.usage.ambiguous ? ' (ambiguous)' : ''}`);
    }
  }
  if (inv.coverage.uncertain) out.push(`\nUsage may be incomplete: ${inv.coverage.reasons.join('; ')}.`);
  if (inv.linesUnreadable) out.push(`${inv.linesUnreadable} log lines could not be read.`);
  return out.join('\n');
}
