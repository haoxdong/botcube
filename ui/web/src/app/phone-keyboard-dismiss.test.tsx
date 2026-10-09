import { fireEvent, render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useScrollUpClosesKeyboard } from './phone-keyboard-dismiss';

function Fixture() {
  useScrollUpClosesKeyboard();
  return (
    <div className="copilotKitChat">
      <p>An earlier reply</p>
      <div data-testid="copilot-input-overlay">
        <textarea aria-label="Ask anything" />
      </div>
    </div>
  );
}

function drag(target: Element, from: number, to: number) {
  fireEvent.touchStart(target, { touches: [{ clientX: 200, clientY: from }] });
  fireEvent.touchMove(target, { touches: [{ clientX: 200, clientY: to }] });
}

// With the keyboard up, scrolling a phone's chat up left the composer focused and the keyboard over the chat; Safari
// panned the page instead. As in iMessage, the drag closes the keyboard.
it('closes the keyboard as the user drags the phone chat down to scroll it up (#3613)', () => {
  const { getByText, getByLabelText } = render(<Fixture />);
  const composer = getByLabelText('Ask anything');
  composer.focus();

  drag(getByText('An earlier reply'), 300, 280);
  expect(document.activeElement).toBe(composer);

  drag(getByText('An earlier reply'), 300, 340);
  expect(document.activeElement).not.toBe(composer);
});

it("keeps the keyboard up for a drag that starts in the composer", () => {
  const { getByLabelText } = render(<Fixture />);
  const composer = getByLabelText('Ask anything');
  composer.focus();

  drag(composer, 300, 340);
  expect(document.activeElement).toBe(composer);
});
