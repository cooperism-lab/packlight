// Builds the sample report for GitHub Pages: an invented setup (scripts/demo-setup.mts) scanned by the real CLI.
// Output: demo-site/index.html. Paths are rewritten to /Users/demo so nothing about the build machine leaks.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The real path: on macOS /tmp is a link, and a project only matches its sessions by the same spelling.
const root = join(realpathSync('/tmp'), 'packlight-demo');
const run = (cmd: string, args: string[], cwd?: string) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status) process.exit(r.status);
};
run(process.execPath, ['--import', 'tsx', 'scripts/demo-setup.mts', root]);
const home = join(root, 'home');
run(process.execPath, [join(process.cwd(), 'dist', 'cli.js'), '--home', home, '--out', join(root, 'out'), '--no-open'], join(home, 'code', 'ledger-api'));

let html = readFileSync(join(root, 'out', 'report.html'), 'utf8');
for (const p of new Set([realpathSync(home), home])) html = html.split(p).join('/Users/demo');
const banner = '<div style="background:#18181b;color:#f4efe0;font:14px/1.45 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;padding:10px 16px;text-align:center">'
  + 'Sample report: an invented setup, not anyone\'s real data. '
  + '<a href="https://github.com/cooperism-lab/packlight" style="color:#7fdca4">Run packlight on your own setup</a></div>';
html = html.replace('<div id="app">', banner + '<div id="app">').replace(/<title>[^<]*<\/title>/, '<title>packlight: sample report</title>');
if (/\/tmp\/|\/private\/|cooper-kao|cooperkao/i.test(html)) { console.error('The sample still names a build path; refusing to write it.'); process.exit(1); }
mkdirSync('demo-site', { recursive: true });
writeFileSync('demo-site/index.html', html);
writeFileSync('demo-site/.nojekyll', '');
console.log('demo-site/index.html', html.length, 'bytes');
