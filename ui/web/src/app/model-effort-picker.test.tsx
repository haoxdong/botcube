import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';

import { ModelEffortPicker } from './model-effort-picker';

const picker = () => {
  render(
    <ModelEffortPicker
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

it('returns to model choices when the pill opens again after the effort panel', async () => {
  const pill = picker();
  await userEvent.click(pill);
  await userEvent.click(screen.getByText('Effort'));
  expect(document.querySelector('.mep-back')).not.toBeNull();
  await userEvent.keyboard('{Escape}');
  await userEvent.click(pill);
  expect(document.querySelector('.mep-back')).toBeNull();
  expect(screen.getByRole('button', { name: 'GPT-6.1-Sol' })).toBeVisible();
});
