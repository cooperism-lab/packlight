/** Reads `name`, `description` and `model` from a markdown file's YAML frontmatter (simple scalars and folded blocks). */
export function frontmatter(text: string): { name?: string; description?: string; model?: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m?.[1]) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] ?? '');
    if (!kv?.[1]) continue;
    const key = kv[1];
    if (key !== 'name' && key !== 'description' && key !== 'model') continue;
    let value = kv[2] ?? '';
    // Block scalar (| or >) or a value continued on indented lines.
    if (/^[|>][+-]?$/.test(value)) value = '';
    const cont: string[] = [];
    while (i + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[i + 1] ?? '') && !/^[A-Za-z][\w-]*:/.test(lines[i + 1] ?? '')) {
      cont.push((lines[++i] ?? '').trim());
    }
    value = [value, ...cont].join(' ').replace(/\s+/g, ' ').trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\(["\\/])/g, '$1').replace(/\\n/g, ' ');
    else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'");
    out[key] = value;
  }
  return out;
}
