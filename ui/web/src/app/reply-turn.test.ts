import { expect, it } from 'vitest';

import { openFence } from './reply-turn';

it('reads the code of a fence nothing closes yet', () => {
  expect(openFence('Settlement:\n\n```mermaid\nflowchart LR\n  A --> B')).toBe('flowchart LR\n  A --> B');
  expect(openFence('```mermaid\n')).toBe('');
});

it('reads no open fence once every fence has closed', () => {
  expect(openFence('Text only')).toBeNull();
  expect(openFence('```mermaid\nflowchart LR\n```\n\nThen prose.')).toBeNull();
  expect(openFence('~~~\ncode\n~~~')).toBeNull();
});

it('closes a fence only with its own mark, at least as long, and nothing after it', () => {
  expect(openFence('````\n```\nstill code')).toBe('```\nstill code');
  expect(openFence('```\n~~~\nstill code')).toBe('~~~\nstill code');
  expect(openFence('```mermaid\nA\n``` not a close')).toBe('A\n``` not a close');
  expect(openFence('```mermaid\nA\n```\n```mermaid\nB')).toBe('B');
});

it('reads inline code as no fence', () => {
  expect(openFence('``` inline ``` code')).toBeNull();
});
