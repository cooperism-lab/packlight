import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The built output: E2E tests run exactly what ships.
import { packlightPaths } from '../../dist/archive/paths.js';
import { scan } from '../../dist/core/scan.js';
import { buildReport, type ReportData } from '../../dist/report/model.js';
import { renderReport } from '../../dist/report/render.js';
import { buildHome } from '../fixtures/home.js';

export const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script></script><!--';

export interface ReportFixture { dir: string; home: string; project: string; root: string; report: string; regenerate: (now: Date) => Promise<void> }

/** A fixture home with one hostile skill description, scanned and rendered to <home>/.packlight/report.html. */
export async function makeReport(now = new Date('2026-10-01T12:00:00Z'), tweak?: (data: ReportData) => void): Promise<ReportFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'packlight-e2e-'));
  const { home, project } = buildHome(dir);
  const hostile = join(home, '.claude', 'skills', 'hostile');
  mkdirSync(hostile, { recursive: true });
  writeFileSync(join(hostile, 'SKILL.md'), `---\ndescription: "${HOSTILE.replace(/"/g, '\\"')}"\n---\n`);
  mkdirSync(join(home, 'Downloads'), { recursive: true });
  const root = join(home, '.packlight');
  const report = join(root, 'report.html');
  const regenerate = async (at: Date): Promise<void> => {
    const inv = await scan({ home, cwd: project, now: at });
    mkdirSync(join(root, 'scans', inv.scanId), { recursive: true });
    writeFileSync(join(root, 'scans', inv.scanId, 'inventory.json'), JSON.stringify(inv));
    const data = buildReport(inv, packlightPaths(home));
    tweak?.(data);
    writeFileSync(report, renderReport(data));
  };
  await regenerate(now);
  return { dir, home, project, root, report, regenerate };
}
