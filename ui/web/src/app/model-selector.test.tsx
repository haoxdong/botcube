import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';

import { ModelSelector } from './model-selector';

const picker = () => {
  render(
    <ModelSelector
      models={{ loaded: true, accountId: undefined, models: [{ key: 'sol', label: 'GPT-6.1-Sol', provider: 'openai' }] }}
      model="sol"
      effort="medium"
      loadingLabel={undefined}
      onModelChange={() => {}}
      onEffortChange={() => {}}
    />,
  );
  return screen.getByRole('button', { name: /^Model GPT-6.1-Sol/ });
};

it('opens from the pill and restores focus when Escape closes it', async () => {
  const pill = picker();
  await userEvent.click(pill);
  expect(screen.getByRole('dialog', { name: 'Model and effort' })).toBeVisible();
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'Model and effort' })).toHaveFocus());
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Model and effort' })).toBeNull());
  expect(pill).toHaveFocus();
});

it('opens model and nested effort choices from one composer trigger', async () => {
  const pill = picker();
  expect(screen.queryByRole('button', { name: 'Reasoning Medium' })).toBeNull();
  await userEvent.click(pill);
  expect(screen.getByRole('radio', { name: 'GPT-6.1-Sol' })).toHaveAttribute('aria-checked', 'true');
  await userEvent.click(screen.getByRole('button', { name: 'Effort Medium' }));
  expect(await screen.findByRole('radio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
  expect(pill).toHaveAttribute('aria-expanded', 'true');
  await userEvent.click(screen.getByRole('button', { name: 'Back to models' }));
  expect(await screen.findByRole('radio', { name: 'GPT-6.1-Sol' })).toBeVisible();
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(pill).toHaveFocus();
});

it('marks the loaded model selected when the catalog arrives in an open menu', async () => {
  const callbacks = { onModelChange: () => {}, onEffortChange: () => {} };
  const view = render(<ModelSelector models={{ loaded: false, error: null }} model={undefined} effort="medium" loadingLabel={undefined} {...callbacks} />);
  await userEvent.click(screen.getByRole('button', { name: /^Model Loading models/ }));
  view.rerender(<ModelSelector models={{ loaded: true, accountId: undefined, models: [{ key: 'sol', label: 'GPT-6.1-Sol', provider: 'openai' }] }} model="sol" effort="medium" loadingLabel={undefined} {...callbacks} />);
  expect(screen.getByRole('radio', { name: 'GPT-6.1-Sol' })).toHaveAttribute('aria-checked', 'true');
});

it('returns to models after picking any effort, including the selected effort', async () => {
  const onEffortChange = vi.fn();
  render(<ModelSelector models={{ loaded: true, accountId: undefined, models: [{ key: 'sol', label: 'GPT-6.1-Sol', provider: 'openai' }] }} model="sol" effort="medium" loadingLabel={undefined} onModelChange={() => {}} onEffortChange={onEffortChange} />);
  const pill = screen.getByRole('button', { name: /^Model / });
  await userEvent.click(pill);
  await userEvent.click(screen.getByRole('button', { name: 'Effort Medium' }));
  await userEvent.click(await screen.findByRole('radio', { name: 'Medium' }));
  expect(await screen.findByRole('radio', { name: 'GPT-6.1-Sol' })).toBeVisible();
  expect(onEffortChange).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Effort Medium' }));
  await userEvent.click(await screen.findByRole('radio', { name: 'High' }));
  expect(onEffortChange).toHaveBeenCalledExactlyOnceWith('high');
  expect(await screen.findByRole('radio', { name: 'GPT-6.1-Sol' })).toBeVisible();
});
