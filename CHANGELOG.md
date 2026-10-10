# Changelog

What changed in each release of packlight. The newest is first. Every release is also on
[GitHub Releases](https://github.com/cooperism-lab/packlight/releases); choose Watch › Custom › Releases there to hear about new ones.

## 0.1.1 (2026-10-10)

- The savings line never shows more than 100% of your setup. Before, a fix plan larger than the measured
  setup could show a share over 100%, in the report and in `packlight fix`.

## 0.1.0 (2026-10-09)

The first release, on npm as `packlight-cli`.

- Measures the tokens each Claude Code and Codex session starts with, split by source: skill listing, MCP tool
  names and instructions, hook text, agent descriptions, CLAUDE.md and AGENTS.md. For Codex the number is measured
  from the input tokens Codex logs.
- Shows which skills, agents, plugins, MCP servers and hooks you used, and which you never did, from your own
  session logs. Runs offline and sends nothing.
- `packlight fix` and the report's Fix it button archive everything unused since it was installed, after one
  question. Items only you can remove (claude.ai connectors, app plugins, Codex config) come with the exact place
  to turn them off.
- `packlight restore` puts archived items back byte for byte. Skills installed by a suite like gstack are never
  archived.
- One report per agent: `report-claude-code.html` and `report-codex.html` in `~/.packlight`.
