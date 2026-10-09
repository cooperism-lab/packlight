# packlight

See what your coding agent carries, keep what you use, archive the rest.

Claude Code (and Codex) load every skill, agent, hook and connector you have installed. packlight scans your setup and your local session logs, then writes one self-contained report. The report shows:

- which skills are pushed out of Claude Code's skill listing
- how much text each hook injects
- how many items were not observed in any session

You mark what to archive. `packlight apply` moves it out reversibly, and `packlight restore` brings it back.

Everything runs locally: no telemetry, and no network calls from the CLI or the report.

## Status

Issues 1 to 3 are built (v0.1 scope). `packlight` scans your setup and opens a report: which skills Claude Code dropped from its listing, what each hook injects, and what was not observed in your sessions. Mark what to archive and press Save my picks; `packlight apply` archives it and `packlight restore` puts it back byte for byte, with a crash-safe journal.

Or skip the marking: `packlight fix` scans again, shows a plan that archives every unused item (none used since it was installed, over at least 20 sessions and 14 days, nothing you kept) with its projected gain, and asks once. It also lists the unused items only you can remove, such as claude.ai synced skills and the Claude app's own plugins.

```bash
npm install
npm run build
node dist/cli.js
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
