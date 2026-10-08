---
title: "packlight: see what your coding agent carries, keep what you use, archive the rest"
repo: cooperism-lab/packlight
status: draft (Phase 4, awaiting Cooper's review)
date: 2026-10-07
type: epic
---

# packlight

> Your agent loads every skill, hook and connector you ever installed into every session.
> packlight shows what each one costs, how often you actually use it, and lets you archive the rest in one step.

## Context

Solo developers using Claude Code (and Codex) accumulate skills, plugins, agents, hooks and MCP connectors. Each enabled skill and agent puts its description into every session's system prompt; each hook can inject text on every tool call or session start. Nobody sees this bill. Unused items cost tokens on every request, overlapping items make the agent pick the wrong one, and limit hits ("try again") are the most common friction in heavy use.

Why now: the prototype (Toolkit Ledger, 2026-10-07) proved the problem on one real setup, and the two closest open-source tools each cover only part of it (see Prior art).

## Current State (verified 2026-10-07)

### The prototype

`~/.claude/toolkit-ledger/` (Python, no dependencies): `scan.py` inventories items and counts usage from `~/.claude/projects/*/*.jsonl`; `merge.py` attaches usage; `finalize.py` writes the page data. Ratings were written by three model runs. Output was a claude.ai artifact (not reusable by others: needs a claude.ai account).

Findings on Cooper's setup, which become the launch benchmark:

| Metric | Value |
|---|---|
| Items installed | 282 (210 skills, 24 connectors and servers, 15 plugins, 13 agents, 10 commands, 6 hooks, 4 mods) |
| Never used since 2026-08-20 (102 sessions) | 238 (84%) |
| Skill and agent description text loaded every session | ~50k characters, ~46k of it from never-used items |
| Vercel plugin SessionStart hook | ~7.4k characters per session start, 1.5M total over 205 starts |
| graphify PreToolUse guard | 5,491 firings, ~770k characters |
| Default model | `"model": "sonnet"` in `~/.claude/settings.json`, silently routing sessions to a smaller model |

Scan time on 1.3 GB of logs: 1.9 s.

### Where the data lives

**Claude Code**
- Skills: `~/.claude/skills/*/SKILL.md`; project `.claude/skills`; plugin `skills/*/SKILL.md`.
- Agents: `~/.claude/agents`, project `.claude/agents`, plugin `agents/`.
- Hooks: `hooks` in `~/.claude/settings.json`, `settings.local.json`, project `.claude/settings*.json`, plugin `hooks/hooks.json`.
- Plugins: `~/.claude/plugins/installed_plugins.json`, with on/off state in `enabledPlugins`.
- MCP: `~/.claude.json` (`mcpServers`, global and per project) and plugin `.mcp.json`.
- Logs: `~/.claude/projects/*/*.jsonl`. Skill use is a `Skill` tool_use (`input.skill`), plus slash commands in `<command-name>`. Agent use is `Agent`/`Task` with `subagent_type`. MCP use is a tool name `mcp__<server>__<tool>`. Hooks are `attachment.type = hook_success | hook_additional_context`, with `hookEvent`, `hookName`, the exact `command`, `durationMs`, `stdout` and `content`.

**Codex**
- Rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`session_meta`, `response_item`, `event_msg` records).
- MCP: `config.toml` `[mcp_servers.*]`.
- Skills and plugins: `~/.codex/skills/`, `~/.codex/plugins/`.
- Always-loaded instructions: `AGENTS.md`.
- Skill usage is counted from SKILL.md reads in rollouts (the skills-audit method).

**Not verified**
- Grok and other agents: no local install to inspect. Deferred to adapters after v1.

### Prior art

| | skills-audit | claude-prospector | ccusage | packlight |
|---|---|---|---|---|
| Inventory | Skills, ~15 agents | Skills, agents, MCP | none | Skills, commands, agents, hooks, plugins, MCP, always-loaded files |
| Usage counts | yes | yes | tokens and dollars only | yes |
| Hook cost per firing (chars and latency) | no | no | no | **yes** |
| Settings checks | no | no | no | **yes** |
| Overlap handling | no | name and word similarity | no | duplicate, competing and similar, with "which one" cards |
| Ratings for the user's own work | no | keep/modify/drop | no | usefulness and efficiency 1-5, plus what, when and how |
| Reversible archive and restore | no (removal prompt) | no (read-only) | no | **yes** |

## Proposed Change

### What a user gets

1. They run `npx packlight`. In under 30 s it scans locally, writes `~/.packlight/report.html` and opens it.
2. The report shows:
   - a summary: items, used in the last 30 days, never used, and estimated tokens loaded every session
   - findings
   - one card per item: usage, cost, and a verdict once rated
3. They mark cards Archive or Keep, then click **Save my picks**, which downloads `packlight-picks-<scanId>.json`.
4. Applying the picks:
   - *With the skill installed:* they tell their agent "apply my packlight picks". The skill finds the newest picks file and shows the archive plan grouped by method. On "yes", it runs `packlight apply`.
   - *Without the skill:* the report and the CLI print the exact `npx packlight apply` command.
5. The report re-renders with a before/after line: "Loaded every session: 12.6k → 3.1k tokens (est.)".
6. Anything archived comes back with `packlight restore <id>`, or from the Archive tab.

The ratings and "which one" cards come from the packlight skill running inside the user's own agent (`npx packlight install-skill`). No API key is needed and nothing leaves the machine. The report works fully without the skill; the rating fields just stay empty, with a prompt to install it.

**No automatic background suggestion.** A SessionStart hook could suggest "apply my picks" by itself, but it would cost context in every session, which is the waste packlight exists to remove. Instead, the suggestion happens at three moments:
- the CLI's closing line
- the Save confirmation in the report
- the skill's first step whenever it runs

### Architecture

```
            ┌─────────────── packlight CLI (TypeScript, npx) ───────────────┐
 adapters → │ claude-code adapter   codex adapter   (later: cursor, gemini, …)│
            │        │ inventory + usage + cost (deterministic, no model)    │
            │        ▼                                                       │
            │  ~/.packlight/scans/<scanId>/inventory.json                    │
            │        │                         ▲ ratings.json (from skill)   │
            │        ▼                         │                             │
            │  report.html (single file, no network) ── Save my picks ─┐     │
            │                                                          ▼     │
            │  apply / archive / restore / purge  ◀── picks.json (Downloads)  │
            │        │                                                       │
            │        ▼                                                       │
            │  ~/.packlight/archive/<ts>-<id>/{manifest.json, payload/}      │
            └────────────────────────────────────────────────────────────────┘
 packlight skill (Claude Code / Codex): reads inventory.json + profile → writes ratings.json,
 groups.json (which-one cards); finds new picks → proposes `packlight apply`.
```

### Implementation Details

**CLI commands**

| Command | Does |
|---|---|
| `npx packlight` | `scan` + `report` + open in the browser |
| `packlight scan [--agent claude\|codex\|all] [--since 2026-08-01]` | Writes `inventory.json` for a new `scanId` |
| `packlight report [--scan <id>]` | Re-renders `report.html`, merging `ratings.json` and `groups.json` if present |
| `packlight apply [picks.json] [--yes]` | Archives the picked items. Prompts once per method group unless `--yes`. Defaults to the newest picks file in `~/Downloads`. |
| `packlight archive <id…>` / `restore <id…\|--all>` / `archive list` | Direct control |
| `packlight purge --older-than 30d` | Permanently deletes archived payloads, after listing them and a typed `purge` confirmation |
| `packlight doctor` | Settings checks only, printed as text |
| `packlight install-skill [--agent claude\|codex]` | Copies the skill to `~/.claude/skills/packlight` or `~/.codex/skills/packlight` |

**inventory.json item**

```ts
type Item = {
  id: string;                 // stable: `${agent}:${kind}:${source}:${name}` slugged
  agent: 'claude-code' | 'codex';
  kind: 'skill' | 'command' | 'agent' | 'hook' | 'plugin' | 'mcp' | 'instructions';
  name: string;
  source: string;             // 'personal' | 'plugin:<name>' | 'project:<path>' | 'user config' | 'connector' | …
  path: string | null;        // null for items only removable in a web UI
  enabled: boolean;
  description: string;        // as the agent lists it
  descHash: string;           // sha1 of name+description, drives incremental rating
  standingChars: number;      // characters loaded into every session (0 for hooks and on-demand items)
  usage: { total: number; last30: number; lastUsed: string | null };
  hook?: { event: string; matchers: string[]; command: string;
           firings: number; injectedChars: number; avgDurationMs: number; p95DurationMs: number };
  removal: { method: 'move' | 'plugin-disable' | 'hook-extract' | 'mcp-extract' | 'manual'; where?: string };
};
```

**Standing cost.** `standingChars` is name + description for enabled skills, commands and agents; the full file for always-loaded instructions (CLAUDE.md, AGENTS.md, memory indexes); and the tool names for MCP servers. Tokens are shown as an estimate, `≈ chars ÷ 4`, always labelled "est.".

**Hook cost.** Attributed exactly by the `command` field. Reported as firings per session, injected characters per firing, and p95 latency.

**Overlap detection.** Deterministic, in the CLI:
- same name across sources
- word-overlap (Jaccard) of description tokens ≥ 0.5
- same MCP server name or URL configured twice

This produces candidate groups. The skill then classifies each group:
- `duplicate`: keep one
- `competing`: one winner, archive the losers
- `similar`: keep both, plus a "use A when…, B when…" card

Descriptions are never rewritten in v1.

**Settings checks (`doctor` and report findings)**
1. A default model or subagent model is set to a smaller tier.
2. A hook injects more than 5k characters per session start, or fires more than 50 times per session.
3. A hook's p95 latency is over 1 s.
4. A plugin is turned off but still cached.
5. Broken symlinks in the skills folders.
6. Items with the same name.
7. MCP servers configured twice.
8. An archived item came back (an updater reinstalled it).

**Picks file**

```json
{ "scanId": "2026-10-07T13-40-12Z", "createdAt": "…",
  "picks": [{ "id": "claude-code:skill:plugin-finance:journal-entry", "action": "archive", "note": "" }] }
```

`apply` refuses a picks file whose `scanId` doesn't match the newest scan of the same agent. If an item's `descHash` changed since the scan, `apply` skips it and says why.

**Archive manifest:** `~/.packlight/archive/<ts>-<id>/manifest.json`

```ts
type Manifest = {
  id: string; kind: Item['kind']; agent: Item['agent']; name: string; archivedAt: string; reason: string;
  method: Item['removal']['method'];
  originalPath?: string; isSymlink?: boolean; symlinkTarget?: string;     // move
  settingsFile?: string; jsonPointer?: string; fragment?: unknown;        // hook-extract / mcp-extract
  plugin?: { key: string; wasEnabled: boolean };                          // plugin-disable
  manualSteps?: string;                                                   // manual: where to click
};
```

Restore reverses each method exactly. It refuses if the original path is now occupied, and if the settings file changed around the pointer it re-inserts by matching on event and matcher. Items removed by hand are tracked as "waiting for you" until the next scan confirms they're gone.

**Report (`report.html`)**
- One self-contained file.
- No network requests: a CSP meta tag of `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:`, and system fonts.
- Under 2 MB for 500 items.
- Light and dark themes, usable at 400 px wide.
- Marks in progress are kept in localStorage. **Save my picks** writes the picks file.
- Tabs: Items, Which one, Archive, Findings.

**Skill (`packlight`)**
1. On every run, check `~/Downloads` for a picks file newer than the last apply. If there is one, propose applying it first.
2. Build a short profile of the user's work from recent session prompts and repos. Save it to `~/.packlight/profile.md`, and show it so the user can edit it.
3. Rate only items whose `descHash` is new or changed, in batches of about 90, into `ratings.json`. Each rating has `what`, `when`, `how`, `usefulness` 1-5, `efficiency` 1-5, a `verdict` (keep / review / archive) and a `note`.
4. Classify the overlap groups into `groups.json`.
5. Run `packlight report`.

### Privacy (do not relax)

- Nothing leaves the machine: no telemetry, no network calls from the CLI or the report.
- The report holds counts and descriptions, never the text of the user's prompts.
- Ratings run inside the user's own agent session.
- `profile.md` is local and editable.

## Child Issues

| # | Title | Priority | Effort (human / CC) | Depends on |
|---|---|---|---|---|
| 1 | Scanner core and Claude Code adapter (inventory, usage, standing cost, exact hook attribution) | Critical | 4 d / 2 h | n/a |
| 2 | Self-contained report.html (cards, filters, findings, before/after, Save my picks) | Critical | 4 d / 2 h | 1 |
| 3 | Archive, restore, apply and purge with manifests (all five methods) | Critical | 4 d / 2 h | 1 |
| 4 | Overlap candidate detection and settings checks (`doctor`) | High | 2 d / 1 h | 1 |
| 5 | packlight skill: profile, incremental ratings, which-one cards, picks suggestion | High | 3 d / 1.5 h | 1, 2, 4 |
| 6 | Codex adapter (rollouts, config.toml, skills, AGENTS.md) | High | 3 d / 1.5 h | 1 |
| 7 | Packaging and launch: npm publish, README with Cooper's before/after, fixture home dirs, CI | High | 2 d / 1 h | 1-5 |

```
#1 Scanner ─┬─> #2 Report ──┐
            ├─> #3 Archive ─┼─> #5 Skill ──> #7 Launch
            ├─> #4 Overlap ─┘
            └─> #6 Codex (any time after #1, ships in v0.3)
```

**Sequencing.** #1 defines the inventory format that every other part reads. #2 and #3 together make up the minimum useful loop: see, mark, archive, restore. That loop ships as v0.1, before ratings exist. Ratings (#5) depend on overlap groups (#4) and need the report to show them. Codex (#6) reuses the format and can't move it.

**Releases**
- v0.1: #1-#3
- v0.2: #4-#5
- v0.3: #6
- #7 runs alongside, with a public launch at v0.2

## Acceptance Criteria

1. On a fixture home folder holding exactly 12 skills, 3 commands, 4 agents, 5 hooks, 3 plugins and 6 MCP servers, `packlight scan` reports exactly those counts by kind and source.
2. Usage counts on the fixture logs match the hand-counted expected file exactly, for every item.
3. Hook firings, injected characters and p95 latency are attributed by the `command` field. Two hooks on the same event are never merged.
4. `npx packlight` on Cooper's machine (1.3 GB of logs, 282 items) finishes scan and report in under 30 s. On a cold npx cache, it reaches an opened report in under 120 s.
5. report.html makes zero network requests (checked by a Playwright test watching all requests). It stays under 2 MB with 500 items and renders at 400 px with no horizontal scroll.
6. Archive → restore round trip:
   - restored skill folders are byte-identical
   - symlinks point to the same target
   - plugin on/off flags match
   - settings files parse to the same object as before
   - this holds for all five methods
7. `apply` with no `--yes` asks once per method group and changes nothing on "no". A picks file with an old `scanId` is refused with the message "These picks are from an older scan. Re-open the newest report and save again."
8. No file is written outside `~/.packlight`, `~/Downloads` (read only) and the paths named in a manifest. Checked by a test that diffs the fixture home folder.
9. After applying, a re-scan shows the before/after standing-cost line, and archived items no longer count toward it.
10. If an updater reinstalls an archived item, the next scan flags it as "came back".
11. Re-running the skill with no changed descriptions rates 0 items. Changing one description re-rates exactly 1.
12. The Codex adapter, on a fixture `~/.codex`, reports skills, MCP servers and AGENTS.md cost, and counts skill usage from rollouts.
13. Tests are written and passing in CI on macOS and Linux.

## Testing Plan

| Layer | What | Count |
|---|---|---|
| Unit | Each adapter parser (skills, agents, plugins, hooks, MCP, logs), cost math, Jaccard grouping, picks validation, every manifest method | +40 |
| Integration | Fixture home folder: scan → report → apply → restore round trip; resurrection; stale picks; occupied restore path | +12 |
| E2E | Playwright on report.html: filters, marks persist, Save my picks, zero network, 400 px layout, dark mode | +6 |
| Benchmark | Scan of a synthetic 1.5 GB log set under 30 s | +1 |

## Rollback Plan

Every change packlight makes is in a manifest. `packlight restore --all` returns the setup to its state before packlight. Uninstalling is `restore --all`, then deleting `~/.packlight`. `purge` is the only irreversible command, and it asks for a typed confirmation.

## Effort Estimate

About 22 working days for a human, or about 11 hours with Claude Code: #1 4 d / 2 h, #2 4 d / 2 h, #3 4 d / 2 h, #4 2 d / 1 h, #5 3 d / 1.5 h, #6 3 d / 1.5 h, #7 2 d / 1 h.

## Files Reference (new repo)

| Path | Contents |
|---|---|
| `src/cli.ts` | Command routing |
| `src/adapters/claude-code/{inventory,usage,hooks}.ts` | Claude Code adapter |
| `src/adapters/codex/{inventory,usage}.ts` | Codex adapter |
| `src/core/{item,cost,overlap,doctor}.ts` | Shared types and rules |
| `src/archive/{apply,archive,restore,purge,manifest}.ts` | Reversible changes |
| `src/report/{render.ts,template.html}` | Single-file report |
| `skill/SKILL.md` | The packlight skill (Claude Code and Codex) |
| `test/fixtures/home-claude/`, `test/fixtures/home-codex/` | Fixture home folders with expected counts |
| Prototype to port | `~/.claude/toolkit-ledger/{scan,merge,finalize}.py` |

## What's Working Well (keep from the prototype)

- Counting usage from the logs: Skill, Agent, `mcp__` prefixes and slash commands. This was verified on 102 sessions.
- Card content: what, when and how; usefulness and efficiency; a verdict; a one-line reason that names the overlap.
- Grouping the kill list by removal method, including manual steps for web-only items.

## Out of Scope (v1)

- Teams, shared policy and cloud sync.
- Telemetry or community stats.
- Dollar cost and billing windows (ccusage covers these).
- Rewriting skill descriptions. Revisit for the user's own skills in v2.
- Automatically removing claude.ai web skills, connectors, desktop extensions or browser extensions. These are listed as manual steps.
- A local server or click-to-act buttons in the report.
- Adapters beyond Claude Code and Codex: Cursor, Gemini CLI and Grok are v2+, Grok only once a local install can be inspected.
- A SessionStart hook of its own.

## Open Questions

1. claude.ai connectors show up in desktop-app logs as `mcp__<uuid>__…`. Is there a local file that maps the uuid to a display name? If not, show the uuid with sample tool names, and let the user label it once in `profile.md`.
2. Does Claude Code shorten long skill descriptions in the system prompt? If it does, `standingChars` should use the shortened length. Measure with `/context` on a fixture.
3. Licence: MIT, matching the prior art, unless you prefer Apache-2.0.

---

## Review ledger (/plan-ceo-review, 2026-10-07, mode SCOPE REDUCTION)

Design doc: ~/essent-hq/docs/designs/packlight.md (APPROVED 2026-10-07, 8/10). Approach B (full spec) chosen by Cooper in office hours D7. Premise correction carried in: hero metrics are skills over the listing budget and hook injection per session, with "not observed in N sessions" wording.

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| MODE (Cooper) | 0E rules, ~25 planned files | SCOPE REDUCTION | - | approved | D2 answer, 2026-10-07 |
| APPROACH (Cooper) | office hours D7 | B, full spec, 7 issues | - | approved | D7 answer "B) Full spec, all seven issues" |
| DEF-1 purge (Cooper) | spec CLI table: `packlight purge --older-than 30d`; premise 2 says delete is a separate later step; no v1 criterion depends on purge | deferred to TODOS (archive-only v1); purge design unchanged for the follow-up | - | approved (deferral) | D10 answer "A) Defer purge to TODOS.md", scope: delivery only, issue 3 drops purge |
| DEF-2 doctor (Cooper) | spec CLI table: `packlight doctor` prints settings checks as text; the report's Findings carries the same checks | deferred to TODOS; checks stay in the report's Findings | - | approved (deferral) | D11 answer "A) Defer `doctor` to TODOS.md", scope: delivery only, issue 4 drops the command |
| DEF-3 semantic restore (Cooper) | design doc restore conflict rule: parse-and-serialize re-insert when a settings file changed; reviewer R3-3 notes the ordering gap | v1: byte restore only; changed file -> refuse that item, print fragment and path; items from one file restored newest first; semantic re-insert to TODOS | - | approved (deferral) | D12 answer "A) Byte restore only; refuse on change", scope: issue 3 restore path; logged as a shortcut decision |
| F1 crash-safe archive (Cooper) | Section 1/2: archive = move + manifest write, two steps; a crash between them loses the item's way home. Contract: restore is exact, nothing silent. | unspecified order | journal: write manifest with status `pending` first, then move or edit, then mark `done`; every packlight start finishes or rolls back any `pending` entry and says which | approved | D13 answer "A) Add the journal", scope: issue 3 archive path + startup recovery + kill -9 test |
| F2 compare-and-swap on settings writes (Cooper) | Section 4: Claude Code itself rewrites ~/.claude/settings.json (e.g. /model, /plugin) and may do so between packlight's read and write | unspecified | re-hash the file immediately before writing; if it differs from the hash read at plan time, abort that item with a clear message; same check on restore | approved | D14 answer "A) Re-hash before every write, plus a lock", scope: issue 3 settings writes and restores |
| F3 picks file is untrusted input (Cooper) | Section 3: apply reads the newest `packlight-picks-*.json` in ~/Downloads; any download can carry that name | picks carry ids | picks may only name item ids from the newest scan; apply never takes a path or command from the file; unknown ids are listed and skipped; apply shows the full plan and asks before acting even when started by the skill | approved | D15 answer "A) Ids only, always confirm", scope: issue 3 apply |
| F4 escape third-party text in the report (Cooper) | Section 3: skill and agent descriptions are written by plugin authors; the report's CSP allows inline script, so unescaped text could run script in the user's browser | unspecified | all third-party text rendered via textContent or HTML-escaped; a test renders a description containing `<script>` and `<img onerror>` and asserts no execution | approved | D16 answer "A) Escape everything, test it", scope: issue 2 report rendering + Playwright test |
| F5 prompt injection in rating (Cooper) | Section 3: the packlight skill feeds third-party descriptions to the user's own agent, which has tools | unspecified | the skill treats every description as data and instructs the agent so; it only reads inventory.json and writes ratings.json/groups.json; the CLI validates both against a strict schema (ids from the scan, enums, lengths) and drops anything else before merging | approved | D17 answer "A) Data-only instruction plus strict schema", scope: issue 5 skill + CLI ratings merge |
| O1 project scope (Codex outside voice) | project skills/agents load only in their project; global total overstates per-session cost | one global total | per-project report: global + current project's items; project named in the hero; other projects listed separately; budget finding uses the same scope | approved | D18 answer "A) Per project, named in the hero", scope: issue 1 scope model + issue 2 hero |
| O2 ambiguous usage (Codex) | duplicate names / shared hook commands cannot be split from logs | exact counts | both items marked "usage ambiguous" with the shared count; never suggested for archive on usage alone; which-one card decides | approved | D19 answer "A) Mark ambiguous, never auto-suggest", scope: issue 1 attribution + issue 2 verdict display |
| O3 plugin removal unit (Codex) | v1 removes plugin children only by disabling the plugin | unspecified | marking any plugin child marks the plugin; plan shows full impact (counts by kind); overlapping picks merge into one journal step | approved | D20 answer "A) Plugin is the unit; show full impact", scope: issue 3 apply + issue 2 marks |
| O4 F2 is not a true CAS (Codex) | Claude Code does not honor packlight's lock; a last-instant write can still be lost | F2 promised protection | factual correction: spec says F2 narrows, not closes, the window (writes via temp file + atomic rename); plus warn and ask when Claude Code processes are running before a settings write | approved | correction applied under D14 scope (no behavior change); warning: D21 answer "A) Warn and ask when Claude Code is running", scope: issue 3 |
| O5 privacy promise scope (Codex) | rating sends descriptions and the profile to the agent's model provider | "nothing leaves the machine" for the whole product | factual correction: the no-network promise covers the CLI and report; the rating step states what it sends to the agent before it runs | approved | factual correction of a false claim; no behavior change; scope: spec Privacy section + skill preamble text |
| O6 skill permission split (Codex) | D17's data-only rule conflicts with the skill's orchestration jobs | one skill step | orchestration may only run packlight CLI commands (which confirm); rating step data-only per D17; profile built from CLI counts, never prompt text | approved | D22 answer "A) Two steps; profile from counts only", scope: issue 5 |
| O7 rating invalidation (Codex) | ratings depend on profile, usage and overlap group too | re-rate on descHash only (criterion 11) | re-rate when descHash, usage bucket (unused/rare/regular), overlap group or profile hash changes; criterion 11 rewritten to test this | approved | D23 answer "A) Re-rate on description, usage bucket, group or profile change", scope: issue 5 + criterion 11 |

