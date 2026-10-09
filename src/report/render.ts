import { clientMain } from './client.js';
import type { ReportData } from './model.js';
import { logoSvg } from './logo.js';
import { STYLES } from './styles.js';
import { simulateListing } from './suggest.js';

/** No network at all (acceptance criterion 5): inline style and script only, images only as data: URIs. */
export const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:";

// A tile, so the tab icon reads on light and dark browser chrome alike.
const ICON = 'data:image/svg+xml,' + encodeURIComponent(logoSvg({ ink: '#f4efe0', tile: '#18181b' }));

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
const simulateListing = ${simulateListing.toString()};
(${clientMain.toString()})();
</script>
</body>
</html>
`;
}
