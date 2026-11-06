import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { fileExtension, FileTypeIcon, isImageName } from './file-type-icon';


/** The text the icon shows: its type's label, or nothing on a plain page. */
const label = (name: string) => render(<FileTypeIcon name={name} />).container.textContent;

describe('FileTypeIcon', () => {
  it.each([
    ['report.pdf', 'pdf'],
    ['model.xlsx', 'xlsx'],
    ['deck.PPTX', 'pptx'],
    ['memo.docx', 'docx'],
    ['prices.csv', 'csv'],
    ['dashboard.html', 'html'],
    ['recap.md', 'md'],
    ['backtest.py', 'py'],
    ['config.json', 'json'],
    ['pack.zip', 'zip'],
    ['thread.eml', 'eml'],
    ['notes.txt', 'txt'],
  ])('labels %s with its type', (name, type) => {
    expect(label(name)).toBe(type);
  });

  it.each(['Makefile', '.env'])('draws %s as a plain page with no label', (name) => {
    expect(label(name)).toBe('');
  });
});

describe('fileExtension', () => {
  it.each([
    ['deck.PPTX', 'pptx'],
    ['archive.tar.gz', 'gz'],
    ['Makefile', ''],
    ['.env', ''],
    ['notes.', ''],
  ])('reads %s as %j', (name, extension) => {
    expect(fileExtension(name)).toBe(extension);
  });
});

describe('isImageName', () => {
  it.each(['curve.png', 'spread.JPEG', 'photo.jpg', 'loop.gif', 'shot.webp', 'logo.svg'])('takes %s for an image', (name) => {
    expect(isImageName(name)).toBe(true);
  });

  it.each(['photo.heic', 'report.pdf', 'Makefile', '.png'])('takes %s for no image', (name) => {
    expect(isImageName(name)).toBe(false);
  });
});
