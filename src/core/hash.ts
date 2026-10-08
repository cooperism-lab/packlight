import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'item';

/**
 * Stable item id (eng A1, extended by X5): readable slug plus 8 hex of a hash over everything that
 * identifies one declaration, including the JSON pointer for settings-file entries.
 */
export function itemId(parts: { agent: string; kind: string; source: string; name: string; path: string | null; pointer?: string }): string {
  const key = [parts.agent, parts.kind, parts.source, parts.name, parts.path ?? '', parts.pointer ?? ''].join('\u0000');
  return `${slug(`${parts.kind}-${parts.name}`)}-${sha256(key).slice(0, 8)}`;
}

/**
 * Content fingerprint (eng X1): a symlink hashes its target string (the link is what packlight moves),
 * a file hashes its bytes, a folder hashes every entry's relative path and content in sorted order.
 */
export function pathFingerprint(path: string): string {
  const h = createHash('sha256');
  const walk = (p: string, rel: string): void => {
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (!st) { h.update(`missing:${rel}\n`); return; }
    if (st.isSymbolicLink()) { h.update(`link:${rel}:${readlinkSync(p)}\n`); return; }
    if (st.isDirectory()) {
      h.update(`dir:${rel}\n`);
      for (const name of readdirSync(p).sort()) walk(join(p, name), rel ? `${rel}/${name}` : name);
      return;
    }
    h.update(`file:${rel}:${st.size}\n`);
    h.update(readFileSync(p));
  };
  walk(path, '');
  return h.digest('hex');
}

export const valueFingerprint = (value: unknown): string => sha256(JSON.stringify(value));
