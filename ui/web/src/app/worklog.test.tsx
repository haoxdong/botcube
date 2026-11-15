import { CopilotChatConfigurationProvider, CopilotChatMessageView, CopilotKitProvider } from '@copilotkit/react-core/v2';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

import { ThoughtStep, ToolStep, TurnStart, Worklog, worklogRows, type TurnMessage } from './worklog';

const START = Date.parse('2026-10-11T14:05:41Z');
/** When a replayed message started and ended, `from` and `to` seconds into its Turn. */
const stamp = (from: number, to: number) => ({ metadata: { started_at: START + from * 1000, ended_at: START + to * 1000 } });
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

/** A Turn as a replay sends it, its ids under `prefix`: a note and its call, the call's result, then the answer. */
const turn = (prefix: string) => [
  { id: `${prefix}u`, role: 'user' as const, content: 'One-minute US rates update' },
  { id: `${prefix}a`, role: 'assistant' as const, content: "I'll check the rates skill first.", toolCalls: [call(`${prefix}c`, 'read_file')], ...stamp(0, 1.5) },
  { id: `${prefix}t`, role: 'tool' as const, toolCallId: `${prefix}c`, content: '---\nname: rates', ...stamp(1, 2.3) },
  { id: `${prefix}f`, role: 'assistant' as const, content: '2s10s steepened to +45bp.', ...stamp(34.4, 38) },
];
const unstamped = (messages: TurnMessage[]) => messages.map(({ metadata: _metadata, ...message }) => message);

/** The chat's rows as CopilotKit lays them out, each keyed by its message's id; a tool result has none. */
function Chat({ messages, running }: { messages: readonly TurnMessage[]; running: boolean }) {
  const rows = messages.filter(({ role }) => role !== 'tool').map(({ id, content }) => <p key={id}>{String(content)}</p>);
  return <>{worklogRows(rows, messages, running)}</>;
}

/** The chat surface's message list: CopilotKit's own, with a custom-message renderer, so it lays out those slots too. */
function CopilotKitChat({ messages }: { messages: ReturnType<typeof turn> }) {
  return (
    <CopilotKitProvider renderCustomMessages={[{ render: () => null }]}>
      <CopilotChatConfigurationProvider threadId="thread">
        <CopilotChatMessageView messages={messages} isRunning={false}>
          {({ messageElements, messages: shown, isRunning }) => <>{worklogRows(messageElements, shown, isRunning)}</>}
        </CopilotChatMessageView>
      </CopilotChatConfigurationProvider>
    </CopilotKitProvider>
  );
}

