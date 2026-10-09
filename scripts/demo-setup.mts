// Builds an invented but realistic Claude Code setup for marketing screenshots. Nothing here is a real person's data.
import { mkdirSync, writeFileSync, utimesSync, readdirSync, statSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { simulateListing } from '../dist/report/suggest.js';
const root = process.argv[2]; rmSync(root, { recursive: true, force: true });
const home = join(root, 'home'); const claude = join(home, '.claude'); const project = join(home, 'code', 'ledger-api');
const write = (p: string, s: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, s); };
const json = (p: string, v: unknown) => write(p, JSON.stringify(v, null, 1));
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
const words = 'Use when the user asks to plan, review, refactor, test, migrate, document or ship changes in a TypeScript, React or Node codebase. Covers edge cases, conventions, examples and a checklist so the result is consistent and production ready.'.split(' ');
const desc = (topic: string, n: number) => `${topic}. ` + Array.from({ length: n }, () => pick(words)).join(' ') + '.';

const personal = ['commit-message','pr-review','write-tests','refactor-plan','sql-optimizer','api-docs','changelog','dependency-audit','release-notes','bug-triage','perf-profile','react-migrate','tailwind-ui','storybook','e2e-playwright','docker-compose','k8s-debug','terraform-plan','aws-cost','security-scan','regex-helper','i18n-extract','a11y-audit','lighthouse','graphql-schema','prisma-migrate','next-app-router','zod-schemas','trpc-router','rust-clippy','go-tests','python-typing','notebook-clean','data-viz','csv-clean','pdf-extract','slide-deck','design-tokens','figma-to-code','copywriting','seo-meta','email-templates','stripe-webhooks','auth-flows','rate-limit','error-budget','log-search','oncall-runbook','feature-flags','monorepo-tidy','eslint-fix','type-coverage','bundle-size','cache-headers','cron-jobs','queue-workers','websocket-debug','sse-stream','openapi-gen','sdk-release'];
const kit = ['scaffold','lint','format','deploy','preview','rollback','env','secrets','logs','metrics','traces','alerts','db-branch','db-seed','db-diff','storage','cdn','edge-config','cron','queues','sandbox','ai-gateway','agents','evals','prompts','embeddings','vector-search','rag','chat-ui','workflows','auth','billing','analytics','experiments','flags','domains','firewall','image-opt','fonts','og-images','sitemap','robots','redirects','headers'];
const used = new Map<string, number>([['commit-message', 31], ['pr-review', 24], ['write-tests', 19], ['refactor-plan', 8], ['bug-triage', 11], ['e2e-playwright', 6], ['prisma-migrate', 5], ['zod-schemas', 4], ['devkit:deploy', 9], ['devkit:logs', 7], ['devkit:preview', 5], ['api-docs', 3], ['changelog', 2]]);