## Review sections (/plan-ceo-review, SCOPE REDUCTION, implementation-ready depth)

### Section 1: Architecture

```
            local only, no network
  ┌──────────────────────────────────────────────────────────────────┐
  │ adapters/claude-code  adapters/codex (v0.3)                      │
  │      │ read files + session logs (never execute anything)        │
  │      ▼                                                           │
  │ core: inventory, usage, hook attribution, budget, overlap        │
  │      │ writes                                                    │
  │      ▼                                                           │
  │ ~/.packlight/scans/<scanId>/inventory.json ◀── ratings.json,     │
  │      │                                         groups.json       │
  │      ▼                                         (packlight skill, │
  │ report.html (static, escaped, CSP) ──Save my picks──┐  in agent)  │
  │                                                     ▼            │
  │ apply/archive/restore ◀── ~/Downloads/packlight-picks-<id>.json  │
  │      │ journal + manifests                                       │
  │      ▼                                                           │
  │ ~/.packlight/archive/<ts>-<id>/{manifest.json, payload}          │
  └──────────────────────────────────────────────────────────────────┘
```

Data flow, archive of one item (happy / nil / empty / error):
```
 picks id ──▶ resolve in newest inventory ──▶ plan step ──▶ journal pending ──▶ move/edit ──▶ journal done
   │nil: no picks file → ask for a path        │unknown id → list, skip (F3)
   │empty: picks with 0 items → "nothing to apply", exit 0
   │error: source vanished → item skipped, reason printed; settings changed since scan → abort item (F2)
```

Archive state machine (per item):
```
  ACTIVE ──archive──▶ PENDING ──commit──▶ ARCHIVED ──restore──▶ ACTIVE
                        │ crash                │ restore refused (file changed / path occupied)
                        ▼                      ▼
                  recovered on next start   ARCHIVED (unchanged, reason shown)
  Impossible: ARCHIVED ─▶ deleted (purge deferred, D10); PENDING left after a start (F1 recovery).
```

Findings: **F1 (CRITICAL GAP)**: the archive is two steps with no ordering; a crash or Ctrl-C between them leaves a moved skill with no manifest or a manifest with no payload. **OK**: coupling is one-directional (adapters know nothing of the report); scaling is linear in log size; there is no server, so there is no endpoint surface. Rollback posture: every action is reversible except D10's deferred purge, which is not in v1.

### Section 2: Error & Rescue Map

```
  CODEPATH                  | WHAT CAN GO WRONG                         | ERROR CLASS
  --------------------------|-------------------------------------------|-----------------------
  scan.readLogs             | malformed JSONL line                      | LogLineParseError
                            | log dir missing / unreadable              | LogSourceMissingError
  scan.readSettings         | settings.json invalid JSON                | SettingsParseError
  apply.loadPicks           | no picks file / stale scanId / bad schema | PicksMissing / PicksStale / PicksInvalid
  archive.move              | source vanished / EXDEV / EACCES          | SourceMissing / CrossDevice / PermissionDenied
  archive.editSettings      | file changed since plan (F2)              | SettingsChangedError
  archive (whole)           | crash between steps (F1)                  | (journal recovery)
  restore.move              | original path occupied                    | RestoreConflictError
  restore.settings          | file changed since archive (D12)          | RestoreConflictError
  report.mergeRatings       | ratings.json invalid / foreign ids (F5)   | RatingsInvalidError

  ERROR CLASS              | RESCUED? | RESCUE ACTION                               | USER SEES
  -------------------------|----------|---------------------------------------------|---------------------------------------------
  LogLineParseError        | Y        | skip line, count it                         | "N log lines could not be read" in the report
  LogSourceMissingError    | Y        | usage shown as unknown, not zero            | "No session logs found at <path>"
  SettingsParseError       | Y        | that file's items listed read-only          | "settings.json is not valid JSON; fix it first"
  Picks*                   | Y        | stop before any change                      | exact reason + the command to re-save picks
  SourceMissing            | Y        | skip item                                   | item listed as "already gone"
  CrossDevice              | Y        | copy + verify hash + remove (not rename)    | transparent
  PermissionDenied         | Y        | skip item                                   | path and the permission needed
  SettingsChangedError     | N ← GAP (F2) | abort item                              | "settings.json changed while packlight ran"
  crash mid-archive        | N ← GAP (F1) | journal recovery                        | "Recovered 1 interrupted archive"
  RestoreConflictError     | Y        | refuse item, print fragment/path (D12)      | what is in the way and what to paste
  RatingsInvalidError      | N ← GAP (F5) | drop invalid entries                    | "N ratings were ignored (invalid)"
```
No catch-all handlers: each class maps to one message and a non-zero exit when anything was skipped.

### Section 3: Security & Threat Model

| Threat | Likelihood | Impact | Mitigated by plan? |
|---|---|---|---|
| Crafted picks file in ~/Downloads makes apply archive or touch arbitrary paths | Low | High | Partly (ids only), **F3** makes it explicit |
| Third-party description injects script into report.html (CSP allows inline script) | Med | Med | **No, F4** |
| Third-party description instructs the user's agent during rating (prompt injection) | Med | High | **No, F5** |
| Scanner executes a hook or plugin script | Low | High | Yes: design-doc constraint, never execute |
| Session-log text (user prompts) leaks into a shared report or README | Med | Med | Partly: design R3-13 note; report holds counts, names, paths only (carried as an accepted constraint) |
| npm supply chain (typosquat, compromised dependency) | Low | High | Partly: zero runtime dependencies target, npm provenance on publish |
No secrets, no network, no accounts.

### Section 4: Data Flow & Interaction Edge Cases

```
 INPUT(logs, settings, picks) -> VALIDATE(schema, scanId, ids) -> TRANSFORM(plan) -> PERSIST(journal, move/edit, manifest) -> OUTPUT(report, summary)
   shadow: missing file | invalid JSON | huge file (stream) | concurrent writer (F2) | crash (F1) | stale picks | encoding (UTF-8 BOM in settings)
```
Ordering: packlight `apply` versus Claude Code writing settings.json. Invariant: no write loses another writer's change.
```
 t   packlight apply              Claude Code (/model)        settings.json
 1   read + hash H1                                            S1
 2                                 write S2 (model change)     S2
 3   write S1-minus-hook  ✗ loses S2                           S1'   ← violation without F2
 with F2: at step 3 packlight re-hashes, sees H2 != H1, aborts the item; S2 kept.
```
Two `packlight apply` runs at once: same race; F2's check plus a lock file in ~/.packlight covers it.

| Interaction | Edge case | Handled? | How |
|---|---|---|---|
| Save my picks | clicked twice | Yes | second file is newer; apply uses newest, same scanId |
| Save my picks | browser saves to a non-default folder | Yes | apply asks for a path |
| apply | run twice on the same picks | Yes | already-archived ids reported, nothing done |
| restore --all | one conflict among many | Yes | others restored, conflict listed, non-zero exit |
| report | 0 items / no logs | Yes | empty state names the log path looked at |
| report | 2,000 items | Yes | list virtualised by kind; under 2 MB budget |

### Section 5: Code Quality
Fits: one module per concern, adapters behind one interface. Risk: `apply` grows branches per removal method (five) plus F1/F2 checks; keep one handler per method behind a table, each under five branches. Over-engineering to avoid: no plugin system for adapters until a third agent exists. No issues beyond F1/F2 already raised.

### Section 6: Tests

| New thing | Type | Happy | Failure | Edge |
|---|---|---|---|---|
| Claude Code scan | unit + fixture | exact counts by kind/source | missing log dir → unknown usage | malformed lines counted |
| Hook attribution | unit | firings and chars by `command` | two hooks on one event never merged | hook with empty stdout |
| Budget finding | unit | warning parsed → named skills | warning absent → labelled estimate | budget fraction set in settings |
| archive/restore (move, plugin-disable, hook-extract, mcp-extract) | integration on fixture home | byte-identical round trip | path occupied → refuse | symlinked skill moves the link only |
| restore order | integration | two hooks from one file, both byte-restored | file edited in between → refuse with fragment (D12) | restore --all mixed outcome |
| apply/picks | integration | picks → plan → confirm → done | stale scanId refused | unknown id skipped |
| report | Playwright | renders, filters, Save my picks | zero network requests | 400 px, dark mode |
2am-Friday test: archive 20 items across all methods, kill -9 mid-run, restart, restore --all, diff the fixture home folder → empty diff (needs F1). Hostile QA: picks naming `../../.ssh` (needs F3); description with `<img onerror>` (needs F4). Chaos: Claude Code rewrites settings.json during apply (needs F2). Pyramid: ~40 unit, ~12 integration, ~6 E2E; no tests depend on time except the 30-day logic, now deferred with purge.

### Section 7: Performance
Logs streamed line by line (prototype: 1.9 s on 1.3 GB). Memory bounded by inventory size (hundreds of items). Cache: `~/.packlight/scans/<scanId>/` holds the parsed results; the "cold cache" in the criteria means the npx download plus a first full parse. Slowest paths: first log parse (~2-5 s), report render (<1 s), archive of a large skill folder (copy across devices). No issues found.

### Section 8: Observability
Every run appends to `~/.packlight/packlight.log` (local only): command, scanId, each item's planned action and outcome, error class. `--verbose` echoes it. The report shows parse gaps (unreadable lines, missing sources). Runbook in the README: "restore refused" → the fragment printed and where to paste it; "Recovered interrupted archive" → what was rolled back (F1). No gaps beyond F1.

### Section 9: Deployment & Rollout
npm publish from CI on a tag with provenance; v0.1 tagged but announced only at v0.2. No migrations, no server. A bad release is fixed by publishing a patch and `npm deprecate` on the broken version; users' archives remain restorable by any later version because the manifest format is versioned (`manifestVersion: 1`) and readers must accept older versions. Post-release check: run `npx packlight@<new>` against the fixture home and the author's machine.

### Section 10: Long-term trajectory
Reversibility 4/5 (everything restorable; manual items excepted). Debt carried: D10 purge, D11 doctor, D12 semantic restore, Codex TOML edits. Path dependency: the inventory and manifest formats are the contract every later feature (loadouts, more adapters) builds on; version both from day one. A new engineer in 12 months can follow it if the README documents the five methods table.

### Section 11: Design & UX
UI scope exists (the report). Information order: hero finding (skills over budget, hook injection) → KPI cards → tables by kind → archive list. State map:
```
 FEATURE        | LOADING            | EMPTY                         | ERROR                          | SUCCESS          | PARTIAL
 report         | n/a (static)       | "No session logs at <path>"   | data.json missing → fix hint   | full dashboard   | "N lines unreadable" banner
 ratings        | n/a                | "Not rated yet, install skill"| invalid entries dropped (F5)   | cards filled     | some items unrated, labelled
 Save my picks  | -                  | 0 marked → button disabled    | download blocked → copy text   | toast + command  | -
```
The Toolkit Ledger (artifact v5) is the visual reference. Recommend `/plan-design-review` before building issue 2.

Approval readiness: PASS. Checked rows and answers: MODE (D2), APPROACH (D7), DEF-1 (D10), DEF-2 (D11), DEF-3 (D12), F1 (D13), F2 (D14), F3 (D15), F4 (D16), F5 (D17), O1 (D18), O2 (D19), O3 (D20), O4 (D14 scope correction + D21), O5 (factual correction, no behavior change), O6 (D22), O7 (D23). No declined, unanswered or out-of-scope remedy is in accepted work.

## Spec corrections carried from this review (apply before filing issues)

1. Hero metrics: skills over the listing budget (and which would come back under it) and characters hooks inject per session start and per tool call, scoped per project (O1). Description-size estimate kept for Codex only.
2. Wording: "not observed in N sessions" with the scan's date range and parse gaps, never "unused". Ambiguous items labelled as such (O2).
3. CLI table: remove `purge` (D10) and `doctor` (D11). Restore is byte-exact; a changed settings file makes restore refuse that item and print the fragment and path; items from one file restore newest first (D12).
4. Removal methods: the five-method table from the design doc, with plugins as the only removal unit for their children and full impact shown (O3); Codex `config.toml` servers report-only.
5. Archive: journal (`pending` → `done`) with recovery at every start (F1); writes via temp file + atomic rename after a re-hash; lock file; warn and ask if Claude Code is running before a settings write; spec states the remaining window plainly (F2, O4, D21).
6. Apply: picks name only ids from the newest scan; unknown ids skipped and listed; plan always shown and confirmed (F3).
7. Report: all third-party text escaped; hostile-description Playwright test (F4).
8. Skill: orchestration step may only run packlight commands; rating step data-only; CLI validates ratings.json and groups.json against a strict schema; profile from CLI counts only (F5, O6). Re-rate keys: descHash, usage bucket, overlap group, profile hash; criterion 11 rewritten (O7).
9. Privacy section: the no-network promise covers the CLI and report; the rating step states what it sends to the agent's provider before it runs (O5).

## NOT in scope

Deferred (to the packlight TODOS.md once the repo exists):
- `packlight purge`, permanent delete with a 30-day guard and typed confirmation. D10: v1 ships with no irreversible command.
- `packlight doctor`, the settings checks as terminal text. D11: the same checks ship in the report.
- Semantic re-insert when a settings file changed since archive. D12: v1 refuses and prints the fragment; logged as a shortcut decision with its upgrade trigger.
- Codex `config.toml` MCP archiving (needs a TOML-preserving edit). Design doc, approved D8.
- Loadouts (task-specific capability sets). Office hours D7 chose B over C; design doc lists it as a v2 candidate.
Rejected:
- Approach A, minimal loop only (office hours D7: the owner wants ratings and which-one cards in the first public release).

## What already exists

| Sub-problem | Existing code | Reused? |
|---|---|---|
| Inventory and usage from Claude Code logs | `~/.claude/toolkit-ledger/scan.py`, `merge.py` (verified on 102 sessions, 1.9 s on 1.3 GB) | Yes, ported to TypeScript |
| Card copy, ratings, removal grouping | `toolkit-ledger/finalize.py`, `rated1-3.json` | Yes, as the format reference for ratings.json |
| Report layout | Toolkit Ledger artifact v5 (`toolkit-ledger.html`) | Yes, ported; corrected hero |
| Overlap by word similarity | claude-prospector (MIT) | Approach reimplemented, not depended on |
| Hook attribution by `command` and `durationMs` | log attachments, verified 2026-10-07 | Yes, replaces the prototype's text-signature guess |

## Dream state delta

```
  CURRENT STATE                      THIS PLAN (v0.1-v0.3)                     12-MONTH IDEAL
  Python scripts + a private     ->  npx packlight: per-project scan, budget  -> every adapter, a safe-default
  claude.ai page, Claude Code        and hook findings, reversible archive       "archive what's not observed",
  only, ratings from ad-hoc          with journal, ratings via the user's        loadouts, opt-in shared
  model runs                         agent, Codex inventory                      "what others kept"
```
Left for later: delete, doctor, semantic restore, Codex archiving, loadouts, any shared signal.

## Failure Modes Registry

```
  CODEPATH              | FAILURE MODE                         | RESCUED? | TEST? | USER SEES?                              | LOGGED?
  ----------------------|--------------------------------------|----------|-------|-----------------------------------------|--------
  scan.readLogs         | malformed line                       | Y        | Y     | "N lines unreadable"                    | Y
  scan.readLogs         | no logs                              | Y        | Y     | "No session logs at <path>"             | Y
  scan.attribution      | name/command collision (O2)          | Y        | Y     | "usage ambiguous"                       | Y
  apply.loadPicks       | stale / invalid / hostile picks (F3) | Y        | Y     | reason + re-save command                | Y
  archive               | crash mid-item (F1)                  | Y        | Y     | "Recovered 1 interrupted archive"       | Y
  archive.editSettings  | concurrent writer (F2, O4)           | Y        | Y     | "settings.json changed" / running warn  | Y
  archive.plugin child  | hidden sibling removal (O3)          | Y        | Y     | full plugin impact before confirm       | Y
  restore               | path occupied / file changed (D12)   | Y        | Y     | what is in the way + fragment to paste  | Y
  report.render         | hostile description (F4)             | Y        | Y     | text shown as text                      | n/a
  report.mergeRatings   | invalid / injected ratings (F5)      | Y        | Y     | "N ratings ignored"                     | Y
```
CRITICAL GAPS remaining: 0 (every gap found in review has an approved remedy and a planned test; none is implemented yet).

## Diagrams produced
System architecture, archive data flow with nil/empty/error paths, archive state machine, error/rescue map, settings-write race schedule (Section 4), report state map (Section 11). Deployment is publish-only (no sequence diagram needed); rollback is `restore --all` plus `npm deprecate`. Stale diagram audit: the spec's earlier architecture diagram omits the journal, the lock and the per-project scope; superseded by Section 1's diagram.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code or Codex; checkbox as you ship. (Effort ratios assumed: features ~30x, tests ~50x, architecture ~5x human to CC.)

- [ ] **T1 (P1, human: ~2h / CC: ~10min)** — spec — Apply the nine spec corrections above before filing the epic and issues
  - Surfaced by: Step 0 premise correction, D10-D12, F1-F5, O1-O7
  - Files: packlight-SPEC.md (then cooperism-lab/packlight issues)
  - Verify: each correction line maps to an edited spec section; no `purge`/`doctor` in the CLI table
- [ ] **T2 (P1, human: ~1d / CC: ~30min)** — archive — Journal with `pending`/`done` and startup recovery
  - Surfaced by: Section 1, F1 (D13)
  - Files: src/archive/journal.ts, src/archive/apply.ts (to be created)
  - Verify: kill -9 mid-apply on the fixture home, restart, `restore --all`, empty diff
- [ ] **T3 (P1, human: ~1d / CC: ~30min)** — archive — Re-hash + temp-file atomic rename + lock + Claude-running warning
  - Surfaced by: Section 4, F2 (D14), O4 (D21)
  - Files: src/archive/settingsWrite.ts (to be created)
  - Verify: test that mutates settings.json between plan and write expects an abort; process-list mock expects the warning
- [ ] **T4 (P1, human: ~0.5d / CC: ~15min)** — apply — Ids-only picks, unknown ids skipped, plan always confirmed
  - Surfaced by: Section 3, F3 (D15)
  - Files: src/archive/picks.ts (to be created)
  - Verify: picks with `../../.ssh` and unknown ids change nothing and list the skips
- [ ] **T5 (P1, human: ~0.5d / CC: ~10min)** — report — Escape all third-party text
  - Surfaced by: Section 3, F4 (D16)
  - Files: src/report/render.ts (to be created)
  - Verify: Playwright with `<script>` and `<img onerror>` descriptions: shown as text, no execution
- [ ] **T6 (P1, human: ~1d / CC: ~30min)** — skill — Orchestration/rating split, schema validation on merge, counts-only profile
  - Surfaced by: Section 3, F5 (D17), O6 (D22)
  - Files: skill/SKILL.md, src/report/mergeRatings.ts (to be created)
  - Verify: ratings.json with foreign ids, extra fields and oversized text merges only valid entries and reports the count
- [ ] **T7 (P1, human: ~1d / CC: ~30min)** — scanner — Per-project scope and project-named hero
  - Surfaced by: outside voice O1 (D18)
  - Files: src/core/scope.ts, src/report/hero.ts (to be created)
  - Verify: fixture with project agents: hero total excludes them outside that project
- [ ] **T8 (P1, human: ~0.5d / CC: ~20min)** — scanner — Ambiguous usage for name/command collisions
  - Surfaced by: outside voice O2 (D19)
  - Files: src/core/usage.ts (to be created)
  - Verify: two skills named `learn`: both labelled ambiguous, neither suggested for archive
- [ ] **T9 (P1, human: ~1d / CC: ~30min)** — apply — Plugin as removal unit; impact shown; overlapping picks merged
  - Surfaced by: outside voice O3 (D20)
  - Files: src/archive/plan.ts (to be created)
  - Verify: marking one plugin skill yields one plan step showing the plugin's full counts; restore re-enables it
- [ ] **T10 (P2, human: ~0.5d / CC: ~20min)** — skill — Re-rate keys and rewritten criterion 11
  - Surfaced by: outside voice O7 (D23)
  - Files: skill/SKILL.md, src/core/ratingKey.ts (to be created)
  - Verify: change only the usage bucket of one item: exactly that item is re-rated
- [ ] **T11 (P2, human: ~15min / CC: ~5min)** — spec — Privacy section scoped to CLI and report; rating disclosure text
  - Surfaced by: outside voice O5 (factual correction)
  - Files: packlight-SPEC.md, skill/SKILL.md
  - Verify: the skill's first message names what it sends to the agent before rating
_No new tasks from Section 5, Section 7, Section 8 or Section 9 beyond those above._

## Completion Summary

```
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SCOPE REDUCTION                             |
  | System Audit         | new repo; prototype in ~/.claude/toolkit-   |
  |                      | ledger; Claude Code 2.1.289 caps the skill  |
  |                      | listing (premise corrected)                 |
  | Step 0               | office hours: approach B; 3 deferrals       |
  |                      | (purge, doctor, semantic restore)           |
  | Section 1  (Arch)    | 1 issue found (F1)                          |
  | Section 2  (Errors)  | 10 error paths mapped, 3 GAPS (all resolved)|
  | Section 3  (Security)| 3 issues found, 1 High severity (F5)        |
  | Section 4  (Data/UX) | 7 edge cases mapped, 1 unhandled (F2, res.) |
  | Section 5  (Quality) | 0 issues found                              |
  | Section 6  (Tests)   | Diagram produced, 3 gaps (covered by F1-F4) |
  | Section 7  (Perf)    | 0 issues found                              |
  | Section 8  (Observ)  | 0 gaps found                                |
  | Section 9  (Deploy)  | 1 risk flagged (manifest versioning)        |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 4           |
  | Section 11 (Design)  | 0 issues; /plan-design-review recommended   |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (6 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 11 rows, 0 CRITICAL GAPS                    |
  | Failure modes        | 10 total, 0 CRITICAL GAPS                   |
  | TODOS.md updates     | 3 items (deferred; repo not yet created)    |
  | Scope proposals      | 3 proposed cuts, 3 accepted                 |
  | CEO plan             | skipped by mode                             |
  | Outside voice        | codex: completed, 7 findings, 7 resolved    |
  | Lake Score           | 11/12 recommendations chose complete option |
  | Diagrams produced    | 6 (architecture, data flow, state machine,  |
  |                      | error map, race schedule, UI state map)     |
  | Stale diagrams found | 1 (spec's original architecture)            |
  | Unresolved decisions | 0                                           |
  +====================================================================+
```