const heads = () => screen.getAllByRole('button', { name: /^Work/ });
const head = () => {
  const [first] = heads();
  assert(first, 'a Worklog header');
  return first;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('a Worklog', () => {
  it('owns both the startup Worklog and its first populated Worklog', () => {
    const messages = turn('retained-startup');
    const view = render(<Chat messages={messages.slice(0, 1)} running />);
    const owner = view.container.querySelector('.worklog');
    expect(owner).not.toBeNull();
    expect(view.container.querySelectorAll('.worklog-title')).toHaveLength(1);
    view.rerender(<Chat messages={messages.slice(0, 3)} running />);
    expect(view.container.querySelectorAll('.worklog')).toHaveLength(1);
    expect(view.container.querySelectorAll('.worklog-title')).toHaveLength(1);
    expect(head()).toHaveAttribute('aria-expanded', 'true');
  });

  it("folds a finished Turn's work under one header timed from its messages, its answer outside", () => {
    render(<Chat messages={turn('fold')} running={false} />);

    expect(heads()).toHaveLength(1);
    expect(head()).toHaveTextContent(/^Worked for 38s$/);
    expect(head()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText("I'll check the rates skill first.")).toBeNull();
    expect(screen.getByText('2s10s steepened to +45bp.')).toBeVisible();
  });

  it('says only "Worked" for a Turn recorded before messages were stamped', () => {
    render(<Chat messages={unstamped(turn('bare'))} running={false} />);

    expect(head()).toHaveTextContent(/^Worked$/);
  });

  it('opens and folds on its header', () => {
    render(<Chat messages={turn('tap')} running={false} />);

    fireEvent.click(head());
    expect(head()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText("I'll check the rates skill first.")).toBeVisible();
    fireEvent.click(head());
    expect(screen.queryByText("I'll check the rates skill first.")).toBeNull();
  });

  it('is open while its Turn runs, on a clock, and folds when the Turn ends', () => {
    vi.useFakeTimers({ now: START });
    const messages = turn('live');
    const view = render(<Chat messages={unstamped(messages.slice(0, 3))} running />);

    expect(head()).toHaveTextContent(/^Working · 0s$/);
    expect(head()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText("I'll check the rates skill first.")).toBeVisible();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(head()).toHaveTextContent(/^Working · 4s$/);

    act(() => {
      vi.advanceTimersByTime(36000);
    });
    view.rerender(<Chat messages={unstamped(messages)} running={false} />);
    expect(head()).toHaveTextContent(/^Worked for 40s$/);
    expect(head()).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps its clock when CopilotKit remounts its row mid-run', () => {
    vi.useFakeTimers({ now: START });
    const messages = turn('remount').slice(0, 3);
    const first = render(<Chat messages={messages} running />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    first.unmount();

    render(<Chat messages={messages} running />);

    expect(head()).toHaveTextContent(/^Working · 5s$/);
  });

  it('times a Turn from its head with no rows, which opens to nothing, and carries that clock on to its rows', () => {
    vi.useFakeTimers({ now: START });
    const messages = turn('head');
    const view = render(<Worklog id="headu" running asked="headu" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(view.container).toHaveTextContent(/^Working · 0s$/);
    act(() => {
      vi.advanceTimersByTime(3000);
    });

    view.rerender(<Chat messages={messages.slice(0, 3)} running />);

    expect(head()).toHaveTextContent(/^Working · 3s$/);
    expect(head()).toHaveAttribute('aria-expanded', 'true');
  });

  it('collapses at the first answer token while its Turn still runs', () => {
    render(<Chat messages={turn('answering')} running />);

    expect(head()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('2s10s steepened to +45bp.')).toBeVisible();
  });

  it('resets manual expansion only when work, answer or completion phases change', () => {
    vi.useFakeTimers({ now: START });
    const [question, note, result, answer] = unstamped(turn('phases'));
    assert(question && note && result && answer, 'the Turn');
    const work = [question, note, result];
    const view = render(<Chat messages={[...work, { ...answer, content: '' }]} running />);
    expect(head()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(head());
    expect(head()).toHaveAttribute('aria-expanded', 'false');

    view.rerender(<Chat messages={[...work, { ...answer, content: '2s' }]} running />);
    expect(head()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('2s')).toBeVisible();
    fireEvent.click(head());
    expect(head()).toHaveAttribute('aria-expanded', 'true');
    view.rerender(<Chat messages={[...work, answer]} running />);
    expect(head()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('2s10s steepened to +45bp.')).toBeVisible();

    const toolNote = { ...answer, toolCalls: [call('phases-next-call', 'execute')] };
    view.rerender(<Chat messages={[...work, toolNote]} running />);
    expect(head()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText("I'll check the rates skill first.")).toBeVisible();
    const next = { id: 'phases-next-answer', role: 'assistant', content: 'Swaps rose.' };
    view.rerender(<Chat messages={[...work, toolNote, next]} running />);
    expect(head()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Swaps rose.')).toBeVisible();
    expect(head()).toHaveTextContent(/^Working · 0s$/);
    fireEvent.click(head());
    view.rerender(<Chat messages={[...work, toolNote, next]} running={false} />);
    expect(head()).toHaveAttribute('aria-expanded', 'false');
    expect(head()).toHaveTextContent(/^Worked for 0s$/);
  });

  it('reopens for reasoning after an answer and keeps work open beside a proposal', () => {
    const messages = turn('resume');
    const view = render(<Chat messages={messages} running />);
    expect(head()).toHaveAttribute('aria-expanded', 'false');
    const reasoning = { id: 'resume-reasoning', role: 'reasoning', content: 'Check the benchmark.' };
    view.rerender(<Chat messages={[...messages, reasoning]} running />);
    expect(head()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Check the benchmark.')).toBeVisible();
    const proposal = { id: 'resume-proposal', role: 'assistant', content: 'Propose a brief.', toolCalls: [call('resume-pc', 'propose_scheduled_task')] };
    view.rerender(<Chat messages={[...messages, reasoning, proposal]} running />);
    expect(head()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Propose a brief.')).toBeVisible();
    expect(screen.getByText('Check the benchmark.')).toBeVisible();
  });

  it('folds an earlier Worklog the user opened once they ask again', () => {
    const first = turn('again');
    const view = render(<Chat messages={first} running={false} />);
    fireEvent.click(head());
    expect(head()).toHaveAttribute('aria-expanded', 'true');

    view.rerender(<Chat messages={[...first, { id: 'again-next', role: 'user', content: 'And swaps?' }]} running />);

    expect(head()).toHaveAttribute('aria-expanded', 'false');
  });

  it('leaves a proposed schedule, which waits on the user, outside the Worklog', () => {
    const [question, note, result, answer] = turn('proposal');
    assert(question && note && result && answer, 'the Turn');
    const proposal = { id: 'proposal-p', role: 'assistant', content: "I'll propose a weekday brief.", toolCalls: [call('proposal-pc', 'propose_scheduled_task')] };
    render(<Chat messages={[question, note, result, proposal, { id: 'proposal-pt', role: 'tool', toolCallId: 'proposal-pc', content: 'Proposed' }, answer]} running={false} />);

    expect(heads()).toHaveLength(1);
    expect(screen.queryByText("I'll check the rates skill first.")).toBeNull();
    expect(screen.getByText("I'll propose a weekday brief.")).toBeVisible();
  });

  it('leaves a published Artifact, the deliverable, outside the Worklog', () => {
    const [question, note, result, answer] = turn('artifact');
    assert(question && note && result && answer, 'the Turn');
    const publish = { id: 'artifact-p', role: 'assistant', content: 'Publishing the chart.', toolCalls: [call('artifact-pc', 'Artifact', { file_path: '/q3.html' })] };
    render(<Chat messages={[question, note, result, publish, { id: 'artifact-pt', role: 'tool', toolCallId: 'artifact-pc', content: '{}' }, answer]} running={false} />);

    expect(heads()).toHaveLength(1);
    expect(screen.queryByText("I'll check the rates skill first.")).toBeNull();
    expect(screen.getByText('Publishing the chart.')).toBeVisible();
  });

  it("shows each text after the Turn's last tool call as its own bubble, and folds a text a call follows", () => {
    const [question, note, result, answer] = turn('texts');
    assert(question && note && result && answer, 'the Turn');
    const first = { id: 'texts-first', role: 'assistant', content: 'Rates fell.', ...stamp(30, 31) };
    const second = { id: 'texts-second', role: 'assistant', content: 'Swaps followed.' };
    const view = render(<Chat messages={[question, first, note, result, answer, second]} running={false} />);

    expect(heads()).toHaveLength(1);
    expect(screen.queryByText('Rates fell.')).toBeNull();
    expect(screen.getByText('2s10s steepened to +45bp.')).toBeVisible();
    expect(screen.getByText('Swaps followed.')).toBeVisible();
    expect(view.container.lastElementChild?.previousElementSibling).toHaveTextContent('2s10s steepened to +45bp.');
  });

  it('shows the Turn its last text when no text follows its last tool call', () => {
    const question = { id: 'early-u', role: 'user', content: 'One-minute US rates update' };
    const answer = { id: 'early-a', role: 'assistant', content: 'Rates fell.' };
    const calling = { id: 'early-c', role: 'assistant', content: '', toolCalls: [call('early-cc', 'read_file')] };
    const result = { id: 'early-t', role: 'tool', toolCallId: 'early-cc', content: '---\nname: rates' };
    render(<Chat messages={[question, answer, calling, result, { id: 'early-e', role: 'assistant', content: '' }]} running={false} />);

    expect(heads()).toHaveLength(1);
    expect(screen.getByText('Rates fell.')).toBeVisible();
  });

  it("shows each scheduled run's card the Chat Service posts after a Turn, folding none and leaving the Turn's answer outside", () => {
    const card = (id: string, title: string) => ({ id, role: 'assistant', content: `Scheduled task "${title}": done`, metadata: { scheduledRun: { title } } });
    render(<Chat messages={[...turn('runs'), card('runs-1', 'Oil brief'), card('runs-2', 'Credit brief')]} running={false} />);

    expect(heads()).toHaveLength(1);
    expect(screen.getByText('2s10s steepened to +45bp.')).toBeVisible();
    expect(screen.getByText('Scheduled task "Oil brief": done')).toBeVisible();
    expect(screen.getByText('Scheduled task "Credit brief": done')).toBeVisible();
  });

  it("folds the rows CopilotKit's own message list lays out, custom-message slots and renamed messages included", () => {
    const messages = turn('copilotkit');
    const view = render(<CopilotKitChat messages={messages} />);

    expect(heads()).toHaveLength(1);
    expect(head()).toHaveTextContent(/^Worked for 38s$/);
    expect(screen.queryByText("I'll check the rates skill first.")).toBeNull();
    expect(screen.getByText('2s10s steepened to +45bp.')).toBeVisible();

    // A merged stream can rename a note: CopilotKit keeps its row's key, found by its tool call.
    const [question, note, ...rest] = messages;
    assert(question && note, 'the Turn');
    view.rerender(<CopilotKitChat messages={[question, { ...note, id: 'copilotkit-renamed' }, ...rest]} />);

    expect(heads()).toHaveLength(1);
    expect(screen.queryByText("I'll check the rates skill first.")).toBeNull();
  });
});

describe('a tool step', () => {
  it('shows a denied copy in the dialog, keeps the text available, and clears the error after a successful retry', async () => {
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new DOMException('Write permission denied.', 'NotAllowedError'));
    try {
      render(<ToolStep name="execute" params={{ command: 'printf hunter' }} status="complete" output="hunter" />);
      await user.click(screen.getByRole('button', { name: /^Ran/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Terminal' });
      const copy = within(dialog).getByRole('button', { name: 'Copy command' });
      await user.click(copy);
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(/^Copy failed\. Select the text to copy it manually, or try again\.$/);
      expect(dialog.querySelector('.step-section-text')).toHaveTextContent('printf hunter');
      expect(dialog.querySelector('.step-section-text')).toBeVisible();
      expect(copy.querySelector('.lucide-check')).toBeNull();
      await user.click(copy);
      await waitFor(() => expect(within(dialog).queryByRole('alert')).toBeNull());
      expect(await navigator.clipboard.readText()).toBe('printf hunter');
      expect(copy.querySelector('.lucide-check')).not.toBeNull();
    } finally {
      write.mockRestore();
    }
  });

  it('clears the copied indicator when a running command changes after copying', async () => {
    const user = userEvent.setup();
    const view = render(<ToolStep name="execute" params={{ command: 'printf old' }} status="running" output={undefined} />);
    await user.click(screen.getByRole('button', { name: /^Running/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Terminal' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await act(async () => fireEvent.click(within(dialog).getByRole('button', { name: 'Copy command' })));
    expect(await navigator.clipboard.readText()).toBe('printf old');
    expect(within(dialog).getByRole('button', { name: 'Copy command' }).querySelector('.lucide-check')).not.toBeNull();

    view.rerender(<ToolStep name="execute" params={{ command: 'printf old && printf new' }} status="running" output={undefined} />);

    expect(dialog).toHaveTextContent('printf old && printf new');
    expect(await navigator.clipboard.readText()).toBe('printf old');
    expect(within(dialog).getByRole('button', { name: 'Copy command' }).querySelector('.lucide-check')).toBeNull();
  });

  /** Each of the sheet's sections as its label and the rest of its text. */
  const sections = (sheet: HTMLElement) =>
    Array.from(sheet.querySelectorAll('.step-section'), (section) => [section.querySelector('.step-section-label')?.textContent, section.textContent.replace(section.querySelector('.step-section-label')?.textContent ?? '', '')]);

  it('reads a running command by its verb and the command exactly as run', () => {
    const { container } = render(<ToolStep name="execute" params={{ command: 'acme search "Japan"', timeout: null }} status="running" output={undefined} />);

    expect(container).toHaveTextContent(/^Runningacme search "Japan"$/);
  });

  it("opens a failed command to a sheet titled by its tool: the full command, its exit code, and its output without the trailer", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ToolStep
        name="execute"
        params={{ command: 'acme widget view @s3 --json' }}
        status="complete"
        output={'[stderr] Specify one or more comma-separated fields for `--json`\n[Command failed with exit code 1]'}
      />,
    );
    expect(container.querySelector('.lucide-circle-x')).not.toBeNull();
    const step = screen.getByRole('button', { name: /^Ran/ });
    expect(step).toHaveAttribute('aria-haspopup', 'dialog');

    await user.click(step);

    const sheet = await screen.findByRole('dialog', { name: 'Terminal' });
    expect(step).toHaveAttribute('aria-expanded', 'true');
    expect(sections(sheet)).toEqual([
      ['Command', 'acme widget view @s3 --json'],
      ['Output', 'Exit 1[stderr] Specify one or more comma-separated fields for `--json`'],
    ]);
    await user.click(within(sheet).getByRole('button', { name: 'Copy command' }));
    expect(await navigator.clipboard.readText()).toBe('acme widget view @s3 --json');
    expect(within(sheet).getByRole('button', { name: 'Copy command' }).querySelector('.lucide-check')).not.toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(step).toHaveAttribute('aria-expanded', 'false');
  });

  it('holds each word of a command together, so it wraps only at a space', async () => {
    render(<ToolStep name="execute" params={{ command: 'acme search "US CPI" --limit 1' }} status="complete" output="1 result" />);

    fireEvent.click(screen.getByRole('button', { name: /^Ran/ }));

    const sheet = await screen.findByRole('dialog');
    expect(Array.from(sheet.querySelectorAll('.step-section-text .code-word'), (word) => word.textContent)).toEqual(['"US', 'CPI"', '--limit']);
  });

  it("opens a call whose argument is all it has, and shows a description that isn't its input above it", async () => {
    render(<ToolStep name="execute" params={{ command: 'acme ls', description: 'List the files' }} status="running" output={undefined} />);

    fireEvent.click(screen.getByRole('button', { name: /^Running/ }));

    expect(sections(await screen.findByRole('dialog', { name: 'Terminal' }))).toEqual([['Description', 'List the files'], ['Command', 'acme ls']]);
  });

  it.each([
    ['its description, when that is all it has', 'task', { description: 'Compare research' }, 'Helper', [['Description', 'Compare research']]],
    ['every argument, not only its one text', 'read_file', { file_path: '/a.md', offset: 10, limit: 5 }, 'Read file', [['Input', '{\n  "file_path": "/a.md",\n  "offset": 10,\n  "limit": 5\n}']]],
    ['all its arguments', 'read_file', { file_path: '/a.md', path: '/b' }, 'Read file', [['Input', '{\n  "file_path": "/a.md",\n  "path": "/b"\n}']]],
    ['its name, for a tool it has no title for', 'fetch_quote', { ticker: 'GS' }, 'Fetch quote', [['Input', 'GS']]],
  ])('reads a call by %s', async (_case, name, params, title, shown) => {
    render(<ToolStep name={name} params={params} status="complete" output={undefined} />);

    fireEvent.click(screen.getByRole('button'));

    expect(sections(await screen.findByRole('dialog', { name: title }))).toEqual(shown);
  });

  it('keeps the exit code of a failed command that printed nothing', async () => {
    render(<ToolStep name="execute" params={{ command: 'acme sync' }} status="complete" output={'\n[Command failed with exit code 2]'} />);

    fireEvent.click(screen.getByRole('button'));

    expect(sections(await screen.findByRole('dialog', { name: 'Terminal' }))).toEqual([['Command', 'acme sync'], ['Output', 'Exit 2']]);
  });

  it('marks a command that succeeded after quoting a failure as done', () => {
    const { container } = render(
      <ToolStep name="execute" params={{ command: 'cat log' }} status="complete" output={'log\n[Command failed with exit code 1]\n[Command succeeded with exit code 0]'} />,
    );

    expect(container.querySelector('.lucide-circle-x')).toBeNull();
    expect(container.querySelector('.lucide-square-terminal')).not.toBeNull();
  });

  it('marks a stopped call', () => {
    const { container } = render(<ToolStep name="task" params={{ description: 'Compare research' }} status="stopped" output={undefined} />);

    expect(container).toHaveTextContent(/^Stopped · Asked a helperCompare research$/);
  });

  it('marks a call a stopped Turn cut as stopped once replayed, opening to its input alone', async () => {
    const { container } = render(
      <ToolStep name="execute" params={{ command: 'sleep 30; echo slept' }} status="complete" output="Tool call 'execute' with id 'call_dl0u' was interrupted before completion." />,
    );

    expect(container).toHaveTextContent(/^Stopped · Ransleep 30; echo slept$/);
    expect(container.querySelector('.worklog-step')).toHaveAttribute('data-state', 'stopped');
    fireEvent.click(screen.getByRole('button', { name: /^Stopped · Ran/ }));
    expect(sections(await screen.findByRole('dialog', { name: 'Terminal' }))).toEqual([['Command', 'sleep 30; echo slept']]);
  });

  it('is a plain row, not a control, while it has nothing to open to', () => {
    const { container } = render(<ToolStep name="execute" params={{ timeout: null }} status="running" output={undefined} />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(container).toHaveTextContent(/^Running$/);
  });

  it('opens a call with no argument to its output alone, with no input section', async () => {
    render(<ToolStep name="ls" params={{}} status="complete" output="notes.md" />);

    fireEvent.click(screen.getByRole('button', { name: /^Listed/ }));

    expect(sections(await screen.findByRole('dialog', { name: 'List files' }))).toEqual([['Output', 'notes.md']]);
  });
});

/** The chat's rows as the chat surface lays them out: a thought, each tool call, a note or the answer. */
function StepsChat({ messages, running = false }: { messages: readonly TurnMessage[]; running?: boolean }) {
  const latest = messages.at(-1)?.id;
  const rows = messages.filter(({ role }) => role !== 'tool').map((message) => {
    if (message.role === 'reasoning') return <ThoughtStep key={message.id} message={message} isRunning={running} isLatest={message.id === latest} />;
    const calls = (message.toolCalls as ReturnType<typeof call>[] | undefined)?.map(({ id, function: { name, arguments: args } }) => {
      const result = messages.find((other) => other.toolCallId === id);
      return <ToolStep key={id} id={id} name={name} params={JSON.parse(args) as Record<string, unknown>} status={result ? 'complete' : 'running'} output={result ? String(result.content) : undefined} />;
    });
    return <div key={message.id}>{calls ?? String(message.content)}</div>;
  });
  return <>{worklogRows(rows, messages, running)}</>;
}

const longCommand = 'acme data query --dataset EQUITY_PRICES --ticker AAPL --start 2026-10-14T13:30:00Z --end 2026-10-14T20:00:00Z --fields open,high,low,close,volume';

/** A replayed Turn: its question stamped at Send, a thought, a search, a thought with no words, a command, the answer. */
const timed = (prefix: string, startup = 6.4) => [
  { id: `${prefix}u`, role: 'user' as const, content: 'Fed minutes and AAPL', ...stamp(0, 0) },
  { id: `${prefix}r1`, role: 'reasoning' as const, content: '**Planning the search**\n\nMinutes first, then the price pull.', ...stamp(startup, 15.2) },
  { id: `${prefix}a1`, role: 'assistant' as const, content: '', toolCalls: [call(`${prefix}c1`, 'web_search', { query: 'Fed minutes October 2026' })], ...stamp(15.2, 16) },
  { id: `${prefix}t1`, role: 'tool' as const, toolCallId: `${prefix}c1`, content: 'results', ...stamp(15.3, 19.6) },
  { id: `${prefix}r2`, role: 'reasoning' as const, content: '', ...stamp(19.6, 21.9) },
  { id: `${prefix}a2`, role: 'assistant' as const, content: '', toolCalls: [call(`${prefix}c2`, 'execute', { command: longCommand })], ...stamp(21.9, 23) },
  { id: `${prefix}t2`, role: 'tool' as const, toolCallId: `${prefix}c2`, content: 'ok', ...stamp(22, 24.8) },
  { id: `${prefix}f`, role: 'assistant' as const, content: 'AAPL fell 0.8% after the release.', ...stamp(25, 35.6) },
];

/** Each step row's label and its time, once the Worklog is open. */
const stepRows = () => Array.from(document.querySelectorAll('.worklog-step'), (step) => [
  step.querySelector('.worklog-step-label')?.textContent, step.querySelector('.worklog-step-time')?.textContent ?? null,
]);
const secondsIn = (time: string | null | undefined) => {
  const [, minutes, rest] = /^(?:(\d+)m )?(\d+)s$/.exec(time ?? '') ?? [];
  return Number(minutes ?? 0) * 60 + Number(rest);
};

describe("a Worklog's step times", () => {
  it.each(['tool', 'thought'] as const)('omits an unallocated %s clock from its detail title', async (kind) => {
    const prefix = `unallocated-${kind}`;
    const question = { id: `${prefix}-u`, role: 'user', content: 'Compare markets', ...stamp(0, 0) };
    const work = kind === 'tool' ? [
      { id: `${prefix}-a`, role: 'assistant', content: '', toolCalls: [call(`${prefix}-c`, 'execute', { command: 'research' })], ...stamp(23, 23) },
      { id: `${prefix}-t`, role: 'tool', toolCallId: `${prefix}-c`, content: 'Done', ...stamp(23, 23.2) },
    ] : [{ id: `${prefix}-r`, role: 'reasoning', content: '**Plan**', ...stamp(23, 23.2) }];
    render(<StepsChat messages={[question, ...work]} />);
    fireEvent.click(head());
    fireEvent.click(screen.getByRole('button', { name: kind === 'tool' ? /^Ran/ : /^Thought/ }));
    const title = await screen.findByRole('heading', { name: kind === 'tool' ? /^Terminal/ : /^Thought/ });
    expect(title).toHaveTextContent(kind === 'tool' ? /^Terminal$/ : /^Thought$/);
  });

  it('waits for a positive allocation before revealing a new step clock', () => {
    vi.useFakeTimers({ now: START + 23000 });
    const question = { id: 'first-clock-u', role: 'user', content: 'Compare investment markets', ...stamp(0, 0) };
    const first = { id: 'first-clock-a', role: 'assistant', content: '', toolCalls: [call('first-clock-c', 'execute', { command: 'research' })], ...stamp(23, 23) };
    const view = render(<StepsChat messages={[question, first]} running />);
    const clock = view.container.querySelector('.worklog-step[data-kind="tool"] .worklog-step-time');
    assert(clock, 'the running tool clock');
    expect(head()).toHaveTextContent(/^Working · 23s$/);
    expect(clock).toHaveTextContent(/^0s$/);
    expect(clock).not.toBeVisible();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(clock).toBeVisible();
    expect(clock).toHaveTextContent(/^1s$/);
    expect(head()).toHaveTextContent(/^Working · 24s$/);
    const result = { id: 'first-clock-t', role: 'tool', toolCallId: 'first-clock-c', content: 'Done', ...stamp(23, 23.2) };
    const next = { id: 'next-clock-a', role: 'assistant', content: '', toolCalls: [call('next-clock-c', 'execute', { command: 'calculate' })], ...stamp(24, 24) };
    view.rerender(<StepsChat messages={[question, first, result, next]} running />);
    const clocks = view.container.querySelectorAll('.worklog-step[data-kind="tool"] .worklog-step-time');
    expect(clocks[0]).toBeVisible();
    expect(clocks[0]).toHaveTextContent(/^1s$/);
    expect(clocks[1]).not.toBeVisible();
    const visibleSeconds = [...view.container.querySelectorAll('.worklog-step-time')].filter((element) => getComputedStyle(element).visibility !== 'hidden').reduce((sum, element) => sum + secondsIn(element.textContent), 0);
    expect(visibleSeconds).toBe(24);
    expect(head()).toHaveTextContent(/^Working · 24s$/);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(clocks[1]).toBeVisible();
    expect(clocks[1]).toHaveTextContent(/^1s$/);
    expect(clocks[0]).toHaveTextContent(/^1s$/);
    expect(head()).toHaveTextContent(/^Working · 25s$/);
  });

  it('keeps card-separated views from double-counting the same Turn', () => {
    vi.useFakeTimers({ now: START + 8000 });
    const messages = [
      { id: 'card-clock-u', role: 'user', content: 'Build a chart and compare rates', ...stamp(0, 0) },
      { id: 'card-clock-r', role: 'reasoning', content: 'Plan', ...stamp(0, 2) },
      { id: 'card-clock-card', role: 'assistant', content: '', toolCalls: [call('card-clock-artifact', 'Artifact', { description: 'Rates chart' })], ...stamp(2, 2) },
      { id: 'card-clock-card-result', role: 'tool', toolCallId: 'card-clock-artifact', content: 'Chart ready', ...stamp(2, 4) },
      { id: 'card-clock-next', role: 'assistant', content: '', toolCalls: [call('card-clock-query', 'execute', { command: 'compare rates' })], ...stamp(4, 4) },
      { id: 'card-clock-next-result', role: 'tool', toolCallId: 'card-clock-query', content: 'Done', ...stamp(4, 6) },
      { id: 'card-clock-answer', role: 'assistant', content: 'Rates compared.', ...stamp(6, 8) },
    ];
    render(<StepsChat messages={messages} running />);
    expect(heads()).not.toHaveLength(0);
    for (const header of heads()) expect(header).toHaveTextContent(/^Working · 8s$/);
    for (const header of heads()) fireEvent.click(header);
    const diagnosticIds = [...document.querySelectorAll('.worklog-step')].map(step => step.getAttribute('data-step-id'));
    expect(new Set(diagnosticIds).size).toBe(diagnosticIds.length);
    act(() => { vi.advanceTimersByTime(1000); });
    for (const header of heads()) expect(header).toHaveTextContent(/^Working · 9s$/);
  });

  it('keeps seconds on their rows when replay corrects the Turn start by a fraction', () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'fraction-origin-u', role: 'user', content: 'Rates' };
    const first = { id: 'fraction-origin-a1', role: 'assistant', content: '', toolCalls: [call('fraction-origin-c1', 'execute', { command: 'first' })], ...stamp(0, 0) };
    const chat = (messages: TurnMessage[]) => <TurnStart.Provider value={new Date(START).toISOString()}><StepsChat messages={messages} running /></TurnStart.Provider>;
    const view = render(chat([question, first]));
    act(() => { vi.advanceTimersByTime(400); });
    const result = { id: 'fraction-origin-t', role: 'tool', toolCallId: 'fraction-origin-c1', content: 'Done', ...stamp(0, 0.4) };
    const second = { id: 'fraction-origin-a2', role: 'assistant', content: '', toolCalls: [call('fraction-origin-c2', 'execute', { command: 'second' })], ...stamp(0.4, 0.4) };
    view.rerender(chat([question, first, result, second]));
    act(() => { vi.advanceTimersByTime(600); });
    expect(stepRows()).toEqual([['Ranfirst', '0s'], ['Runningsecond', '1s']]);
    view.rerender(chat([{ ...question, ...stamp(-0.4, -0.4) }, first, result, second]));
    expect(stepRows()).toEqual([['Ranfirst', '0s'], ['Runningsecond', '1s']]);
    expect(head()).toHaveTextContent(/^Working · 1s$/);
  });

  it('keeps a historical Turn on its own timestamps while another Turn runs', () => {
    const [question, ...rest] = timed('historical-current');
    assert(question, 'a question');
    render(<TurnStart.Provider value={new Date(START + 100000).toISOString()}>
      <StepsChat messages={[{ ...question, metadata: undefined }, ...rest]} />
    </TurnStart.Provider>);
    expect(head()).toHaveTextContent(/^Worked for 29s$/);
    fireEvent.click(head());
    expect(stepRows().reduce((sum, [, time]) => sum + secondsIn(time), 0)).toBe(29);
  });

  it('accounts for the final wait when a Turn stops without an answer', () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'stopped-wait-u', role: 'user', content: 'Rates', ...stamp(0, 0) };
    const tool = { id: 'stopped-wait-a', role: 'assistant', content: '', toolCalls: [call('stopped-wait-c', 'execute', { command: 'rates' })], ...stamp(0, 0) };
    const view = render(<StepsChat messages={[question, tool]} running />);
    act(() => { vi.advanceTimersByTime(2000); });
    const result = { id: 'stopped-wait-t', role: 'tool', toolCallId: 'stopped-wait-c', content: 'Done', ...stamp(0, 2) };
    view.rerender(<StepsChat messages={[question, tool, result]} running />);
    act(() => { vi.advanceTimersByTime(2000); });
    vi.setSystemTime(START + 4600);
    view.rerender(<StepsChat messages={[question, tool, result]} />);
    expect(head()).toHaveTextContent(/^Worked for 5s$/);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Ranrates', '5s']]);
  });

  it('keeps displayed tool time when the earlier server Turn start arrives', () => {
    vi.useFakeTimers({ now: START + 9000 });
    const question = { id: 'late-origin-u', role: 'user', content: 'Rates' };
    const tool = { id: 'late-origin-a', role: 'assistant', content: '', toolCalls: [call('late-origin-c', 'execute', { command: 'rates' })], ...stamp(3, 3) };
    const view = render(<StepsChat messages={[question, tool]} running />);
    expect(head()).toHaveTextContent(/^Working · 6s$/);
    view.rerender(<TurnStart.Provider value={new Date(START).toISOString()}><StepsChat messages={[question, tool]} running /></TurnStart.Provider>);
    expect(head()).toHaveTextContent(/^Working · 9s$/);
    expect(stepRows()).toEqual([['Started up', '3s'], ['Runningrates', '6s']]);
  });

  it('refreshes Turn time immediately on reconnect after a paused browser clock', () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'online-u', role: 'user', content: 'Rates', ...stamp(0, 0) };
    const tool = { id: 'online-a', role: 'assistant', content: '', toolCalls: [call('online-c', 'execute', { command: 'rates' })], ...stamp(0, 0) };
    render(<StepsChat messages={[question, tool]} running />);
    act(() => {
      vi.setSystemTime(START + 5000);
      window.dispatchEvent(new Event('online'));
    });
    expect(head()).toHaveTextContent(/^Working · 5s$/);
    expect(stepRows()).toEqual([['Runningrates', '5s']]);
  });

  it('retains step times on a reload mid-Turn after delayed replay', async () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'reload-live-u', role: 'user', content: 'Compare rates', ...stamp(0, 0) };
    const tool = { id: 'reload-live-a', role: 'assistant', content: '', toolCalls: [call('reload-live-first', 'execute', { command: 'first' }), call('reload-live-second', 'execute', { command: 'second' })], ...stamp(0, 0) };
    const view = render(<StepsChat messages={[question, tool]} running />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(stepRows()).toEqual([['Runningfirst', '5s'], ['Runningsecond', '0s']]);
    view.unmount();
    vi.setSystemTime(START + 9000);
    vi.resetModules();
    const reloaded = await import('./worklog');
    const result = { id: 'reload-live-t', role: 'tool', toolCallId: 'reload-live-first', content: 'Done', ...stamp(0, 0.2) };
    render(<reloaded.Worklog id="reload-live-a" asked="reload-live-u" question={question} turn={[tool, result]} running>
      <reloaded.ToolStep id="reload-live-first" name="execute" params={{ command: 'first' }} status="complete" output="Done" />
      <reloaded.ToolStep id="reload-live-second" name="execute" params={{ command: 'second' }} status="running" output={undefined} />
    </reloaded.Worklog>);
    expect(stepRows()).toEqual([['Ranfirst', '5s'], ['Runningsecond', '4s']]);
    expect(head()).toHaveTextContent(/^Working · 9s$/);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(stepRows()).toEqual([['Ranfirst', '5s'], ['Runningsecond', '5s']]);
  });

  it('retains completed step allocations when reload replaces the message view key', async () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'view-reload-u', role: 'user', content: 'Compare rates', ...stamp(0, 0) };
    const tool = { id: 'view-reload-live', role: 'assistant', content: '', toolCalls: [call('view-reload-first', 'execute', { command: 'first' }), call('view-reload-second', 'execute', { command: 'second' })], ...stamp(0, 0) };
    const view = render(<StepsChat messages={[question, tool]} running />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(stepRows()).toEqual([['Runningfirst', '5s'], ['Runningsecond', '0s']]);
    view.unmount();
    vi.setSystemTime(START + 9000);
    vi.resetModules();
    const reloaded = await import('./worklog');
    const result = { id: 'view-reload-t', role: 'tool', toolCallId: 'view-reload-first', content: 'Done', ...stamp(0, 0.2) };
    const replayed = { ...tool, id: 'view-reload-persisted' };
    const restored = render(<reloaded.Worklog id="view-reload-persisted" asked={question.id} question={question} turn={[replayed, result]} running>
      <reloaded.ToolStep id="view-reload-first" name="execute" params={{ command: 'first' }} status="complete" output="Done" />
      <reloaded.ToolStep id="view-reload-second" name="execute" params={{ command: 'second' }} status="running" output={undefined} />
    </reloaded.Worklog>);
    expect(stepRows()).toEqual([['Ranfirst', '5s'], ['Runningsecond', '4s']]);
    expect(head()).toHaveTextContent(/^Working · 9s$/);
    act(() => { vi.advanceTimersByTime(1000); });
    restored.unmount();
    vi.resetModules();
    const again = await import('./worklog');
    render(<again.Worklog id="view-reload-again" asked={question.id} question={question} turn={[{ ...replayed, id: 'view-reload-again' }, result]} running>
      <again.ToolStep id="view-reload-first" name="execute" params={{ command: 'first' }} status="complete" output="Done" />
      <again.ToolStep id="view-reload-second" name="execute" params={{ command: 'second' }} status="running" output={undefined} />
    </again.Worklog>);
    expect(stepRows()).toEqual([['Ranfirst', '5s'], ['Runningsecond', '5s']]);
    expect(head()).toHaveTextContent(/^Working · 10s$/);
  });

  it('keeps later elapsed time when replay moves an earlier completion forward', () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'forward-u', role: 'user', content: 'Compare rates', ...stamp(0, 0) };
    const first = { id: 'forward-a1', role: 'assistant', content: '', toolCalls: [call('forward-c1', 'execute', { command: 'first' })], ...stamp(0, 0) };
    const view = render(<StepsChat messages={[question, first]} running />);
    act(() => { vi.advanceTimersByTime(2000); });
    const result = { id: 'forward-t1', role: 'tool', toolCallId: 'forward-c1', content: 'Done', ...stamp(0, 2) };
    const second = { id: 'forward-a2', role: 'assistant', content: '', toolCalls: [call('forward-c2', 'execute', { command: 'second' })], ...stamp(2, 2) };
    view.rerender(<StepsChat messages={[question, first, result, second]} running />);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(stepRows()).toEqual([['Ranfirst', '2s'], ['Runningsecond', '3s']]);
    view.rerender(<StepsChat messages={[question, first, { ...result, ...stamp(0, 5) }, second]} running />);
    expect(stepRows()).toEqual([['Ranfirst', '2s'], ['Runningsecond', '3s']]);
    expect(head()).toHaveTextContent(/^Working · 5s$/);
  });

  it('keeps the startup row and its time when replay backdates the first tool start', () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'backdated-u', role: 'user', content: 'Search' };
    const tool = { id: 'backdated-a', role: 'assistant', content: '', toolCalls: [call('backdated-c', 'execute', { command: 'rates' })] };
    const chat = (messages: TurnMessage[]) => <TurnStart.Provider value={new Date(START).toISOString()}><StepsChat messages={messages} running /></TurnStart.Provider>;
    const view = render(chat([question]));
    act(() => { vi.advanceTimersByTime(2000); });
    view.rerender(chat([question, tool]));
    act(() => { vi.advanceTimersByTime(3000); });
    expect(stepRows()).toEqual([['Started up', '2s'], ['Runningrates', '3s']]);
    view.rerender(chat([{ ...question, ...stamp(0, 0) }, { ...tool, ...stamp(0, 0) }]));
    expect(stepRows()).toEqual([['Started up', '2s'], ['Runningrates', '3s']]);
    expect(head()).toHaveTextContent(/^Working · 5s$/);
  });

  it('keeps displayed parallel time from resetting to zero when a delayed result arrives', async () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'delayed-u', role: 'user', content: 'Compare rates', ...stamp(0, 0) };
    const tools = { id: 'delayed-a', role: 'assistant', content: '', toolCalls: [call('delayed-first', 'execute', { command: 'first' }), call('delayed-second', 'execute', { command: 'second' })], ...stamp(0, 0) };
    const view = render(<StepsChat messages={[question, tools]} running />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(stepRows()).toEqual([['Runningfirst', '5s'], ['Runningsecond', '0s']]);

    const result = { id: 'delayed-t', role: 'tool', toolCallId: 'delayed-first', content: 'Done', ...stamp(0, 0.2) };
    view.rerender(<StepsChat messages={[question, tools, result]} running />);
    expect(stepRows()).toEqual([['Ranfirst', '5s'], ['Runningsecond', '0s']]);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(stepRows()).toEqual([['Ranfirst', '5s'], ['Runningsecond', '1s']]);
    expect(head()).toHaveTextContent(/^Working · 6s$/);
    view.unmount();
    vi.resetModules();
    const reloaded = await import('./worklog');
    const second = { id: 'delayed-second-t', role: 'tool', toolCallId: 'delayed-second', content: 'Done', ...stamp(0, 6) };
    render(<reloaded.Worklog id="delayed-a" asked="delayed-u" question={question} turn={[tools, result, second]} running={false}>
      <reloaded.ToolStep id="delayed-first" name="execute" params={{ command: 'first' }} status="complete" output="Done" />
      <reloaded.ToolStep id="delayed-second" name="execute" params={{ command: 'second' }} status="complete" output="Done" />
    </reloaded.Worklog>);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Ranfirst', '5s'], ['Ransecond', '1s']]);
    expect(head()).toHaveTextContent(/^Worked for 6s$/);
  });

  it('keeps twelve tool rows and their times in order through reversed completion and replay', () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'reverse-u', role: 'user', content: 'Compare markets', ...stamp(0, 0) };
    const calls = Array.from({ length: 12 }, (_, index) => call(`reverse-${index}`, 'execute', { command: `market ${index}` }));
    const tools = { id: 'reverse-a', role: 'assistant', content: '', toolCalls: calls, ...stamp(0, 0) };
    const view = render(<StepsChat messages={[question, tools]} running />);
    act(() => { vi.advanceTimersByTime(5000); });
    const order = calls.map((_, index) => `market ${index}`);
    const results: TurnMessage[] = [];
    for (const tool of [...calls].reverse()) {
      results.push({ id: `${tool.id}-result`, role: 'tool', toolCallId: tool.id, content: 'Done', ...stamp(0, 5) });
      view.rerender(<StepsChat messages={[question, tools, ...results]} running />);
      expect(stepRows().map(([label]) => label?.replace(/^Running|^Ran/, ''))).toEqual(order);
      expect(stepRows().map(([, time]) => time)).toEqual(['5s', '0s', '0s', '0s', '0s', '0s', '0s', '0s', '0s', '0s', '0s', '0s']);
    }
    view.rerender(<StepsChat messages={[question, tools, ...results]} />);
    fireEvent.click(head());
    const completed = stepRows();
    view.unmount();
    render(<StepsChat messages={[question, tools, ...results]} />);
    fireEvent.click(head());
    expect(stepRows()).toEqual(completed);
  });

  it('accounts for every second between twelve sequential finance tool steps', () => {
    vi.useFakeTimers({ now: START });
    const messages: TurnMessage[] = [{ id: 'finance-u', role: 'user', content: 'Compare twelve markets', ...stamp(0, 0) }];
    const view = render(<StepsChat messages={messages} running />);
    const gaps: number[] = [];
    for (let index = 0; index < 12; index++) {
      const began = index * 3;
      const id = `finance-${index}`;
      messages.push({ id: `${id}-a`, role: 'assistant', content: '', toolCalls: [call(id, 'execute', { command: `market ${index}` })], ...stamp(began, began) });
      view.rerender(<StepsChat messages={[...messages]} running />);
      act(() => { vi.advanceTimersByTime(2000); });
      messages.push({ id: `${id}-t`, role: 'tool', toolCallId: id, content: 'Done', ...stamp(began, began + 2) });
      view.rerender(<StepsChat messages={[...messages]} running />);
      act(() => { vi.advanceTimersByTime(1000); });
      const sum = stepRows().reduce((total, [, time]) => total + secondsIn(time), 0);
      const total = secondsIn(/· (.+)$/.exec(head().textContent)?.[1]);
      gaps.push(total - sum);
    }
    expect(stepRows()).toHaveLength(12);
    expect(gaps).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('keeps the step sum equal to the running Turn while waiting after a tool result', () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'between-u', role: 'user', content: 'Compare markets', ...stamp(0, 0) };
    const tools = { id: 'between-a', role: 'assistant', content: '', toolCalls: [call('between-c', 'execute', { command: 'rates' })], ...stamp(0, 0) };
    const view = render(<StepsChat messages={[question, tools]} running />);
    act(() => { vi.advanceTimersByTime(2000); });
    const result = { id: 'between-t', role: 'tool', toolCallId: 'between-c', content: 'Done', ...stamp(0, 2) };
    view.rerender(<StepsChat messages={[question, tools, result]} running />);
    act(() => { vi.advanceTimersByTime(1000); });

    expect(head()).toHaveTextContent(/^Working · 3s$/);
    expect(stepRows().reduce((sum, [, time]) => sum + secondsIn(time), 0)).toBe(3);
  });

  it('keeps a finished fractional step from dropping to zero when the next step finishes', () => {
    vi.useFakeTimers({ now: START + 600 });
    const question = { id: 'fraction-u', role: 'user', content: 'Search', ...stamp(0, 0) };
    const thought = { id: 'fraction-r', role: 'reasoning', content: 'Plan', ...stamp(0, 0.6) };
    const search = { id: 'fraction-a', role: 'assistant', content: '', toolCalls: [call('fraction-c', 'web_search', { query: 'Fed' })], ...stamp(0.6, 0.6) };
    const view = render(<StepsChat messages={[question, thought, search]} running />);
    expect(stepRows()).toEqual([['Thought', '1s'], ['Searching the webFed', '0s']]);

    act(() => { vi.setSystemTime(START + 1300); });
    const result = { id: 'fraction-t', role: 'tool', toolCallId: 'fraction-c', content: 'Found', ...stamp(0.6, 1.3) };
    view.rerender(<StepsChat messages={[question, thought, search, result]} running />);

    expect(stepRows()).toEqual([['Thought', '1s'], ['Searched the webFed', '0s']]);
    expect(head()).toHaveTextContent(/^Working · 1s$/);
    view.rerender(<StepsChat messages={[question, thought, search, result]} />);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Thought', '1s'], ['Searched the webFed', '0s']]);
    view.unmount();
    render(<StepsChat messages={[question, thought, search, result]} />);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Thought', '1s'], ['Searched the webFed', '0s']]);
    expect(head()).toHaveTextContent(/^Worked for 1s$/);
  });

  it('keeps elapsed parallel tool time on its step when another call completes', () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'parallel-live-u', role: 'user', content: 'Run both', ...stamp(0, 0) };
    const tools = { id: 'parallel-live-a', role: 'assistant', content: '', toolCalls: [call('parallel-live-slow', 'execute', { command: 'sleep 5' }), call('parallel-live-fast', 'execute', { command: 'true' })], ...stamp(0, 0) };
    const view = render(<StepsChat messages={[question, tools]} running />);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(stepRows()).toEqual([['Runningsleep 5', '2s'], ['Runningtrue', '0s']]);

    const fast = { id: 'parallel-live-result', role: 'tool', toolCallId: 'parallel-live-fast', content: '', ...stamp(0, 2) };
    view.rerender(<StepsChat messages={[question, tools, fast]} running />);

    expect(stepRows()).toEqual([['Runningsleep 5', '2s'], ['Rantrue', '0s']]);
    expect(head()).toHaveTextContent(/^Working · 2s$/);
    act(() => { vi.advanceTimersByTime(3000); });
    const slow = { id: 'parallel-live-slow-result', role: 'tool', toolCallId: 'parallel-live-slow', content: '', ...stamp(0, 5) };
    view.rerender(<StepsChat messages={[question, tools, fast, slow]} />);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Ransleep 5', '5s'], ['Rantrue', '0s']]);
    expect(head()).toHaveTextContent(/^Worked for 5s$/);
    view.unmount();
    render(<StepsChat messages={[question, tools, fast, slow]} />);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Ransleep 5', '5s'], ['Rantrue', '0s']]);
  });

  it('gives every step one line and a time, rounding so the steps sum exactly to the header, after a reload', () => {
    render(<StepsChat messages={timed('sum')} />);
    fireEvent.click(head());

    expect(head()).toHaveTextContent(/^Worked for 36s$/);
    expect(stepRows()).toEqual([
      ['Started up', '6s'],
      ['ThoughtPlanning the search', '9s'],
      ['Searched the webFed minutes October 2026', '5s'],
      ['Thought', '2s'],
      [`Ran${longCommand}`, '3s'],
      ['Answered', '11s'],
    ]);
    expect(stepRows().reduce((sum, [, time]) => sum + secondsIn(time), 0)).toBe(36);
  });

  it('folds a start-up under a second into the first step, so the sum still ties', () => {
    render(<StepsChat messages={timed('quick', 0.4)} />);
    fireEvent.click(head());

    expect(stepRows()[0]).toEqual(['ThoughtPlanning the search', '15s']);
    expect(stepRows().reduce((sum, [, time]) => sum + secondsIn(time), 0)).toBe(36);
    expect(head()).toHaveTextContent(/^Worked for 36s$/);
  });

  it('shows a long command exactly as run in its row and its sheet, titled with its time', async () => {
    render(<StepsChat messages={timed('long')} />);
    fireEvent.click(head());

    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Ran ${longCommand.slice(0, 20)}`) }));

    const dialog = await screen.findByRole('dialog', { name: 'Terminal · 3s' });
    expect(dialog.querySelector('.step-section-text')?.textContent).toBe(longCommand);
  });

  it("opens a thought to the model's summary, and leaves a thought with no words closed", async () => {
    render(<StepsChat messages={timed('sheet')} />);
    fireEvent.click(head());

    expect(screen.queryByRole('button', { name: /^Thought 2s$/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Thought Planning the search/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Thought · 9s' });
    expect(dialog.querySelector('.step-section-label')).toHaveTextContent(/^Reasoning$/);
    expect(dialog).toHaveTextContent('Minutes first, then the price pull.');
  });

  it('assigns overlapping time to the first call in message order after replay', () => {
    const [question, thought, , , , , , answer] = timed('parallel');
    assert(question && thought && answer, 'a Turn');
    const calls = { id: 'parallel-a', role: 'assistant' as const, content: '', toolCalls: [call('slow', 'execute', { command: 'sleep 5' }), call('quick', 'execute', { command: 'true' })], ...stamp(15.2, 15.6) };
    render(<StepsChat messages={[question, thought, calls, { id: 'rs', role: 'tool', toolCallId: 'slow', content: '', ...stamp(15.3, 21.2) }, { id: 'rq', role: 'tool', toolCallId: 'quick', content: '', ...stamp(15.3, 17.2) }, answer]} />);
    fireEvent.click(head());

    expect(stepRows().slice(2, 4)).toEqual([['Ransleep 5', '6s'], ['Rantrue', '0s']]);
    expect(stepRows().reduce((sum, [, time]) => sum + secondsIn(time), 0)).toBe(36);
  });

  it('times the steps of a Turn recorded before its question was stamped from its first step, with no start-up', () => {
    const [question, ...rest] = timed('old');
    assert(question, 'a question');
    render(<StepsChat messages={[{ ...question, metadata: undefined }, ...rest]} />);
    fireEvent.click(head());

    expect(stepRows()[0]).toEqual(['ThoughtPlanning the search', '9s']);
    expect(stepRows().reduce((sum, [, time]) => sum + secondsIn(time), 0)).toBe(29);
  });

  it("shows a thought's reasoning in its sheet exactly as the provider returned it", async () => {
    render(<StepsChat messages={timed('plain')} />);
    fireEvent.click(head());
    fireEvent.click(screen.getByRole('button', { name: /^Thought Planning the search/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Thought · 9s' });
    expect(dialog.querySelector('.step-section-text')?.textContent).toBe('**Planning the search**\n\nMinutes first, then the price pull.');
  });

  it('keeps its step times once a Turn sent in this tab finishes, before any replay stamps arrive', () => {
    vi.useFakeTimers({ now: START });
    const live = timed('here').map(({ metadata: _metadata, ...message }) => message);
    const [question, thought, search, result] = live;
    assert(question && thought && search && result, 'a live Turn');
    const view = render(<StepsChat messages={[question]} running />);
    const at = (seconds: number, messages: TurnMessage[], running = true) => {
      act(() => { vi.setSystemTime(START + seconds * 1000); });
      view.rerender(<StepsChat messages={messages} running={running} />);
      act(() => { vi.advanceTimersByTime(1000); });
    };
    at(2, [question, thought]);
    at(8, [question, thought, search]);
    at(12, [question, thought, search, result]);
    const answer = { id: 'here-f', role: 'assistant' as const, content: 'Done.' };
    at(14, [question, thought, search, result, answer]);
    at(17, [question, thought, search, result, answer], false);
    fireEvent.click(head());

    const times = stepRows().map(([, time]) => time);
    expect(times.every((time) => time !== null && time !== '')).toBe(true);
    expect(stepRows().reduce((sum, [, time]) => sum + secondsIn(time), 0)).toBe(secondsIn(/for (.+)$/.exec(head().textContent)?.[1]));
  });

  it('keeps a finished row still while the running step ticks', () => {
    vi.useFakeTimers({ now: START });
    const live = timed('still').map(({ metadata: _metadata, ...message }) => message);
    const [question, thought, search] = live;
    assert(question && thought && search, 'a live Turn');
    const chat = (messages: TurnMessage[]) => <TurnStart.Provider value={new Date(START).toISOString()}><StepsChat messages={messages} running /></TurnStart.Provider>;
    const view = render(chat([question]));
    act(() => { vi.setSystemTime(START + 1600); });
    view.rerender(chat([question, thought]));
    act(() => { vi.setSystemTime(START + 7900); });
    view.rerender(chat([question, thought, search]));
    const finished = () => stepRows().slice(0, 2);
    const before = finished();
    for (const tick of [300, 400, 500, 600]) {
      act(() => { vi.advanceTimersByTime(tick); });
      expect(finished()).toEqual(before);
      expect(stepRows().reduce((sum, [, time]) => sum + secondsIn(time), 0)).toBe(secondsIn(/· (.+)$/.exec(head().textContent)?.[1]));
    }
  });

  it('ends startup at the first observed step when an earlier completed call never mounted', () => {
    vi.useFakeTimers({ now: START });
    const messages: TurnMessage[] = [
      { id: 'startup-u', role: 'user', content: 'Search' },
      { id: 'startup-a', role: 'assistant', content: '', toolCalls: [call('startup-hidden', 'write_todos')] },
      { id: 'startup-result', role: 'tool', toolCallId: 'startup-hidden', content: 'Updated todo list' },
      { id: 'startup-search-a', role: 'assistant', content: '', toolCalls: [call('startup-search', 'web_search', { query: 'Fed minutes' })] },
    ];
    render(<TurnStart.Provider value={new Date(START).toISOString()}>
      <Worklog id="startup-turn" turn={messages.slice(1)} question={messages[0]} running asked="startup-u">
        <ToolStep id="startup-search" name="web_search" params={{ query: 'Fed minutes' }} status="running" output={undefined} />
      </Worklog>
    </TurnStart.Provider>);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(head()).toHaveTextContent(/^Working · 2s$/);
    expect(stepRows()).toEqual([['Searching the webFed minutes', '2s']]);
  });

  it('keeps the live tool time when only its row remounts after a paused clock', () => {
    vi.useFakeTimers({ now: START });
    const messages: TurnMessage[] = [
      { id: 'pause-u', role: 'user', content: 'Search' },
      { id: 'pause-a', role: 'assistant', content: '', toolCalls: [call('pause-search', 'web_search', { query: 'Fed minutes' })], ...stamp(0, 0) },
    ];
    const chat = (shown: boolean) => <TurnStart.Provider value={new Date(START).toISOString()}>
      <Worklog id="pause-turn" turn={messages.slice(1)} question={messages[0]} running asked="pause-u">
        {shown && <ToolStep id="pause-search" name="web_search" params={{ query: 'Fed minutes' }} status="running" output={undefined} />}
      </Worklog>
    </TurnStart.Provider>;
    const view = render(chat(true));
    view.rerender(chat(false));
    act(() => { vi.setSystemTime(START + 2000); });
    view.rerender(chat(true));
    expect(head()).toHaveTextContent(/^Working · 2s$/);
    expect(stepRows()).toEqual([['Searching the webFed minutes', '2s']]);
  });

  it.each(['tool', 'thought'] as const)('gives elapsed time to the live tool after a completed %s without a visible clock', (kind) => {
    vi.useFakeTimers({ now: START });
    const messages: TurnMessage[] = [
      { id: `hidden-${kind}-u`, role: 'user', content: 'Search' },
      { id: 'observed-a', role: 'assistant', content: '', toolCalls: [call('observed-call', 'read_file')], ...stamp(0, 0) },
      { id: 'observed-result', role: 'tool', toolCallId: 'observed-call', content: 'Read', ...stamp(0, 0) },
      ...(kind === 'tool' ? [
        { id: 'hidden-a', role: 'assistant', content: '', toolCalls: [call('hidden-todos', 'write_todos')] },
        { id: 'hidden-result', role: 'tool', toolCallId: 'hidden-todos', content: 'Updated todo list' },
      ] : [{ id: 'hidden-thought', role: 'reasoning', content: 'Plan the search' }]),
      { id: 'visible-a', role: 'assistant', content: '', toolCalls: [call('visible-search', 'web_search', { query: 'Fed minutes' })] },
    ];
    render(<TurnStart.Provider value={new Date(START).toISOString()}>
      <Worklog id="hidden-turn" turn={messages.slice(1)} question={messages[0]} running asked="hidden-u">
        <ToolStep id="visible-search" name="web_search" params={{ query: 'Fed minutes' }} status="running" output={undefined} />
      </Worklog>
    </TurnStart.Provider>);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(head()).toHaveTextContent(/^Working · 2s$/);
    expect(stepRows()).toEqual([['Searching the webFed minutes', '2s']]);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(head()).toHaveTextContent(/^Working · 3s$/);
    expect(stepRows()).toEqual([['Searching the webFed minutes', '3s']]);
  });

  it('counts the running step up live, its steps summing to "Working" all along, from the Chat Service\'s start', () => {
    vi.useFakeTimers({ now: START });
    const live = timed('live-sum').map(({ metadata: _metadata, ...message }) => message);
    const [question, thought, search, result] = live;
    assert(question && thought && search && result, 'a live Turn');
    const view = render(<TurnStart.Provider value={new Date(START).toISOString()}><StepsChat messages={[question]} running /></TurnStart.Provider>);
    const at = (seconds: number, messages: TurnMessage[]) => {
      act(() => {
        vi.setSystemTime(START + seconds * 1000);
      });
      view.rerender(<TurnStart.Provider value={new Date(START).toISOString()}><StepsChat messages={messages} running /></TurnStart.Provider>);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    };
    const sum = () => stepRows().reduce((total, [, time]) => total + secondsIn(time), 0);

    at(2, [question, thought]);
    at(8, [question, thought, search]);
    expect(stepRows()).toEqual([['Started up', '2s'], ['ThoughtPlanning the search', '6s'], ['Searching the webFed minutes October 2026', '1s']]);
    expect(head()).toHaveTextContent(/^Working · 9s$/);
    at(12, [question, thought, search, result]);
    expect(sum()).toBe(13);
    expect(head()).toHaveTextContent(/^Working · 13s$/);
    at(14, [question, thought, search, result, { ...thought, id: 'live-r2', content: '' }]);
    expect(sum()).toBe(15);
    expect(head()).toHaveTextContent(/^Working · 15s$/);
  });
});

