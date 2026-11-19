import { expect, it } from 'vitest';

import { keepSize, sizeOf } from './late-boxes';

it('keeps sizes across visits, the oldest going first past its limit', () => {
  keepSize('image:/artifacts/chart.png', { width: 1200, height: 640 });
  const stored = new Map(JSON.parse(localStorage.getItem('late-box-sizes') ?? '[]') as [string, unknown][]);
  expect(stored.get('image:/artifacts/chart.png')).toEqual({ width: 1200, height: 640 });
  for (let index = 0; index < 500; index += 1) keepSize(`image:${index}`, { width: 1, height: 1 });
  expect(sizeOf('image:/artifacts/chart.png')).toBeNull();
  expect(sizeOf('image:499')).toEqual({ width: 1, height: 1 });
});