## Eng review (/plan-eng-review, 2026-10-07)

Target: ~/.claude/toolkit-ledger/packlight-SPEC.md (this plan, including its CEO review ledger and Sections 1-11). Source of truth for problem and constraints: ~/essent-hq/docs/designs/packlight.md (APPROVED).

### Scope record
feature answers: none proposed (CEO review already cut purge, doctor, semantic restore: D10-D12); structure: B "Smaller arrangement" (eng D1, 2026-10-07); accepted scope: all CEO-approved features, contracts and remedies (F1-F5, O1-O7) in about 12 files: src/cli.ts; src/adapters/claude-code.ts, codex.ts; src/core/inventory.ts, findings.ts; src/archive/journal.ts, methods.ts, apply.ts; src/report/render.ts, ratings.ts, template.html; skill/SKILL.md (+ test/ and fixtures); pending remedies: SC1, SC2.
Scope Challenge result: scope accepted as-is (smaller arrangement preserves scope). Scope Challenge findings: SC1 approved B (Windows in v1, eng D2); SC2 approved A (write-file-atomic, eng D3).

### Decision ledger

### SC1: Windows support in v1
Finding: 1, P2, confidence 7/10, packlight-SPEC.md Testing Plan + design doc Distribution ("test on macOS and Linux"), reviewer: native eng review.
Plan baseline: CI on macOS and Linux; Windows unstated (original proposal).
Runtime evidence: Claude Code ships for Windows; ~/.claude, symlinks, rename-over-existing and the Downloads folder behave differently there. Not probed (no Windows host).
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| SC1 Windows in v1 | unstated | unsupported in v1: `npx packlight` exits with a clear "macOS and Linux only for now" message; README says so; Windows to TODOS | supported: Windows CI job, path handling, junctions instead of symlinks, rename retry |
| SC2 atomic write helper | unspecified, pending | unspecified, pending | unspecified, pending |
Question D2:
D2 — SC1: Support Windows in packlight v1?
Project/branch/task: packlight plan, issue 1 and issue 7 (CI and packaging).
ELI10: The plan tests on macOS and Linux only and never says what happens on Windows. Claude Code runs on Windows, where home folders, symlinks, renaming over a file and the Downloads folder all behave differently. Saying "not yet" out loud is safe; silently half-working on Windows is not, because archive and restore move and rewrite files.
Stakes if we pick wrong: a Windows user runs archive on a code path nobody tested, or v1 slips while Windows details are worked out.
Recommendation: A because the archive path must be tested on every OS it runs on, and a clear refusal keeps v1 honest without doubling the test matrix (engineering preference: explicit over clever).
Completeness: A=7/10, B=10/10
Net: a clear "not yet" versus a second platform's worth of edge cases in the first release.
Header: Windows in v1
Options:
A) Not in v1, say so clearly (recommended)
Effort S (human ~1 h / CC ~5 min), risk low. Reuses nothing. ✅ No archive or restore ever runs on an untested OS, so the trust boundary holds. ✅ The CI matrix stays at two platforms for the first release. ❌ Windows users get a polite refusal until a follow-up adds support.
B) Support Windows in v1
Effort M (human ~3 d / CC ~1.5 h), risk medium. Reuses the same modules with platform branches. ✅ Every Claude Code user can run packlight from day one. ✅ Forces path handling to be correct early. ❌ Adds a third CI platform and Windows-only file semantics to the riskiest code before anyone has used it.

State: approved
Actual answer: B) "Support Windows in v1" (eng D2, 2026-10-07)
Accepted scope: Windows supported in v1: Windows CI job alongside macOS and Linux; path handling via os.homedir() and path.join, never "~" strings; directory links via junctions on Windows (symlinks elsewhere); rename-over-existing with bounded retry on EPERM/EBUSY; Downloads folder resolved per OS (asks for a path when not found); the archive round-trip and kill -9 tests run on all three platforms.
History: none

### SC2: Atomic write helper for settings files
Finding: 2, P2, confidence 8/10, packlight-SPEC.md CEO ledger F2/O4 ("writes via temp file + atomic rename after a re-hash"), reviewer: native eng review.
Plan baseline: F2 approved (D14) and O4 correction: temp file + atomic rename after a re-hash; CEO Section 3 targets zero runtime dependencies.
Runtime evidence: npm's write-file-atomic writes a uniquely named temp file in the same directory, copies the original's mode and owner, fsyncs, renames, and unlinks the temp file on failure; it is used by npm itself on macOS, Linux and Windows. A hand-rolled temp+rename that skips the mode copy would turn a 0600 settings file into 0644. Not probed locally.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| SC1 Windows in v1 | approved: supported (eng D2) | supported (unchanged) | supported (unchanged) |
| F2 re-hash before write + lock + O4 running warning | approved (CEO D14, D21) | unchanged | unchanged |
| SC2 atomic write implementation | unspecified | depend on write-file-atomic (one runtime dependency, pinned) | hand-roll in methods.ts: same-dir temp file, copy mode, fsync, rename with Windows retry, unlink on failure, own tests |
Question D3:
D3 — SC2: Use npm's write-file-atomic for settings writes, or write our own?
Project/branch/task: packlight plan, issue 3 (src/archive/methods.ts).
ELI10: When packlight rewrites settings.json it must never leave a half-written file and must keep the file's permissions. npm maintains a small library that does exactly this on macOS, Linux and Windows. The plan aimed for zero runtime dependencies; writing our own is about 30 lines plus tests that must cover the same cases, including Windows.
Stakes if we pick wrong: a hand-rolled version that loses a file's permissions or leaves a temp file behind on Windows, or one runtime dependency in a tool that promises a small footprint.
Recommendation: A because a widely used, npm-maintained helper already handles the permission copy, fsync and Windows rename edge cases that the archive path depends on (engineering preference: reuse before writing new code).
Completeness: A=10/10, B=8/10
Net: one well-known dependency versus thirty lines of our own on the riskiest path.
Header: Atomic writes
Options:
A) Use write-file-atomic (recommended)
Effort S (human ~1 h / CC ~5 min), risk low. Reuses npm's helper, pinned and lock-filed. ✅ Permission copy, fsync, temp cleanup and Windows rename handling come tested from npm's own use. ✅ methods.ts stays focused on packlight's rules (re-hash, journal), not file-system mechanics. ❌ One runtime dependency to watch, against the zero-dependency target.
B) Hand-roll it in methods.ts
Effort S (human ~1 d / CC ~30 min), risk medium. Reuses Node's fs only. ✅ Zero runtime dependencies, the smallest possible supply-chain surface. ✅ Full control of every step. ❌ Our own code and tests must match the permission, fsync and Windows behaviour the library already has.

State: approved
Actual answer: A) "Use write-file-atomic" (eng D3, 2026-10-07)
Accepted scope: settings-file writes in src/archive/methods.ts go through write-file-atomic (pinned exact version, lock-filed; the only runtime dependency) after the F2 re-hash; its mode/owner copy and fsync are relied on and covered by one test per OS asserting a 0600 file stays 0600 after archive and restore.
History: none

### Section 1: Architecture review (eng)

```
 src/cli.ts ──▶ adapters/claude-code.ts ─┐                 (Windows, macOS, Linux; eng D2)
           └──▶ adapters/codex.ts ───────┤ lines → {cwd, version, kind, payload}
                                         ▼
                     core/inventory.ts (items, ids, scope by cwd, usage, ambiguity, rating keys)
                     core/findings.ts  (budget, hook cost, overlap, settings checks)
                                         │ inventory.json (versioned)
              ┌──────────────────────────┼──────────────────────────────┐
              ▼                          ▼                              ▼
   report/render.ts + template.html   report/ratings.ts ◀── skill   archive/apply.ts (picks → plan → confirm)
   (escaped; hero per project)        (strict schema merge)            │
                                                                       ▼
                                          archive/journal.ts ◀──▶ archive/methods.ts ──▶ write-file-atomic (eng D3)
                                          (pending → done, recovery)  (move | plugin-disable | hook-extract | mcp-extract | manual)
```

Findings:
- [P1] (confidence: 7/10) packlight-SPEC.md, inventory.json Item: `id: string; // stable: ${agent}:${kind}:${source}:${name} slugged` — slugging can merge distinct items (`plugin:vercel` and `plugin-vercel`, names differing only by punctuation), and the id is also the archive folder name and the picks key. Two items with one id means a pick or restore acts on the wrong one. → A1, decision below.
- [P1] (confidence: 8/10) packlight-SPEC.md Current State: "Logs: `~/.claude/projects/*/*.jsonl`. Skill use is a `Skill` tool_use (`input.skill`) … Hooks are `attachment.type = hook_success | hook_additional_context`" — this is Claude Code's internal, undocumented log format, already seen changing across 2.1.x (the probe shows `version` on each line). A silent shape change would turn real usage into "not observed" and suggest archiving things in use. → A2, decision below.
- [P2] (confidence: 9/10) packlight-SPEC.md O1 row: "per-project report: global + current project's items" — mapping logs to projects by folder name is lossy: probe 2026-10-07 shows `/Users/cooper-kao/essent-hq` and `/Users/cooper/kao-essent/hq` both encode to `-Users-cooper-kao-essent-hq`. Each log line carries `cwd` (1,529 of 2,273 lines in the newest session; the rest are summary/attachment lines that inherit their session's cwd). → A3: required implementation of approved O1 (CEO D18): project attribution comes from `cwd`, never the folder name. Carried forward, no new question.
- OK: one-directional coupling (adapters know nothing of report or archive); single point of failure is the journal directory, covered by F1 recovery; distribution path (npm on tag, CI on three OSes) is in issue 7.

### A1: Inventory item id uniqueness
Finding: Section 1, P1, confidence 7/10, packlight-SPEC.md inventory.json Item `id` comment, reviewer: native eng review.
Plan baseline: id = `${agent}:${kind}:${source}:${name}` slugged (original proposal; no approval).
Runtime evidence: the prototype already produced ids by this rule; no collision observed on 282 items (not proof for other machines). Unknown on other setups.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| A1 id rule | slug of agent:kind:source:name | slug + "-" + first 8 hex of sha256(agent, kind, source, name, path); scan fails loudly if two items still share an id; archive folder and picks use this id | keep the slug; scan detects duplicates and appends -2, -3 in scan order |
| A2 log format handling | unspecified, pending | unspecified, pending | unspecified, pending |
| SC1, SC2, F1-F5, O1-O7 | approved | unchanged | unchanged |
Question D4:
D4 — A1: Make every inventory id unique by adding a short hash?
Project/branch/task: packlight plan, issue 1 (src/core/inventory.ts) and issue 3 (archive folders, picks).
ELI10: Every installed item gets an id. That id names its archive folder and is what your picks file refers to. The plan builds it by slugging the item's name and source, and two different items can slug to the same text. If they do, archiving or restoring one could act on the other. Adding a short hash of the item's full identity (including its path) makes ids unique, and the scan refuses to continue if two ever match.
Stakes if we pick wrong: an archive or restore acts on the wrong skill, or ids shift between scans and your saved picks stop matching.
Recommendation: A because a hash of the full identity is unique and stable across scans, while numbering by scan order changes when something new is installed (engineering preference: explicit over clever).
Completeness: A=10/10, B=6/10
Net: slightly longer ids versus ids that can collide or shift.
Header: Item ids
Options:
A) Slug plus short hash (recommended)
Effort S (human ~1 h / CC ~5 min), risk low. Reuses the slug. ✅ Two different items can never share an id, and the same item keeps its id across scans. ✅ A duplicate, if it ever happens, stops the scan with both paths named. ❌ Ids are less readable (an 8-character suffix) in archive folder names.
B) Slug, number duplicates
Effort S (human ~1 h / CC ~5 min), risk medium. Reuses the slug. ✅ Readable ids for the common case. ✅ Duplicates get distinct ids within one scan. ❌ Numbering follows scan order, so an install between scans can swap ids and make older picks point at the wrong item.

State: approved
Actual answer: A) "Slug plus short hash" (eng D4, 2026-10-07)
Accepted scope: id = slug + "-" + first 8 hex of sha256(agent, kind, source, name, path); scan fails with both paths named if two items share an id; archive folders and picks use this id; unit test with two items that slug alike asserts distinct ids and stable ids across two scans.
History: extended by X5 (eng D12): declaration locator added to the hashed fields; archive folders use operation ids. D4 answer retained.

### A2: Claude Code log format drift
Finding: Section 1, P1, confidence 8/10, packlight-SPEC.md Current State "Logs: ~/.claude/projects/*/*.jsonl … attachment.type = hook_success | hook_additional_context", reviewer: native eng review.
Plan baseline: parse the current shapes (original proposal; no approval).
Runtime evidence: probe 2026-10-07: each line carries `version` (2.1.289 in the newest session); 744 of 2,273 lines have no `cwd`. Older sessions came from earlier 2.1.x builds. The format is not documented by Anthropic.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| A1 id rule | approved: slug + hash (eng D4) | unchanged | unchanged |
| A2 log format handling | parse current shapes | recognise known shapes per line; count lines of unknown shape; when unknown lines exceed 1% of a session or appear in the newest Claude Code version seen, the report says usage may be incomplete, marks affected items "usage uncertain" and suggests no archive on usage for them; fixtures captured from real logs per Claude Code version run in CI | parse current shapes; count unparseable lines only |
| SC1, SC2, F1-F5, O1-O7 | approved | unchanged | unchanged |
Question D5:
D5 — A2: Detect when Claude Code's log format changes, and stop trusting usage counts when it does?
Project/branch/task: packlight plan, issue 1 (src/adapters/claude-code.ts) and issue 7 (fixtures in CI).
ELI10: packlight reads Claude Code's private session logs to count how often you use each thing. Anthropic doesn't document that format and can change it in any release. If a field moves, packlight would quietly count zero uses for things you use daily, then suggest archiving them. The fix: recognise the shapes it knows, count anything it doesn't, and when unknown lines show up, label usage as uncertain and suggest nothing on usage alone. Real log samples from each Claude Code version become test fixtures.
Stakes if we pick wrong: after a Claude Code update, packlight confidently tells you to archive the tools you rely on most.
Recommendation: A because a wrong "not observed" is the costliest error packlight can make, and Claude Code updates often (engineering preference: zero silent failures).
Completeness: A=10/10, B=4/10
Net: an honest "can't tell after an update" versus confident wrong numbers.
Header: Log drift
Options:
A) Detect drift, mark usage uncertain (recommended)
Effort S (human ~1 d / CC ~30 min), risk low. Reuses the per-line parser and the O2 "ambiguous" label path. ✅ A format change shows up as a visible warning instead of fake zero counts. ✅ Version fixtures in CI catch a break the day a new Claude Code release is sampled. ❌ After an update, some items stay "usage uncertain" until packlight ships a parser for the new shape.
B) Count bad lines only
Effort S (human ~1 h / CC ~5 min), risk high. Reuses the parser. ✅ Simplest code. ✅ The report still says how many lines failed to parse. ❌ Lines that parse but changed meaning (a renamed field) are counted as nothing, silently.

State: approved
Actual answer: A) "Detect drift, mark usage uncertain" (eng D5, 2026-10-07)
Accepted scope: per-line shape recognition in src/adapters/claude-code.ts; unknown-shape lines counted per session and per Claude Code version; above 1% of a session's lines, or any unknown line from the newest version seen, the report shows "usage may be incomplete" and affected items are "usage uncertain" with no usage-based archive suggestion; test/fixtures/logs/<version>/ captured from real logs (counts only, no prompt text) run in CI; a test feeds a renamed-field fixture and asserts "usage uncertain", not zero.
History: none

Section 1 dispositions: A1 accepted (D4); A2 accepted (D5); A3 carried forward under CEO D18 (cwd-based project attribution; test: two projects whose folder names collide are attributed correctly by cwd).

### Section 2: Code quality review (eng)

- [P2] (confidence: 8/10) packlight-SPEC.md O7 row: "re-rate when descHash, usage bucket (unused/rare/regular), overlap group or profile hash changes" — the bucket boundaries are not defined, so two implementations would re-rate differently and criterion 11 cannot be tested. → Q1, decision below.
- OK: removal methods as one table in src/archive/methods.ts (eng D1) keeps each handler under five branches; Windows link handling (eng D2) is one helper there, not spread across files. No shared-code extraction proposed: the only repeated logic (text escaping) already has one home in render.ts.
- Stale diagram: the spec's original Architecture block omits the journal, lock, per-project scope and write-file-atomic; superseded by Section 1 (eng) above.

### Q1: Usage bucket boundaries for re-rating
Finding: Section 2, P2, confidence 8/10, packlight-SPEC.md O7 row, reviewer: native eng review.
Plan baseline: CEO D23 approved re-rating on bucket change with buckets unused/rare/regular; boundaries unspecified.
Runtime evidence: on the builder's machine, 238 of 282 items have 0 uses in 102 sessions; the top items have 100+ uses; most used items sit between 1 and 25.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| A1, A2 | approved (eng D4, D5) | unchanged | unchanged |
| O7 re-rate keys | approved (CEO D23) | unchanged | unchanged |
| Q1 bucket boundaries | unspecified | relative to the scan window: unused = 0 uses; rare = at most 1 use per 10 sessions in the window; regular = more | fixed counts: unused = 0; rare = 1 to 4 uses in the window; regular = 5+ |
Question D6:
D6 — Q1: How should packlight decide "unused", "rare" and "regular" for re-rating?
Project/branch/task: packlight plan, issue 5 (src/core/inventory.ts rating keys).
ELI10: A rating is redone when an item moves between usage buckets. The buckets need exact edges. Measuring against how many sessions the logs cover keeps a heavy user and a light user on the same scale; fixed counts are simpler but mean different things for someone with 20 sessions and someone with 500.
Stakes if we pick wrong: ratings get redone too often (wasting the user's tokens) or too rarely (stale verdicts).
Recommendation: A because the scan already knows how many sessions it covers, and a per-session rate means the same thing on every machine (engineering preference: explicit over clever).
Completeness: A=10/10, B=7/10
Net: a rate that scales with each user versus simpler fixed numbers.
Header: Usage buckets
Options:
A) Relative to sessions scanned (recommended)
Effort S (human ~1 h / CC ~5 min), risk low. Reuses the session count the scan already has. ✅ "Rare" means the same for a light user and a heavy user. ✅ One rule to test with two fixture sizes. ❌ A user with very few sessions sees items flip between rare and regular more easily.
B) Fixed counts in the window
Effort S (human ~1 h / CC ~5 min), risk low. Reuses nothing. ✅ Easiest rule to explain in the report. ✅ Stable for small log sets. ❌ For a heavy user almost everything used at all is "regular", so the bucket stops telling anything apart.

State: approved
Actual answer: A) "Relative to sessions scanned" (eng D6, 2026-10-07)
Accepted scope: buckets computed per scan window: unused = 0 uses; rare = uses <= sessions_in_window / 10; regular = more; unit test at 20 and 500 sessions asserting the same item rates land in the same bucket; criterion 11 tests a bucket crossing.
History: none

Section 2 dispositions: Q1 accepted (D6); stale spec diagram superseded (no decision needed).

### Section 3: Test review (eng)

Framework detection: no repository exists yet (greenfield); no CLAUDE.md testing section for packlight; framework unknown. The spec names Playwright for the report but no unit/integration runner.

```
CODE PATHS (all proposed; nothing exists yet, so every row is a required test, not a gap in existing code)
[+] src/adapters/claude-code.ts
  ├── parse line by shape ............ unit: known shapes; [→ fixture] unknown shape counted (A2); renamed field → "usage uncertain"
  ├── session cwd inheritance ........ unit: lines without cwd take their session's (A3)
  └── hook attribution by command .... unit: two hooks on one event never merged; duplicate command → ambiguous (O2)
[+] src/adapters/codex.ts (v0.3) ..... unit on fixture ~/.codex: skills, MCP report-only, AGENTS.md cost
[+] src/core/inventory.ts
  ├── ids (A1) ....................... unit: alike slugs → distinct ids; stable across scans; collision → scan fails naming both
  ├── scope by project (O1) .......... unit: project items excluded outside their project
  ├── ambiguity (O2) ................. unit: two "learn" skills → both ambiguous, no archive suggestion
  └── buckets + rating keys (Q1, O7) . unit: 20 vs 500 sessions; bucket crossing triggers re-rate
[+] src/core/findings.ts ............. unit: budget warning parsed vs recomputed estimate; hook chars/firing; overlap groups
[+] src/archive/apply.ts
  ├── picks validation (F3) .......... integration: stale scanId refused; unknown id skipped; path in picks ignored
  ├── plugin unit + merge (O3) ....... integration: child pick → one plugin step with full counts
  └── confirm prompt ................. integration: "no" changes nothing
[+] src/archive/journal.ts (F1) ...... integration [→E2E]: kill -9 mid-apply on fixture home, restart recovers, restore --all → empty diff (macOS, Linux, Windows; eng D2)
[+] src/archive/methods.ts
  ├── move (+ symlink / junction) .... integration: round trip byte-identical; occupied path → refuse
  ├── hook/mcp-extract + plugin-disable integration: untouched file → byte restore; changed file → refuse + fragment (D12); newest-first order
  ├── re-hash before write (F2) ...... integration: file mutated between plan and write → item aborts
  ├── Claude-running warning (D21) ... unit with process-list stub
  └── write-file-atomic (eng D3) ..... integration per OS: 0600 stays 0600 after archive and restore
[+] src/report/render.ts (F4) ........ E2E Playwright: hostile description renders as text; zero network requests; 400 px; dark mode
[+] src/report/ratings.ts (F5, O6) ... unit: foreign ids, extra fields, oversized text dropped and counted
[+] skill/SKILL.md (O6) .............. [→EVAL] orchestration step only calls packlight commands; rating step output validates

USER FLOWS
[+] npx packlight → report opens ................. E2E: cold run under 120 s on fixture; report shows project name in hero
[+] mark → Save my picks → "apply my picks" ...... E2E: picks file in Downloads (per OS) → plan → confirm → archived
[+] restore one / restore --all .................. integration: mixed outcome lists refusals, non-zero exit
[+] Windows user runs apply ...................... CI matrix job (eng D2)

COVERAGE (proposed): code paths 22/22 have a named test; user flows 4/4 | E2E: 4 | EVAL: 1 | gaps in the plan's own test list: test runner unchosen
```

- [P2] (confidence: 9/10) packlight-SPEC.md Testing Plan: "Unit | Each adapter parser … +40", no runner named; the plan cannot be implemented test-first without one. → T1, decision below.
- Regression rule: not applicable (no existing behavior; greenfield).
- LLM/eval scope: the packlight skill is a prompt; one eval case is required by approved O6/F5 (orchestration only calls packlight commands; rating output passes the schema). Carried as required proof, no new choice.

