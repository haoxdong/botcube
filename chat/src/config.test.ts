import { expect, it } from 'vitest';
import { positiveInteger } from './config.js';

it('reads a configured positive integer', () => {
  expect(positiveInteger({ LIMIT: '7' }, 'LIMIT', 5)).toBe(7);
  expect(positiveInteger({}, 'LIMIT', 5)).toBe(5);
});

it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity'])('rejects invalid configuration %s', (value) => {
  expect(() => positiveInteger({ LIMIT: value }, 'LIMIT', 5)).toThrow('LIMIT must be a positive integer');
});
