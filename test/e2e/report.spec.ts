import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MESSAGES } from '../../dist/core/messages.js';
import { HOSTILE, makeReport, type ReportFixture } from './report-fixture.js';

let fx: ReportFixture;
test.beforeEach(async () => { fx = await makeReport(); });
test.afterEach(() => rmSync(fx.dir, { recursive: true, force: true }));

const open = async (page: Page): Promise<void> => {
  await page.goto(pathToFileURL(fx.report).href);
  await expect(page.getByRole('tab', { name: 'Items' })).toBeVisible();
};

test('makes zero network requests (criterion 5)', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', r => { if (!/^(file|data|blob):/.test(r.url())) requests.push(r.url()); });
  await open(page);
  for (const tab of ['Findings', 'Picks', 'Archived', 'Items']) await page.getByRole('tab', { name: new RegExp(tab) }).click();
  expect(requests).toEqual([]);
  expect(statSync(fx.report).size).toBeLessThan(2 * 1024 * 1024);
});

test('renders a hostile description as text and never runs it (CEO F4)', async ({ page }) => {
  await open(page);
  await page.getByRole('searchbox', { name: /Search/ }).fill('hostile');
  await page.getByRole('button', { name: 'Details for hostile' }).click();
  await expect(page.getByText(HOSTILE, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await page.locator('img[src="x"]').count()).toBe(0);
});

test('leads with the listing budget for the scanned project (DR1)', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText("1 skills pushed out of proj's skill listing");
  await expect(page.getByRole('img', { name: '1 of 3 skills listed without their description' })).toBeVisible();
  await page.getByRole('button', { name: 'Review the 1' }).click();
  await expect(page.getByRole('status').first()).toHaveText('Showing 1 of 13');
});

for (const width of [320, 400, 720, 1280]) {
  test(`has no horizontal scroll at ${width} px (DR11)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`has no axe violations on any tab in ${scheme} mode (DR12)`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    for (const tab of ['Items', 'Findings', 'Picks', 'Archived']) {
      await page.getByRole('tab', { name: new RegExp(tab) }).click();
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map(v => `${tab}: ${v.id} ${v.nodes.map(n => n.target.join(' ')).join(', ')}`)).toEqual([]);
    }
  });
}

test('marks, keeps and saves picks with the keyboard alone, then shows the next steps (DR7, DR8, DR12)', async ({ page }) => {
  await open(page);
  const live = page.locator('#live');
  await page.keyboard.press('/');
  await page.keyboard.type('alpha');
  await page.getByRole('button', { name: 'Archive' }).first().focus();
  await page.keyboard.press('Enter');
  await expect(live).toHaveText('Marked alpha for archive');
  await page.getByRole('searchbox', { name: /Search/ }).fill('beta');
  await page.getByRole('group', { name: 'Mark beta' }).getByRole('button', { name: 'Keep' }).press('Space');
  await expect(live).toHaveText('Kept beta');

  await page.getByRole('tab', { name: /Items/ }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Picks (2)' })).toHaveAttribute('aria-selected', 'true');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save my picks' }).press('Enter');
  const file = join(fx.dir, 'picks.json');
  await (await download).saveAs(file);
  const picks = JSON.parse(readFileSync(file, 'utf8'));
  expect(picks.picks.map((p: { action: string }) => p.action).sort()).toEqual(['archive', 'keep']);
  await expect(page.getByRole('region', { name: 'Next step' })).toContainText(MESSAGES.picksSaved);
  await expect(page.getByRole('region', { name: 'Next step' })).toContainText(MESSAGES.stepReport);
});

test('marks a plugin through one of its skills and shows the full impact first (DR7)', async ({ page }) => {
  await open(page);
  await page.getByRole('searchbox', { name: /Search/ }).fill('kit-a');
  await page.getByRole('button', { name: 'Mark plugin…' }).click();
  await expect(page.getByRole('group', { name: 'Archive kit' })).toContainText('Archiving kit turns off 6 items: 2 skills, 1 command, 1 agent, 1 hook, 1 MCP server.');
  await page.getByRole('button', { name: 'Archive plugin' }).click();
  await expect(page.getByText('archived with kit')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Picks (1)' })).toBeVisible();
});

test('carries marks into a regenerated report @carry', async ({ page }) => {
  await open(page);
  await page.getByRole('searchbox', { name: /Search/ }).fill('gamma');
  await page.getByRole('button', { name: 'Archive' }).first().click();
  await page.getByRole('tab', { name: /Picks/ }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save my picks' }).click();
  const saved = join(fx.home, 'Downloads', (await download).suggestedFilename());
  await (await download).saveAs(saved);

  // A new scan rewrites the report at the same path (eng delta DE4).
  await fx.regenerate(new Date('2026-10-02T12:00:00Z'));
  await page.reload();
  await page.getByRole('tab', { name: /Items/ }).click();
  await expect(page.getByText(/still match this scan/)).toBeVisible();
  await page.getByRole('button', { name: 'Bring them over' }).click();
  await expect(page.getByRole('tab', { name: 'Picks (1)' })).toBeVisible();
});

test('says marks will not survive when the browser blocks storage (DR5)', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  await open(page);
  await expect(page.getByText('Marks last until you close this page (this browser blocks saved marks).')).toBeVisible();
});

test('reads usage as unavailable, never zero, without session logs (DR5)', async ({ page }) => {
  rmSync(join(fx.home, '.claude', 'projects'), { recursive: true, force: true });
  await fx.regenerate(new Date('2026-10-03T12:00:00Z'));
  await open(page);
  await expect(page.getByText(/No session logs at/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Unavailable' }).first()).toBeVisible();
  writeFileSync(join(fx.dir, 'done'), '');
});

test('offers saved picks in a browser that kept no marks (DE4) @carry', async ({ page, browser }) => {
  await open(page);
  await page.getByRole('searchbox', { name: /Search/ }).fill('gamma');
  await page.getByRole('button', { name: 'Archive' }).first().click();
  await page.getByRole('tab', { name: /Picks/ }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save my picks' }).click();
  await (await download).saveAs(join(fx.home, 'Downloads', (await download).suggestedFilename()));

  await fx.regenerate(new Date('2026-10-02T12:00:00Z'));
  // A fresh browser context has empty storage: the marks can only come from the saved picks file.
  const fresh = await browser.newContext();
  const p2 = await fresh.newPage();
  await p2.goto(pathToFileURL(fx.report).href);
  await expect(p2.getByText(/Only marks you saved with Save my picks carry over in this browser/)).toBeVisible();
  await p2.getByRole('button', { name: 'Bring them over' }).click();
  await expect(p2.getByRole('tab', { name: 'Picks (1)' })).toBeVisible();
  await fresh.close();
});