### T1: Test runner
Finding: Section 3, P2, confidence 9/10, packlight-SPEC.md Testing Plan, reviewer: native eng review.
Plan baseline: Playwright for the report (spec criterion 5); no unit/integration runner (original proposal).
Runtime evidence: none (no repo).
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| T1 unit/integration runner | unspecified | Vitest (TypeScript-native, watch mode, same config for unit and integration) | Node's built-in node:test with tsx (no dev dependency beyond tsx) |
| Report E2E | Playwright (spec) | unchanged | unchanged |
| A1, A2, Q1, SC1, SC2 | approved | unchanged | unchanged |
Question D7:
D7 — T1: Which test runner for packlight's unit and integration tests?
Project/branch/task: packlight plan, issue 1 onward (test/), CI on macOS, Linux and Windows.
ELI10: The plan lists about 40 unit and 12 integration tests but never says what runs them. Vitest understands TypeScript out of the box and is what most TypeScript CLIs use today. Node's built-in runner needs nothing extra installed but is plainer to work with. Both are dev-only, so neither ships to users.
Stakes if we pick wrong: a slower test loop that makes the archive tests painful to iterate on, or one more dev dependency.
Recommendation: A because the archive round-trip tests need fast iteration, and Vitest runs TypeScript directly with clear diffs on failure (engineering preference: every behavior tested, so the loop must be pleasant).
Note: options differ in kind, not coverage — no completeness score.
Net: a faster, friendlier test loop versus zero extra dev dependencies.
Header: Test runner
Options:
A) Vitest (recommended)
Effort S (human ~1 h / CC ~5 min), risk low. Reuses nothing; dev dependency only. ✅ TypeScript tests run directly with readable failure diffs and watch mode. ✅ Snapshot support fits the inventory.json and report fixtures. ❌ One more dev dependency to keep updated.
B) node:test with tsx
Effort S (human ~2 h / CC ~10 min), risk low. Reuses Node's built-in runner. ✅ No test framework to install or upgrade. ✅ Matches the zero-dependency spirit of the CLI. ❌ Plainer output and fewer helpers, so fixture comparisons need more hand-written code.

State: approved
Actual answer: A) "Vitest" (eng D7, 2026-10-07)
Accepted scope: Vitest for unit and integration tests (dev dependency), Playwright for report E2E, both in the three-OS CI matrix.
History: none

Section 3 dispositions: T1 accepted (D7); required tests listed in the diagram above carried from approved contracts (no new choice); eval case carried under F5/O6.

### Section 4: Performance review (eng)

No issues found. Scale: the builder's machine holds 1.3 GB of logs across 102 sessions; the Python prototype parsed them in 1.9 s line by line. The plan streams logs line by line (no whole-file loads), holds only per-item counters (hundreds of items), and has no network or database. Slowest paths: first full parse (estimated 2 to 5 s in Node, unmeasured), report render (one HTML file, under 2 MB per criterion 5), archive of a large skill folder across devices (bounded by disk copy). Criterion 4's 30 s budget holds with margin; a parse cache is not needed for v1.

### Outside voice (eng phase): codex gpt-6-astra, completed
Raw verdict line said "clean / FINDINGS: none"; the text holds 6 P1 and 2 P2 (recorded as issues_found). Codex saw the plan only up to SC1 (30 KB limit).
- X6 inventory envelope (P1): carried forward as required implementation of O1, O2, A2, Q1: inventory.json gets an envelope {schemaVersion, scanId, agent, projectScope (cwd root or "global"), window {from, to}, sessionsInWindow, linesTotal, linesUnknownShape, claudeCodeVersions[]}; item usage gains {ambiguous: boolean, uncertain: boolean}. Correction: "newest scan of the same agent" becomes "newest scan of the same agent and projectScope" (F3). Test: two successive scans of different projects keep separate newest scans.
- X7 ratings persistence (P2): carried forward as required implementation of O7 (CEO D23): ratings live in ~/.packlight/ratings/<agent>.json keyed by item id with the rating key (descHash, bucket, group id, profile hash) stored beside each entry; a new scan reuses entries whose key matches. Test: two distinct scanIds, one changed key, exactly one re-rated.
- X8 budget warnings (P2): factual correction, no behavior choice: a budget warning is bound to its session and timestamp; after archive the report says "predicted to come back" until a newer session's warning confirms it; design-doc success criterion 5 reworded to match.

### X1: Target fingerprint for picks
Finding: Outside voice (codex), P1, confidence 7/10, packlight-SPEC.md picks file and apply ("skips any item whose descHash changed since the scan").
Plan baseline: apply checks descHash and the scanId only (CEO F3 D15; spec).
Runtime evidence: descHash covers name and description only; a skill folder, symlink target, hook command or plugin member list can change without it. Not probed.
Comparison grid:
| Choice | Current | A | B | C | D |
|---|---|---|---|---|---|
| X1 picks freshness check | descHash + scanId | scan records targetFingerprint per item (hash of folder contents or file bytes, link target, hook command, plugin member list); apply recomputes it and refuses that item with "changed since you reviewed it, rescan" when it differs | descHash + scanId | investigate which target changes matter (bounded: one day), no change yet | defer to TODOS; keep descHash + scanId |
| A1, A2, Q1, T1, SC1, SC2, F1-F5, O1-O7 | approved | unchanged | unchanged | unchanged | unchanged |
Question D8:
D8 — X1: Refuse picks when the thing being archived changed since you reviewed it?
Project/branch/task: packlight plan, issue 1 (fingerprint at scan) and issue 3 (apply check).
ELI10: Your picks are checked against each item's description. But a skill's files, a link's target, a hook's command or a plugin's contents can change while the description stays the same, for example after an update. Then apply would archive something different from what you looked at. The fix: record a fingerprint of the actual thing at scan time and refuse that item at apply if it changed, asking you to rescan.
Stakes if we pick wrong: you approve archiving one version of a plugin and packlight archives an updated one with different contents.
Recommendation: A because a pick should authorize exactly what the user reviewed (engineering preference: explicit over clever).
Note: options differ in kind, not coverage — no completeness score.
Net: one more hash per item versus approving a moving target.
Header: Target freshness
Options:
A) Apply this change (recommended)
Effort S (human ~0.5 d / CC ~20 min), risk low. Reuses the A1 hash helper. ✅ Apply only acts on exactly what the user reviewed; a changed target is refused per item with a clear rescan message. ✅ Covers updates between scan and apply. ❌ A plugin that auto-updates often will need more rescans.
B) Keep the current value
Effort S (zero implementation work), risk medium. ✅ No extra hashing at scan time. ✅ Description changes are still caught. ❌ Changes to files, links, commands or plugin contents slip through.
C) Investigate before choosing
Effort S (human ~1 d, bounded), risk low. ✅ Measures how often targets change without description changes before committing. ✅ Nothing changes yet. ❌ Issue 3 waits for the result.
D) Defer this change only
Effort S (zero now), risk medium. ✅ Keeps v1 as specified. ✅ Recorded in TODOS with context. ❌ The gap ships in v1.

State: approved
Actual answer: A) "Apply this change" (eng D8, 2026-10-07)
Accepted scope: inventory items carry targetFingerprint (sha256 over folder contents or file bytes, link target, hook command, plugin member list); apply recomputes per picked item and refuses a changed one with "changed since you reviewed it, rescan"; integration test: change a picked skill file after scan, apply refuses that item only.
History: none

### X2: Effective configuration and settings precedence
Finding: Outside voice (codex), P1, confidence 8/10, packlight-SPEC.md removal methods ("plugin-disable … enabledPlugins in ~/.claude/settings.json").
Plan baseline: plugin-disable and hook/mcp-extract edit the file where the item was found (design doc removal table; CEO O3 D20).
Runtime evidence: Claude Code reads settings from user, project and local files; a project .claude/settings.json can carry its own enabledPlugins and hooks (this machine: essent-hq/.claude/settings.json declares hooks). Precedence not verified for every key.
Comparison grid:
| Choice | Current | A | B | C | D |
|---|---|---|---|---|---|
| X2 settings provenance | edit the file the item was found in | adapters report every declaration of an item across user/project/local files with its source; the plan shows all of them; apply disables or removes each contributing declaration (each with its own manifest) and a rescan verifies the item is no longer effective, else reports it | edit the found file only | investigate Claude Code precedence per key (bounded: 1 day) before deciding | defer to TODOS; edit found file only |
| A1, A2, Q1, T1, SC1, SC2, F1-F5, O1-O7 | approved | unchanged | unchanged | unchanged | unchanged |
Question D9:
D9 — X2: Handle the same plugin or hook being turned on in more than one settings file?
Project/branch/task: packlight plan, issue 1 (adapter provenance) and issue 3 (apply).
ELI10: Claude Code reads settings from your user file and from each project's files. A plugin can be enabled in both. If packlight turns it off only in your user file, the project file can keep it on and nothing changes. The fix: find every place an item is switched on, show them all in the plan, change each one (each restorable), then rescan to confirm it's really off and say so if it isn't.
Stakes if we pick wrong: packlight reports a plugin as archived while it still loads in your projects.
Recommendation: A because "archived" must mean "no longer loaded", and a rescan is the only proof (engineering preference: zero silent failures).
Note: options differ in kind, not coverage — no completeness score.
Net: a fuller plan and a verification rescan versus a removal that may not take effect.
Header: Settings scope
Options:
A) Apply this change (recommended)
Effort M (human ~2 d / CC ~1 h), risk low. Reuses the per-file manifests. ✅ Every contributing declaration is shown and changed, each with its own restore. ✅ A post-apply rescan confirms the item is no longer effective and reports it if it is. ❌ Plans get longer when an item is declared in several places.
B) Keep the current value
Effort S (zero implementation work), risk high. ✅ Simplest apply. ✅ Works when an item is declared once. ❌ An item declared in several files stays active while packlight says it is archived.
C) Investigate before choosing
Effort S (human ~1 d, bounded), risk low. ✅ Confirms Claude Code precedence key by key first. ✅ Nothing changes yet. ❌ Issue 3 waits for the result.
D) Defer this change only
Effort S (zero now), risk high. ✅ Keeps v1 as specified. ✅ Recorded in TODOS. ❌ The false "archived" case ships.

State: approved
Actual answer: A) "Apply this change" (eng D9, 2026-10-07)
Accepted scope: adapters return every declaration of an item across user, project and local settings with its source file; the apply plan lists all of them; apply removes or disables each (one manifest each); a post-apply rescan confirms the item is no longer effective and reports any that still is; integration test: plugin enabled in both user and project settings ends disabled in both and restore re-enables both.
History: none

### X3: Journal covers restore and recovery
Finding: Outside voice (codex), P1, confidence 8/10, packlight-SPEC.md F1 row ("journal: write manifest with status pending first, then move or edit, then mark done").
Plan baseline: CEO F1 (D13): journal for archive with pending → done and recovery at start.
Runtime evidence: Restore also mutates files and settings; F1 does not name restore states or what recovery does if a file changed while an entry was pending.
Comparison grid:
| Choice | Current | A | B | C | D |
|---|---|---|---|---|---|
| X3 journal lifecycle | archive only | one state machine for archive and restore (pending-archive → archived; pending-restore → active), each entry records the expected before/after file state; recovery finishes or rolls back only when disk matches one of them, otherwise refuses and reports; fault-injection tests at every transition including restore | archive only | investigate (bounded: 0.5 d) | defer to TODOS; archive only |
| A1, A2, Q1, T1, SC1, SC2, F1-F5, O1-O7 | approved | unchanged | unchanged | unchanged | unchanged |
Question D10:
D10 — X3: Extend the crash-safe journal to restore, and refuse recovery when files changed?
Project/branch/task: packlight plan, issue 3 (src/archive/journal.ts).
ELI10: The approved journal makes archive survive a crash. Restore changes files too, so a crash halfway through restore can leave things inconsistent. And if you edited a file while an operation was pending, blindly finishing or undoing it could overwrite your edit. The fix: the same journal covers restore, each entry records what the files should look like before and after, and recovery only acts when the disk matches one of those; otherwise it stops and tells you.
Stakes if we pick wrong: a crash during restore leaves a skill half back, or recovery overwrites a change you made.
Recommendation: A because restore is half of the trust promise, and recovery must never guess (engineering preference: zero silent failures).
Note: options differ in kind, not coverage — no completeness score.
Net: one state machine for both directions versus a crash-safe archive with a fragile restore.
Header: Restore journal
Options:
A) Apply this change (recommended)
Effort S (human ~1 d / CC ~40 min), risk low. Reuses the F1 journal. ✅ Archive and restore are both crash-safe with one recovery rule. ✅ Recovery never overwrites a file that changed; it refuses and names it. ❌ More states to test (fault injection at each transition).
B) Keep the current value
Effort S (zero implementation work), risk medium. ✅ Smaller journal. ✅ Archive stays crash-safe. ❌ A crash during restore, or an edit during a pending entry, is unhandled.
C) Investigate before choosing
Effort S (human ~0.5 d, bounded), risk low. ✅ Maps restore failure points first. ✅ Nothing changes yet. ❌ Issue 3 waits for the result.
D) Defer this change only
Effort S (zero now), risk medium. ✅ Keeps F1 as approved. ✅ Recorded in TODOS. ❌ Restore ships without crash safety.

State: approved
Actual answer: A) "Apply this change" (eng D10, 2026-10-07)
Accepted scope: src/archive/journal.ts holds one state machine for archive and restore (pending-archive -> archived; pending-restore -> active) with expected before/after file state per entry; recovery acts only when disk matches one of them and otherwise refuses and names the file; fault-injection tests at every transition of both directions on all three OSes.
History: none

### X4: Cross-volume archive moves
Finding: Outside voice (codex), P1, confidence 8/10, packlight-SPEC.md CEO Section 2 ("CrossDevice | Y | copy + verify hash + remove (not rename)").
Plan baseline: CEO Section 2 rescue: copy, verify hash, remove; not tied to the journal.
Runtime evidence: Project skills and agents can live on another drive from ~/.packlight; rename fails with EXDEV across volumes; write-file-atomic covers single files, not folders.
Comparison grid:
| Choice | Current | A | B | C | D |
|---|---|---|---|---|---|
| X4 cross-volume move | copy, verify, remove | journal step per phase: copy into a staging folder in the archive, verify the staged tree hash against the A1/X1 fingerprint, then remove the source; recovery finishes or discards the stage; source changed during copy → refuse; integration test on a real second volume (tmpfs on Linux, RAM disk on macOS) | copy, verify, remove (unjournaled) | investigate (bounded: 0.5 d) | defer to TODOS |
| A1, A2, Q1, T1, SC1, SC2, F1-F5, O1-O7 | approved | unchanged | unchanged | unchanged | unchanged |
Question D11:
D11 — X4: Make archiving across drives crash-safe too?
Project/branch/task: packlight plan, issue 3 (src/archive/methods.ts, journal.ts).
ELI10: Moving a folder on the same drive is one instant step. Moving it to another drive is copy then delete, and a crash in between can leave half a copy, or the original deleted before the copy was checked. The fix: copy into a staging area, check the copy matches, only then delete the original, with each step in the journal; and refuse if the original changed during the copy.
Stakes if we pick wrong: a project skill on an external or second drive is lost or duplicated after a crash.
Recommendation: A because the archive promise must hold no matter where the item lives (engineering preference: edge cases over speed).
Note: options differ in kind, not coverage — no completeness score.
Net: a staged copy and one more test volume versus an unprotected copy-then-delete.
Header: Cross-drive
Options:
A) Apply this change (recommended)
Effort S (human ~1 d / CC ~40 min), risk low. Reuses the journal and fingerprints. ✅ No crash point loses or half-copies an item across drives. ✅ A source changed mid-copy is refused, not archived. ❌ CI needs a second volume per OS for the integration test.
B) Keep the current value
Effort S (zero implementation work), risk medium. ✅ Copy, verify, remove already described. ✅ Works when nothing crashes. ❌ A crash between copy and delete is not recoverable.
C) Investigate before choosing
Effort S (human ~0.5 d, bounded), risk low. ✅ Checks how often skills live on another drive first. ✅ Nothing changes yet. ❌ Issue 3 waits for the result.
D) Defer this change only
Effort S (zero now), risk medium. ✅ Keeps v1 as specified. ✅ Recorded in TODOS. ❌ Cross-drive archives ship unprotected.

State: approved
Actual answer: A) "Apply this change" (eng D11, 2026-10-07)
Accepted scope: cross-volume moves are journaled per phase: copy into a staging folder inside the archive, verify the staged tree against targetFingerprint (X1), then remove the source; recovery finishes or discards the stage; a source changed during copy is refused; integration test on a real second volume per OS (tmpfs on Linux, RAM disk on macOS, a second drive letter or VHD on Windows).
History: none

### X5: Identity for repeated declarations and archive operations (reopens A1)
Finding: Outside voice (codex), P1, confidence 7/10, packlight-SPEC.md A1 accepted scope ("sha256(agent, kind, source, name, path)").
Plan baseline: eng D4 (A1): id = slug + 8 hex of sha256(agent, kind, source, name, path). Reopened for new evidence: two identical hook entries in one settings file share all five fields.
Runtime evidence: Settings files can declare the same hook command twice (same file path); D4 would give them one id. Archive and restore cycles of one item also reuse the item id as the archive folder name.
Comparison grid:
| Choice | Current | A | B | C | D |
|---|---|---|---|---|---|
| X5 identity | eng D4 hash over (agent, kind, source, name, path) | add the declaration locator (JSON pointer into the settings file) to the hashed fields for declarations; each archive operation gets its own operation id (timestamp + random), used for the archive folder and manifest, linked to the item id | keep eng D4 as is | investigate (bounded: 2 h) | defer to TODOS |
| A1, A2, Q1, T1, SC1, SC2, F1-F5, O1-O7 | approved | unchanged | unchanged | unchanged | unchanged |
Question D12:
D12 — X5: Tell apart duplicate hook entries, and give each archive its own id?
Project/branch/task: packlight plan, issue 1 (ids) and issue 3 (archive folders); reopens your D4 answer for new evidence.
ELI10: D4's ids hash an item's agent, kind, source, name and file path. Two identical hook entries in the same settings file share all of those, so they'd get one id and one pick would hit both or the wrong one. Adding the entry's position in the file to the hash separates them. Separately, archiving the same item twice (archive, restore, archive again) reuses one folder name; giving each archive its own operation id keeps every cycle restorable.
Stakes if we pick wrong: a duplicate hook can't be archived on its own, or a second archive of an item overwrites the first one's record.
Recommendation: A because both are small additions to D4 that close the last ways two targets share an identity (engineering preference: explicit over clever).
Note: options differ in kind, not coverage — no completeness score.
Net: two more fields in the identity versus rare but confusing collisions.
Header: Ids, revisited
Options:
A) Apply this change (recommended)
Effort S (human ~2 h / CC ~10 min), risk low. Reuses the D4 hash. ✅ Duplicate declarations in one file get distinct ids and can be archived one at a time. ✅ Every archive operation has its own folder and manifest, so repeated cycles never overwrite each other. ❌ Archive folder names change from item ids to operation ids (the item id stays in the manifest).
B) Keep the current value
Effort S (zero implementation work), risk medium. ✅ D4 stands unchanged. ✅ No duplicates seen on the builder's machine. ❌ Identical declarations collide, and a re-archive reuses one folder.
C) Investigate before choosing
Effort S (human ~2 h, bounded), risk low. ✅ Checks how often duplicates occur in real settings first. ✅ Nothing changes yet. ❌ Issue 1 waits for the result.
D) Defer this change only
Effort S (zero now), risk medium. ✅ Keeps D4. ✅ Recorded in TODOS. ❌ Both collisions ship.

State: approved
Actual answer: A) "Apply this change" (eng D12, 2026-10-07)
Accepted scope: declaration items (hooks, MCP servers, plugin flags) hash agent, kind, source, name, path and the JSON pointer of the declaration; each archive operation gets an operation id (UTC timestamp + 6 random hex) naming its archive folder and manifest, which records the item id; unit test: two identical hook entries in one file get distinct ids; integration test: archive, restore, archive the same item keeps two restorable records.
History: none

Approval readiness (eng): PASS. Checked: SC1 (eng D2), SC2 (D3), A1 (D4, extended by D12), A2 (D5), A3 (carried under CEO D18), Q1 (D6), T1 (D7), X1 (D8), X2 (D9), X3 (D10), X4 (D11), X5 (D12), X6 and X7 (carried under CEO D18/D19/D23 and eng D5/D6), X8 (factual correction). Structure: eng D1. No unanswered or out-of-scope remedy is in accepted work.

### NOT in scope (eng)
- Parse cache for logs: not needed for v1 (Section 4: 30 s budget holds with margin).
- Shared helpers beyond the 12-file arrangement: no duplicated behavior found that justifies one.
- CEO deferrals carried unchanged: purge (D10), doctor (D11), semantic restore (D12), Codex TOML archiving, loadouts.
- TODOS.md: the packlight repo does not exist yet; the five CEO deferrals above are its first entries once created (not persisted as a file today).

### What already exists (eng)
- ~/.claude/toolkit-ledger/scan.py and merge.py: usage parsing to port into src/adapters/claude-code.ts (now with shape recognition, A2, and cwd attribution, A3).
- write-file-atomic (npm): settings writes (eng D3).
- Toolkit Ledger artifact v5: report layout reference for src/report/template.html.

### Diagrams (eng)
Archive and restore lifecycle (X3, X4):
```
 ACTIVE ──archive──▶ PENDING-ARCHIVE ──(same volume: rename | other volume: copy→stage→verify→remove)──▶ ARCHIVED
   ▲                     │ crash: disk = before → roll back; disk = after → mark done; else REFUSE + name file
   │                                                                                    │
   └────────────── ACTIVE ◀──commit── PENDING-RESTORE ◀──restore (file untouched, path free)──┘
                                         │ crash: same rule as above
 Refusals keep the item in its current state and print why (path occupied, file changed, target changed X1).
```
Inline diagrams to keep in code: src/archive/journal.ts (the state machine above), src/archive/methods.ts (method table), src/core/inventory.ts (id and rating-key derivation).

### Failure modes (eng additions)
| Path | Realistic failure | Test | Handling | User sees |
|---|---|---|---|---|
| claude-code adapter | Claude Code update changes a field | fixture per version (A2) | lines counted as unknown shape | "usage may be incomplete"; items "usage uncertain" |
| inventory ids | two identical hook entries | unit (X5) | locator in hash | two separate rows |
| apply | plugin updated between scan and apply | integration (X1) | fingerprint mismatch → refuse item | "changed since you reviewed it, rescan" |
| apply | plugin also enabled in project settings | integration (X2) | every declaration changed, rescan verifies | plan lists both files; warning if still active |
| restore | crash mid-restore | fault injection (X3) | journal recovery or refusal | "Recovered" or "refused: <file> changed" |
| archive | item on a second drive, crash mid-copy | real second volume (X4) | staged copy, verify, then remove | "Recovered interrupted archive" |
| any settings write | 0600 file | per-OS test (D3) | write-file-atomic keeps mode | nothing (permissions unchanged) |
Critical gaps: 0.

