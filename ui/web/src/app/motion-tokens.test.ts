import { expect, it, onTestFinished } from 'vitest';

import { motionTokens } from './motion-tokens';

const root = (css: string) => {
  const sheet = document.head.appendChild(document.createElement('style'));
  sheet.textContent = `:root { ${css} }`;
  onTestFinished(() => sheet.remove());
};

it("turns globals.css's motion tokens into Motion transitions, in seconds on --ease", () => {
  root('--motion-move: 300ms; --motion-quick: 0.15s; --ease: cubic-bezier(0.32, 0.72, 0, 1);');
  expect(motionTokens()).toEqual({
    move: { duration: 0.3, ease: [0.32, 0.72, 0, 1] },
    quick: { duration: 0.15, ease: [0.32, 0.72, 0, 1] },
  });
});

it('is instant where no stylesheet sets the tokens', () => {
  expect(motionTokens()).toEqual({ move: { duration: 0 }, quick: { duration: 0 } });
  expect(motionTokens().move).not.toHaveProperty('ease');
  expect(motionTokens().quick).not.toHaveProperty('ease');
});
