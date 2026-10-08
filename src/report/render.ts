import { clientMain } from './client.js';
import type { ReportData } from './model.js';
import { STYLES } from './styles.js';
import { projectDropped } from './suggest.js';

/** No network at all (acceptance criterion 5): inline style and script only, images only as data: URIs. */
export const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";

const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><path d="M12 6.5V5.5a2 2 0 0 1 4 0v1" fill="none" stroke="#18181b" stroke-width="1.8" stroke-linecap="round"/><path d="M8.5 6.5h11a3.5 3.5 0 0 1 3.5 3.5v11.5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V10a3.5 3.5 0 0 1 3.5-3.5z" fill="none" stroke="#18181b" stroke-width="1.8"/><path d="M5.2 12.5c2.8 1.6 5.7 2.3 8.8 2.3s6-.7 8.8-2.3" fill="none" stroke="#18181b" stroke-width="1.8" stroke-linecap="round"/><rect x="9.5" y="17.5" width="9" height="5" rx="1.6" fill="#2f7a55"/></svg>');

/**
 * JSON that is safe inside a <script> element: "<", ">" and "&" are escaped so no description can close the
 * element or open a comment, and the line separators JavaScript treats as newlines are escaped too (CEO F4).
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const escapeText = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function renderReport(data: ReportData): string {
  const scope = data.scope === 'global' ? 'all projects' : data.scope.split(/[\\/]/).pop() ?? data.scope;
  const title = `packlight: ${scope}, ${new Date(data.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeText(title)}</title>
<link rel="icon" href="${ICON}">
<style>${STYLES}</style>
</head>
<body>
<a class="sr" href="#main">Skip to the report</a>
<div id="app"><noscript>This report needs JavaScript, which runs only inside this file and makes no network requests.</noscript></div>
<div id="live" class="sr" aria-live="polite"></div>
<script id="packlight-data" type="application/json">${scriptSafeJson(data)}</script>
<script>
const projectDropped = ${projectDropped.toString()};
(${clientMain.toString()})();
</script>
</body>
</html>
`;
}
