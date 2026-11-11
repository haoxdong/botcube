// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { excelOf } from './sheet-excel';

const soffice = spawnSync('soffice', ['--version'], { encoding: 'utf8' }).status === 0;

// Spawns LibreOffice, so it runs where `soffice` is installed (a developer's machine) and is skipped elsewhere, as CI's
// runners have none.
describe.skipIf(!soffice)('a Sheet downloaded as Excel, opened in LibreOffice', () => {
  it('computes the same totals the grid does, and shows the open-ended range as the error it is', async () => {
    const sheet = { edits: [
      { kind: 'writeCells', sheet: 'Budget', topLeft: 'A1', rows: [['Item', 'Cost', 'Done'], ['Rent', 1200, false], ['Food', 300, true], ['Total', '=SUM(B2:B3)', null]] },
      // The User typed 1500 over the rent, as the panel saves it.
      { kind: 'writeCells', sheet: 'Budget', topLeft: 'B2', rows: [[1500]] },
      { kind: 'writeCells', sheet: 'Budget', topLeft: 'E1', rows: [['=SUMIFS(B2:B3,C2:C3,FALSE)', '=SUMIFS(B2:B,C2:C,FALSE)']] },
    ] };
    const folder = await mkdtemp(path.join(tmpdir(), 'sheet-libreoffice-'));
    try {
      await writeFile(path.join(folder, 'budget.xlsx'), new Uint8Array(await (await excelOf(sheet as never)).arrayBuffer()));
      execFileSync('soffice', [
        `-env:UserInstallation=file://${folder}/profile`, '--headless', '--convert-to', 'csv', '--outdir', folder, path.join(folder, 'budget.xlsx'),
      ], { stdio: 'ignore' });
      const rows = (await readFile(path.join(folder, 'budget.csv'), 'utf8')).trim().split(/\r?\n/).map((row) => row.split(','));

      expect(rows[3]?.slice(0, 2)).toEqual(['Total', '1800']);
      expect(rows[0]?.slice(4, 6)).toEqual(['1500', '#NAME?']);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
