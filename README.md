<p>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/packlight-mark-light.svg">
    <img src="docs/brand/packlight-mark.svg" width="72" height="72" alt="">
  </picture>
</p>

# packlight

See what your coding agent carries, keep what you use, archive the rest.

Claude Code loads every skill, agent, hook and MCP server you have installed into every session, used or not. packlight scans your setup and your local session logs, then writes one self-contained report. The report shows:

- how many tokens each session starts with, by source: MCP tool names, the skill listing, hook text, agent descriptions
- which skills are pushed out of Claude Code's skill listing
- how much text each hook injects
- which items were not used in any session since they were installed

Works with **Claude Code** and **Codex**. packlight picks Claude Code when `~/.claude` exists; for Codex, add `--agent codex` (`packlight --agent codex`, `packlight fix --agent codex`). Each tool gets its own report: `~/.packlight/report-claude-code.html` for Claude Code, `~/.packlight/report-codex.html` for Codex. For Codex the headline is measured: Codex logs the input tokens of each session's first request, and packlight reports the median. Codex plugins and MCP servers are switched off in `~/.codex/config.toml`, so packlight lists them with the exact line to change rather than editing that file.

**[See a sample report →](https://cooperism-lab.github.io/packlight/sample/)** (an invented setup, so you can click around before installing).

You mark what to archive. `packlight apply` moves it out reversibly, and `packlight restore` brings it back.

Everything runs locally: no telemetry, and no network calls from the CLI or the report.

## Status

Issues 1 to 3 are built (v0.1 scope). `packlight` scans your setup and opens a report: what every session starts with (MCP tool names per server, the skill listing, MCP instructions, hook text), which skills Claude Code dropped from its listing, what each hook injects, and what was not observed in your sessions. Mark what to archive and press Save my picks; `packlight apply` archives it and `packlight restore` puts it back byte for byte, with a crash-safe journal.

Or skip the marking: `packlight fix` scans again, shows a plan that archives every unused item (none used since it was installed, over at least 20 sessions and 14 days, nothing you kept) with its projected gain, and asks once. It also lists the unused items only you can remove, such as claude.ai synced skills and the Claude app's own plugins.

Needs Node 20 or later. Run it without installing:

```bash
npx packlight-cli                  # Claude Code: scan, write the report and open it
npx packlight-cli --agent codex    # Codex
```

Or install it once, then use the short command:

```bash
npm install -g packlight-cli
packlight
packlight fix
packlight restore --all
```

`npx` always runs the newest version; a global install updates with `npm update -g packlight-cli`.

The spec has been through strategy, design and engineering review.

- [docs/spec.md](docs/spec.md) is the full spec, including every review decision and the implementation tasks.
- [docs/design.md](docs/design.md) is the approved design doc: problem, premises and approach.
- [docs/report-design.md](docs/report-design.md) is the visual system for the report.

Planned releases:

- **v0.1:** scanner for Claude Code, the report, and reversible archive and restore.
- **v0.2:** overlap detection, plus a packlight skill that rates items and writes "which one" cards. This is the public launch.
- **v0.3:** Codex adapter.

## What's new

See [CHANGELOG.md](CHANGELOG.md), or [GitHub Releases](https://github.com/cooperism-lab/packlight/releases) to be told about new versions (Watch › Custom › Releases). `npx packlight-cli` always runs the newest version; a global install updates with `npm install -g packlight-cli`.

## Who made it

Built by Cooper Kao ([cooperism-lab](https://github.com/cooperism-lab)). Issues and pull requests are welcome.

## Licence

MIT © 2026 Cooper Kao
