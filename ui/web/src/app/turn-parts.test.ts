import { expect, it } from 'vitest';

import { partsOf, type TurnMessage } from './turn-parts';

const publish = (id: string, file: string, version = 1): TurnMessage[] => [
  { id, role: 'assistant', content: '', toolCalls: [{ id: `${id}-call`, function: { name: 'Artifact', arguments: '{"action":"publish"}' } }] },
  { id: `${id}-result`, role: 'tool', toolCallId: `${id}-call`, content: JSON.stringify({ id: file, type: null, title: file, description: '', version, path: `/artifacts/${file}.versions/${version}.html` }) },
];

// A card shown while the Turn runs moves when the answer's words stream in above it.
it('keeps published Artifacts in the Worklog while the Turn runs, then shows them once under its answer', () => {
  const messages = [
    { id: 'question', role: 'user', content: 'Publish two pages' },
    ...publish('first', 'one'),
    ...publish('second', 'two'),
    ...publish('revision', 'one', 2),
  ];
  const answer = { id: 'answer', role: 'assistant', content: 'Here are both pages.' };
  for (const turn of [messages, [...messages, answer]]) {
    const running = partsOf(turn, true);
    expect(['first', 'second', 'revision'].map((id) => running.parts.get(id))).toEqual(['work', 'work', 'work']);
  }
  expect(partsOf(messages, true).cards.size).toBe(0);
  // The streaming answer is already the bubble its cards will join, so it keeps one layout when they arrive.
  const streaming = partsOf([...messages, answer], true);
  expect([...streaming.cards]).toEqual([['answer', []]]);
  expect(streaming.parts.get('answer')).toBe('shown');

  const answered = partsOf([...messages, answer], false);
  expect([...answered.cards]).toEqual([['answer', [
    { id: 'one', type: null, title: 'one', description: '', version: 2, path: '/artifacts/one.versions/2.html' },
    { id: 'two', type: null, title: 'two', description: '', version: 1, path: '/artifacts/two.versions/1.html' },
  ]]]);
  expect(['first', 'second', 'revision'].map((id) => answered.parts.get(id))).toEqual(['card', 'card', 'card']);

  const unanswered = partsOf(messages, false);
  expect([...unanswered.cards.keys()]).toEqual(['revision']);
  expect(unanswered.parts.get('revision')).toBe('shown');
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
  const ended = partsOf(messages, false);
  expect(ended.cards.get('first')?.map(({ id }) => id)).toEqual(['one']);
  expect(ended.parts.get('mixed')).toBe('shown');
  expect(ended.parts.get('refused-result')).toBe('work');
});
