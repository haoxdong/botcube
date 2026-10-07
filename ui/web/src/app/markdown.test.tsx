import { CopilotChatAssistantMessage } from '@copilotkit/react-core/v2';
import { render, waitFor } from '@testing-library/react';
import { Streamdown } from 'streamdown';
import { expect, it } from 'vitest';

import { MARKDOWN_RENDERER } from './markdown';

const tables = [
  {
    name: 'Q6 breakevens and real yields',
    markdown: `| Measure | Latest | 3-month range: low–high | Below 3-month high | Position in range* |
|---|---:|---:|---:|---:|
| 5y breakeven | **2.36%** | 2.16%–2.46% | 10 bp | 67% |
| 10y breakeven | **2.36%** | 2.20%–2.40% | 4 bp | 80% |
| 5y real yield | **2.65%** | 1.94%–2.73% | 8 bp | 90% |
| 10y real yield | **2.88%** | 2.24%–2.93% | 5 bp | 93% |`,
    headers: [
      'Measure',
      'Latest',
      '3-month range: low–high',
      'Below 3-month high',
      'Position in range*',
    ],
    rows: [
      ['5y breakeven', '2.36%', '2.16%–2.46%', '10 bp', '67%'],
      ['10y breakeven', '2.36%', '2.20%–2.40%', '4 bp', '80%'],
      ['5y real yield', '2.65%', '1.94%–2.73%', '8 bp', '90%'],
      ['10y real yield', '2.88%', '2.24%–2.93%', '5 bp', '93%'],
    ],
  },
  {
    name: 'Q15 currency ranks',
    markdown: `| YTD rank | Currency | YTD move vs USD | 3-month rank | Rank change* |
|---:|---|---:|---:|---|
| 1 | Norwegian krone (NOK) | +5.16% | 2 | Up 1 |
| 2 | Australian dollar (AUD) | +4.47% | 3 | Up 1 |
| 3 | Japanese yen (JPY) | −0.78% | 1 | Down 2 |
| 4 | British pound (GBP) | −1.80% | 5 | Up 1 |
| 5 | New Zealand dollar (NZD) | −2.73% | 6 | Up 1 |
| 6 | Canadian dollar (CAD) | −3.76% | 4 | Down 2 |
| 7 | Euro (EUR) | −4.47% | 7 | Unchanged |
| 8 | Swiss franc (CHF) | −4.55% | 8 | Unchanged |
| 9 | Swedish krona (SEK) | −8.18% | 9 | Unchanged |`,
    headers: [
      'YTD rank',
      'Currency',
      'YTD move vs USD',
      '3-month rank',
      'Rank change*',
    ],
    rows: [
      ['1', 'Norwegian krone (NOK)', '+5.16%', '2', 'Up 1'],
      ['2', 'Australian dollar (AUD)', '+4.47%', '3', 'Up 1'],
      ['3', 'Japanese yen (JPY)', '−0.78%', '1', 'Down 2'],
      ['4', 'British pound (GBP)', '−1.80%', '5', 'Up 1'],
      ['5', 'New Zealand dollar (NZD)', '−2.73%', '6', 'Up 1'],
      ['6', 'Canadian dollar (CAD)', '−3.76%', '4', 'Down 2'],
      ['7', 'Euro (EUR)', '−4.47%', '7', 'Unchanged'],
      ['8', 'Swiss franc (CHF)', '−4.55%', '8', 'Unchanged'],
      ['9', 'Swedish krona (SEK)', '−8.18%', '9', 'Unchanged'],
    ],
  },
];

it.each(tables)(
  'keeps $name footnote markers out of body cells after streaming',
  ({ markdown, headers, rows }) => {
    const view = render(<Streamdown {...MARKDOWN_RENDERER}>{''}</Streamdown>);
    for (let end = 1; end <= markdown.length; end++) {
      view.rerender(
        <Streamdown {...MARKDOWN_RENDERER}>{markdown.slice(0, end)}</Streamdown>
      );
    }
    expect(
      Array.from(
        view.container.querySelectorAll('th'),
        (cell) => cell.textContent
      )
    ).toEqual(headers);
    expect(
      Array.from(view.container.querySelectorAll('tbody tr'), (row) =>
        Array.from(row.querySelectorAll('td'), (cell) => cell.textContent)
      )
    ).toEqual(rows);
  }
);

it.each(tables)(
  'renders the complete $name table cleanly after reload',
  ({ markdown, headers, rows }) => {
    const view = render(
      <Streamdown {...MARKDOWN_RENDERER}>{markdown}</Streamdown>
    );
    expect(
      Array.from(
        view.container.querySelectorAll('th'),
        (cell) => cell.textContent
      )
    ).toEqual(headers);
    expect(
      Array.from(view.container.querySelectorAll('tbody tr'), (row) =>
        Array.from(row.querySelectorAll('td'), (cell) => cell.textContent)
      )
    ).toEqual(rows);
  }
);

it('preserves emphasis, math, code highlighting and table controls after the renderer upgrade', async () => {
  const view = render(
    <Streamdown {...MARKDOWN_RENDERER}>{`*italic* and **bold** and **日本語。**

$$x^2$$

\`\`\`javascript
const answer = 42;
\`\`\`

| Header |
|---|
| Value |`}</Streamdown>
  );
  expect(view.container.querySelector('em')?.textContent).toBe('italic');
  expect(
    Array.from(
      view.container.querySelectorAll('[data-streamdown="strong"]'),
      (node) => node.textContent
    )
  ).toEqual(['bold', '日本語。']);
  expect(view.container.querySelector('.katex annotation')?.textContent).toBe(
    'x^2'
  );
  await waitFor(() =>
    expect(
      view.container.querySelector(
        '[data-streamdown="code-block-body"] span[style]'
      )?.textContent
    ).toBe('const')
  );
  expect(view.getByRole('button', { name: 'Copy table' })).toBeInTheDocument();
  expect(
    view.getByRole('button', { name: 'Download table' })
  ).toBeInTheDocument();
});

it.each(tables)(
  'keeps the actual assistant $name table clean after streaming',
  ({ markdown, headers, rows }) => {
    const Renderer = CopilotChatAssistantMessage.MarkdownRenderer;
    const view = render(<Renderer {...MARKDOWN_RENDERER} content="" />);
    for (let end = 1; end <= markdown.length; end++) {
      view.rerender(
        <Renderer {...MARKDOWN_RENDERER} content={markdown.slice(0, end)} />
      );
    }
    expect(
      Array.from(
        view.container.querySelectorAll('th'),
        (cell) => cell.textContent
      )
    ).toEqual(headers);
    expect(
      Array.from(view.container.querySelectorAll('tbody tr'), (row) =>
        Array.from(row.querySelectorAll('td'), (cell) => cell.textContent)
      )
    ).toEqual(rows);
  }
);
