import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import { ModelSelector } from './model-selector';

const catalog = {
  loaded: true as const,
  accountId: undefined,
  models: [
    { key: 'sol', label: 'GPT-6.1-Sol', provider: 'openai', description: 'Deep reasoning' },
    { key: 'astra', label: 'GPT-6-Astra', provider: 'openai' },
  ],
};

const picker = (props: Partial<Parameters<typeof ModelSelector>[0]> = {}) => {
  const callbacks = { onModelChange: vi.fn(), onEffortChange: vi.fn() };
  render(<ModelSelector models={catalog} model="sol" effort="medium" loadingLabel={undefined} {...callbacks} {...props} />);
  return { ...callbacks, trigger: screen.getByRole('button', { name: /^Model GPT-6.1-Sol, reasoning/ }) };
};

const dialog = () => screen.getByRole('dialog', { name: 'Model and effort' });
const effortSlider = () => {
  const slider = dialog().querySelector<HTMLInputElement>('input[type="range"]');
  if (!slider) throw new Error('Effort slider is missing');
  expect(document.getElementById(slider.getAttribute('aria-labelledby') ?? '')).toHaveTextContent('Effort');
  return slider;
};

it('opens from the trigger and restores focus when Escape closes it', async () => {
  const { trigger } = picker();
  await userEvent.click(trigger);
  expect(dialog()).toBeVisible();
  await waitFor(() => expect(dialog()).toContainElement(document.activeElement as HTMLElement));
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Model and effort' })).toBeNull());
  expect(trigger).toHaveFocus();
});

it('shows the effort as the title and the model as a link to the model list', async () => {
  const { trigger } = picker({ effort: 'high' });
  expect(trigger).toHaveAccessibleName('Model GPT-6.1-Sol, reasoning High');
  await userEvent.click(trigger);
  expect(dialog()).toHaveTextContent(/^Effort\s*High/);
  expect(screen.getByRole('combobox', { name: 'Model GPT-6.1-Sol' })).toBeVisible();
  // Stock Slider sets no aria-valuetext; the title is a status that speaks each effort by name.
  expect(dialog().querySelector('[role="status"]')).toHaveTextContent(/High$/);
  expect(effortSlider()).toHaveAttribute('aria-valuenow', '2');
});

it('chooses a model from the list, with each description under its name', async () => {
  const { trigger, onModelChange } = picker();
  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole('combobox', { name: 'Model GPT-6.1-Sol' }));
  const sol = await screen.findByRole('option', { name: /GPT-6.1-Sol/ });
  expect(sol).toHaveTextContent('Deep reasoning');
  expect(sol).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('option', { name: 'GPT-6-Astra' })).toHaveTextContent(/^GPT-6-Astra$/);
  await userEvent.click(screen.getByRole('option', { name: 'GPT-6-Astra' }));
  expect(onModelChange).toHaveBeenCalledExactlyOnceWith('astra');
  expect(dialog()).toBeVisible();
});

it('chooses a model from the keyboard by type-ahead', async () => {
  const { trigger, onModelChange } = picker();
  await userEvent.click(trigger);
  screen.getByRole('combobox', { name: 'Model GPT-6.1-Sol' }).focus();
  await userEvent.keyboard('{Enter}');
  await screen.findByRole('listbox');
  await userEvent.keyboard('GPT-6-A');
  await waitFor(() => expect(screen.getByRole('option', { name: 'GPT-6-Astra' })).toHaveAttribute('data-highlighted'));
  await userEvent.keyboard('{Enter}');
  expect(onModelChange).toHaveBeenCalledExactlyOnceWith('astra');
});

it('moves the effort with the slider keys', async () => {
  const { trigger, onEffortChange } = picker();
  await userEvent.click(trigger);
  const slider = effortSlider();
  slider.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(onEffortChange).toHaveBeenLastCalledWith('high');
  await userEvent.keyboard('{End}');
  expect(onEffortChange).toHaveBeenLastCalledWith('max');
  await userEvent.keyboard('{Home}');
  expect(onEffortChange).toHaveBeenLastCalledWith('low');
});

it('resets the effort to Medium', async () => {
  const { trigger, onEffortChange } = picker({ effort: 'max' });
  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole('button', { name: 'Reset effort' }));
  expect(onEffortChange).toHaveBeenCalledExactlyOnceWith('medium');
});

it('reads as loading until the catalog arrives, then shows the loaded model in an open picker', async () => {
  const callbacks = { onModelChange: () => {}, onEffortChange: () => {} };
  const view = render(<ModelSelector models={{ loaded: false, error: null }} model={undefined} effort="medium" loadingLabel={undefined} {...callbacks} />);
  await userEvent.click(screen.getByRole('button', { name: 'Model Loading models…, reasoning Medium' }));
  expect(screen.getByRole('combobox', { name: 'Model Loading models…' })).toBeVisible();
  view.rerender(<ModelSelector models={catalog} model="sol" effort="medium" loadingLabel={undefined} {...callbacks} />);
  await userEvent.click(screen.getByRole('combobox', { name: 'Model GPT-6.1-Sol' }));
  expect(await screen.findByRole('option', { name: /GPT-6.1-Sol/ })).toHaveAttribute('aria-selected', 'true');
});
