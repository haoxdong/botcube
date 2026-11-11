import { createUniver, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import sheetsCoreEnUS from "@univerjs/preset-sheets-core/locales/en-US";
import "@univerjs/preset-sheets-core/lib/index.css";

import type { UniverCells } from "./sheet-model";

/**
 * Univer's open-source grid, which computes the formulas and lets the User type into cells. This module is loaded only
 * when a Sheet opens, so Univer stays out of the app's first load.
 */
export type Grid = {
  /** The cells as they are now, the User's typing included. */
  cells: () => UniverCells;
  dispose: () => void;
};

/**
 * Mounts the grid in `container`. `rendered` is called once Univer has drawn it and set up its controls (its Rendered
 * lifecycle stage): before that, a jump from the name box fails. `changed` is called on every change to a value.
 */
export function mountGrid(container: HTMLElement, data: Record<string, unknown>, { rendered, changed }: { rendered: () => void; changed: () => void }): Grid {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: mergeLocales(sheetsCoreEnUS) },
    presets: [UniverSheetsCorePreset({
      container, header: true, toolbar: false,
      footer: { sheetBar: true, statisticBar: true, menus: false, zoomSlider: false },
    })],
  });
  const stages = univerAPI.addEvent(univerAPI.Event.LifeCycleChanged, ({ stage }) => {
    if (stage >= univerAPI.Enum.LifecycleStages.Rendered) rendered();
  });
  const workbook = univerAPI.createWorkbook(data);
  const values = univerAPI.addEvent(univerAPI.Event.SheetValueChanged, changed);
  return {
    cells: () => workbook.save(),
    dispose: () => {
      stages.dispose();
      values.dispose();
      univer.dispose();
    },
  };
}
