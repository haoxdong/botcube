import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import sheetsCoreEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import "@univerjs/preset-sheets-core/lib/index.css";

import type { UniverCells } from "./sheet-model";

export type GridPosition = { sheet: string; sheetViewStartRow: number; sheetViewStartColumn: number; offsetX: number; offsetY: number };

export type Grid = {
  /** The cells as they are now, the User's typing included. */
  cells: () => UniverCells;
  position: () => GridPosition;
  dispose: () => void;
};

/**
 * Mounts the grid in `container`. `rendered` is called once Univer has drawn it and set up its controls (its Steady
 * lifecycle stage): before that, a jump from the name box fails. `changed` is called on every change to a value.
 */
export function mountGrid(container: HTMLElement, data: Record<string, unknown>, { rendered, changed, position }: { rendered: () => void; changed: () => void; position?: GridPosition | null }): Grid {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: mergeLocales(sheetsCoreEnUS) },
    presets: [UniverSheetsCorePreset({
      container, header: true, toolbar: false,
      footer: { sheetBar: true, statisticBar: true, menus: false, zoomSlider: false },
    })],
  });
  const stages = univerAPI.addEvent(univerAPI.Event.LifeCycleChanged, ({ stage }) => {
    if (stage < univerAPI.Enum.LifecycleStages.Steady) return;
    stages.dispose();
    const sheet = position && workbook.getSheetByName(position.sheet);
    if (sheet) {
      workbook.setActiveSheet(sheet);
      if (!univerAPI.syncExecuteCommand('sheet.command.scroll-view', { ...position, unitId: workbook.getId(), sheetId: sheet.getSheetId(), duration: 0 })) {
        throw new Error("Couldn't restore the Sheet's reading position");
      }
    }
    rendered();
  });
  const workbook = univerAPI.createWorkbook(data);
  const values = univerAPI.addEvent(univerAPI.Event.SheetValueChanged, changed);
  return {
    cells: () => workbook.save(),
    position: () => {
      const sheet = workbook.getActiveSheet();
      const { sheetViewStartRow, sheetViewStartColumn, offsetX, offsetY } = sheet.getScrollState();
      return { sheet: sheet.getSheetName(), sheetViewStartRow, sheetViewStartColumn, offsetX, offsetY };
    },
    dispose: () => {
      stages.dispose();
      values.dispose();
      univer.dispose();
    },
  };
}
