import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';

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
  expect(document.querySelector('.mep-dropdown')).not.toBeNull();
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(document.querySelector('.mep-dropdown')).toBeNull());
  expect(pill).toHaveFocus();
});

it('keeps model and effort choices in separate menus', async () => {
  const model = picker();
  await userEvent.click(screen.getByRole('button', { name: 'Reasoning Medium' }));
  expect(screen.queryByRole('menuitemradio', { name: 'GPT-6.1-Sol' })).toBeNull();
  await userEvent.keyboard('{Escape}');
  await userEvent.click(model);
  expect(screen.getByRole('menuitemradio', { name: 'GPT-6.1-Sol' })).toBeVisible();
  expect(screen.queryByRole('menuitemradio', { name: 'Medium' })).toBeNull();
});

it('opens reasoning directly without replacing the model menu panel', async () => {
  picker();
  await userEvent.click(screen.getByRole('button', { name: 'Reasoning Medium' }));
  expect(screen.getByRole('menuitemradio', { name: 'Medium' })).toHaveAttribute('aria-checked', 'true');
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(screen.getByRole('button', { name: 'Reasoning Medium' })).toHaveFocus();
});

it('marks the loaded model selected when the catalog arrives in an open menu', async () => {
  const callbacks = { onModelChange: () => {}, onEffortChange: () => {} };
  const view = render(<ModelSelector models={{ loaded: false, error: null }} model={undefined} effort="medium" loadingLabel={undefined} {...callbacks} />);
  await userEvent.click(screen.getByRole('button', { name: /^Model Loading models/ }));
  view.rerender(<ModelSelector models={{ loaded: true, accountId: undefined, models: [{ key: 'sol', label: 'GPT-6.1-Sol', provider: 'openai' }] }} model="sol" effort="medium" loadingLabel={undefined} {...callbacks} />);
  expect(screen.getByRole('menuitemradio', { name: 'GPT-6.1-Sol' })).toHaveAttribute('aria-checked', 'true');
});
