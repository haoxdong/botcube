import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { Composer } from './composer';

function renderComposer({ canSend = true, running = false } = {}) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  render(
    <Composer
      value="早上好"
      onChange={() => {}}
      onSend={canSend ? onSend : undefined}
      onStop={onStop}
      running={running}
      hasFiles={false}
      addMenu={null}
      disclaimer={null}
    />,
  );
  return { text: screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }), onSend, onStop };
}

it.each([{ keyCode: 229 }, { isComposing: true }, { shiftKey: true }])('leaves Enter to the editor with %j', (event) => {
  const { text, onSend } = renderComposer();
  expect(fireEvent.keyDown(text, { key: 'Enter', ...event })).toBe(true);
  expect(onSend).not.toHaveBeenCalled();
});

it.each([false, true])('sends on Enter whether a Turn is running (%s)', (running) => {
  const { text, onSend, onStop } = renderComposer({ running });
  fireEvent.keyDown(text, { key: 'Enter' });
  expect(onSend).toHaveBeenCalledOnce();
  expect(onStop).not.toHaveBeenCalled();
});

it('submits with the Send button', () => {
  const { onSend } = renderComposer();
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(onSend).toHaveBeenCalledOnce();
});

it('can stop a running Turn without sending the draft', () => {
  const { onSend, onStop } = renderComposer({ running: true });
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(onStop).toHaveBeenCalledOnce();
  expect(onSend).not.toHaveBeenCalled();
});

it.each([false, true])('keeps a held draft when a Turn is running (%s)', (running) => {
  const { text, onSend, onStop } = renderComposer({ canSend: false, running });
  if (text.form === null) throw new Error('Missing composer form');
  fireEvent.submit(text.form);
  fireEvent.keyDown(text, { key: 'Enter' });
  expect(text).not.toHaveFocus();
  expect(onSend).not.toHaveBeenCalled();
  expect(onStop).not.toHaveBeenCalled();
});
