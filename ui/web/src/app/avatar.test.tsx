import { fireEvent, render } from '@testing-library/react';
import { assert, describe, expect, it } from 'vitest';

import { Avatar } from './avatar';

const avatar = () => document.querySelector<HTMLElement>('.avatar');
const picture = () => avatar()?.querySelector('img');
const failToLoad = () => {
  const img = picture();
  assert(img, 'the picture');
  fireEvent.error(img);
};

describe('Avatar', () => {
  it('shows the picture when given one, at the requested size', () => {
    render(<Avatar picture="https://example.com/ada.png" emoji="🪶" name="Ada" size={64} />);

    expect(picture()).toHaveAttribute('src', 'https://example.com/ada.png');
    expect(avatar()).toHaveTextContent(/^$/);
    expect(avatar()).toHaveStyle({ width: '64px', height: '64px', fontSize: '28px' });
  });

  it('shows the emoji without a picture', () => {
    render(<Avatar emoji="🪶" name="Ada" size={32} />);

    expect(picture()).toBeNull();
    expect(avatar()).toHaveTextContent(/^🪶$/);
  });

  it("shows the name's initial without a picture or emoji", () => {
    render(<Avatar picture="" emoji="" name="ada Bot" size={32} />);

    expect(picture()).toBeNull();
    expect(avatar()).toHaveTextContent(/^a$/);
  });

  it('falls back to the emoji when the picture fails to load', () => {
    render(<Avatar picture="https://example.com/gone.png" emoji="🪶" name="Ada" size={32} />);

    failToLoad();

    expect(picture()).toBeNull();
    expect(avatar()).toHaveTextContent(/^🪶$/);
  });

  it('falls back to the initial when the picture fails to load and there is no emoji', () => {
    render(<Avatar picture="https://example.com/gone.png" name="Ada" size={32} />);

    failToLoad();

    expect(picture()).toBeNull();
    expect(avatar()).toHaveTextContent(/^A$/);
  });

  it("shows the agent's monocled avatar, not its initial, without a picture or emoji", () => {
    render(<Avatar picture="" emoji="" name="Ada Bot" agent size={40} />);

    expect(avatar()).toHaveClass('avatar-agent');
    expect(avatar()).toHaveTextContent(/^$/);
    expect(avatar()?.querySelector('.avatar-monocle')).toHaveAttribute('stroke-width', '2.2');
    expect(avatar()?.querySelector('.avatar-monocle-chain')).not.toBeNull();
  });

  it("keeps the agent's monocle legible at 32px: a thicker ring and no chain", () => {
    render(<Avatar name="Ada Bot" agent size={32} />);

    expect(avatar()?.querySelector('.avatar-monocle')).toHaveAttribute('stroke-width', '3.4');
    expect(avatar()?.querySelector('.avatar-monocle-chain')).toBeNull();
  });

  it("shows the agent's own picture or emoji over its default avatar", () => {
    const { unmount } = render(<Avatar picture="https://example.com/ada.png" name="Ada Bot" agent size={48} />);
    expect(picture()).toHaveAttribute('src', 'https://example.com/ada.png');
    expect(avatar()).not.toHaveClass('avatar-agent');
    unmount();

    render(<Avatar emoji="🪶" name="Ada Bot" agent size={48} />);
    expect(avatar()).toHaveTextContent(/^🪶$/);
    expect(avatar()).not.toHaveClass('avatar-agent');
  });

  it("falls back to the agent's default avatar when its picture fails to load", () => {
    render(<Avatar picture="https://example.com/gone.png" name="Ada Bot" agent size={48} />);

    failToLoad();

    expect(picture()).toBeNull();
    expect(avatar()?.querySelector('.avatar-monocle')).not.toBeNull();
  });

  it('shows a generic person without a picture, emoji, or name', () => {
    render(<Avatar size={28} />);

    expect(avatar()?.querySelector('svg')).not.toBeNull();
    expect(avatar()).toHaveTextContent(/^$/);
  });
});
