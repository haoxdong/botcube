// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Sheet } from 'botcube-artifact-check/sheet';
import { describe, expect, it } from 'vitest';

import { replay, univerDataOf } from './sheet-model';

const SKILL_PAGE = 'botcube/harness/deepagents/artifact-check/skills/artifacts/SKILL.md';

function skillPageSheets(): Sheet[] {
  const page = readFileSync(fileURLToPath(new URL(`../../../../../${SKILL_PAGE}`, import.meta.url)), 'utf8');
  const section = page.slice(page.indexOf('\n## Sheet\n'));
  const next = section.indexOf('\n## ', 1);
  return [...(next === -1 ? section : section.slice(0, next)).matchAll(/```json\n(\{"edits".*?)\n```/gs)].map(([, json = '']) => {
    const sheet: Sheet = JSON.parse(json);
    return sheet;
  });
}

function skillPageExample(): Sheet {
  const [example, ...others] = skillPageSheets();
  if (example === undefined || others.length > 0) throw new Error(`${SKILL_PAGE} must have exactly one Sheet example`);
  return example;
}

describe("the skill page's Sheet example, loaded into the grid", () => {
  it('replays into the sheets, values, formulas, merges and frozen rows it writes', () => {
    expect(univerDataOf(replay(skillPageExample()))).toMatchObject({
      sheetOrder: ['sheet-0', 'sheet-1'],
      sheets: {
        'sheet-0': {
          name: 'Budget',
          cellData: { 1: { 1: { v: 1200 } }, 2: { 1: { v: '02139' } }, 3: { 1: { f: '=SUM(B2:B3)' } } },
          mergeData: [{ startRow: 5, startColumn: 0, endRow: 5, endColumn: 1 }, { startRow: 8, startColumn: 0, endRow: 8, endColumn: 1 }],
          showGridlines: 0,
        },
        'sheet-1': { name: 'Tasks', cellData: { 1: { 4: { v: 1, t: 3 } } }, freeze: { ySplit: 1 } },
      },
    });
  });

  it("hands the grid the open-ended range as written, which it can't compute", () => {
    const data = univerDataOf(replay(skillPageExample()));

    expect(data).toMatchObject({ sheets: { 'sheet-1': { cellData: { 0: { 9: { f: '=SUMIFS(F2:F,E2:E,FALSE)' } } } } } });
    expect(data).not.toMatchObject({ sheets: { 'sheet-1': { cellData: { 0: { 9: { v: expect.anything() } } } } } });
  });
});
