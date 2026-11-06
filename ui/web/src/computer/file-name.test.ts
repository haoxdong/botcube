import { expect, it } from 'vitest';

import { cutFitting } from './file-name';

/** Every way `name` is tried, in order, until `fits` takes one. */
const tried = (name: string, fits: (parts: string[]) => boolean = () => false) => {
  const seen: string[] = [];
  const chosen = cutFitting(name, (parts) => {
    seen.push(parts.join('|'));
    return fits(parts);
  });
  return { seen, chosen: chosen.join('|') };
};

it('tries a name whole, then before its extension, then each cut, longest start first, as Finder cuts it', () => {
  expect(tried('auction-tails.pdf').seen).toEqual([
    'auction-tails.pdf', 'auction-tails|.pdf',
    'auction-ta…ls.pdf', 'auction-ta…ls|.pdf', 'auction-t…ls.pdf', 'auction-t…ls|.pdf',
    'auction-…ls.pdf', 'auction-…ls|.pdf', 'auction…ls.pdf', 'auction…ls|.pdf', 'auctio…ls.pdf', 'auctio…ls|.pdf',
    'aucti…ls.pdf', 'aucti…ls|.pdf', 'auct…ls.pdf', 'auct…ls|.pdf', 'auc…ls.pdf', 'auc…ls|.pdf', 'au…ls.pdf', 'au…ls|.pdf',
    'a…ls.pdf', 'a…ls|.pdf', '…ls.pdf',
  ]);
});

it('takes the first way that fits, which a shorter cut may be after a longer one does not', () => {
  // Lines break only between words: `auction-t…ls` / `.pdf` fits where the longer cuts as they are do not.
  expect(tried('auction-tails.pdf', (parts) => parts.join('|') === 'auction-t…ls|.pdf').chosen).toBe('auction-t…ls|.pdf');
});

it('shows the ellipsis and the tail when no cut fits, and a short name wrapped before its extension', () => {
  expect(tried('auction-tails.pdf').chosen).toBe('…ls.pdf');
  expect(tried('a.png').seen).toEqual(['a.png', 'a|.png']);
  expect(tried('a.png').chosen).toBe('a|.png');
  // A leading dot belongs to the name.
  expect(tried('.env').seen).toEqual(['.env', '.env']);
});
