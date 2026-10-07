import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Button } from './button';
import { Field } from './field';
import { ListRowIcon } from './list-row';

afterEach(cleanup);

describe('Button', () => {
  it.each([
    ['secondary', 'button'],
    ['primary', 'button button-primary'],
    ['destructive', 'button button-destructive'],
  ] as const)('renders the %s variant as %s', (variant, className) => {
    render(<Button variant={variant}>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).className).toBe(className);
  });

  it('is secondary by default', () => {
    render(<Button>Edit</Button>);
    expect(screen.getByRole('button', { name: 'Edit' }).className).toBe('button');
  });
});

describe('ListRowIcon', () => {
  it('tints its tile only when what it lists failed', () => {
    const { container } = render(
      <>
        <ListRowIcon />
        <ListRowIcon failed />
      </>,
    );
    expect([...container.children].map((icon) => icon.className)).toEqual([
      'list-row-icon',
      'list-row-icon list-row-icon-failed',
    ]);
  });
});

describe('Field', () => {
  it('labels its control', () => {
    render(
      <Field label="Name">
        <input />
      </Field>,
    );
    expect(screen.getByLabelText('Name').closest('label')?.className).toBe('field');
  });
});