### Worktree parallelization strategy
| Step | Modules touched | Depends on |
|---|---|---|
| Inventory contract (envelope, ids, scope, usage, drift) | src/core, src/adapters/claude-code | — |
| Archive engine (journal, methods, apply, restore) | src/archive | inventory contract |
| Report (render, template, ratings merge) | src/report | inventory contract |
| Codex adapter (v0.3) | src/adapters/codex | inventory contract |
| Skill (orchestration + rating step) | skill/ | report, inventory contract |
| CI matrix + packaging | .github, package.json | any lane's first tests |
Parallel lanes: Lane A: inventory contract (sequential, first). Then Lane B: archive engine; Lane C: report → skill; Lane D: codex adapter; Lane E: CI matrix + packaging.
Execution order: build Lane A and merge it. Launch B + C + D + E. Merge B and C before the v0.2 skill work completes.
Conflict flags: src/core/inventory.ts is read by every lane; freeze its envelope (X6) at the end of Lane A and change it only by a versioned schema bump.

### Implementation Tasks (eng)
Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code or Codex; checkbox as you ship. (Ratios assumed: features ~30x, tests ~50x, architecture ~5x human to CC.)

- [ ] **E1 (P1, human: ~1d / CC: ~30min)** — inventory — Define the inventory envelope and ids (schemaVersion, projectScope, window, sessionsInWindow, coverage; ids with locator hash; operation ids)
  - Surfaced by: Section 1 A1 (D4), outside voice X5 (D12), X6
  - Files: src/core/inventory.ts, src/adapters/claude-code.ts
  - Verify: vitest: alike slugs and identical hook entries get distinct, stable ids; two projects keep separate newest scans
- [ ] **E2 (P1, human: ~1d / CC: ~30min)** — adapters — Shape recognition, unknown-line counting, "usage uncertain", per-version fixtures in CI
  - Surfaced by: Section 1 A2 (D5)
  - Files: src/adapters/claude-code.ts, test/fixtures/logs/
  - Verify: renamed-field fixture yields "usage uncertain", never zero
- [ ] **E3 (P1, human: ~2h / CC: ~10min)** — adapters — Project attribution from each line's cwd (session inheritance)
  - Surfaced by: Section 1 A3 (CEO D18)
  - Files: src/adapters/claude-code.ts
  - Verify: colliding folder names attributed correctly by cwd
- [ ] **E4 (P2, human: ~0.5d / CC: ~20min)** — inventory — Usage buckets relative to sessions; ratings cache across scans
  - Surfaced by: Section 2 Q1 (D6), outside voice X7 (CEO D23)
  - Files: src/core/inventory.ts, src/report/ratings.ts
  - Verify: 20 vs 500 sessions bucket equally; two scanIds re-rate exactly the changed item
- [ ] **E5 (P1, human: ~3d / CC: ~1.5h)** — platform — Windows support: homedir/path.join, junctions, rename retry, Downloads per OS, CI job
  - Surfaced by: Scope Challenge SC1 (D2)
  - Files: src/archive/methods.ts, src/archive/apply.ts, .github/workflows/ci.yml
  - Verify: archive round trip and kill -9 test green on windows-latest
- [ ] **E6 (P1, human: ~1h / CC: ~5min)** — archive — Settings writes through write-file-atomic (pinned)
  - Surfaced by: Scope Challenge SC2 (D3)
  - Files: src/archive/methods.ts, package.json
  - Verify: 0600 file stays 0600 after archive and restore on each OS
- [ ] **E7 (P1, human: ~0.5d / CC: ~20min)** — apply — Target fingerprint recorded at scan, checked at apply
  - Surfaced by: outside voice X1 (D8)
  - Files: src/core/inventory.ts, src/archive/apply.ts
  - Verify: change a picked skill file after scan, apply refuses that item only
- [ ] **E8 (P1, human: ~2d / CC: ~1h)** — apply — Every declaration across user/project/local settings; post-apply verification rescan
  - Surfaced by: outside voice X2 (D9)
  - Files: src/adapters/claude-code.ts, src/archive/apply.ts
  - Verify: plugin enabled in user and project ends disabled in both; restore re-enables both
- [ ] **E9 (P1, human: ~1d / CC: ~40min)** — archive — One journal state machine for archive and restore; recovery refuses on divergence
  - Surfaced by: outside voice X3 (D10), extends CEO F1 (D13)
  - Files: src/archive/journal.ts
  - Verify: fault injection at every transition, both directions, three OSes
- [ ] **E10 (P1, human: ~1d / CC: ~40min)** — archive — Staged, verified cross-volume moves
  - Surfaced by: outside voice X4 (D11)
  - Files: src/archive/methods.ts, src/archive/journal.ts
  - Verify: real second-volume test per OS; source changed mid-copy is refused
- [ ] **E11 (P2, human: ~2h / CC: ~10min)** — tests — Vitest + Playwright setup in the three-OS CI matrix
  - Surfaced by: Section 3 T1 (D7), SC1 (D2)
  - Files: vitest.config.ts, playwright.config.ts, .github/workflows/ci.yml
  - Verify: CI green on ubuntu, macos, windows with one sample test each
- [ ] **E12 (P2, human: ~1h / CC: ~5min)** — findings — Bind budget warnings to their session; "predicted to come back" until confirmed
  - Surfaced by: outside voice X8 (factual correction)
  - Files: src/core/findings.ts, docs/designs/packlight.md (criterion 5 wording)
  - Verify: after archive, report shows a prediction label until a newer session's warning is parsed
_No new tasks from Section 4 (Performance)._

### Completion summary (eng)
- Step 0: Scope Challenge — scope accepted as-is (smaller arrangement, eng D1; SC1 and SC2 resolved)
- Architecture Review: 3 issues found (A1, A2, A3)
- Code Quality Review: 1 issue found (Q1), plus 1 stale diagram noted
- Test Review: diagram produced, 1 gap identified (T1 runner)
- Performance Review: 0 issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 new items proposed (5 CEO deferrals carried; repo not created)
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex (gpt-6-astra), completed, 8 findings (5 decided D8-D12, 2 carried under existing approvals, 1 factual correction)
- Parallelization: 5 lanes, 4 parallel / 1 sequential (Lane A first)
- Lake Score: 5/5 answers picked the 10/10 option

## Design review (/plan-design-review, 2026-10-07)

Scope: report.html (issue 2), all seven passes (D1). Mockups not generated: the gstack designer has no OpenAI key (`design setup` enables it; brief kept at essent-hq `.gstack/tmp/brief.QEliXL`). Outside voices: Codex gpt-6-astra (9 findings, hard rejections 1, 3, 7) and an independent Claude subagent (7 findings, hard rejections 1, 3, 5); both classify the report as APP UI. These decisions supersede the Toolkit Ledger v5 prototype wherever the two differ.

### Decision ledger

| ID | Decision | Approval |
|---|---|---|
| DR1 hero | Budget-bar hero (spec below) | D3 answer "A) Budget bar hero" |
| DR2 layout | One continuous surface: unboxed hero, one-line totals strip, inventory directly below; no KPI cards, no frame shadow, no gradients | D4 answer "A) One surface" |
| DR3 navigation | Tabs Items · Findings · Picks (n) · Archived (n); "Which one (n)" appears only when groups.json exists | D5 answer "A) Picks + Archived" |
| DR4 inventory | Expandable rows with per-kind columns, replacing "one card per item" | D6 answer "A) Expandable rows" |
| DR5 states | Full per-tab state table below, replacing CEO Section 11's three-row table | D7 answer "A) Full state table" |
| DR6 v0.1 suggestions | Printed suggestion rule plus "Mark all N shown"; no verdict column until ratings.json merges | D8 answer "A) Rule + Mark all shown" |
| DR7 marking | Three states (none / Archive / Keep); the plugin row is the only mark for plugin children; Keep persists | D9 answer "A) Plugin-level mark + Keep" |
| DR8 hand-off | Persistent Next step panel after Save; "Projected" vs measured before/after; restore commands in Archived | D10 answer "A) Next step panel" |
| DR9 identity and copy | "packlight" wordmark masthead; finding-style headings; sentence-case labels; action-named buttons | D11 answer "A) Wordmark + copy rules" |
| DR10 tokens and type | Native system font stack, defined type scale, colour tokens from v5 without glow or decorative shadow; themed browser surfaces | D12 answer "A) Native stack + scale" |
| DR11 narrow layout | Designed layout below 720 px: two-line rows, filters behind one button, compact picks bar, 44 px targets | D13 answer "A) Designed narrow layout" |
| DR12 accessibility | Written keyboard and screen-reader contract, tested with axe in Playwright | D14 answer "A) Contract + axe tests" |
| DR13 units | Measured characters in every column and the hero; token estimates only as a secondary "est." | D15 answer "A) Chars, tokens as est." |
| DR14 projects | One report file; the project switcher re-scopes inside it; opens on the cwd project; one set of marks | D16 answer "A) One file, switcher" |
| DR15 which-one card | One comparison card per overlap group, members side by side, actions by group type | D17 answer "A) Comparison card" |

### DR1: the hero

```
 essent-hq · Claude Code · 20 Aug to 7 Oct · 102 sessions                    [parse gaps: 3 lines]
 41 skills pushed out of essent-hq's skill listing
 ┌──────────────────────────── listing budget (1% of context) ─────────┬╌╌╌╌ pushed out ╌╌╌╌╌╌┐
 │███████████████████████████████████████████████████████████████████│▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒│
 └─────────────────────────────────────────────────────────────────────┴──────────────────────┘
 169 listed · 41 dropped · archiving the 38 not observed in 102 sessions brings 29 back   [Review the 41]
 Hooks add 7.4k chars per session start and 140 per tool call                          [Review hooks]
```
- The bar holds skills in listing order. A solid vertical line marks the budget, and the overflow segment is hatched. Each segment is not separately interactive, so the bar is one image with a text equivalent (`role="img"` plus an `aria-label` that repeats the sentence under it).
- **Review the 41** switches to Items › Skills filtered to "pushed out". **Review hooks** switches to Items › Hooks sorted by chars per session start.
- **Estimate state:** if no budget warning was found in the scanned logs, the line is dashed and a label reads "Estimated: no budget warning in these logs. Recomputed from the 1% budget." The count reads "about 41".
- **All-fit state:** "All 210 skills fit in essent-hq's listing", with the bar shown and no overflow. The hook line moves up and becomes the lead.
- **Codex (no budget):** the bar is replaced by "Skill descriptions: 18.2k chars (est.)" with no pushed-out claim (CEO correction 1).
- The context line names the project, agent, date range, session count and any parse gaps (O1, A2).

### DR2-DR4: page structure

```
 ┌ packlight ─────────── essent-hq ▾ ── Claude Code ── scanned 7 Oct 2026 ────────────────────────┐
 │ Items   Findings (5)   Picks (0)   Archived (0)   [Which one (7): only once groups.json exists] │
 ├──────────────────────────────────────────────────────────────────────────────────────────────┤
 │ HERO (DR1)                                                                                   │
 │ 282 installed · 238 not observed in 102 sessions · 4 usage ambiguous          ← totals strip │
 │ Skills 210  Hooks 6  Plugins 15  Agents 13  Connectors 24  Commands 10        ← kind filter  │
 │ [Search names, descriptions]  Sort: Chars per session ▼   Showing 210   Clear filters        │
 │ ○ name            source        last observed    sessions   listing      chars/session       │
 │ ▸ row …                                                                                      │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```
- **Order of attention:** (1) the hero, (2) the totals strip, (3) the inventory. Nothing else on the Items tab. The hero and totals strip appear on Items only, and other tabs open with their own title line.
- **Surface:** one page background, hairline (1 px `--line`) rules between the hero, the strip and the table. No KPI cards, no frame shadow, no gradient fills. Depth is used only for the floating picks bar and any popover.
- **Tabs (DR3):** Items is the default. **Findings** lists setup-wide checks: settings, broken symlinks, duplicate names, items that came back. **Picks (n)** lists marked items not yet applied, grouped by removal method, with Save my picks and the apply command. **Archived (n)** lists what packlight actually moved, read from the manifests, with each item's `packlight restore <id>` command. **Which one (n)** is absent until groups.json exists. Tab counts update live as marks change.
- **Inventory (DR4):** one table per kind via the kind filter.

| Kind | Columns (left to right) |
|---|---|
| Skills, commands, agents | mark · name · source · last observed · sessions used · listing status (listed / pushed out / n/a) · chars per session |
| Hooks | mark · name (event + matcher) · source · firings · chars per firing · chars per session start · p95 ms |
| Plugins | mark · name · items inside (by kind) · enabled · last observed (any child) · chars per session (sum) |
| Connectors | mark · name · source · last observed · tool calls · tools listed |

  - The row expands in place (disclosure button at row start) to show: path, full description (escaped, F4), hook command, the reason it is flagged, overlap group, and the plugin it belongs to.
  - Search filters names and descriptions. Sort shows its column and direction. The result count and **Clear filters** sit on the same line.
  - Default sort: chars per session, descending, so the costliest items come first.

### DR5: state table (replaces Section 11's table)

The report is static, so there is no loading state for data. The only wait is the first paint of a long list, covered by the first-paint row.

| Where | State | What the user sees |
|---|---|---|
| Whole page | No items found by the scan | Hero replaced by "packlight found no skills, hooks, agents, plugins or connectors for Claude Code." plus the folders it looked in, listed as paths. No table. |
| Whole page | Embedded data fails validation | Only this, at the top: "This report's data is damaged or from a newer packlight. Run `npx packlight report` to rebuild it." No partial rendering. |
| Hero + table | No session logs at all | Inventory shown in full. Usage columns read "Unavailable" (never 0 and never "not observed"). Banner above the hero: "No session logs at ~/.claude/projects. Usage is unknown, not zero, so nothing is suggested for archive." The budget bar shows the estimate state (DR1). |
| Hero + table | Some log lines unreadable | Context line shows "parse gaps: N lines". Clicking it expands one sentence: "N lines in M sessions could not be read. Counts may be low for items used in those sessions." Affected usage cells carry a small "may be low" mark. |
| Table | Usage ambiguous (O2) | Usage cell reads "ambiguous: 31 shared". The row is never in any suggestion. Expanding it explains which items share the count. |
| Table | Search or filter matches nothing | "No items match 'xyz' in Skills." plus a **Clear filters** button. |
| Table | First paint, 500+ items | Hero, strip and the first 50 rows render first, and the rest append in idle time. The count reads "Showing 50 of 210, loading the rest" until done. No spinner. |
| Picks tab | Nothing marked | "Nothing marked yet. In Items, mark the rows you want to archive; they collect here." Save my picks is disabled, with the reason as visible text, not only a tooltip. |
| Picks tab | Marks from an older scan in storage | Banner: "You marked 12 items in the 7 Oct scan. 11 still match this scan." with **Bring them over** and **Discard**. Items whose fingerprint changed are listed and not carried over (X1). |
| Picks tab | Browser blocks storage | Notice: "Marks last until you close this page (this browser blocks saved marks)." Everything else works. |
| Picks tab | Download blocked | The picks JSON is shown in a read-only text box with **Copy**, plus "Save this as packlight-picks-<scanId>.json, then run the command below." |
| Archived tab | Nothing archived | "Nothing archived yet. Items you apply with `packlight apply` appear here, each with its restore command." |
| Archived tab | Manual items | Grouped under "Waiting for you": what to click and where. Each shows "done" only after a re-scan confirms it is gone. |
| Archived tab | Item came back (doctor check 8) | Row tagged "came back": "Archived 7 Oct, reinstalled since (probably by an updater)." |
| Findings tab | No findings | "No setup problems found in this scan." plus the list of checks that ran. |
| Which one tab | groups.json present, some items unrated | Unrated members read "Not rated yet". The tab shows "Rated 31 of 38 items. Run the packlight skill again to rate the rest." |

### DR6: suggestions before ratings exist (v0.1)

- **Rule (printed beside the button, word for word):** "Suggested: not observed in any of the 102 sessions from 20 Aug to 7 Oct. Excludes items with shared usage and items only removable by hand."
- **Eligibility:** not observed in the scan; the scan covers at least 20 sessions **and** at least 14 days; usage not ambiguous (O2); removal method is not `manual`; the item is not packlight itself. If the scan is below the threshold, no item is suggested, and the filter reads "Too few sessions to suggest (12 of 20 needed)".
- **Control:** a "Suggested (38)" filter chip in the kind-filter row. When that filter is active, a **Mark all 38 shown** button appears and marks exactly the visible rows. Plugin children follow DR7. Nothing is ever pre-marked.
- **No rating UI in v0.1:** no verdict column, no rated sorts, no "Not rated yet" prompts in rows. When ratings.json is merged (v0.2), a Verdict column appears after "name", "Best rated" joins the sort menu, the suggestion rule gains "or rated archive", and the Which one tab appears (DR3).

### DR7: marking

- **Control:** each markable row starts with a two-button segmented control, **Archive** and **Keep**. Pressing the active one again clears it. It is a real `<button aria-pressed>` pair, not a clickable row (DR9 covers the keyboard). The row tint follows the state: Archive gets `--red-soft` and Keep gets a hairline `--green` check. Colour is never the only signal, because the pressed button's label stays visible.
- **Plugin children:** a skill, hook, agent or connector bundled by a plugin shows a "part of vercel" tag. In place of the segmented control it shows **Mark plugin…**, which expands the impact line "Archiving vercel disables 14 items: 9 skills, 3 hooks, 2 agents" with **Archive plugin** and **Cancel**. Once the plugin is marked, every child row shows "archived with vercel" and is not separately markable. Unmarking the plugin (from any child or the plugin row) clears it for all. The Picks tab counts plugins as one pick, with the child counts shown under it.
- **Ambiguous items (O2):** they can be marked by hand. The row keeps its "ambiguous: 31 shared" text, and the Picks tab repeats it next to the item.
- **Keep:** written to picks.json as `action: "keep"`. `packlight apply` records keeps in `~/.packlight/keeps.json` (id plus fingerprint, X1), and later scans exclude kept items from suggestions (DR6) and show a small "kept 7 Oct" tag. A kept item whose fingerprint changes loses its keep and is shown as new. Format addition for issue 1 (read) and issue 3 (write).
- **Live counts:** the Picks tab label and the floating picks bar show "12 to archive · 3 to keep".

### DR8: the page-to-terminal hand-off

Journey storyboard (accepted):

| Step | User does | User feels | Specified by |
|---|---|---|---|
| 1 | Runs `npx packlight`; the page opens | curious, a bit suspicious | spec: under 30 s, local only |
| 2 | Reads the hero (first 5 s) | "41 of my skills are hidden" | DR1 |
| 3 | Filters, marks, keeps (5 min) | in control, not rushed | DR4, DR6, DR7 |
| 4 | Saves picks | needs to know it is not done yet | DR8 panel |
| 5 | Runs apply in the terminal | cautious, then relieved | F3 (plan and confirm), DR8 command |
| 6 | Re-opens the report | wants proof | DR8 since-last-scan strip |
| 7 | Weeks later misses a skill | worried, then reassured | DR8 Archived restore commands |

- **Before Save:** the Picks tab shows the picks grouped by removal method (as the prototype does) and a line "Projected after apply: 41 → 12 skills pushed out · 7.4k → 0.3k chars per session start". The word "Projected" is always present.
- **Save my picks** downloads the file. The panel then stays open on the Picks tab until marks change: "Picks saved to your downloads folder. Nothing has changed yet." followed by step 1 `npx packlight apply` [Copy] and step 2 "Then run `npx packlight report` to see the result" [Copy]. A short confirmation ("Saved packlight-picks-2026-10-07T13-40-12Z.json") may also appear, but the panel is the record. The floating picks bar on Items shows "Saved, not applied" until marks change.
- **The CLI** prints the same two lines at the end of `scan` and `apply`, word for word, so the page and the terminal tell one story.
- **After apply and a new report:** a strip directly under the hero reads "Since the 7 Oct scan: hook chars per session start 7.4k → 0.3k · 38 items archived". The pushed-out count shows "41 → 12 predicted" until a newer session's budget warning confirms it, then "41 → 12" (E12). The strip appears only when an earlier scan exists, and it can be dismissed for that scan.
- **Archived tab:** each row shows what was archived, when, by which method, and `npx packlight restore <id>` [Copy]. A **Copy restore-all command** button sits at the top. Manual items sit under "Waiting for you" (DR5).

### DR9: identity and copy rules

- **Masthead:** "packlight" (weight 650, 17 px) at the left, followed by the project switcher "essent-hq ▾", "Claude Code" and "scanned 7 Oct 2026". No logo glyph, no badge, no "Live" indicator, no sync dot. The `<title>` is "packlight: essent-hq, 7 Oct 2026".
- **Headings are findings or say what the area holds,** in sentence case: "41 skills pushed out of essent-hq's skill listing", "Picks: not applied yet", "Archived by packlight", "Setup checks". Never "Toolkit Health", "Overview" or "Dashboard".
- **Labels:** sentence case, normal tracking. No uppercase letter-spaced labels anywhere, including table headers.
- **Buttons name their action:** "Save my picks", "Copy command", "Review the 41", "Mark plugin…", "Bring them over". No "Submit", "OK" or "Done". The action keeps its name through the flow: Save my picks → "Picks saved".
- **Evidence words:** "not observed in N sessions" (never "unused" or "never used"), "usage ambiguous", "Unavailable", "est." on every token figure, "Projected" before apply, "predicted" until confirmed (DR8).
- **Do not port from Ledger v5 (DR9):** "Toolkit Health.", `.label` uppercase style, "Live marks", the sync dot and side-foot, the `--glow` gradients, the 40 px frame shadow, the Google Fonts link, `fetch('data.json')`, `window.claude` storage, "Select all suggested", the verdict filters and "Best/Worst rated" sorts (v0.2 only, DR6), and the "Archive candidates" panel.

### DR10: tokens and type (the report's design system; no separate DESIGN.md)

