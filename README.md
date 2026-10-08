# packlight

See what your coding agent carries, keep what you use, archive the rest.

Claude Code (and Codex) load every skill, agent, hook and connector you have installed. packlight scans your setup and your local session logs, then writes one self-contained report. The report shows:

- which skills are pushed out of Claude Code's skill listing
- how much text each hook injects
- how many items were not observed in any session

You mark what to archive. `packlight apply` moves it out reversibly, and `packlight restore` brings it back.

Everything runs locally: no telemetry, and no network calls from the CLI or the report.

## Status

Issue 1 (scanner and Claude Code adapter) is in progress. `packlight scan` inventories skills, commands, agents, hooks, plugins, MCP servers and instruction files. It counts their use from your local session logs and reads Claude Code's own skill listing to see which skills lost their description. The report, archive and restore come in issues 2 and 3.

```bash
npm install
npm run build
node dist/cli.js scan
```

The spec has been through strategy, design and engineering review.

- [docs/spec.md](docs/spec.md) is the full spec, including every review decision and the implementation tasks.
- [docs/design.md](docs/design.md) is the approved design doc: problem, premises and approach.
- [docs/report-design.md](docs/report-design.md) is the visual system for the report.

Planned releases:

- **v0.1:** scanner for Claude Code, the report, and reversible archive and restore.
- **v0.2:** overlap detection, plus a packlight skill that rates items and writes "which one" cards. This is the public launch.
- **v0.3:** Codex adapter.

## Licence

MIT
