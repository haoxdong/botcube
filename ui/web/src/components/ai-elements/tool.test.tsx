import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert, describe, expect, it } from 'vitest';

import { Tool, ToolContent, ToolHeader, ToolOutput, type ToolState } from './tool';

function renderTool({
  title = 'execute',
  state = 'output-available',
  description,
  output = '',
}: { title?: string; state?: ToolState; description?: string; output?: string } = {}) {
  return render(
    <Tool>
      <ToolHeader title={title} state={state} description={description} />
      <ToolContent>
        <ToolOutput output={output} />
      </ToolContent>
    </Tool>,
  );
}

const header = () => screen.getByRole('button');
const iconOf = (element: Element) => element.querySelector('svg.lucide')?.getAttribute('class');

describe('ToolHeader', () => {
  it.each([
    ['execute', 'lucide-terminal'],
    ['read_file', 'lucide-file-text'],
    ['read', 'lucide-file-text'],
    ['write_file', 'lucide-pencil'],
    ['write', 'lucide-pencil'],
    ['ls', 'lucide-folder-open'],
    ['list_directory', 'lucide-folder-open'],
    ['delegate_to_subagent', 'lucide-user'],
    ['delegate', 'lucide-user'],
    ['task', 'lucide-list-todo'],
    ['search_web', 'lucide-settings'],
    ['read more', 'lucide-file-text'],
  ])('shows the %s tool with its icon', (title, icon) => {
    renderTool({ title });

    expect(header()).toHaveTextContent(title);
    expect(iconOf(header())).toContain(icon);
    expect(iconOf(header())).toContain('text-muted-foreground');
  });

  it.each([
    ['input-streaming', 'Pending', 'lucide-circle '],
    ['input-available', 'Running', 'lucide-clock'],
  ] as const)('labels a %s tool call %s', (state, label, icon) => {
    renderTool({ state });

    const badge = screen.getByText(label);
    expect(badge).toHaveAttribute('data-slot', 'badge');
    expect(badge.querySelector('svg')?.getAttribute('class')).toContain(icon);
  });

  it('marks a finished tool call with a green check and no label', () => {
    renderTool({ state: 'output-available' });

    expect(header().querySelector('.lucide-circle-check-big')?.getAttribute('class')).toContain('text-(--color-success)');
    expect(header()).toHaveTextContent(/^execute$/);
  });

  it('marks a failed tool call with a destructive cross and no label', () => {
    renderTool({ state: 'output-error' });

    expect(header().querySelector('.lucide-circle-x')?.getAttribute('class')).toContain('text-destructive');
    expect(header().querySelector('.lucide-circle-check-big')).toBeNull();
    expect(header()).toHaveTextContent(/^execute$/);
  });

  it.each([
    ['input-streaming', 'read_file /SKILL.md'],
    ['input-available', 'example content view @s3.c1'],
    ['output-available', 'example content view @s3.c1'],
    ['output-available', ''],
  ] as const)('pins a %s status to the row\'s right edge after the description "%s"', (state, description) => {
    const { container } = renderTool({ state, description });

    // happy-dom does no layout, so this reads the flex classes that place the status.
    const row = container.querySelector('button > div');
    assert.exists(row, 'the tool row is missing');
    expect(row).toHaveClass('flex-1');
    expect(row.lastElementChild).toHaveClass('ml-auto');
    expect(row.lastElementChild?.querySelector('svg')).not.toBeNull();
  });

  it('shows the description beside the tool name when there is one', () => {
    renderTool({ description: 'ls -la' });
    expect(screen.getByText('ls -la')).toHaveClass('truncate');

    cleanup();
    renderTool({ description: '' });
    expect(header().querySelectorAll('span.truncate')).toHaveLength(0);
  });
});