**Fonts** (no downloads; CSP unchanged)
- UI: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`
- Mono, only for paths, commands and ids: `ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace`
- `font-variant-numeric: tabular-nums` on every number. `font-optical-sizing: auto`.

**Type scale (px / line-height / weight / tracking)**

| Role | Size | LH | Weight | Tracking |
|---|---|---|---|---|
| Hero finding | 30 | 1.15 | 650 | -0.02em |
| Tab title, section heading | 22 | 1.25 | 600 | -0.01em |
| Explanatory prose, banners, empty states | 16 | 1.5 | 400 | 0 |
| Table cells, controls, masthead meta | 14 | 1.45 | 400 / 500 | 0 |
| Table headers, tags, secondary meta | 13 | 1.4 | 500 | 0 |
| Footnotes only (never data or labels) | 12 | 1.4 | 400 | +0.01em |

Space above a heading is at least twice the space below it. Spacing scale: 4, 8, 12, 16, 24, 32, 48.

**Colour tokens** (light / dark; carried from v5, with glow and decorative shadow removed)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #ffffff | #121317 | page (one surface, DR2) |
| `--bg-2` | #f6f7f8 | #1a1c21 | expanded rows, code boxes, hover |
| `--ink` | #111318 | #eef0f3 | primary text |
| `--ink-2` | #535b67 | #aab1bc | secondary text (≥ 4.5:1 on `--bg` and `--bg-2`) |
| `--ink-3` | #9aa1ab | #6b7280 | non-text only: rules, the bar's track, disabled outlines |
| `--line` | #e6e8eb | #262a31 | hairlines |
| `--accent` | #111318 | #eef0f3 | primary button fill, focus ring |
| `--green` / `--green-soft` | #15803d / #e9f7ee | #34d070 / #13261b | Keep, "listed", healthy |
| `--amber` / `--amber-soft` | #b45309 / #fff4e0 | #f5b14b / #2e2414 | estimates, partial data, hook cost |
| `--red` / `--red-soft` | #b91c1c / #fdecec | #f87171 / #2f1a1a | Archive marks, pushed-out segment |

Text colours on soft fills meet 4.5:1. The green, amber and red text values are darkened from v5 for that reason. `prefers-contrast: more` raises `--ink-2` to `--ink` and `--line` to `--ink-3`.

**Radius and depth:** 6 px for controls and tags, 8 px for the code box and popovers. No other radii. One shadow token, `0 2px 8px rgba(0,0,0,.12)`, used only for the floating picks bar and popovers.

**Browser surfaces:** `::selection` uses `--red-soft` / `--ink`. The focus ring is a 2 px `--accent` outline with a 2 px offset on every interactive element. `accent-color: var(--accent)`, `caret-color: var(--accent)`, `color-scheme: light dark`. Scrollbars use `scrollbar-color: var(--ink-3) transparent`. Links are underlined with a 0.15em offset, and visited links use `--ink-2`.

**Motion:** only in answer to an action. Row expand takes 120 ms ease-out on height or opacity, and the picks bar slides 160 ms ease-out. Both become an instant change under `prefers-reduced-motion`. No entrance animations.

### DR11: widths

| Width | Layout |
|---|---|
| ≥ 1100 px | Content max-width 1200 px, centred. Masthead on one line, tabs below it. Full per-kind tables (DR4). |
| 720-1099 px | Same structure. Tables drop "source" into the expanded row. The hero's two action buttons sit under their sentences, not beside them. |
| < 720 px (tested at 400) | The masthead wraps to two lines: "packlight" plus the project switcher, then agent and date. Tabs form one horizontally scrollable row with the active tab kept in view. The budget bar stays full width, with its sentence below. The totals strip wraps. Search stays visible, and the kind filter, sort and Suggested fold into one **Filters (n)** button that opens a sheet. Each row becomes two lines. Line 1: mark control, name, kind tag. Line 2: the kind's key number (chars per session; firings for hooks; items inside for plugins) and last observed. Everything else is in the expanded row. The floating picks bar shows only "12 marked" and **Review picks**. Commands in code boxes wrap (`overflow-wrap: anywhere`) and keep their Copy button. Every target is at least 44 × 44 px. Bottom padding equals the picks bar height plus the safe-area inset. |

No horizontal page scroll at any width from 320 px up, checked at 400, 720 and 1280 px in Playwright.

### DR12: accessibility contract

- **Structure:** `<header>` (masthead), `<nav>` with `role="tablist"` (tabs as `role="tab"` with `aria-selected`; tab panels as `role="tabpanel"`), `<main>`. One `<h1>` per tab panel (the hero finding on Items). Tables use `<th scope="col">`. Sort state is shown with `aria-sort`.
- **Controls are real buttons,** never clickable rows. The row disclosure is a `<button aria-expanded aria-controls>`, and the marks are `<button aria-pressed>` pairs (DR7). **Mark plugin…** opens a disclosure, not a modal, and its impact line is read before the confirm button.
- **Keyboard:** Tab and Shift-Tab follow the visual order. Arrow keys move between tabs. `/` focuses search. Esc closes the Filters sheet and any disclosure, returning focus to the control that opened it. Enter or Space activate everything. No keyboard trap.
- **Announcements:** one polite live region announces "Marked vercel for archive, 14 items", "Kept learn", "Picks saved, not applied yet", "Copied command" and filter results ("38 items shown").
- **Visible state:** the focus ring per DR10. Marks carry text labels, not only colour. The budget bar has its text equivalent (DR1). All text meets 4.5:1 (DR10 tokens), and controls and the bar's segments meet 3:1 against their neighbours.
- **Preferences:** honours `prefers-reduced-motion`, `prefers-contrast: more` and `prefers-color-scheme`. Text resizes to 200% without loss.
- **Tests:** `@axe-core/playwright` with zero violations on each tab in light and dark. Keyboard-only marking and saving end to end. Live-region text asserted for mark, keep and save.

### DR13: units

- Every cost column and the hero show **measured characters**: "7.4k chars", "140 chars per tool call". One unit per column, never mixed.
- A token estimate appears only as secondary text in the expanded row ("≈ 1.9k tokens (est.)", chars ÷ 4) and as the cell's `title`. It is never the only place a number is shown, since hover does not exist on touch. Hooks never show tokens.
- This supersedes the spec's "Tokens are shown as an estimate" for display. The inventory field stays `standingChars`.

### DR14: projects in one report

- One `report.html` holds the global items once, plus each project's own items. It opens scoped to the project `packlight` ran in (cwd). If cwd is not a known project, it opens on "All projects".
- The masthead switcher lists "All projects" and each project seen in the logs, with its session count. Switching re-scopes the hero, the totals strip and the inventory, updates the URL hash (`#project=essent-hq`) so reloads keep it, and is announced in the live region (DR12).
- "All projects" shows global items plus a "projects" column (how many projects each item is used in). The budget bar is hidden there, since the listing budget is per session and so per project. The hero reads "Pick a project to see its listing budget", with the five largest projects as buttons.
- Marks are one set across projects, keyed by item id. A project item marked in one project appears in Picks with its project named.
- Size: the 2 MB budget holds at 500 global items plus 20 projects × 50 project items. A Playwright fixture checks it.

### DR15: the which-one card (v0.2, from groups.json)

```
 ┌ These compete: keep one ─────────────────────────────────────────────────────────┐
 │ Both write commit messages from your staged changes.                              │
 │ ┌ commit (personal) ───────────────┐ ┌ git-commit (plugin: commit-tools) ───────┐ │
 │ │ Use when: you want a one-line    │ │ Use when: you want conventional-commit   │ │
 │ │ summary and no prompt            │ │ format and a body                        │ │
 │ │ Example: "commit this"           │ │ Example: "write a conventional commit"   │ │
 │ │ 41 sessions · last 6 Oct         │ │ not observed in 102 sessions             │ │
 │ │ [Keep this one]                  │ │ [Keep this one]                          │ │
 │ └──────────────────────────────────┘ └──────────────────────────────────────────┘ │
 └───────────────────────────────────────────────────────────────────────────────────┘
```
- **Header by type:** duplicate → "Same skill installed twice"; competing → "These compete: keep one"; similar → "Similar: both useful". One plain sentence follows, from groups.json.
- **Member columns** (2-4 side by side; stacked below 720 px): name and source, "Use when…", an example prompt, usage (DR5 wording, ambiguity shown), and its plugin tag if it has one.
- **Actions:** duplicate and competing groups → **Keep this one** on each member, which marks that member Keep and the others Archive. Plugin members follow DR7: the action reads "Keep this one (archives plugin vercel, 14 items)" and asks first. Ambiguous members are never auto-marked; they stay unmarked with a note. Similar groups → **Keep both**, which marks all Keep. Every action is undoable from the same card ("Undo").
- **Privacy:** the example prompt and "use when" come from ratings.json written by the skill. Never from session log text (design-doc concern R3-13).
- This is the one place in the report where a card is the interaction; nowhere else uses cards (DR2).

### Spec corrections from the design review (apply with the CEO and eng corrections before filing issues)
10. "What a user gets" step 2 and "Report (report.html)": replace "one card per item" with DR4. Replace the tab list with DR3. Add "see Design review DR1-DR15".
11. CEO Section 11's state table is superseded by DR5. Its information order is superseded by DR2.
12. "Standing cost": tokens are a secondary estimate in the report (DR13).
13. Acceptance criterion 5 gains: no horizontal scroll at 400, 720 and 1280 px (DR11); zero axe violations per tab in light and dark (DR12); the 2 MB check uses the DR14 fixture.
14. Picks file `action` accepts `"keep"`. `packlight apply` writes `~/.packlight/keeps.json` (DR7; issues 1 and 3).

### NOT in scope (design)
- Visual mockups: the designer has no OpenAI key. Run `design setup`, then `/design-shotgun` with the saved brief, if you want pictures before building.
- A standalone DESIGN.md or a packlight logo mark: DR10 and DR9 are enough for one screen. Revisit if packlight gets a website.
- A first-run tour or onboarding overlay: the DR6 rule text and DR5 banners explain the evidence in place.
- Click-to-act buttons in the report: still out of scope (spec Out of Scope). The page only marks and saves.
- Theme toggle in the page: it follows the OS (`prefers-color-scheme`). No in-page switch in v1.

### What already exists (design)
- Toolkit Ledger v5 (`~/.claude/toolkit-ledger/site/toolkit-ledger.html`). Reuse: the colour tokens (adjusted in DR10), the per-kind icon paths, the escape helper (F4), grouping picks by removal method, and the `.cmd` code box. Do not port: the DR9 list.
- The prototype's `scan.py`, `merge.py` and `finalize.py` produce the data the report renders (ported in issue 1).

### Design implementation tasks
- [ ] **D1 (P1, human: ~1d / CC: ~30min)**: report hero: build the budget bar with listing, estimate, all-fit and Codex states (DR1). Verify: Playwright snapshots of all four states, light and dark.
- [ ] **D2 (P1, human: ~1d / CC: ~30min)**: report structure: masthead, tabs, totals strip, per-kind tables with expandable rows, search, sort, count and clear (DR2-DR4). Verify: Playwright filters and sorts, at 210 and 500 items.
- [ ] **D3 (P1, human: ~4h / CC: ~15min)**: report states: implement the DR5 table with its exact copy. Verify: one Playwright fixture per state row (no logs, parse gaps, damaged data, blocked storage, old-scan marks, empty tabs).
- [ ] **D4 (P1, human: ~2h / CC: ~10min)**: suggestion rule and "Mark all N shown", with the 20-session and 14-day threshold (DR6). Verify: unit test of eligibility; the fixture below the threshold shows the "Too few sessions" text.
- [ ] **D5 (P1, human: ~4h / CC: ~15min)**: marking: Archive/Keep pairs, plugin-level mark with the impact line, ambiguous handling, keeps.json read and write (DR7; issues 1 and 3). Verify: marking a plugin child marks the plugin and every sibling shows "archived with vercel"; a keep survives a re-scan.
- [ ] **D6 (P1, human: ~3h / CC: ~10min)**: hand-off: Next step panel, Projected line, the CLI printing identical lines, the since-last-scan strip, restore commands in Archived (DR8). Verify: Playwright save flow; a CLI snapshot test of the closing lines.
- [ ] **D7 (P1, human: ~2h / CC: ~10min)**: tokens and type: CSS variables, scale, browser surfaces, motion, reduced-motion and contrast media (DR10). Verify: a contrast check script over the token pairs; no `font-face`, and CSP unchanged.
- [ ] **D8 (P1, human: ~4h / CC: ~15min)**: widths: two-line rows, Filters sheet, compact picks bar, 44 px targets (DR11). Verify: Playwright at 320, 400, 720 and 1280 px, no horizontal scroll.
- [ ] **D9 (P1, human: ~3h / CC: ~10min)**: accessibility contract plus `@axe-core/playwright` (DR12). Verify: zero axe violations per tab in light and dark; keyboard-only mark and save; live-region assertions. Manual: one VoiceOver (macOS) and one NVDA (Windows) pass before v0.1 is tagged.
- [ ] **D10 (P2, human: ~1h / CC: ~5min)**: copy rules and the do-not-port list applied; units as chars with secondary est. (DR9, DR13). Verify: a grep test that the built HTML contains no "unused", "Toolkit Health", uppercase-label CSS or "tok" in column headers.
- [ ] **D11 (P2, human: ~4h / CC: ~15min)**: project switcher in one file, hash state, "All projects" view, size fixture (DR14). Verify: Playwright switch and reload keeps the project; 2 MB at 500 + 20×50.
- [ ] **D12 (P2, v0.2, human: ~4h / CC: ~15min)**: which-one cards by group type with actions and undo (DR15). Verify: fixtures for duplicate, competing and similar; a plugin member asks first; ambiguous members stay unmarked.
- [ ] **D13 (P2, human: ~30min / CC: ~5min)**: apply spec corrections 10-14 above before filing issues.


### Completion summary (design)

```
  +====================================================================+
  |         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
  +====================================================================+
  | System Audit         | no DESIGN.md; UI scope = report.html (4-5 tabs) |
  | Step 0               | 4/10; all 7 passes (D1)                     |
  | Pass 1  (Info Arch)  | 3/10 → 9/10 after fixes (DR1-DR4)           |
  | Pass 2  (States)     | 3/10 → 9/10 after fixes (DR5, DR6)          |
  | Pass 3  (Journey)    | 4/10 → 9/10 after fixes (DR7, DR8)          |
  | Pass 4  (AI Slop)    | 3/10 → 9/10 after fixes (DR2, DR9)          |
  | Pass 5  (Design Sys) | 2/10 → 9/10 after fixes (DR10)              |
  | Pass 6  (Responsive) | 2/10 → 9/10 after fixes (DR11, DR12)        |
  | Pass 7  (Decisions)  | 3 resolved (DR13-DR15), 0 deferred          |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (5 items)                           |
  | What already exists  | written                                     |
  | TODOS.md updates     | 0 items proposed                            |
  | Approved Mockups     | 0 generated (designer has no OpenAI key)    |
  | Decisions made       | 15 added to plan (DR1-DR15)                 |
  | Decisions deferred   | 0                                           |
  | Overall design score | 2/10 → 9/10                                 |
  +====================================================================+
```
Remaining point per pass: P1 narrow navigation covered by DR11; P2 and P3 first-run explanation left to in-place copy; P4 typeface is native by choice (DR10); P5 no standalone DESIGN.md; P6 needs a manual VoiceOver/NVDA pass (task D9). Plan is design-complete. Run /design-review on the built report for visual QA.

## Eng review, design delta (/plan-eng-review, 2026-10-08)

Target: ~/.claude/toolkit-ledger/packlight-SPEC.md, the design-review additions only (DR5 mark carry-over, DR6 suggestions, DR7 Keep and keeps.json, DR8 CLI lines, DR12 axe dependency, DR14 one-file projects). Earlier eng decisions SC1, SC2, A1, A2, Q1, T1 and X1-X5 stand unchanged.

### Scope record
feature answers: none asked (fewer than 8 files, one new module: src/core/keeps.ts); structure: not asked; accepted scope: design delta as approved in DR5-DR14; pending remedies: DE1. Scope Challenge result: scope accepted as-is.

### Decision ledger (delta)

### DE1: Usage scope for global items in a project view
Finding: Section 1, P1, confidence 9/10, packlight-SPEC.md DR6 ("Eligibility: not observed in the scan") and DR14 ("Switching re-scopes the hero, the totals strip and the inventory"), reviewer: native eng review.
Plan baseline: DR6 (design D8) and DR14 (design D16) approved; neither says whether a global item's usage in a project view counts only that project or all projects.
Runtime evidence: unknown (no code yet). Archiving a global item is global (spec removal methods), so a project-scoped "not observed" can suggest removing a skill used daily in another project.
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| DE1 usage counted for global items in a project view | unspecified, pending | all projects; the row shows "used in 3 other projects" | this project only; a "used elsewhere" warning on marking |
| Suggestion eligibility (DR6) | approved D8 rule | unchanged rule, applied to all-project usage for global items | unchanged rule, applied to project usage, plus the warning |
| Project items (only load in their project) | per project | unchanged: their own project's usage | unchanged |
| Hero "archiving the N not observed brings M back" | DR1 | counts only items eligible under A | counts B's items |
| Tests | none | unit: global skill used only in project B is not suggested in project A's view | unit: the warning appears when marking it in A |

Question D1:
D1 — In a project view, does "not observed" count use from all projects or only this one?
Project/branch/task: packlight plan, design delta (DR6 suggestions + DR14 project switcher); report.html and src/core suggestion logic.
ELI10: Global skills load in every project, so archiving one removes it everywhere. The design lets you switch the report to one project. If a global skill is only used in project B, project A's view would see "not observed" and suggest archiving it, and B would lose it. Option A counts a global item's use across all projects, while project-only items keep their own project's count.
Stakes if we pick wrong: the report suggests removing a skill you use every day in another repo, and the bulk "Mark all shown" button makes that a one-click mistake.
Recommendation: A because the count must match the reach of the action: global archive, global evidence.
Completeness: A=10/10, B=6/10
Pros / cons:
A) Global items use all-project usage (recommended)
  ✅ A global skill used anywhere is never suggested; its row says "used in 3 other projects" in a project view
  ✅ Same rule feeds the hero's "archiving N brings M back", so the projection stays honest
  ❌ A project view can show a global skill as "used" though it never fires in that project (human: ~2h / CC: ~10 min)
B) Project-only usage, warn when marking
  ✅ The view answers "what does this project actually use" literally
  ✅ Simple: one usage number per view
  ❌ Suggestions and Mark all shown still pick globally used skills; the warning arrives after the bulk mark
Net: A ties the evidence to the blast radius of the action; B shows a literal per-project view and relies on a warning.
Header: Usage scope
Options:
A) Global usage for global items (recommended)
In a project view, global items count usage across all projects (row shows "used in N other projects"); project items use their project's usage; DR6 rule and the hero projection use these counts; unit test that a global skill used only in project B is not suggested in A. (human: ~2h / CC: ~10 min)
B) Project usage plus a warning
Every item counts only the viewed project's usage; marking a global item used elsewhere shows "used in N other projects"; suggestions unchanged; unit test for the warning. (human: ~1h / CC: ~5 min)

State: approved
Actual answer: A) "Global usage for global items" (eng delta D1, 2026-10-08)
Accepted scope: in a project view, global items count usage across all projects and show "used in N other projects"; project items use their own project's usage; the DR6 suggestion rule and the DR1 hero projection use these counts; unit test: a global skill used only in project B is not suggested in project A's view.
History: none

### DE2: What a Keep is tied to
Finding: Section 1, P2, confidence 8/10, packlight-SPEC.md DR7 ("`packlight apply` records keeps in `~/.packlight/keeps.json` (id plus fingerprint, X1) … A kept item whose fingerprint changes loses its keep and is shown as new"), reviewer: native eng review.
Plan baseline: DR7 (design D9) approved Keep as a persistent mark; the id-plus-fingerprint key is an implementation detail written in DR7's spec text, not a separately asked choice.
Runtime evidence: X1 targetFingerprint hashes folder contents. In this session gstack auto-upgraded 1.91.32 → 1.91.33 → 1.91.34 within two days, rewriting SKILL.md and sections files, so every gstack skill's fingerprint changed twice.
Comparison grid:

| Choice | Current | A | B | C |
|---|---|---|---|---|
| DE2 keep key | id + targetFingerprint (DR7 text) | item id only (A1/X5) | id + descHash | unchanged: id + targetFingerprint |
| When a keep is dropped | any content change | only when the id disappears from a scan | when the description changes | any content change |
| Row tag after an update | "new" | "kept 7 Oct · updated since" | "kept 7 Oct" until the description changes | "new" |
| Apply's X1 refusal for archive picks | approved X1 | unchanged | unchanged | unchanged |
| Tests | none | unit: keep survives a file change, dropped when id gone | unit: survives a file change, dropped on description change | unit: dropped on file change |

Question D2:
D2 — Should a Keep survive when the kept skill is updated?
Project/branch/task: packlight plan, design delta DR7 (Keep marks, ~/.packlight/keeps.json).
ELI10: When you mark an item Keep, packlight stops suggesting it. The design ties a Keep to a fingerprint of the item's files, so any update wipes the Keep. gstack updated itself twice in the last two days, which would wipe every Keep on its 50 skills and put the unused ones back in the suggestions. Option A ties a Keep to the item itself, so it lasts until the item is uninstalled.
Stakes if we pick wrong: users re-mark the same skills after every plugin update and stop trusting Keep.
Recommendation: A because a Keep records a decision about the tool, not about a particular version of its files.
Completeness: A=9/10, B=8/10, C=6/10
Pros / cons:
A) Keep follows the item id (recommended)
  ✅ Survives updates; dropped only when a scan no longer finds that id (uninstalled or renamed)
  ✅ Row shows "kept 7 Oct · updated since", so a big change is still visible without undoing the Keep
  ❌ If a skill changes what it does under the same name, the old Keep still hides it from suggestions
B) Keep follows id + description
  ✅ Survives file edits but resets when the description, the part you judged, changes
  ✅ Matches how ratings re-run (descHash, Q1)
  ❌ Plugins that tweak descriptions each release still reset Keeps now and then
C) Keep as designed: id + full fingerprint
  ✅ Strictest: any change asks you to look again
  ✅ No extra rule; reuses X1 directly
  ❌ Every update resets Keeps; with daily-updating plugins Keep is close to useless
Net: A treats Keep as a lasting decision; B re-asks when the description changes; C re-asks on every update.
Header: Keep scope
Options:
A) Keep follows the item id (recommended)
keeps.json stores the item id (A1/X5) and the date; a keep is dropped only when a scan no longer finds that id; rows show "kept <date> · updated since" when the fingerprint changed; X1 apply refusal unchanged; unit test: keep survives a file change and is dropped when the id disappears. (human: ~1h / CC: ~5 min)
B) Keep follows id + description
keeps.json stores id and descHash; a keep is dropped when the description changes or the id disappears; X1 unchanged; unit test for both. (human: ~1h / CC: ~5 min)
C) Keep as designed (id + fingerprint)
keeps.json stores id and targetFingerprint; any content change drops the keep and the row shows "new"; unit test for the drop. (human: ~1h / CC: ~5 min)

State: approved
Actual answer: A) "Keep follows the item id" (eng delta D2, 2026-10-08)
Accepted scope: keeps.json stores the item id (A1/X5) and the keep date; a keep is dropped only when a scan no longer finds that id; rows show "kept <date> · updated since" when the fingerprint changed; X1 apply refusal for archive picks unchanged; unit test: a keep survives a file change and is dropped when the id disappears. Supersedes DR7's "id plus fingerprint" wording.
History: none

### DE3: How apply writes keeps
Finding: Section 1, P2, confidence 8/10, packlight-SPEC.md acceptance criterion 7 ("`apply` with no `--yes` asks once per method group and changes nothing on 'no'") and DR7 ("`packlight apply` records keeps in `~/.packlight/keeps.json`"), reviewer: native eng review.
Plan baseline: criterion 7 and X3 (eng D10) cover archive groups and the journal; keep writing is unspecified.
Runtime evidence: unknown (no code). keeps.json lives under ~/.packlight and changes nothing in the agent's setup.
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| DE3 confirmation for keeps | unspecified | none: keeps are listed in the plan and written after the archive groups | its own "Keep N items?" prompt like a method group |
| Journal (X3) for keeps | unspecified | not journaled; written with write-file-atomic (SC2); logged in packlight.log | not journaled; same write |
| Keep-only picks file | unspecified | apply writes keeps, prints "Kept 3 items. Nothing archived.", no prompt | apply asks once, then writes |
| Stale scanId refusal (F3) | approved: whole file refused | unchanged | unchanged |
| "no" to an archive group | changes nothing for that group (criterion 7) | unchanged; keeps in the same file are still written | unchanged; keeps follow their own answer |
| Tests | none | integration: keep-only picks writes keeps with no prompt; "no" to all groups still writes keeps | integration: keep prompt "no" writes nothing |