for (const s of personal) write(join(claude, 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: ${desc(s.replace(/-/g, ' '), 50 + Math.floor(rnd() * 35))}\n---\nBody.\n`);
const kitDir = join(claude, 'plugins', 'cache', 'market', 'devkit', '3.2.0');
for (const s of kit) write(join(kitDir, 'skills', s, 'SKILL.md'), `---\nname: ${s}\ndescription: ${desc(s, 34 + Math.floor(rnd() * 22))}\n---\n`);
json(join(kitDir, '.claude-plugin', 'plugin.json'), { name: 'devkit', version: '3.2.0' });
json(join(claude, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'devkit@market': [{ scope: 'user', installPath: kitDir, version: '3.2.0', installedAt: '2026-08-01T00:00:00.000Z' }] } });
const agents = ['code-reviewer','test-writer','architect','db-migrator','docs-writer','security-auditor','perf-tuner','ui-polisher'];
for (const a of agents) write(join(claude, 'agents', `${a}.md`), `---\nname: ${a}\ndescription: ${desc(a.replace('-', ' '), 25)}\n---\nYou are a ${a}.\n`);
json(join(claude, 'settings.json'), {
  enabledPlugins: { 'devkit@market': true },
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node ~/.claude/hooks/load-context.mjs' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/guard.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/notify.sh' }] }],
  },
});
const servers: [string, number, number][] = [['github', 51, 0], ['linear', 24, 0], ['sentry', 18, 1200], ['supabase', 29, 2400], ['figma', 12, 0], ['playwright', 25, 0], ['context7', 2, 900], ['notion', 21, 0], ['slack', 14, 0], ['postgres', 6, 0], ['stripe', 31, 1800], ['vercel', 62, 0]];
const verbs = ['list','get','create','update','delete','search','run','query','fetch','describe','apply','preview','sync','watch'];
const nouns = ['issues','pulls','projects','deployments','logs','tables','rows','branches','comments','files','events','users','customers','invoices','pages','channels','messages','alerts','traces','frames','components','docs','migrations','functions','domains','webhooks'];
const toolsOf = (s: string, n: number) => { const out = new Set<string>(); while (out.size < n) out.add(`mcp__${s}__${pick(verbs)}_${pick(nouns)}_${pick(nouns)}`); return [...out]; };
const tools = Object.fromEntries(servers.map(([s, n]) => [s, toolsOf(s, n)]));
const callRate: Record<string, number> = { github: 0.9, supabase: 0.6, playwright: 0.5, context7: 0.4, sentry: 0.15, linear: 0.04, postgres: 0.1 };
json(join(home, '.claude.json'), {
  mcpServers: Object.fromEntries(servers.map(([s]) => [s, { command: 'npx', args: [`@example/${s}-mcp`] }])),
  projects: { [project]: {} },
  skillUsage: Object.fromEntries([...used].map(([k, n]) => [k, { usageCount: n, lastUsedAt: Date.now() }])),
});
mkdirSync(join(project, '.git'), { recursive: true });

// The skill listing as Claude Code would build it at a 30k cap.
const fm = (p: string) => /description: (.*)/.exec(readFileSync(p, 'utf8'))?.[1] ?? '';
const listing = [...[...personal].sort().map(n => ({ name: n, d: fm(join(claude, 'skills', n, 'SKILL.md')) })), ...kit.map(n => ({ name: `devkit:${n}`, d: fm(join(kitDir, 'skills', n, 'SKILL.md')) }))];
const sim = simulateListing(listing.map(e => ({ name: e.name, fullChars: `- ${e.name}: ${e.d}`.length + 1, nameChars: e.name.length + 3, priority: used.has(e.name) })), 30000);
const described = new Set(sim.describedNames);
const listingContent = listing.map(e => (described.has(e.name) ? `- ${e.name}: ${e.d}` : `- ${e.name}`)).join('\n');

const DAY = 86400000; const now = Date.parse('2026-10-09T09:00:00Z');
const contextText = 'Project context loaded by hook. '.repeat(190);
const folder = join(claude, 'projects', '-home-code-ledger-api');
const allTools = ['WebFetch', 'WebSearch', 'NotebookEdit', ...servers.flatMap(([s]) => tools[s]!)];
const instr = servers.filter(([, , c]) => c > 0);
for (let i = 0; i < 48; i++) {
  let t = now - (44 - i * 0.92) * DAY;
  const ts = () => new Date((t += 40000)).toISOString();
  const base = { cwd: project, version: '2.1.293', sessionId: `s${i}` };
  const rows: object[] = [];
  const at = (attachment: object) => rows.push({ type: 'attachment', timestamp: ts(), ...base, attachment });
  at({ type: 'skill_listing', isInitial: true, skillCount: listing.length, names: listing.map(e => e.name), content: listingContent });
  at({ type: 'deferred_tools_delta', addedNames: allTools, addedLines: allTools, removedNames: [] });
  at({ type: 'mcp_instructions_delta', addedNames: instr.map(([s]) => s), addedBlocks: instr.map(([s, , c]) => `## ${s}\n${s[0]!.toUpperCase()}${s.slice(1)}: ` + 'Prefer the narrowest tool and confirm before writes. '.repeat(Math.ceil(c / 54)).slice(0, c)), removedNames: [] });
  at({ type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', command: 'node ~/.claude/hooks/load-context.mjs', stdout: '{"ok":true}', durationMs: 180 + Math.floor(rnd() * 120), exitCode: 0 });
  at({ type: 'hook_additional_context', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', content: [contextText] });
  const tool = (name: string, input: object) => { const id = `tu-${i}-${rows.length}`; rows.push({ type: 'assistant', timestamp: ts(), ...base, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }); return id; };
  for (const [k, n] of used) if (rnd() < n / 48) tool('Skill', { skill: k });
  if (rnd() < 0.5) tool('Agent', { subagent_type: 'code-reviewer', prompt: 'x' });
  if (rnd() < 0.35) tool('Agent', { subagent_type: 'test-writer', prompt: 'x' });
  if (rnd() < 0.06) tool('Agent', { subagent_type: 'architect', prompt: 'x' });
  for (const [s, r] of Object.entries(callRate)) if (rnd() < r) for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) tool(pick(tools[s]!), {});
  for (let k = 0; k < 6; k++) {
    const id = tool('Bash', { command: 'npm test' });
    at({ type: 'hook_success', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', toolUseID: id, command: '~/.claude/hooks/guard.sh', stdout: '{"decision":"allow"}', durationMs: 20 + Math.floor(rnd() * 30), exitCode: 0 });
    at({ type: 'hook_additional_context', hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', toolUseID: id, content: ['Guard: command allowed. Remember to run tests before pushing to main.'] });
  }
  at({ type: 'hook_success', hookName: 'Stop', hookEvent: 'Stop', command: '~/.claude/hooks/notify.sh', stdout: '', durationMs: 40, exitCode: 0 });
  write(join(folder, `s${i}.jsonl`), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

// Everything was installed two months ago (APFS moves the birth time back with the modified time).
const old = new Date(now - 60 * DAY);
const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); utimesSync(p, old, old); } utimesSync(d, old, old); };
walk(join(claude, 'skills')); walk(join(claude, 'agents')); walk(kitDir);
console.log(home, project, 'listing', listingContent.length, 'described', sim.described, 'of', listing.length);
