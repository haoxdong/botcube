import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Opens the panel head's Download menu from the keyboard and returns its formats: jsdom lays the panel's resize handle
 * out over everything, so a click there never reaches the trigger.
 */
export async function openDownloads(panel: HTMLElement): Promise<HTMLElement[]> {
  act(() => within(panel).getByRole('button', { name: 'Download' }).focus());
  await userEvent.keyboard('{Enter}');
  return screen.findAllByRole('menuitem');
}

/** Downloads `format` from the panel head's Download menu. */
export async function downloadAs(panel: HTMLElement, format: string) {
  await openDownloads(panel);
  await userEvent.click(screen.getByRole('menuitem', { name: format }));
}