Question D3:
D3 — Should saving Keeps need a yes/no prompt during apply?
Project/branch/task: packlight plan, design delta DR7; src/archive/apply.ts and src/core/keeps.ts.
ELI10: `packlight apply` asks "yes or no" before each kind of removal, because removals change your setup. A Keep changes nothing on your machine; it only tells packlight to stop suggesting that item. The plan doesn't say whether Keeps also get a prompt, or what happens if your picks file holds only Keeps. Option A writes Keeps without asking and says so in the plan it prints.
Stakes if we pick wrong: either users answer a pointless extra prompt every time, or a Keep is silently dropped because they said no to an unrelated archive group.
Recommendation: A because prompts should guard changes to the user's setup, and a Keep makes none (explicit over clever).
Completeness: A=9/10, B=8/10
Pros / cons:
A) No prompt for keeps (recommended)
  ✅ The printed plan lists "Keep: 3 items (no change to your setup)"; they are written after the archive groups
  ✅ A keep-only picks file finishes with "Kept 3 items. Nothing archived." and no question
  ❌ Saying "no" to every archive group still records the keeps, which some may not expect (human: ~1h / CC: ~5 min)
B) Keeps get their own prompt
  ✅ Every write apply makes is confirmed, one simple rule to explain
  ✅ A user who changed their mind can drop keeps at the prompt
  ❌ One more question per apply for a change with no effect on the setup (human: ~1h / CC: ~5 min)
Net: A asks only where your setup changes; B asks about everything.
Header: Keep writes
Options:
A) No prompt for keeps (recommended)
apply lists keeps in its printed plan as "no change to your setup", writes ~/.packlight/keeps.json with write-file-atomic after the archive groups (not journaled, logged in packlight.log); keep-only picks files run without prompts; F3 stale-scan refusal unchanged; integration tests for keep-only picks and for "no" to all archive groups. (human: ~1h / CC: ~5 min)
B) Keeps get their own prompt
apply asks "Keep N items?" as its own group; "no" writes no keeps; same atomic write and log; F3 unchanged; integration test for the "no" answer. (human: ~1h / CC: ~5 min)

State: approved
Actual answer: A) "No prompt for keeps" (eng delta D3, 2026-10-08)
Accepted scope: apply lists keeps in its printed plan as "no change to your setup" and writes ~/.packlight/keeps.json with write-file-atomic after the archive groups (not journaled; logged in packlight.log); keep-only picks files run without prompts and end with "Kept N items. Nothing archived."; F3 stale-scan refusal unchanged; integration tests: keep-only picks writes keeps with no prompt, and "no" to every archive group still writes the keeps.
History: none

Section 2 (code quality) note, no choice: DR8 requires the CLI and report next-step lines to match word for word; necessary implementation of design D10 is one module `src/core/messages.ts` used by `src/cli.ts` and `src/report/render.ts` (two proposed callers), plus a snapshot test asserting identical strings.

### DE4: Browsers the mark carry-over is tested in
Finding: Section 3, P2, confidence 6/10 (medium, verify), packlight-SPEC.md DR5 ("Marks from an older scan in storage … Bring them over"), reviewer: native eng review.
Plan baseline: DR5 (design D7) approved the carry-over and the blocked-storage notice; T1 (eng D7) approved Playwright; no browser list.
Runtime evidence: unknown. Browsers scope `file://` storage differently (Firefox defaults to a unique origin per file); not probed here.
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| DE4 Playwright browsers for DR5 storage tests | unspecified | Chromium, Firefox and WebKit | Chromium only |
| Where carry-over fails in a browser | unspecified | that browser shows DR5's "Marks last until you close this page" notice, asserted by the test | untested outside Chromium |
| Other report E2E (DR11, DR12) | Playwright, browser unspecified | unchanged, not decided here | unchanged, not decided here |
| CI cost | n/a | +2 browser installs on one OS (Linux) | none |
| Tests | none | storage carry-over test parameterized by 3 browsers on Linux CI | one Chromium test |

Question D4:
D4 — Test the marks carry-over in Chromium only, or in all three browser engines?
Project/branch/task: packlight plan, design delta DR5 (marks kept between reports); Playwright config in CI.
ELI10: The report remembers your marks in the browser's storage, so a newer report can offer to bring them over. Browsers store data for local files differently: Firefox gives every file its own private space by default, and Safari's engine may differ again. If we only test Chrome, Firefox users could silently lose their marks. Option A runs that one test in Chromium, Firefox and WebKit on Linux CI, and checks that a browser which can't keep marks shows the 'marks last until you close this page' notice instead.
Stakes if we pick wrong: a Firefox or Safari user marks 30 items, regenerates the report, and the marks vanish with no warning.
Recommendation: A because the failure is silent data loss and the extra cost is two browser installs on one CI job.
Completeness: A=10/10, B=6/10
Pros / cons:
A) All three engines for the storage test (recommended)
  ✅ Catches a browser that drops file:// storage and proves it shows the notice instead of losing marks quietly
  ✅ Only this one test fans out across browsers; the browser list for other report tests is not changed by this choice
  ❌ Linux CI installs Firefox and WebKit, about a minute more per run (human: ~1h / CC: ~5 min)
B) Chromium only
  ✅ Fastest CI, one browser to install
  ✅ Chrome-family browsers are most of the likely users
  ❌ Firefox and Safari behaviour stays unknown until a user reports lost marks
Net: A pays a minute of CI to turn an unknown into a tested notice; B accepts the unknown.
Header: Browsers
Options:
A) All three engines for storage (recommended)
The DR5 carry-over test runs in Chromium, Firefox and WebKit on Linux CI; where a browser cannot keep file:// storage, the test asserts the DR5 "Marks last until you close this page" notice; the browser list for other report E2E is not decided here. (human: ~1h / CC: ~5 min)
B) Chromium only
The DR5 carry-over test runs in Chromium only; Firefox and WebKit behaviour untested; the browser list for other report E2E is not decided here. (human: ~15 min / CC: ~2 min)

State: approved
Actual answer: A) "All three engines for storage" (eng delta D4, 2026-10-08)
Accepted scope: the DR5 carry-over Playwright test runs in Chromium, Firefox and WebKit on Linux CI; where a browser cannot keep file:// storage, the test asserts the DR5 "Marks last until you close this page" notice; the browser list for other report E2E is not decided here.
History: grid and options revised before asking to remove an unapproved shared value ("other report E2E stays Chromium-only"). Reopened after the Codex outside voice; the current scope is in "DE4 (reopened)" below (D9).

Section 4 (performance) note, no choice: P3, confidence 5/10 (estimate, unmeasured): DR14 at 500 global + 20×50 project items is about 1.1 MB; with every description at the 1,536-char listing cap it could reach about 2.7 MB, which only slows first load (DR5 first paint covers it). No remedy proposed; the DR14 fixture remains the check.

### Outside voice (delta): codex gpt-6-astra, completed
7 findings (5 High/Medium choices, 2 corrections). Prompt held the delta (DR5-DR8, DR12-DR15, DE1-DE4) with DR9-DR11 omitted as visual-only; 28.7 KB, not truncated.
- Correction (no behavior change), Codex "download-to-apply connection is unspecified": already specified. Spec CLI table: `packlight apply [picks.json]` "Defaults to the newest picks file in ~/Downloads"; Section 4 edge cases: "clicked twice: second file newer; apply uses newest, same scanId" and "browser saves to a non-default folder: apply asks for a path".
- Correction under D2's approved scope, Codex "DE2 removes the evidence for its own 'updated since' label": keeps.json also stores the targetFingerprint captured at keep time, as comparison data only (not part of the key); the "updated since" tag compares it with the current scan. Necessary implementation of D2's approved tag.

### DE5: Suggestion window starts when the item was installed
Finding: Outside voice (codex), High, confidence 8/10, packlight-SPEC.md DR6 ("Eligibility: not observed in the scan; the scan covers at least 20 sessions **and** at least 14 days"), reviewer: codex.
Plan baseline: DR6 (design D8) threshold counts the whole scan; DE1 (eng delta D1) sets global usage for global items.
Runtime evidence: unknown (no code). A skill installed yesterday has had at most a day of sessions, yet the scan-wide threshold already passes on older sessions.
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| DE5 window per item | whole scan (DR6) | sessions and days since the item was first seen (install time: folder birth/mtime, plugin installedAt, or first scan that listed it, whichever is known earliest) | unchanged: whole scan |
| Threshold numbers | 20 sessions, 14 days | unchanged numbers, counted inside the item's window | unchanged |
| Parse gaps in the window | DR5 "may be low" mark | pending (DE6), unchanged here | pending (DE6), unchanged here |
| Row text when too new | none | "Installed 2 days ago: too new to judge" | none |
| Tests | none | unit: item installed 1 day ago never suggested; item installed 30 days ago with no use suggested | none |

Question D5:
D5 — Should the "not observed" rule only count sessions since each item was installed?
Project/branch/task: packlight plan, design delta DR6 (v0.1 suggestion rule); src/core/suggest.ts.
ELI10: The suggestion rule says "not observed in at least 20 sessions over 14 days". But it counts the whole scan, so a skill you installed yesterday already "passes": the 20 sessions happened before it existed. Codex flagged this. Option A starts each item's clock when it was installed. (What to do about unreadable log lines is a separate question next.)
Stakes if we pick wrong: the report suggests archiving the skill you installed this morning, which makes every other suggestion look careless.
Recommendation: A because evidence only counts from when the item could have been used.
Completeness: A=10/10, B=5/10
Pros / cons:
A) Apply this change (recommended)
  ✅ A skill installed this week reads "Installed 3 days ago: too new to judge" and is never suggested
  ✅ Same 20-session and 14-day numbers, now counted where they mean something
  ❌ Install time is fuzzy on some systems (no birthtime on Linux); falls back to mtime or first scan
B) Keep this row's current value
  ✅ No install-time detection to build or test on three OSes
  ✅ The rule stays one line, word for word as printed in DR6
  ❌ Newly installed items qualify for archive immediately
C) Investigate before choosing
  ✅ Confirms the install-time sources per kind before committing to them
  ✅ Nothing changes until the facts are in
  ❌ Leaves the rule open while issue 1 is built; the gap ships if forgotten
D) Defer this proposed change only
  ✅ Keeps today's rule and moves on
  ✅ Can be revisited after real users report it
  ❌ The gap stays listed as unresolved in the report
Net: A ties each item's evidence to the time it existed; B keeps the simpler but wrong rule.
Header: Item window
Options:
A) Apply this change (recommended)
Count the 20-session and 14-day threshold only from each item's first-seen time (folder birth/mtime, plugin installedAt or first listing scan, earliest known); rows say "Installed N days ago: too new to judge"; parse-gap handling not decided here (DE6); unit tests: an item installed 1 day ago is never suggested, one installed 30 days ago with no use is. (human: ~3h / CC: ~10 min)
B) Keep this row's current value
The threshold counts the whole scan as DR6 says; no install-time window. (human: none / CC: none)
C) Investigate before choosing
Check, in issue 1, which install-time sources exist per item kind on macOS, Linux and Windows (birthtime, installed_plugins.json fields), then return to this choice; DR6 stays unchanged and this row stays pending. (human: ~2h / CC: ~15 min)
D) Defer this proposed change only
Leave this row unresolved for now; DR6 unchanged; listed under unresolved decisions. (human: none / CC: none)

State: approved
Actual answer: A) "Apply this change" (eng delta D5, 2026-10-08)
Accepted scope: the DR6 threshold (20 sessions and 14 days) counts only from each item's first-seen time (folder birth/mtime, plugin installedAt or first listing scan, earliest known); rows say "Installed N days ago: too new to judge"; parse-gap handling not decided here (DE6); unit tests: an item installed 1 day ago is never suggested, one installed 30 days ago with no use is.
History: options revised before asking: the parse-gap rule was split out as DE6.

### DE6: Unreadable log lines inside an item's window
Finding: Outside voice (codex), High, confidence 7/10, packlight-SPEC.md DR5 ("Some log lines unreadable … Affected usage cells carry a small 'may be low' mark") and DR6 eligibility, reviewer: codex.
Plan baseline: DR5 (design D7) marks counts "may be low"; DR6 (design D8) does not exclude such items; A2 (eng D5) labels unknown log shapes as "usage uncertain"; DE5 (eng delta D5) sets the per-item window.
Runtime evidence: unknown (no code); unreadable-line rates on real logs have not been measured.
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| DE6 suggestion when the item's window has unreadable lines | still suggested, cell marked "may be low" | not suggested; usage reads "uncertain: N unreadable lines" | unchanged: suggested, marked "may be low" |
| Tolerance | none | any unreadable line in a session inside the window excludes the item | n/a |
| Manual marking | allowed | unchanged: allowed, the text stays visible | unchanged |
| DE5 window | approved | unchanged | unchanged |
| Tests | none | unit: an item whose window holds one unreadable session is not suggested | none |

Question D6:
D6 — Should items whose usage window contains unreadable log lines be left out of suggestions?
Project/branch/task: packlight plan, design delta DR5/DR6; src/core/suggest.ts.
ELI10: Sometimes packlight can't read a few lines of a session log, for example after a Claude Code update changes the format. If an item was used in exactly those lines, packlight would count it as not used and might suggest archiving it. Option A stops suggesting any item whose time window includes unreadable lines, and shows "uncertain" on it instead. You can still mark it yourself.
Stakes if we pick wrong: after a log-format change, packlight suggests archiving skills you used, because it could not read the lines that prove it.
Recommendation: A because a suggestion should never rest on lines packlight could not read (evidence over guesses).
Completeness: A=9/10, B=5/10
Pros / cons:
A) Apply this change (recommended)
  ✅ An unreadable session can never turn a used item into a suggested one
  ✅ The row says why: "uncertain: 3 unreadable lines", and manual marking still works
  ❌ After a big log-format change, few or no items are suggested until packlight learns the new format
B) Keep this row's current value
  ✅ Suggestions keep flowing even with a few bad lines
  ✅ The "may be low" mark still warns on each affected row
  ❌ Mark all shown can bulk-mark items whose only evidence is missing lines
C) Investigate before choosing
  ✅ Measure how often unreadable lines occur on real logs before choosing a tolerance
  ✅ No rule change until there is data
  ❌ The rule stays open while issue 1 is built
D) Defer this proposed change only
  ✅ Ship DR6 as written and watch for reports
  ✅ No extra code now
  ❌ Stays listed as unresolved
Net: A trades fewer suggestions after format drift for never suggesting on unreadable evidence.
Header: Parse gaps
Options:
A) Apply this change (recommended)
An item whose DE5 window contains any session with unreadable lines is not suggested; its usage reads "uncertain: N unreadable lines"; manual marking still allowed with the text visible; unit test for exclusion. (human: ~1h / CC: ~5 min)
B) Keep this row's current value
Items stay eligible; affected cells keep the DR5 "may be low" mark. (human: none / CC: none)
C) Investigate before choosing
Count unreadable-line rates on the fixture and the builder's logs in issue 1, then return to this choice; DR5/DR6 unchanged meanwhile. (human: ~1h / CC: ~10 min)
D) Defer this proposed change only
Leave this row unresolved; DR5/DR6 unchanged; listed under unresolved decisions. (human: none / CC: none)

State: approved
Actual answer: A) "Apply this change" (eng delta D6, 2026-10-08)
Accepted scope: an item whose DE5 window contains any session with unreadable lines is not suggested; its usage reads "uncertain: N unreadable lines"; manual marking stays allowed with that text visible; unit test: an item whose window holds one unreadable session is not suggested.
History: split from DE5 before D5 was asked.

### DE7: Suggestions for plugin children are judged at the plugin
Finding: Outside voice (codex), High, confidence 8/10, packlight-SPEC.md DR6 ("Plugin children follow DR7") and DR7 ("Once the plugin is marked, every child row shows 'archived with vercel'"), reviewer: codex.
Plan baseline: DR7 (design D9) makes the plugin the only removal unit; DR6 (design D8) suggests items one by one; nothing says how a suggested child relates to used or kept siblings.
Runtime evidence: unknown (no code). On the builder's machine the Vercel plugin bundles skills, a hook and agents with very different use.
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| DE7 when a plugin child counts as suggested | each child on its own | only if its whole plugin is eligible: every child passes DR6/DE5/DE6, none kept, none ambiguous | unchanged: each child on its own |
| Mark all shown on a suggested child | marks the plugin (DR7) | only reachable when the whole plugin is eligible | marks the plugin even if siblings are used |
| Manual "Mark plugin…" flow | counts by kind (DR7) | unchanged | unchanged |
| Tests | none | unit: a plugin with one used child or one kept child is not suggested, and Mark all shown leaves it unmarked | none |

Question D7:
D7 — Should a skill inside a plugin only be suggested when the whole plugin could go?
Project/branch/task: packlight plan, design delta DR6/DR7; src/core/suggest.ts and the report's Mark plugin flow.
ELI10: You can't archive one skill inside a plugin; packlight has to switch off the whole plugin. Today the rule would suggest an unused skill from a plugin whose other parts you use every day, or one you marked Keep. Clicking "Mark all shown" would then switch off the whole plugin. Option A judges plugin skills at the plugin level: suggested only if everything in the plugin is unused and nothing in it is kept. Marking a plugin by hand works as DR7 already designed.
Stakes if we pick wrong: one bulk click disables a plugin you rely on, including things you explicitly said to keep.
Recommendation: A because a suggestion must be judged on what will actually be removed (blast radius).
Completeness: A=10/10, B=4/10
Pros / cons:
A) Apply this change (recommended)
  ✅ A plugin with any used, kept or ambiguous part is never suggested and never bulk-marked
  ✅ Your Keep on one plugin skill now protects the whole plugin from bulk marking
  ❌ Fewer suggestions: a mostly-unused plugin with one used skill stays installed (human: ~2h / CC: ~10 min)
B) Keep this row's current value
  ✅ More suggestions, each child judged alone
  ✅ No plugin-level rule to build
  ❌ Mark all shown can switch off plugins you use, overriding your own Keeps
C) Investigate before choosing
  ✅ Survey real plugins' child usage first
  ✅ No change meanwhile
  ❌ The bulk-mark risk stays in the plan while issue 2 is built
D) Defer this proposed change only
  ✅ Moves on now
  ✅ Revisit after v0.1 feedback
  ❌ Stays listed as unresolved
Net: A suggests less but never removes something you use; B suggests more and can.
Header: Plugin rule
Options:
A) Apply this change (recommended)
A plugin child counts as suggested only when every child of its plugin passes DR6/DE5/DE6 and none is kept or ambiguous; Mark all shown therefore marks only fully eligible plugins; the manual Mark plugin flow is unchanged (DR7); unit test: a plugin with one used or kept child is not suggested and stays unmarked by Mark all shown. (human: ~2h / CC: ~10 min)
B) Keep this row's current value
Each child is suggested on its own evidence; marking a suggested child marks its plugin per DR7. (human: none / CC: none)
C) Investigate before choosing
Measure, on the builder's machine in issue 1, how many plugins mix used and unused children, then return; DR6/DR7 unchanged meanwhile. (human: ~1h / CC: ~10 min)
D) Defer this proposed change only
Leave unresolved; DR6/DR7 unchanged; listed under unresolved decisions. (human: none / CC: none)

State: approved
Actual answer: A) "Apply this change" (eng delta D7, 2026-10-08)
Accepted scope: a plugin child counts as suggested only when every child of its plugin passes DR6/DE5/DE6 and none is kept or ambiguous; Mark all shown therefore marks only fully eligible plugins; the manual Mark plugin flow is unchanged (DR7); unit test: a plugin with one used or kept child is not suggested and stays unmarked by Mark all shown.
History: options revised before asking: an extra impact-line change was removed (not raised by the finding; DR7 unchanged).

### DE8: Which-one cards whose members share a plugin
Finding: Outside voice (codex), High, confidence 8/10, packlight-SPEC.md DR15 ("**Keep this one** on each member, which marks that member Keep and the others Archive"), reviewer: codex.
Plan baseline: DR15 (design D17) actions; DR7 (design D9) plugin is the only removal unit.
Runtime evidence: unknown (no code). Two competing skills from one plugin cannot be split: archiving one disables both.
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| DE8 "Keep this one" when the members to archive share a plugin with the kept member | marks the others Archive (impossible to carry out) | button disabled; the card says "Both come from commit-tools. packlight can only turn off the whole plugin." and offers Keep both | unchanged |
| Members from different plugins | DR15 + DR7 | unchanged | unchanged |
| Tests | none | unit: competing group inside one plugin renders no Keep this one, shows the sentence and Keep both | none |

Question D8:
D8 — What should a "which one" card do when both competing skills come from the same plugin?
Project/branch/task: packlight plan, design delta DR15 (which-one cards, v0.2).
ELI10: The which-one card offers "Keep this one", which keeps one skill and archives the others. If both skills come from the same plugin, that's impossible: packlight can only turn the whole plugin off, which removes both. Option A disables that button for such cards, says why in one sentence, and leaves "Keep both".
Stakes if we pick wrong: the user clicks "Keep this one", and apply then disables the plugin and removes the skill they chose to keep.
Recommendation: A because the page should never offer an action the CLI cannot carry out (design for trust).
Completeness: A=10/10, B=3/10
Pros / cons:
A) Apply this change (recommended)
  ✅ No button promises a split that cannot happen
  ✅ The sentence tells the user why and what their real choice is (keep both, or archive the plugin from Items)
  ❌ Same-plugin overlaps stay unresolved by packlight; only the plugin author can split them (human: ~1h / CC: ~5 min)
B) Keep this row's current value
  ✅ Every card looks the same
  ✅ No extra rule in the card renderer
  ❌ The click leads to the plugin being disabled, removing the kept skill too
C) Investigate before choosing
  ✅ Count same-plugin overlap groups on real setups first
  ✅ No change meanwhile
  ❌ The broken action stays in the v0.2 plan
D) Defer this proposed change only
  ✅ v0.2 is later; decide then
  ✅ No change now
  ❌ Stays listed as unresolved
Net: A removes an action that cannot work; B keeps it and lets apply surprise the user.
Header: Same plugin
Options:
A) Apply this change (recommended)
When a which-one group's kept member and any member to archive share a plugin, Keep this one is disabled; the card says "Both come from <plugin>. packlight can only turn off the whole plugin." and offers Keep both; members from different plugins unchanged; unit test for the same-plugin card. (human: ~1h / CC: ~5 min)
B) Keep this row's current value
DR15 actions unchanged for same-plugin groups. (human: none / CC: none)
C) Investigate before choosing
Count same-plugin overlap groups on the builder's machine after issue 4, then return; DR15 unchanged meanwhile. (human: ~30 min / CC: ~5 min)
D) Defer this proposed change only
Leave unresolved; DR15 unchanged; listed under unresolved decisions. (human: none / CC: none)

State: approved
Actual answer: A) "Apply this change" (eng delta D8, 2026-10-08)
Accepted scope: when a which-one group's kept member and any member to archive share a plugin, Keep this one is disabled; the card says "Both come from <plugin>. packlight can only turn off the whole plugin." and offers Keep both; members from different plugins unchanged; unit test for the same-plugin card.
History: split from the plugin finding behind DE7.

