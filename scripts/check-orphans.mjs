// Usage: node scripts/check-orphans.mjs <absolute path to an html file>
// Finds orphans: a text block whose last line holds a single word.
import { chromium } from '@playwright/test';
const file = process.argv[2];
const b = await chromium.launch();
for (const w of [1280, 1024, 768, 390]) {
  const c = await b.newContext({ viewport: { width: w, height: 900 } }); const p = await c.newPage();
  await p.goto('file://' + file);
  const found = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('h1,h2,p,summary,figcaption,.row b,li p')) {
      if (el.closest('pre')) continue;
      const words = []; const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n; while ((n = walk.nextNode())) { const re = /\S+/g; let m; while ((m = re.exec(n.data))) { const r = document.createRange(); r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length); const rect = r.getClientRects()[0]; if (rect) words.push({ t: m[0], top: Math.round(rect.top) }); } }
      if (words.length < 4) continue;
      const lines = [...new Set(words.map(x => x.top))];
      if (lines.length < 2) continue;
      const last = words.filter(x => x.top === lines[lines.length - 1]);
      if (last.length === 1) out.push(`${el.tagName.toLowerCase()}: "…${last[0].t}"`);
    }
    return out;
  });
  console.log(w, found.length ? found : 'none');
}
await b.close();
