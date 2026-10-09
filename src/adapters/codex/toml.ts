// A small reader for the parts of Codex's config.toml packlight needs: table headers and simple values.
// It never writes TOML; turning a plugin or MCP server off is a step the person takes (removal method "manual").

export type TomlValue = string | number | boolean | TomlValue[] | null;
export interface TomlTable { path: string[]; values: Record<string, TomlValue>; line: number }

/** Splits a header like `plugins."pdf@openai"` or `mcp_servers.node_repl.env` into its keys. */
export function headerKeys(header: string): string[] {
  const keys: string[] = [];
  let i = 0;
  while (i < header.length) {
    const c = header[i]!;
    if (c === '.' || c === ' ' || c === '\t') { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let key = '';
      while (j < header.length && header[j] !== c) {
        if (c === '"' && header[j] === '\\' && j + 1 < header.length) { key += header[j + 1]; j += 2; continue; }
        key += header[j];
        j++;
      }
      keys.push(key);
      i = j + 1;
    } else {
      let j = i;
      while (j < header.length && header[j] !== '.') j++;
      keys.push(header.slice(i, j).trim());
      i = j;
    }
  }
  return keys;
}

function value(raw: string): TomlValue {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1);
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(x => value(x)) : [];
  }
  return null;
}

/** Every table in the file, in order, with its single-line `key = value` pairs. Multi-line values are skipped. */
export function readToml(text: string): TomlTable[] {
  const tables: TomlTable[] = [{ path: [], values: {}, line: 0 }];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, n) => {
    const t = line.replace(/\s+#.*$/, '').trim();
    if (!t || t.startsWith('#')) return;
    const h = /^\[\s*([^\[\]]+?)\s*\]$/.exec(t);
    if (h) { tables.push({ path: headerKeys(h[1]!), values: {}, line: n + 1 }); return; }
    const kv = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(t);
    if (!kv) return;
    const key = kv[1]!.replace(/^["']|["']$/g, '');
    tables[tables.length - 1]!.values[key] = value(kv[2]!);
  });
  return tables;
}
