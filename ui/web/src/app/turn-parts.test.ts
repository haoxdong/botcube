import { expect, it } from 'vitest';

import { partsOf, type TurnMessage } from './turn-parts';

const publish = (id: string, file: string, version = 1): TurnMessage[] => [
  { id, role: 'assistant', content: '', toolCalls: [{ id: `${id}-call`, function: { name: 'Artifact', arguments: '{"action":"publish"}' } }] },
  { id: `${id}-result`, role: 'tool', toolCallId: `${id}-call`, content: JSON.stringify({ id: file, type: null, title: file, description: '', version, path: `/artifacts/${file}.versions/${version}.html` }) },
];

it('groups published Artifacts while the Turn runs and moves the same group into its answer', () => {
  const messages = [
    { id: 'question', role: 'user', content: 'Publish two pages' },
    ...publish('first', 'one'),
    ...publish('second', 'two'),
    ...publish('revision', 'one', 2),
  ];
  const streaming = partsOf(messages, true);
  expect([...streaming.cards.values()]).toEqual([[
    { id: 'one', type: null, title: 'one', description: '', version: 2, path: '/artifacts/one.versions/2.html' },
    { id: 'two', type: null, title: 'two', description: '', version: 1, path: '/artifacts/two.versions/1.html' },
  ]]);
  expect(streaming.parts.get('first')).toBe('card');
  expect(streaming.parts.get('second')).toBe('card');
  expect(streaming.parts.get('revision')).toBe('shown');

  for (const running of [true, false]) {
    const answered = partsOf([...messages, { id: 'answer', role: 'assistant', content: 'Here are both pages.' }], running);
    expect(answered.cards.get('answer')).toEqual([...streaming.cards.values()][0]);
    expect(answered.parts.get('revision')).toBe('card');
  }
});

it('keeps refused and pending calls out of the published group without losing their work', () => {
  const messages: TurnMessage[] = [
    { id: 'question', role: 'user', content: 'Publish pages' },
    ...publish('first', 'one'),
    { id: 'mixed', role: 'assistant', content: '', toolCalls: [
      { id: 'refused-call', function: { name: 'Artifact', arguments: '{}' } },
      { id: 'pending-call', function: { name: 'Artifact', arguments: '{"action":"publish"}' } },
    ] },
    { id: 'refused-result', role: 'tool', toolCallId: 'refused-call', content: 'Error: no file at /missing.html' },
  ];
  const streaming = partsOf(messages, true);
  expect(streaming.cards.get('first')?.map(({ id }) => id)).toEqual(['one']);
  expect(streaming.parts.get('mixed')).toBe('shown');
  expect(streaming.parts.get('refused-result')).toBe('work');
});