describe('ToolOutput', () => {
  it('shows the result as JSON once the tool call is expanded', async () => {
    renderTool({ output: '{"rows": 2}' });
    expect(screen.queryByText('"rows"')).toBeNull();

    await userEvent.click(header());

    // The first highlighted block in this file: it loads the highlighter every other block shares.
    await waitFor(() => expect(screen.getByText('"rows"')).toHaveStyle({ color: '#005CC5' }));
    const pre = document.querySelector('pre');
    expect(pre).toHaveTextContent('{"rows": 2}');
    expect(pre?.closest('[data-language]')).toHaveAttribute('data-language', 'json');
    // Off-screen results skip rendering, holding a placeholder height.
    expect(pre?.closest('[data-language]')?.getAttribute('style')).toBe(
      'contain-intrinsic-size: auto 200px; content-visibility: auto;',
    );
  });

  it('shows nothing for an empty result', async () => {
    renderTool({ output: '' });

    await userEvent.click(header());

    expect(document.querySelector('pre')).toBeNull();
  });

  it('highlights the result in the light GitHub theme', async () => {
    render(<ToolOutput output={'{\n  "rows": 2,\n\n  "ok": true\n}'} />);

    await waitFor(() => expect(screen.getByText('"rows"')).toHaveStyle({ color: '#005CC5' }));
    expect(document.querySelectorAll('pre .block')).toHaveLength(5);
    expect(document.querySelectorAll('pre .block')[2]).toHaveTextContent(/^$/);
    expect(document.querySelectorAll('pre .block')[2]?.textContent).toBe('\n');
  });

  it("paints the block in the light theme's colors once highlighted", async () => {
    render(<ToolOutput output={'{"painted": 1}'} />);

    await waitFor(() => expect(screen.getByText('"painted"')).toHaveStyle({ color: '#005CC5' }));
    const pre = document.querySelector('pre');
    assert.exists(pre, 'the code block is missing');
    expect(pre).toHaveStyle({ backgroundColor: '#fff', color: '#24292e' });
  });

  it('shows plain text until the highlighter is ready', () => {
    render(<ToolOutput output={'{"first":\n\n1}'} />);

    const lines = [...document.querySelectorAll('pre .block')].map((line) => line.textContent);
    expect(lines).toEqual(['{"first":', '\n', '1}']);
    expect(document.querySelector('pre .block span')?.getAttribute('style')).toBeNull();
    expect(document.querySelector('pre')?.getAttribute('style')).toBe('background-color: transparent; color: inherit;');
  });

  it('highlights each result by its whole text, not a shared beginning and end', async () => {
    const padding = ' '.repeat(120);
    const first = render(<ToolOutput output={`[${padding}"a"${padding}]`} />);
    await waitFor(() => expect(screen.getByText('"a"')).toHaveStyle({ color: '#032F62' }));
    first.unmount();

    render(<ToolOutput output={`[${padding}"b"${padding}]`} />);

    expect(document.querySelector('pre')).toHaveTextContent('"b"');
    await waitFor(() => expect(screen.getByText('"b"')).toHaveStyle({ color: '#032F62' }));
  });

  it('shows a result it already highlighted in color at once', async () => {
    const output = '{"cached": "yes"}';
    const first = render(<ToolOutput output={output} />);
    await waitFor(() => expect(screen.getByText('"cached"')).toHaveStyle({ color: '#005CC5' }));
    first.unmount();

    render(<ToolOutput output={output} />);

    expect(screen.getByText('"cached"')).toHaveStyle({ color: '#005CC5' });
  });

  it('shows a changed result as plain text rather than the previous highlighting', async () => {
    const view = render(<ToolOutput output={'{"before": 1}'} />);
    await waitFor(() => expect(screen.getByText('"before"')).toHaveStyle({ color: '#005CC5' }));

    view.rerender(<ToolOutput output={'{"after": 2}'} />);

    expect(document.querySelector('pre')).toHaveTextContent('{"after": 2}');
    await waitFor(() => expect(screen.getByText('"after"')).toHaveStyle({ color: '#005CC5' }));
  });
});
