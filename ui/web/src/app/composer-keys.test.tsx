import { expect, it, vi } from 'vitest';

import { fireEvent, render, screen } from '@testing-library/react';

import { Composer } from './composer';
import { holdEnter } from './composer-keys';

function renderComposer() {
  render(
    <Composer
      value="早上好"
      onChange={() => {}}
      onSend={() => {}}
      onStop={undefined}
      running={false}
      canSend
      hasFiles={false}
      addMenu={null}
      disclaimer={null}
      onKeyDownCapture={holdEnter(false, false)}
    />,
  );
  return screen.getByRole('textbox', { name: 'Message' });
}

it("keeps Safari's IME Enter (keyCode 229) from sending the draft", () => {
  const submit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => {});
  fireEvent.keyDown(renderComposer(), { key: 'Enter', keyCode: 229 });
  expect(submit).not.toHaveBeenCalled();
  submit.mockRestore();
});

it('sends the draft on a plain Enter', () => {
  const submit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => {});
  fireEvent.keyDown(renderComposer(), { key: 'Enter', keyCode: 13 });
  expect(submit).toHaveBeenCalledOnce();
  submit.mockRestore();
});