### DE4 (reopened): Carry-over when storage is isolated, not blocked
Finding: Outside voice (codex), Medium, confidence 7/10, packlight-SPEC.md DE4 accepted scope ("where a browser cannot keep file:// storage, the test asserts the DR5 'Marks last until you close this page' notice"), reviewer: codex. Reopened for new evidence: storage can work inside one page load yet be unreachable from the next report, so the blocked-storage notice never fires and marks vanish silently.
Plan baseline: DE4 (eng delta D4): carry-over test in Chromium, Firefox and WebKit on Linux CI, asserting the notice where storage is blocked. DR5 (design D7) carry-over banner. Spec: the report is always written to ~/.packlight/report.html.
Runtime evidence: unknown (no browser probe run). Whether Firefox and WebKit give a regenerated file at the same path the same storage is unverified.
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| DE4 carry-over source | browser storage only | browser storage, plus saved picks: `packlight report` embeds the marks from the newest picks file for the previous scan (same ~/Downloads lookup as apply), offered by the same DR5 banner | browser storage only |
| Unsaved marks in a browser that isolates file:// storage | lost silently | still lost; the DR5 banner reads "Only marks you saved with Save my picks carry over in this browser" when no stored marks are found but a saved picks file was | lost silently; README notes it |
| Test | 3 engines, asserts notice when blocked | 3 engines, real old-report → new-report transition at ~/.packlight/report.html; asserts saved marks always carry over and stored marks carry over or the banner sentence appears | 3 engines, real old → new transition; asserts stored marks carry over where they do |
| Browsers for other report E2E | not decided | not decided | not decided |

Question D9:
D9 — How should marks survive into a new report when a browser keeps each file's storage separate?
Project/branch/task: packlight plan, design delta DR5/DE4 (marks carried into a regenerated report).
ELI10: We agreed to test mark carry-over in three browsers and show a warning where storage is blocked. Codex spotted a gap. Some browsers don't block storage; they keep it separate per file load, so the new report simply can't see the old marks, and no warning fires. Option A adds a second route that works everywhere: when packlight builds a new report, it reads your last saved picks file and offers those marks back. Marks you never saved may still be lost in those browsers, and the banner says so.
Stakes if we pick wrong: a Firefox user marks 30 items, regenerates the report, and silently loses all of them.
Recommendation: A because saved picks are a file packlight already reads, so carry-over stops depending on how each browser treats local files.
Completeness: A=10/10, B=6/10
Pros / cons:
A) Apply this change (recommended)
  ✅ Marks saved with Save my picks come back in every browser, through the same banner
  ✅ The test exercises the real old → new transition at the fixed report path in all three engines
  ❌ `packlight report` gains one read of ~/Downloads, the same lookup apply already does (human: ~2h / CC: ~10 min)
B) Keep this row's current value
  ✅ No new code path; storage-only as designed, with the test fixed to the real transition
  ✅ README documents the browser limits
  ❌ In isolating browsers every unsaved and saved mark is lost without a warning
C) Investigate before choosing
  ✅ Probe Firefox and WebKit file:// storage at a fixed path first
  ✅ DE4 stays as approved meanwhile
  ❌ The silent-loss risk stays open until the probe runs
D) Defer this proposed change only
  ✅ Moves on now
  ✅ DE4 stays as approved
  ❌ Stays listed as unresolved
Net: A makes saved marks browser-proof for one extra file read; B keeps storage-only and accepts silent loss in some browsers.
Header: Carry-over
Options:
A) Apply this change (recommended)
`packlight report` embeds marks from the newest picks file for the previous scan (same ~/Downloads lookup as apply) and offers them via the DR5 banner; where no stored marks are found but saved picks were, the banner says "Only marks you saved with Save my picks carry over in this browser"; the DE4 test runs the real old → new transition at ~/.packlight/report.html in Chromium, Firefox and WebKit. (human: ~2h / CC: ~10 min)
B) Keep this row's current value
Storage-only carry-over; the DE4 test is changed to the real old → new transition at ~/.packlight/report.html in three engines; README notes that some browsers lose marks. (human: ~1h / CC: ~5 min)
C) Investigate before choosing
Probe Firefox and WebKit file:// localStorage across a regenerated file at the same path, then return; DE4 stays as approved meanwhile. (human: ~1h / CC: ~10 min)
D) Defer this proposed change only
Leave this reopening unresolved; DE4 stays as approved; listed under unresolved decisions. (human: none / CC: none)

State: approved
Actual answer: A) "Apply this change" (eng delta D9, 2026-10-08)
Accepted scope: replaces DE4's D4 scope. `packlight report` embeds the marks from the newest picks file for the previous scan (same ~/Downloads lookup as apply) and offers them through the DR5 banner; where no stored marks are found but saved picks were, the banner reads "Only marks you saved with Save my picks carry over in this browser"; the carry-over Playwright test runs the real old-report → new-report transition at ~/.packlight/report.html in Chromium, Firefox and WebKit on Linux CI, asserting saved marks always carry over and stored marks carry over or the banner sentence appears; browsers for other report E2E not decided here.
History: DE4 approved via D4 (A, "All three engines for storage") with scope: carry-over test in Chromium, Firefox and WebKit on Linux CI, asserting the blocked-storage notice. Reopened after the Codex outside voice.

### DE9: Ratings must match the item they rated before they drive suggestions
Finding: Outside voice (codex), High, confidence 7/10, packlight-SPEC.md DR6 ("the suggestion rule gains 'or rated archive'") and CEO O7 ("re-rate when descHash, usage bucket (unused/rare/regular), overlap group or profile hash changes"), reviewer: codex.
Plan baseline: O7 (CEO D23) re-rate keys; F5 (CEO D17) strict schema with ids from the scan; DR6 (design D8) v0.2 adds "rated archive" to suggestions; DR15 (design D17) which-one actions.
Runtime evidence: unknown (no code). A skill's files can change without its description changing (descHash same), so an old "archive" verdict survives a substantial rewrite.
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| DE9 rating used for suggestions and which-one actions | any schema-valid rating for the id (F5) | only when the rating's recorded targetFingerprint equals the current one; otherwise shown as "rated before an update" and not used for suggestions or Keep this one | unchanged |
| Re-rate keys (O7) | descHash, usage bucket, group, profile hash | unchanged; targetFingerprint added as a key | unchanged |
| ratings.json entry | id, descHash, fields | adds targetFingerprint at rating time | unchanged |
| groups.json | members by id | adds each member's targetFingerprint; a group with any changed member shows "re-run the skill to refresh" and its actions are disabled | unchanged |
| Tests | none | unit: a rated-archive item whose files changed is not suggested; a group with a changed member renders actions disabled | none |

Question D10:
D10 — Should an old rating stop driving suggestions once the rated skill's files change?
Project/branch/task: packlight plan, design delta DR6 (v0.2 "rated archive" suggestions) and DR15 which-one cards; ratings.json and groups.json from the packlight skill.
ELI10: In v0.2 the packlight skill rates items, and a rating of "archive" makes an item a suggestion. Ratings are only redone when the description changes. A plugin can rewrite a skill completely and keep the same description, so an old "archive" rating keeps pointing at something new. Option A stamps each rating with the item's fingerprint, and ignores the rating for suggestions and which-one buttons once the files change, until the skill re-rates it.
Stakes if we pick wrong: the report recommends archiving a rewritten skill on the strength of a verdict about its old version.
Recommendation: A because a verdict should only apply to the version it judged; X1 already uses the same fingerprint for apply.
Completeness: A=10/10, B=5/10
Pros / cons:
A) Apply this change (recommended)
  ✅ A changed item shows "rated before an update" and is not suggested until re-rated
  ✅ Reuses X1's fingerprint, so no new hashing
  ❌ Busy plugins trigger more re-rating runs in the skill, costing the user's agent tokens (human: ~2h / CC: ~10 min)
B) Keep this row's current value
  ✅ Fewer re-rating runs; O7's keys stay as the CEO review set them
  ✅ Usage-based suggestions (DR6) are unaffected either way
  ❌ An outdated archive verdict can drive Mark all shown on a rewritten item
C) Investigate before choosing
  ✅ Measure how often files change without description changes on real plugins
  ✅ O7 stays as is meanwhile
  ❌ v0.2 work starts with the risk open
D) Defer this proposed change only
  ✅ v0.2 is later; decide with real rating data
  ✅ No change now
  ❌ Stays listed as unresolved
Net: A spends some re-rating to keep verdicts tied to what they judged; B keeps re-rating cheap and verdicts possibly stale.
Header: Rating freshness
Options:
A) Apply this change (recommended)
ratings.json and groups.json record each item's targetFingerprint (X1) at rating time; a rating whose fingerprint differs from the current scan reads "rated before an update" and is not used for suggestions or Keep this one; groups with a changed member show "re-run the skill to refresh" with actions disabled; targetFingerprint joins O7's re-rate keys; unit tests for both. (human: ~2h / CC: ~10 min)
B) Keep this row's current value
O7 keys and F5 validation unchanged; ratings drive suggestions while schema-valid. (human: none / CC: none)
C) Investigate before choosing
After issue 1, measure on the builder's machine how many items change files without changing descriptions over two weeks, then return; O7 unchanged meanwhile. (human: ~1h / CC: ~10 min)
D) Defer this proposed change only
Leave unresolved until v0.2 planning; O7 unchanged; listed under unresolved decisions. (human: none / CC: none)

State: approved
Actual answer: A) "Apply this change" (eng delta D10, 2026-10-08)
Accepted scope: ratings.json and groups.json record each item's targetFingerprint (X1) at rating time; a rating whose fingerprint differs from the current scan reads "rated before an update" and is not used for suggestions or Keep this one; groups with a changed member show "re-run the skill to refresh" with actions disabled; targetFingerprint joins O7's re-rate keys so the skill refreshes those ratings; unit tests: a rated-archive item whose files changed is not suggested, and a group with a changed member renders its actions disabled.
History: none

### DE10: Clearing a saved Keep
Finding: Outside voice (codex), Medium, confidence 8/10, packlight-SPEC.md DR7 ("Pressing the active one again clears it") and DE2 accepted scope ("a keep is dropped only when a scan no longer finds that id"), reviewer: codex.
Plan baseline: DR7 (design D9) clears a pending mark in the page; DE2 (eng delta D2) keeps a saved Keep until the id disappears; DE3 (eng delta D3) writes keeps without a prompt.
Runtime evidence: unknown (no code). Leaving an item out of a later picks file cannot mean "un-keep", so a saved Keep has no way to be removed short of editing keeps.json by hand.
Comparison grid:

| Choice | Current | A | B |
|---|---|---|---|
| DE10 removing a saved Keep | none (edit keeps.json by hand) | a kept row shows "Kept 7 Oct" with **Clear keep**; it writes `action: "unkeep"` to the picks file; apply removes the id from keeps.json | unchanged |
| Apply prompt for unkeep | n/a | none, same as keeps (DE3); listed in the printed plan | n/a |
| Picks schema | archive, keep | adds "unkeep" | unchanged |
| Tests | none | integration: unkeep in picks removes the keep; the next scan suggests the item again if eligible | none |

Question D11:
D11 — Add a "Clear keep" action so a saved Keep can be undone from the report?
Project/branch/task: packlight plan, design delta DR7/DE2/DE3 (persistent Keep); picks file schema, report rows, apply.
ELI10: Once a Keep is saved, it lasts until the item is uninstalled (D2). But there's no button to change your mind later. Clicking Keep again only clears an unsaved mark, and leaving the item out of a future picks file doesn't undo anything. Option A adds a "Clear keep" button on kept rows, saved in the picks file like any other mark and applied with no prompt.
Stakes if we pick wrong: the only way to undo a Keep is hand-editing a JSON file, so users avoid Keep or leave stale Keeps forever.
Recommendation: A because every saved decision needs an undo in the same place it was made (agency).
Completeness: A=10/10, B=5/10
Pros / cons:
A) Apply this change (recommended)
  ✅ Kept rows show "Kept 7 Oct · Clear keep"; one click, saved with your picks
  ✅ Applied like keeps (no prompt), so the item can be suggested again on the next scan
  ❌ One more picks action ("unkeep") for the schema, apply and tests (human: ~1h / CC: ~5 min)
B) Keep this row's current value
  ✅ No schema change
  ✅ Keeps stay simple: add only
  ❌ Undo means editing ~/.packlight/keeps.json by hand
C) Investigate before choosing
  ✅ See whether users ever want to undo Keeps in v0.1
  ✅ No change meanwhile
  ❌ Keep ships without an undo
D) Defer this proposed change only
  ✅ Moves on now
  ✅ Can be added in a patch release
  ❌ Stays listed as unresolved
Net: A gives Keep an undo for one more picks action; B leaves undo to a text editor.
Header: Clear keep
Options:
A) Apply this change (recommended)
Kept rows show "Kept <date>" with a Clear keep button that writes action "unkeep" to the picks file; apply removes that id from keeps.json without a prompt (as DE3) and lists it in the printed plan; picks schema gains "unkeep"; integration test: unkeep removes the keep and the item can be suggested again. (human: ~1h / CC: ~5 min)
B) Keep this row's current value
No undo in the report; a saved Keep is removed only when the id disappears or keeps.json is edited by hand. (human: none / CC: none)
C) Investigate before choosing
Watch v0.1 feedback for Keep-undo requests, then return; no change meanwhile. (human: none / CC: none)
D) Defer this proposed change only
Leave unresolved; no change; listed under unresolved decisions. (human: none / CC: none)

State: approved
Actual answer: A) "Apply this change" (eng delta D11, 2026-10-08)
Accepted scope: kept rows show "Kept <date>" with a Clear keep button that writes action "unkeep" to the picks file; apply removes that id from keeps.json without a prompt (as DE3) and lists it in the printed plan; the picks schema gains "unkeep"; integration test: unkeep removes the keep and the item can be suggested again.
History: none

Cross-model tension (delta): 7 Codex findings; 5 became choices answered D5-D11 (DE4 reopened as D9, plugin finding split into DE7/DE8, eligibility finding split into DE5/DE6), 2 were corrections. Codex and the native review agreed on keep semantics (native DE2, Codex "updated since" correction) and storage carry-over (native DE4, Codex reopening); Codex alone raised install-time windows, parse-gap eligibility, plugin-level eligibility, same-plugin which-one cards, rating freshness and Keep undo; native alone raised global usage in project views (DE1) and the keep write path (DE3). No contradictions.

TODOS.md: no TODO proposals (no deferrals in this delta; the packlight repo and its TODOS.md do not exist yet).

Approval readiness: PASS. DE1 (D1 A), DE2 (D2 A), DE3 (D3 A), DE4 (D4 A, reopened D9 A), DE5 (D5 A), DE6 (D6 A), DE7 (D7 A), DE8 (D8 A), DE9 (D10 A), DE10 (D11 A); corrections: picks-file lookup (no behavior change), keep-time fingerprint stored under D2.

### NOT in scope (eng delta)
- Browser list for report E2E other than the carry-over test: not decided here (DE4); Chromium is the working default until someone decides otherwise.
- A hard 2 MB limit: the DR14 fixture is a check, not an enforced cap (Section 4 note).
- Editing keeps.json from the CLI (`packlight keep`/`unkeep` commands): Clear keep in the report covers undo (DE10).

### What already exists (eng delta)
- X1 targetFingerprint: reused for keep-time comparison (D2 correction) and rating freshness (DE9).
- The apply picks lookup in ~/Downloads: reused by `packlight report` for saved-mark carry-over (DE4 reopened).
- write-file-atomic (SC2): reused for keeps.json (DE3).
- `src/core/messages.ts` is new, shared by `src/cli.ts` and `src/report/render.ts` (two proposed callers; Section 2 note).

### Diagrams (eng delta)
```
 suggestion eligibility (DE1, DE5-DE7, DE9)
 item ──► global? ──yes──► usage = all projects (DE1)
   │          └──no──► usage = its project
   ▼
 window = since first seen (DE5) ──► ≥20 sessions and ≥14 days? ──no──► "too new to judge"
   ▼ yes
 unreadable lines in window? ──yes──► "uncertain" (DE6), not suggested
   ▼ no
 observed? ──yes──► not suggested        kept? ──yes──► not suggested
   ▼ no
 plugin child? ──yes──► whole plugin eligible, none kept/ambiguous? ──no──► not suggested (DE7)
   ▼
 v0.2: rated archive counts only if rating fingerprint = current (DE9)
   ▼
 SUGGESTED

 keeps (DE2, DE3, DE10)
 report mark Keep/Clear keep ─► picks.json {keep|unkeep} ─► apply (no prompt) ─► keeps.json {id, date, fpAtKeep}
 scan ─► id gone? drop : fp changed? tag "kept · updated since"
```

### Failure modes (eng delta)
| Path | Realistic failure | Covered by | User sees |
|---|---|---|---|
| Global usage in project view | global skill used only elsewhere looks unused | DE1 unit test | "used in N other projects" |
| Install window | install time unknown on Linux (no birthtime) | DE5 fallback to mtime or first listing scan | "too new to judge" until the window fills |
| Parse gaps | log format change makes lines unreadable | DE6 unit test | "uncertain: N unreadable lines" |
| Plugin suggestion | bulk mark disables a used plugin | DE7 unit test | plugin not suggested |
| keeps.json | write interrupted | write-file-atomic (SC2); keeps are not journaled, worst case the keep is not saved | apply's summary line lists keeps written |
| Carry-over | browser isolates file:// storage | DE4 reopened: saved picks embedded; banner sentence | "Only marks you saved … carry over in this browser" |
| Ratings | plugin rewrites a skill, same description | DE9 unit test | "rated before an update" |
No critical gaps: every path has a test or a visible message.

### Worktree parallelization (eng delta)
| Step | Modules touched | Depends on |
|---|---|---|
| Suggestion rules (DE1, DE5-DE7) | src/core/ | issue 1 scanner |
| Keeps (DE2, DE3, DE10) | src/core/, src/archive/ | issue 3 apply |
| Carry-over and storage tests (DE4) | src/report/, test/e2e | issue 2 report |
| Rating freshness (DE9) | src/core/, skill/ | issue 5 |
Lane A: suggestion rules → keeps (shared src/core). Lane B: carry-over (src/report). Lane C: rating freshness (after issue 5). Launch A + B; C with v0.2. Conflict flag: src/core/ shared by A and C; sequence C after A.

### Implementation tasks (eng delta)
- [ ] **ED1 (P1, human: ~2h / CC: ~10min)**: suggest: global items use all-project usage; project items their own (DE1)
  - Files: src/core/suggest.ts, test/core/suggest.test.ts
  - Verify: unit test, global skill used only in project B not suggested in A
- [ ] **ED2 (P1, human: ~3h / CC: ~10min)**: suggest: per-item window from first-seen time; "too new to judge" (DE5)
  - Files: src/core/suggest.ts, src/adapters/claude-code/inventory.ts
  - Verify: 1-day-old item never suggested; 30-day-old unused item suggested
- [ ] **ED3 (P1, human: ~1h / CC: ~5min)**: suggest: exclude items with unreadable lines in their window (DE6)
  - Files: src/core/suggest.ts
  - Verify: unit test with one unreadable session in the window
- [ ] **ED4 (P1, human: ~2h / CC: ~10min)**: suggest: plugin children only when the whole plugin is eligible (DE7)
  - Files: src/core/suggest.ts, src/report/render.ts
  - Verify: plugin with one used or kept child not suggested; Mark all shown leaves it unmarked
- [ ] **ED5 (P1, human: ~2h / CC: ~10min)**: keeps: id-keyed keeps.json with keep-time fingerprint; "updated since" tag; unkeep (DE2, D2 correction, DE10)
  - Files: src/core/keeps.ts, src/core/picks.ts, src/report/render.ts
  - Verify: keep survives a file change, dropped when id gone; unkeep removes it
- [ ] **ED6 (P1, human: ~1h / CC: ~5min)**: apply: write keeps without prompts after archive groups (DE3)
  - Files: src/archive/apply.ts
  - Verify: keep-only picks, no prompt; "no" to all groups still writes keeps
- [ ] **ED7 (P1, human: ~2h / CC: ~10min)**: report: embed saved picks for carry-over; 3-engine real-transition test (DE4 reopened)
  - Files: src/report/render.ts, src/core/picks.ts, playwright.config.ts, test/e2e/carry-over.spec.ts
  - Verify: Linux CI in Chromium, Firefox, WebKit
- [ ] **ED8 (P2, human: ~30min / CC: ~5min)**: messages: one module for next-step lines (DR8)
  - Files: src/core/messages.ts, src/cli.ts, src/report/render.ts
  - Verify: snapshot test, CLI and report strings identical
- [ ] **ED9 (P2, v0.2, human: ~1h / CC: ~5min)**: which-one: disable Keep this one for same-plugin groups (DE8)
  - Files: src/report/render.ts
  - Verify: unit test for same-plugin card
- [ ] **ED10 (P2, v0.2, human: ~2h / CC: ~10min)**: ratings: fingerprint freshness for ratings and groups; add to re-rate keys (DE9)
  - Files: src/core/ratings.ts, skill/SKILL.md
  - Verify: changed item with archive rating not suggested; changed group's actions disabled

### Completion summary (eng delta)
- Step 0: Scope Challenge — scope accepted as-is
- Architecture Review: 3 issues found (DE1, DE2, DE3)
- Code Quality Review: 1 issue found (DR8 shared copy, carried as required implementation)
- Test Review: diagram produced, 1 gap decision (DE4) plus 15 required tests
- Performance Review: 1 issue found (P3 size estimate, no remedy)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed to user
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex (gpt-6-astra), completed, 7 findings (5 decided D5-D11 incl. one reopening, 2 corrections)
- Parallelization: 3 lanes, 2 parallel / 1 sequential
- Lake Score: 11/11 answers picked the 10/10 option

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | mode: SCOPE_REDUCTION, 0 critical gaps |
| Outside Review | codex (gpt-6-astra) via `/plan-ceo-review`, `/plan-eng-review` (×2), `/plan-design-review` | Independent 2nd opinion | 4 | completed | 31 findings; 31 resolved; 0 unresolved |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | ISSUES OPEN | 6 issues, 0 critical gaps (all resolved by approved remedies D1-D11) |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR | score: 2/10 → 9/10, 15 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** office-hours: codex completed, 0 findings. CEO plan-review: codex completed, 7 findings, all resolved. Eng plan-review (run 1): codex completed, 8 findings, all resolved (plan truncated at 30 KB). Design phase: codex completed, 9 findings, all resolved. Eng plan-review (run 2, design delta): codex completed, 7 findings, all resolved (5 decisions, 2 corrections; prompt 28.7 KB, not truncated).
- **CROSS-MODEL:** In the delta review, native Claude (Opus 5.5) and Codex (gpt-6-astra) agreed on keep semantics and storage carry-over; Codex alone raised install-time windows, parse-gap eligibility, plugin-level eligibility, same-plugin which-one cards, rating freshness and Keep undo; native alone raised global usage in project views and the keep write path. No contradictions.
- **VERDICT:** CEO and Design CLEARED. Eng Review status is issues_open by the counting rule (6 delta issues found, every one resolved by an approved remedy; 0 unresolved, 0 critical gaps); no open choices remain before building. eng review required

NO UNRESOLVED DECISIONS
