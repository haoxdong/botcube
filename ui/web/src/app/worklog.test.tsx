import { CopilotChatConfigurationProvider, CopilotChatMessageView, CopilotKitProvider, useDefaultRenderTool } from '@copilotkit/react-core/v2';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

import { HttpAgent } from '@ag-ui/client';
import { WorklogAgent } from './worklog-clock';

import type { TurnMessage } from './turn-parts';
import { TurnStart } from './turn-clock';
import { ThoughtStep, ToolStep, Worklog, worklogRows } from './worklog';

/** A publish call's result as the Artifact tool returns it. */
const PUBLISHED = JSON.stringify({ id: '/q3', type: null, title: 'Rates chart', description: '', version: 1, path: '/q3.html' });

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
  it('keeps a days-old reasoning greeting out of the running question clock', () => {
    vi.useFakeTimers({ now: START });
    const greeting = [
      { id: 'greeting-clock-thought', role: 'reasoning', content: 'Prepare a welcome', ...stamp(-259200, -259198) },
      { id: 'greeting-clock-answer', role: 'assistant', content: 'Welcome', ...stamp(-259198, -259197) },
    ];
    const view = render(<Chat messages={greeting} running={false} />);
    expect(head()).toHaveTextContent(/^Worked for 3s$/);

    const messages = [...greeting,
      { id: 'greeting-clock-question', role: 'user', content: 'Compare rates' },
      { id: 'greeting-clock-running', role: 'reasoning', content: 'Compare the markets' },
    ];
    view.rerender(<Chat messages={messages} running />);
    expect(heads()).toHaveLength(2);
    expect(heads()[1]).toHaveTextContent(/^Working · 0s$/);
    view.rerender(<Chat messages={[...messages]} running />);
    act(() => { vi.advanceTimersByTime(4000); });
    expect(heads()[1]).toHaveTextContent(/^Working · 4s$/);
    expect(heads()[0]).toHaveTextContent(/^Worked for 3s$/);
  });

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

  it('stays open while its answer streams and folds once, when the run ends', () => {
    const view = render(<Chat messages={turn('answering')} running />);
    expect(head()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('2s10s steepened to +45bp.')).toBeVisible();
    view.rerender(<Chat messages={turn('answering')} running={false} />);
    expect(head()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('2s10s steepened to +45bp.')).toBeVisible();
  });

  it('keeps a manual fold through mid-Turn text and tools, and resets it when the run ends', () => {
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
    expect(head()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Swaps rose.')).toBeVisible();
    expect(head()).toHaveTextContent(/^Working · 0s$/);
    view.rerender(<Chat messages={[...work, toolNote, next]} running={false} />);
    expect(head()).toHaveAttribute('aria-expanded', 'false');
    expect(head()).toHaveTextContent(/^Worked for 0s$/);
  });

  it('stays open through text, reasoning after it and a proposal', () => {
    const messages = turn('resume');
    const view = render(<Chat messages={messages} running />);
    expect(head()).toHaveAttribute('aria-expanded', 'true');
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

  it('folds the note that published an Artifact once the answer, which shows its card, arrives', () => {
    const [question, note, result, answer] = turn('artifact');
    assert(question && note && result && answer, 'the Turn');
    const publish = { id: 'artifact-p', role: 'assistant', content: 'Publishing the chart.', toolCalls: [call('artifact-pc', 'Artifact', { file_path: '/q3.html' })] };
    render(<Chat messages={[question, note, result, publish, { id: 'artifact-pt', role: 'tool', toolCallId: 'artifact-pc', content: PUBLISHED }, answer]} running={false} />);

    expect(heads()).toHaveLength(1);
    expect(screen.queryByText("I'll check the rates skill first.")).toBeNull();
    expect(screen.queryByText('Publishing the chart.')).toBeNull();
  });

  it('folds a message that refused one publish and made another, leaving no error in the chat', () => {
    const [question, note, result, answer] = turn('mixed-publish');
    assert(question && note && result && answer, 'the Turn');
    const publish = { id: 'mixed-publish-p', role: 'assistant', content: 'Publishing both.', toolCalls: [call('mixed-publish-bad', 'Artifact', { file_path: '/a.html' }), call('mixed-publish-good', 'Artifact', { file_path: '/q3.html' })] };
    render(<Chat messages={[question, note, result, publish, { id: 'mixed-publish-bt', role: 'tool', toolCallId: 'mixed-publish-bad', content: 'Error: no file at /a.html' }, { id: 'mixed-publish-gt', role: 'tool', toolCallId: 'mixed-publish-good', content: PUBLISHED }, answer]} running={false} />);

    expect(heads()).toHaveLength(1);
    expect(screen.queryByText('Publishing both.')).toBeNull();
    expect(screen.queryByText('Error: no file at /a.html')).toBeNull();
  });

  it('folds a refused publish into the Worklog, where the agent recovers from it', () => {
    const [question, note, result, answer] = turn('refused');
    assert(question && note && result && answer, 'the Turn');
    const publish = { id: 'refused-p', role: 'assistant', content: 'Publishing the chart.', toolCalls: [call('refused-pc', 'Artifact', { file_path: '/q3.html' })] };
    render(<Chat messages={[question, note, result, publish, { id: 'refused-pt', role: 'tool', toolCallId: 'refused-pc', content: 'Error: publish refused' }, answer]} running={false} />);

    expect(heads()).toHaveLength(1);
    expect(screen.queryByText('Publishing the chart.')).toBeNull();
    expect(screen.queryByText('Error: publish refused')).toBeNull();
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

    expect(container).toHaveTextContent(/^Running acme search "Japan"$/);
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
    expect(container.querySelector('svg[data-icon="failed"]')).not.toBeNull();
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

    expect(container.querySelector('svg[data-icon="failed"]')).toBeNull();
    expect(container.querySelector('svg[data-icon="ran"]')).not.toBeNull();
  });

  it('marks a stopped call', () => {
    const { container } = render(<ToolStep name="task" params={{ description: 'Compare research' }} status="stopped" output={undefined} />);

    expect(container).toHaveTextContent(/^Stopped · Asked a helper Compare research$/);
  });

  it('marks a call a stopped Turn cut as stopped once replayed, opening to its input alone', async () => {
    const { container } = render(
      <ToolStep name="execute" params={{ command: 'sleep 30; echo slept' }} status="complete" output="Tool call 'execute' with id 'call_dl0u' was interrupted before completion." />,
    );

    expect(container).toHaveTextContent(/^Stopped · Ran sleep 30; echo slept$/);
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
function StepsChat({ messages, running = false, started = running }: { messages: readonly TurnMessage[]; running?: boolean; started?: boolean }) {
  const latest = messages.at(-1)?.id;
  const rows = messages.filter(({ role }) => role !== 'tool').map((message) => {
    if (message.role === 'reasoning') return <ThoughtStep key={message.id} message={message} isRunning={running} isLatest={message.id === latest} />;
    if (message.toolCalls?.some(({ id, function: tool }) => {
      const result = messages.find(other => other.toolCallId === id);
      return tool.name === 'Artifact' || (tool.name === 'propose_scheduled_task' && result && !String(result.content).startsWith("Error invoking tool 'propose_scheduled_task'") && !String(result.content).includes('was interrupted before completion'));
    })) {
      return <div key={message.id} data-testid={`card-${message.id}`}>{String(message.content) || 'Published card'}</div>;
    }
    const calls = (message.toolCalls as ReturnType<typeof call>[] | undefined)?.map(({ id, function: { name, arguments: args } }) => {
      const result = messages.find((other) => other.toolCallId === id);
      return <ToolStep key={id} id={id} name={name} params={JSON.parse(args) as Record<string, unknown>} status={result ? 'complete' : 'running'} output={result ? String(result.content) : undefined} />;
    });
    return <div key={message.id}>{calls ?? String(message.content)}</div>;
  });
  return <>{worklogRows(rows, messages, running, { started })}</>;
}

it('shows the wait between dispatch and the first answer words as a Thought without a summary', () => {
  render(<StepsChat messages={[
    { id: 'silent-question', role: 'user', content: 'Compare exposures', ...stamp(0, 0) },
    { id: 'silent-thought', role: 'reasoning', content: '', ...stamp(2, 8) },
    { id: 'silent-answer', role: 'assistant', content: 'The exposures differ.', ...stamp(8, 9) },
  ]} />);
  expect(head()).toHaveTextContent(/^Worked for 9s$/);
  fireEvent.click(head());
  expect(stepRows()).toEqual([['Started up', '2s'], ['Thought', '6s'], ['Answered', '1s']]);
});

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
  it.each(['tool', 'thought'] as const)('shows an unallocated %s clock in its detail title', async (kind) => {
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
    expect(title).toHaveTextContent(kind === 'tool' ? /^Terminal · 0s$/ : /^Thought · 0s$/);
  });

  it('shows a new step clock at zero before its first positive allocation', () => {
    vi.useFakeTimers({ now: START + 23000 });
    const question = { id: 'first-clock-u', role: 'user', content: 'Compare investment markets', ...stamp(0, 0) };
    const first = { id: 'first-clock-a', role: 'assistant', content: '', toolCalls: [call('first-clock-c', 'execute', { command: 'research' })], ...stamp(23, 23) };
    const view = render(<StepsChat messages={[question, first]} running />);
    const clock = view.container.querySelector('.worklog-step[data-kind="tool"] .worklog-step-time');
    assert(clock, 'the running tool clock');
    expect(head()).toHaveTextContent(/^Working · 23s$/);
    expect(clock).toHaveTextContent(/^0s$/);
    expect(clock).toBeVisible();
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
    expect(clocks[1]).toBeVisible();
    expect(clocks[1]).toHaveTextContent(/^0s$/);
    const visibleSeconds = [...view.container.querySelectorAll('.worklog-step-time')].filter((element) => getComputedStyle(element).visibility !== 'hidden').reduce((sum, element) => sum + secondsIn(element.textContent), 0);
    expect(visibleSeconds).toBe(24);
    expect(head()).toHaveTextContent(/^Working · 24s$/);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(clocks[1]).toBeVisible();
    expect(clocks[1]).toHaveTextContent(/^1s$/);
    expect(clocks[0]).toHaveTextContent(/^1s$/);
    expect(head()).toHaveTextContent(/^Working · 25s$/);
  });

  it.each([false, true])('keeps card-separated views from double-counting the same Turn (canonical=%s)', (canonical) => {
    vi.useFakeTimers({ now: START + 8000 });
    const messages = [
      { id: `card-clock-u-${canonical}`, role: 'user', content: 'Build a chart and compare rates', metadata: { ...stamp(0, 0).metadata, ...(canonical ? { worklog_clock: { version: 1, at: START + 8000 } } : {}) } },
      { id: 'card-clock-r', role: 'reasoning', content: 'Plan', ...stamp(0, 2) },
      { id: 'card-clock-card', role: 'assistant', content: '', toolCalls: [call('card-clock-artifact', 'Artifact', { description: 'Rates chart' })], ...stamp(2, 2) },
      { id: 'card-clock-card-result', role: 'tool', toolCallId: 'card-clock-artifact', content: PUBLISHED, ...stamp(2, 4) },
      { id: 'card-clock-next', role: 'assistant', content: '', toolCalls: [call('card-clock-query', 'execute', { command: 'compare rates' })], ...stamp(4, 4) },
      { id: 'card-clock-next-result', role: 'tool', toolCallId: 'card-clock-query', content: 'Done', ...stamp(4, 6) },
      { id: 'card-clock-answer', role: 'assistant', content: 'Rates compared.', ...stamp(6, 8) },
    ];
    const view = render(<StepsChat messages={messages} running />);
    expect(heads()).toHaveLength(1);
    for (const header of heads()) expect(header).toHaveTextContent(/^Working · 8s$/);
    for (const header of heads()) {
      const group = header.closest('.worklog');
      assert(group, 'a Worklog group');
      const displayed = [...group.querySelectorAll('.worklog-step-time')].reduce((sum, clock) => sum + secondsIn(clock.textContent), 0);
      expect(displayed).toBe(8);
    }
    const diagnosticIds = [...document.querySelectorAll('.worklog-step')].map(step => step.getAttribute('data-step-id'));
    expect(new Set(diagnosticIds).size).toBe(diagnosticIds.length);
    expect(screen.queryByTestId('card-card-clock-card')).toBeNull();
    act(() => { vi.advanceTimersByTime(1000); });
    if (canonical) view.rerender(<StepsChat messages={messages.map(message => message.role === 'user' ? { ...message, metadata: { ...message.metadata, worklog_clock: { version: 1, at: START + 9000 } } } : message)} running />);
    for (const header of heads()) expect(header).toHaveTextContent(/^Working · 9s$/);
  });

  it('retains allocations while a card arrives between live steps and replay', () => {
    vi.useFakeTimers({ now: START + 2000 });
    const question = { id: 'publication-u', role: 'user', content: 'Compare rates', ...stamp(0, 0) };
    const thought = { id: 'publication-r', role: 'reasoning', content: 'Plan', ...stamp(0, 2) };
    const publication = { id: 'publication-a', role: 'assistant', content: 'Rates chart', toolCalls: [call('publication-c', 'Artifact')], ...stamp(2, 2) };
    const publicationResult = { id: 'publication-t', role: 'tool', toolCallId: 'publication-c', content: PUBLISHED, ...stamp(2, 4) };
    const query = { id: 'publication-next', role: 'assistant', content: '', toolCalls: [call('publication-query', 'execute', { command: 'compare rates' })], ...stamp(4, 4) };
    const queryResult = { id: 'publication-query-result', role: 'tool', toolCallId: 'publication-query', content: 'Done', ...stamp(4, 6) };
    const answer = { id: 'publication-answer', role: 'assistant', content: 'Rates compared.', ...stamp(6, 8) };
    const view = render(<StepsChat messages={[question, thought]} running />);
    const owner = view.container.querySelector('.worklog');
    const verify = (total: number, times: string[]) => {
      expect(heads()).toHaveLength(1);
      expect(head()).toHaveTextContent(`Working · ${total}s`);
      expect(stepRows().map(([, time]) => time)).toEqual(times);
      expect(stepRows().reduce((sum, [, time]) => sum + secondsIn(time), 0)).toBe(total);
      expect(view.container.querySelector('.worklog')).toBe(owner);
    };
    verify(2, ['2s']);
    view.rerender(<StepsChat messages={[question, thought, publication]} running />);
    verify(2, ['2s', '0s']);
    expect(screen.queryByTestId('card-publication-a')).toBeNull();
    act(() => { vi.advanceTimersByTime(2000); });
    verify(4, ['2s', '2s']);
    const continued = [question, thought, publication, publicationResult, query];
    view.rerender(<StepsChat messages={continued} running />);
    verify(4, ['2s', '2s', '0s']);
    act(() => { vi.advanceTimersByTime(2000); });
    verify(6, ['2s', '2s', '2s']);
    view.rerender(<StepsChat messages={[...continued, queryResult, { ...answer, ...stamp(6, 6) }]} running />);
    verify(6, ['2s', '2s', '2s', '0s']);
    act(() => { vi.advanceTimersByTime(2000); });
    view.rerender(<StepsChat messages={[...continued, queryResult, answer]} running />);
    verify(8, ['2s', '2s', '2s', '2s']);
    view.rerender(<StepsChat messages={[question, thought, { ...publication, id: 'publication-replayed' }, publicationResult, { ...query, id: 'query-replayed' }, queryResult, answer]} running />);
    verify(8, ['2s', '2s', '2s', '2s']);
    expect(screen.queryByTestId('card-publication-replayed')).toBeNull();
  });

  it('counts a publication once across CopilotKit custom-message slots', () => {
    const [question, note, result, answer] = turn('publication-slots');
    assert(question && note && result && answer, 'a Turn');
    const publication = { id: 'publication-slot-message', role: 'assistant' as const, content: 'Published chart', toolCalls: [call('publication-slot-call', 'Artifact')], ...stamp(3, 3) };
    render(<CopilotKitChat messages={[question, note, result, publication, { id: 'publication-slot-result', role: 'tool', toolCallId: 'publication-slot-call', content: PUBLISHED, ...stamp(3, 4) }, answer]} />);
    expect(heads()).toHaveLength(1);
    fireEvent.click(head());
    expect(document.querySelectorAll('[data-step-id="publication-slot-call"]')).toHaveLength(1);
  });

  it.each([undefined, "Error invoking tool 'propose_scheduled_task': unavailable", "Tool call 'propose_scheduled_task' with id 'pending-proposal-call' was interrupted before completion."])('shows one timed pending or unsuccessful proposal for %s', (output) => {
    vi.useFakeTimers({ now: START + 4000 });
    const question = { id: 'pending-proposal-u', role: 'user', content: 'Schedule a rates brief', ...stamp(0, 0) };
    const proposal = { id: 'pending-proposal-a', role: 'assistant', content: '', toolCalls: [call('pending-proposal-call', 'propose_scheduled_task', { description: 'Rates brief' })], ...stamp(0, 0) };
    const messages = [question, proposal, ...(output === undefined ? [] : [{ id: 'pending-proposal-t', role: 'tool', toolCallId: 'pending-proposal-call', content: output, ...stamp(0, 4) }])];
    render(<StepsChat messages={messages} running />);
    expect(document.querySelectorAll('[data-step-id="pending-proposal-call"]')).toHaveLength(1);
    expect(stepRows().map(([, time]) => time)).toEqual(['4s']);
    expect(head()).toHaveTextContent('Working · 4s');
  });

  it.each(['read', 'list'])('does not label an Artifact %s as a publication', (action) => {
    vi.useFakeTimers({ now: START + 4000 });
    render(<StepsChat messages={[
      { id: 'artifact-action-u', role: 'user', content: 'Inspect Artifacts', ...stamp(0, 0) },
      { id: 'artifact-action-a', role: 'assistant', content: '', toolCalls: [call('artifact-action-c', 'Artifact', { action })], ...stamp(0, 0) },
      { id: 'artifact-action-t', role: 'tool', toolCallId: 'artifact-action-c', content: '{}', ...stamp(0, 4) },
    ]} running />);
    expect(stepRows()).toEqual([['Artifact', '4s']]);
  });

  it('counts mixed ordinary and card calls once through the real tool renderer', () => {
    function Tools() {
      useDefaultRenderTool({ render: ({ name, toolCallId, status, parameters, result }) => name === 'Artifact' ? <button>Rates chart</button> : <ToolStep id={toolCallId} name={name} params={parameters as Record<string, unknown>} status={status === 'complete' ? 'complete' : 'running'} output={result ?? undefined} /> });
      return null;
    }
    const messages = [
      { id: 'mixed-u', role: 'user' as const, content: 'Compare rates', ...stamp(0, 0) },
      { id: 'mixed-a', role: 'assistant' as const, content: 'Chart', toolCalls: [call('mixed-card', 'Artifact'), call('mixed-query', 'execute', { command: 'compare rates' })], ...stamp(0, 0) },
      { id: 'mixed-t1', role: 'tool' as const, toolCallId: 'mixed-card', content: PUBLISHED, ...stamp(0, 2) },
      { id: 'mixed-t2', role: 'tool' as const, toolCallId: 'mixed-query', content: 'Compared', ...stamp(0, 4) },
      { id: 'mixed-answer', role: 'assistant' as const, content: 'Rates compared', ...stamp(4, 8) },
    ];
    render(<CopilotKitProvider><Tools /><CopilotChatConfigurationProvider threadId="mixed">
      <CopilotChatMessageView messages={messages} isRunning={false}>
        {({ messageElements, messages: shown, isRunning }) => <>{worklogRows(messageElements, shown, isRunning)}</>}
      </CopilotChatMessageView>
    </CopilotChatConfigurationProvider></CopilotKitProvider>);
    fireEvent.click(head());
    expect(document.querySelectorAll('[data-step-id="mixed-query"]')).toHaveLength(1);
    expect(stepRows()).toEqual([['Artifact', '2s'], ['Ran compare rates', '2s'], ['Answered', '4s']]);
    fireEvent.click(head());
    expect(screen.queryByRole('button', { name: 'Rates chart' })).toBeNull();
  });

  it.each([true, false])('does not count time away after a Turn finishes, result timestamps %s', (stampedResult) => {
    vi.useFakeTimers({ now: START + 2000 });
    const prefix = `finished-return-${stampedResult}`;
    const question = { id: `${prefix}-u`, role: 'user', content: 'Compare rates', ...stamp(0, 0) };
    const tool = { id: `${prefix}-a`, role: 'assistant', content: '', toolCalls: [call(`${prefix}-c`, 'execute', { command: 'compare rates' })], ...stamp(0, 0) };
    const view = render(<StepsChat messages={[question, tool]} running />);
    expect(stepRows()).toEqual([['Running compare rates', '2s']]);
    view.unmount();
    vi.setSystemTime(START + 3341000);
    const result = { id: `${prefix}-t`, role: 'tool', toolCallId: `${prefix}-c`, content: 'Compared', ...(stampedResult ? stamp(0, 0.2) : {}) };
    const answer = { id: `${prefix}-answer`, role: 'assistant', content: 'Rates compared', ...stamp(0.2, 49) };
    render(<StepsChat messages={[question, tool, result, answer]} />);
    expect(head()).toHaveTextContent(/^Worked for 49s$/);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Ran compare rates', '2s'], ['Answered', '47s']]);
  });

  it.each([false, true])('keeps the displayed minimum when final timestamps arrive late, previously finished %s', async (alreadyFinished) => {
    vi.useFakeTimers({ now: START + 5000 });
    const prefix = `late-finished-minimum-${alreadyFinished}`;
    const question = { id: `${prefix}-u`, role: 'user', content: 'Rates', ...stamp(0, 0) };
    const tool = { id: `${prefix}-a`, role: 'assistant', content: '', toolCalls: [call(`${prefix}-c`, 'execute', { command: 'rates' })], ...stamp(0, 0) };
    const result = { id: `${prefix}-t`, role: 'tool', toolCallId: `${prefix}-c`, content: 'Done', ...stamp(0, 0.2) };
    const answer = { id: `${prefix}-answer`, role: 'assistant', content: 'Rates compared' };
    const view = render(<StepsChat messages={[question, tool]} running />);
    expect(stepRows()).toEqual([['Running rates', '5s']]);
    if (alreadyFinished) view.rerender(<StepsChat messages={[question, tool, result, answer]} />);
    const recorded = { ...answer, ...stamp(0.2, 4.4) };
    view.rerender(<StepsChat messages={[question, tool, result, recorded]} />);
    expect(head()).toHaveTextContent(/^Worked for 5s$/);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Ran rates', '5s'], ['Answered', '0s']]);
    view.unmount();
    vi.resetModules();
    const restored = await import('./worklog');
    render(<restored.Worklog id={tool.id} asked={question.id} question={question} turn={[tool, result, recorded]} running={false}>
      <restored.ToolStep id={`${prefix}-c`} name="execute" params={{ command: 'rates' }} status="complete" output="Done" />
    </restored.Worklog>);
    expect(head()).toHaveTextContent(/^Worked for 5s$/);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Ran rates', '5s'], ['Answered', '0s']]);
  });

  it('keeps a replayed final timestamp while the interactive client briefly reports running', () => {
    vi.useFakeTimers({ now: START + 6 * 60 * 60 * 1000 });
    const question = { id: 'responsive-replay-u', role: 'user', content: 'Publish a slide', ...stamp(0, 0) };
    const tool = { id: 'responsive-replay-a', role: 'assistant', content: '', toolCalls: [call('responsive-replay-c', 'execute', { command: 'publish' })], ...stamp(2, 2) };
    const result = { id: 'responsive-replay-t', role: 'tool', toolCallId: 'responsive-replay-c', content: 'Published', ...stamp(2, 4) };
    const answer = { id: 'responsive-replay-answer', role: 'assistant', content: 'Slide published', ...stamp(4, 49) };
    const messages = [question, tool, result, answer];
    const view = render(<StepsChat messages={messages} />);
    expect(head()).toHaveTextContent(/^Worked for 49s$/);
    view.rerender(<StepsChat messages={messages} running started={false} />);
    expect.soft(head()).toHaveTextContent(/^Worked for 49s$/);
    view.rerender(<StepsChat messages={messages} />);
    expect(head()).toHaveTextContent(/^Worked for 49s$/);
    fireEvent.click(head());
    expect(stepRows().reduce((sum, [, time]) => sum + secondsIn(time), 0)).toBe(49);
  });

  it('keeps an observed completion minimum across reload before final timestamps', async () => {
    vi.useFakeTimers({ now: START + 5000 });
    const question = { id: 'observed-finish-u', role: 'user', content: 'Rates', ...stamp(0, 0) };
    const tool = { id: 'observed-finish-a', role: 'assistant', content: '', toolCalls: [call('observed-finish-c', 'execute', { command: 'rates' })], ...stamp(0, 0) };
    const result = { id: 'observed-finish-t', role: 'tool', toolCallId: 'observed-finish-c', content: 'Done', ...stamp(0, 0.2) };
    const answer = { id: 'observed-finish-answer', role: 'assistant', content: 'Rates compared' };
    const view = render(<StepsChat messages={[question, tool]} running />);
    view.rerender(<StepsChat messages={[question, tool, result, answer]} />);
    expect(head()).toHaveTextContent(/^Worked for 5s$/);
    view.unmount();
    vi.resetModules();
    const restored = await import('./worklog');
    render(<restored.Worklog id={tool.id} asked={question.id} question={question} turn={[tool, result, { ...answer, ...stamp(0.2, 4.4) }]} running={false}>
      <restored.ToolStep id="observed-finish-c" name="execute" params={{ command: 'rates' }} status="complete" output="Done" />
    </restored.Worklog>);
    expect(head()).toHaveTextContent(/^Worked for 5s$/);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Ran rates', '5s'], ['Answered', '0s']]);
  });

  it('keeps a valid legacy completion minimum when its final timestamp arrives', async () => {
    vi.useFakeTimers({ now: START + 10000 });
    const question = { id: 'legacy-minimum-u', role: 'user', content: 'Rates', ...stamp(0, 0) };
    const tool = { id: 'legacy-minimum-a', role: 'assistant', content: '', toolCalls: [call('legacy-minimum-c', 'execute', { command: 'rates' })], ...stamp(0, 0) };
    const result = { id: 'legacy-minimum-t', role: 'tool', toolCallId: 'legacy-minimum-c', content: 'Done', ...stamp(0, 0.2) };
    const answer = { id: 'legacy-minimum-answer', role: 'assistant', content: 'Rates compared', ...stamp(0.2, 4.4) };
    sessionStorage.setItem('botcube.worklog-turns', JSON.stringify([[question.id, {
      start: START, ended: START + 5000,
      observed: { 'legacy-minimum-c': { started: START, ended: START + 200 } },
      allocations: { [tool.id]: { 'legacy-minimum-u-started-up': 0, 'legacy-minimum-c': 5, [answer.id]: 0 } },
    }]]));
    vi.resetModules();
    const restored = await import('./worklog');
    render(<restored.Worklog id={tool.id} asked={question.id} question={question} turn={[tool, result, answer]} running={false}>
      <restored.ToolStep id="legacy-minimum-c" name="execute" params={{ command: 'rates' }} status="complete" output="Done" />
    </restored.Worklog>);
    expect(head()).toHaveTextContent(/^Worked for 5s$/);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Ran rates', '5s'], ['Answered', '0s']]);
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
    expect(stepRows()).toEqual([['Ran first', '0s'], ['Running second', '1s']]);
    view.rerender(chat([{ ...question, ...stamp(-0.4, -0.4) }, first, result, second]));
    expect(stepRows()).toEqual([['Ran first', '0s'], ['Running second', '1s']]);
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
    expect(stepRows()).toEqual([['Ran rates', '5s']]);
  });

  it('keeps displayed tool time when the earlier server Turn start arrives', () => {
    vi.useFakeTimers({ now: START + 9000 });
    const question = { id: 'late-origin-u', role: 'user', content: 'Rates' };
    const tool = { id: 'late-origin-a', role: 'assistant', content: '', toolCalls: [call('late-origin-c', 'execute', { command: 'rates' })], ...stamp(3, 3) };
    const view = render(<StepsChat messages={[question, tool]} running />);
    expect(head()).toHaveTextContent(/^Working · 6s$/);
    view.rerender(<TurnStart.Provider value={new Date(START).toISOString()}><StepsChat messages={[question, tool]} running /></TurnStart.Provider>);
    expect(head()).toHaveTextContent(/^Working · 9s$/);
    expect(stepRows()).toEqual([['Started up', '3s'], ['Running rates', '6s']]);
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
    expect(stepRows()).toEqual([['Running rates', '5s']]);
  });

  it('retains step times on a reload mid-Turn after delayed replay', async () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'reload-live-u', role: 'user', content: 'Compare rates', ...stamp(0, 0) };
    const tool = { id: 'reload-live-a', role: 'assistant', content: '', toolCalls: [call('reload-live-first', 'execute', { command: 'first' }), call('reload-live-second', 'execute', { command: 'second' })], ...stamp(0, 0) };
    const view = render(<StepsChat messages={[question, tool]} running />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(stepRows()).toEqual([['Running first', '5s'], ['Running second', '0s']]);
    view.unmount();
    vi.setSystemTime(START + 9000);
    vi.resetModules();
    const reloaded = await import('./worklog');
    const result = { id: 'reload-live-t', role: 'tool', toolCallId: 'reload-live-first', content: 'Done', ...stamp(0, 0.2) };
    render(<reloaded.Worklog id="reload-live-a" asked="reload-live-u" question={question} turn={[tool, result]} running>
      <reloaded.ToolStep id="reload-live-first" name="execute" params={{ command: 'first' }} status="complete" output="Done" />
      <reloaded.ToolStep id="reload-live-second" name="execute" params={{ command: 'second' }} status="running" output={undefined} />
    </reloaded.Worklog>);
    expect(stepRows()).toEqual([['Ran first', '5s'], ['Running second', '4s']]);
    expect(head()).toHaveTextContent(/^Working · 9s$/);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(stepRows()).toEqual([['Ran first', '5s'], ['Running second', '5s']]);
  });

  it('retains completed step allocations when reload replaces the message view key', async () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'view-reload-u', role: 'user', content: 'Compare rates', ...stamp(0, 0) };
    const tool = { id: 'view-reload-live', role: 'assistant', content: '', toolCalls: [call('view-reload-first', 'execute', { command: 'first' }), call('view-reload-second', 'execute', { command: 'second' })], ...stamp(0, 0) };
    const view = render(<StepsChat messages={[question, tool]} running />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(stepRows()).toEqual([['Running first', '5s'], ['Running second', '0s']]);
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
    expect(stepRows()).toEqual([['Ran first', '5s'], ['Running second', '4s']]);
    expect(head()).toHaveTextContent(/^Working · 9s$/);
    act(() => { vi.advanceTimersByTime(1000); });
    restored.unmount();
    vi.resetModules();
    const again = await import('./worklog');
    render(<again.Worklog id="view-reload-again" asked={question.id} question={question} turn={[{ ...replayed, id: 'view-reload-again' }, result]} running>
      <again.ToolStep id="view-reload-first" name="execute" params={{ command: 'first' }} status="complete" output="Done" />
      <again.ToolStep id="view-reload-second" name="execute" params={{ command: 'second' }} status="running" output={undefined} />
    </again.Worklog>);
    expect(stepRows()).toEqual([['Ran first', '5s'], ['Running second', '5s']]);
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
    expect(stepRows()).toEqual([['Ran first', '2s'], ['Running second', '3s']]);
    view.rerender(<StepsChat messages={[question, first, { ...result, ...stamp(0, 5) }, second]} running />);
    expect(stepRows()).toEqual([['Ran first', '2s'], ['Running second', '3s']]);
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
    expect(stepRows()).toEqual([['Started up', '2s'], ['Running rates', '3s']]);
    view.rerender(chat([{ ...question, ...stamp(0, 0) }, { ...tool, ...stamp(0, 0) }]));
    expect(stepRows()).toEqual([['Started up', '2s'], ['Running rates', '3s']]);
    expect(head()).toHaveTextContent(/^Working · 5s$/);
  });

  it('keeps displayed parallel time from resetting to zero when a delayed result arrives', async () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'delayed-u', role: 'user', content: 'Compare rates', ...stamp(0, 0) };
    const tools = { id: 'delayed-a', role: 'assistant', content: '', toolCalls: [call('delayed-first', 'execute', { command: 'first' }), call('delayed-second', 'execute', { command: 'second' })], ...stamp(0, 0) };
    const view = render(<StepsChat messages={[question, tools]} running />);
    act(() => { vi.advanceTimersByTime(5000); });
    expect(stepRows()).toEqual([['Running first', '5s'], ['Running second', '0s']]);

    const result = { id: 'delayed-t', role: 'tool', toolCallId: 'delayed-first', content: 'Done', ...stamp(0, 0.2) };
    view.rerender(<StepsChat messages={[question, tools, result]} running />);
    expect(stepRows()).toEqual([['Ran first', '5s'], ['Running second', '0s']]);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(stepRows()).toEqual([['Ran first', '5s'], ['Running second', '1s']]);
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
    expect(stepRows()).toEqual([['Ran first', '5s'], ['Ran second', '1s']]);
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
      expect(stepRows().map(([label]) => label?.replace(/^(Running|Ran) /, ''))).toEqual(order);
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
    expect(stepRows()).toEqual([['Thought', '1s'], ['Searching the web Fed', '0s']]);

    act(() => { vi.setSystemTime(START + 1300); });
    const result = { id: 'fraction-t', role: 'tool', toolCallId: 'fraction-c', content: 'Found', ...stamp(0.6, 1.3) };
    view.rerender(<StepsChat messages={[question, thought, search, result]} running />);

    expect(stepRows()).toEqual([['Thought', '1s'], ['Searched the web Fed', '0s']]);
    expect(head()).toHaveTextContent(/^Working · 1s$/);
    view.rerender(<StepsChat messages={[question, thought, search, result]} />);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Thought', '1s'], ['Searched the web Fed', '0s']]);
    view.unmount();
    render(<StepsChat messages={[question, thought, search, result]} />);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Thought', '1s'], ['Searched the web Fed', '0s']]);
    expect(head()).toHaveTextContent(/^Worked for 1s$/);
  });

  it('keeps elapsed parallel tool time on its step when another call completes', () => {
    vi.useFakeTimers({ now: START });
    const question = { id: 'parallel-live-u', role: 'user', content: 'Run both', ...stamp(0, 0) };
    const tools = { id: 'parallel-live-a', role: 'assistant', content: '', toolCalls: [call('parallel-live-slow', 'execute', { command: 'sleep 5' }), call('parallel-live-fast', 'execute', { command: 'true' })], ...stamp(0, 0) };
    const view = render(<StepsChat messages={[question, tools]} running />);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(stepRows()).toEqual([['Running sleep 5', '2s'], ['Running true', '0s']]);

    const fast = { id: 'parallel-live-result', role: 'tool', toolCallId: 'parallel-live-fast', content: '', ...stamp(0, 2) };
    view.rerender(<StepsChat messages={[question, tools, fast]} running />);

    expect(stepRows()).toEqual([['Running sleep 5', '2s'], ['Ran true', '0s']]);
    expect(head()).toHaveTextContent(/^Working · 2s$/);
    act(() => { vi.advanceTimersByTime(3000); });
    const slow = { id: 'parallel-live-slow-result', role: 'tool', toolCallId: 'parallel-live-slow', content: '', ...stamp(0, 5) };
    view.rerender(<StepsChat messages={[question, tools, fast, slow]} />);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Ran sleep 5', '5s'], ['Ran true', '0s']]);
    expect(head()).toHaveTextContent(/^Worked for 5s$/);
    view.unmount();
    render(<StepsChat messages={[question, tools, fast, slow]} />);
    fireEvent.click(head());
    expect(stepRows()).toEqual([['Ran sleep 5', '5s'], ['Ran true', '0s']]);
  });

  it('gives every step one line and a time, rounding so the steps sum exactly to the header, after a reload', () => {
    render(<StepsChat messages={timed('sum')} />);
    fireEvent.click(head());

    expect(head()).toHaveTextContent(/^Worked for 36s$/);
    expect(stepRows()).toEqual([
      ['Started up', '6s'],
      ['Thought · Planning the search', '9s'],
      ['Searched the web Fed minutes October 2026', '5s'],
      ['Thought', '2s'],
      [`Ran ${longCommand}`, '3s'],
      ['Answered', '11s'],
    ]);
    expect(stepRows().reduce((sum, [, time]) => sum + secondsIn(time), 0)).toBe(36);
  });

  it('folds a start-up under a second into the first step, so the sum still ties', () => {
    render(<StepsChat messages={timed('quick', 0.4)} />);
    fireEvent.click(head());

    expect(stepRows()[0]).toEqual(['Thought · Planning the search', '15s']);
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
    fireEvent.click(screen.getByRole('button', { name: /^Thought · Planning the search/ }));

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

    expect(stepRows().slice(2, 4)).toEqual([['Ran sleep 5', '6s'], ['Ran true', '0s']]);
    expect(stepRows().reduce((sum, [, time]) => sum + secondsIn(time), 0)).toBe(36);
  });

  it('times the steps of a Turn recorded before its question was stamped from its first step, with no start-up', () => {
    const [question, ...rest] = timed('old');
    assert(question, 'a question');
    render(<StepsChat messages={[{ ...question, metadata: undefined }, ...rest]} />);
    fireEvent.click(head());

    expect(stepRows()[0]).toEqual(['Thought · Planning the search', '9s']);
    expect(stepRows().reduce((sum, [, time]) => sum + secondsIn(time), 0)).toBe(29);
  });

  it("renders a thought heading in bold and copies the original provider Markdown", async () => {
    render(<StepsChat messages={timed('plain')} />);
    fireEvent.click(head());
    fireEvent.click(screen.getByRole('button', { name: /^Thought · Planning the search/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Thought · 9s' });
    const detail = dialog.querySelector('.step-section-text');
    expect(detail?.querySelector('strong, [data-streamdown="strong"]')).toHaveTextContent('Planning the search');
    expect(detail).toHaveTextContent('Minutes first, then the price pull.');
    expect(detail).not.toHaveTextContent('**');
    const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy reasoning' }));
    expect(write).toHaveBeenCalledWith('**Planning the search**\n\nMinutes first, then the price pull.');
    write.mockRestore();
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
    expect(stepRows()).toEqual([['Searching the web Fed minutes', '2s']]);
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
    expect(stepRows()).toEqual([['Searching the web Fed minutes', '2s']]);
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
    expect(stepRows()).toEqual([['Searching the web Fed minutes', '2s']]);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(head()).toHaveTextContent(/^Working · 3s$/);
    expect(stepRows()).toEqual([['Searching the web Fed minutes', '3s']]);
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
    expect(stepRows()).toEqual([['Started up', '2s'], ['Thought · Planning the search', '6s'], ['Searching the web Fed minutes October 2026', '1s']]);
    expect(head()).toHaveTextContent(/^Working · 9s$/);
    at(12, [question, thought, search, result]);
    expect(sum()).toBe(13);
    expect(head()).toHaveTextContent(/^Working · 13s$/);
    at(14, [question, thought, search, result, { ...thought, id: 'live-r2', content: '' }]);
    expect(sum()).toBe(15);
    expect(head()).toHaveTextContent(/^Working · 15s$/);
  });
});

it('shows every summary part and opens the last multi-sentence thought intact', async () => {
  const last = '**Verify the final result**\n\nThe second part belongs to the next item. Its final sentence must survive replay.';
  render(<StepsChat messages={[
    { id: 'multipart-u', role: 'user', content: 'Compare the financing paths', ...stamp(0, 0) },
    { id: 'multipart-r0', role: 'reasoning', content: '**Compare funding paths**\n\nThe first item has a complete summary. Discount every dated equity cash flow.', ...stamp(0, 1) },
    { id: 'multipart-r1', role: 'reasoning', content: '**Check the tax branch**\n\nThe next item restarts its summary index at zero. Keep this whole paragraph.', ...stamp(1, 2) },
    { id: 'multipart-r2', role: 'reasoning', content: last, ...stamp(2, 3) },
    { id: 'multipart-a', role: 'assistant', content: 'hello', ...stamp(3, 4) },
  ]} />);
  fireEvent.click(head());
  expect(screen.getByRole('button', { name: /^Thought · Compare funding paths/ })).toBeVisible();
  expect(screen.getByRole('button', { name: /^Thought · Check the tax branch/ })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: /^Thought · Verify the final result/ }));
  const dialog = await screen.findByRole('dialog');
  expect(dialog.querySelector('.step-section-text')).toHaveTextContent('Verify the final result');
  expect(dialog.querySelector('.step-section-text')).toHaveTextContent('The second part belongs to the next item. Its final sentence must survive replay.');
});

it('renders a completed Thought heading with a literal internal asterisk in bold', async () => {
  const summary = '**Expressing E* targets**';
  render(<StepsChat messages={[
    { id: 'star-u', role: 'user', content: 'Audit the targets', ...stamp(0, 0) },
    { id: 'star-r', role: 'reasoning', content: summary, ...stamp(0, 1) },
    { id: 'star-a', role: 'assistant', content: 'Targets audited.', ...stamp(1, 2) },
  ]} />);
  fireEvent.click(head());
  fireEvent.click(screen.getByRole('button', { name: /^Thought · Expressing E\* targets/ }));
  const dialog = await screen.findByRole('dialog');
  const detail = dialog.querySelector('.step-section-text');
  await waitFor(() => expect(detail?.querySelector('strong, [data-streamdown="strong"]')).toHaveTextContent('Expressing E* targets'));
  expect(detail?.textContent).toBe('Expressing E* targets');
  const write = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Copy reasoning' }));
  expect(write).toHaveBeenCalledWith(summary);
  write.mockRestore();
});

it('canonical boundaries keep a completed tool gap stable in a fresh saved view', async () => {
  vi.useFakeTimers({ now: START });
  let question = { id: 'gap-u', role: 'user', content: 'Compare markets', metadata: { ...stamp(0, 0).metadata, worklog_clock: { version: 1, at: START } } };
  const first = { id: 'gap-a1', role: 'assistant', content: '', toolCalls: [call('gap-c1', 'execute', { command: 'first' })], ...stamp(0, 0) };
  const firstResult = { id: 'gap-t1', role: 'tool', toolCallId: 'gap-c1', content: 'Done', ...stamp(0, 0.2) };
  const second = { id: 'gap-a2', role: 'assistant', content: '', toolCalls: [call('gap-c2', 'execute', { command: 'second' })], ...stamp(1.8, 1.8) };
  const secondResult = { id: 'gap-t2', role: 'tool', toolCallId: 'gap-c2', content: 'Done', ...stamp(1.8, 2) };
  const answer = { id: 'gap-answer', role: 'assistant', content: 'Compared', ...stamp(2, 2) };
  const view = render(<StepsChat messages={[question, first]} running />);
  act(() => { vi.advanceTimersByTime(200); });
  view.rerender(<StepsChat messages={[question, first, firstResult]} running />);
  act(() => { vi.advanceTimersByTime(800); });
  question = { ...question, metadata: { ...question.metadata, worklog_clock: { version: 1, at: START + 1000 } } };
  view.rerender(<StepsChat messages={[question, first, firstResult]} running />);
  expect(stepRows()).toEqual([['Ran first', '1s']]);
  act(() => { vi.advanceTimersByTime(800); });
  view.rerender(<StepsChat messages={[question, first, firstResult, second]} running />);
  act(() => { vi.advanceTimersByTime(200); });
  view.rerender(<StepsChat messages={[question, first, firstResult, second, secondResult, answer]} />);
  fireEvent.click(head());
  const clocks = () => stepRows().filter(([label]) => /first|second/.test(label ?? '')).map(([, time]) => time);
  const displayed = clocks();
  expect(displayed).toEqual(['2s', '0s']);
  view.unmount();
  sessionStorage.clear();
  vi.resetModules();
  const fresh = await import('./worklog');
  render(<fresh.Worklog id={first.id} asked={question.id} question={question} turn={[first, firstResult, second, secondResult, answer]} running={false}>
    <fresh.ToolStep id="gap-c1" name="execute" params={{ command: 'first' }} status="complete" output="Done" />
    <fresh.ToolStep id="gap-c2" name="execute" params={{ command: 'second' }} status="complete" output="Done" />
  </fresh.Worklog>);
  fireEvent.click(head());
  expect(clocks()).toEqual(displayed);
});

it('canonical progress keeps delayed delivery allocations in a fresh saved view', async () => {
  vi.useFakeTimers({ now: START });
  let question = { id: 'canonical-delivery-u', role: 'user', content: 'Compare markets', metadata: { ...stamp(0, 0).metadata, worklog_clock: { version: 1, at: START } } };
  const first = { id: 'canonical-delivery-a1', role: 'assistant', content: '', toolCalls: [call('canonical-delivery-c1', 'execute', { command: 'first' })], ...stamp(0, 0) };
  const firstResult = { id: 'canonical-delivery-t1', role: 'tool', toolCallId: 'canonical-delivery-c1', content: 'Done', ...stamp(0, 0.2) };
  const second = { id: 'canonical-delivery-a2', role: 'assistant', content: '', toolCalls: [call('canonical-delivery-c2', 'execute', { command: 'second' })], ...stamp(0.2, 0.2) };
  const secondResult = { id: 'canonical-delivery-t2', role: 'tool', toolCallId: 'canonical-delivery-c2', content: 'Done', ...stamp(0.2, 2) };
  const answer = { id: 'canonical-delivery-answer', role: 'assistant', content: 'Compared', ...stamp(2, 2) };
  const view = render(<StepsChat messages={[question, first]} running />);
  act(() => { vi.advanceTimersByTime(1000); });
  expect(head()).toHaveTextContent(/^Working · 0s$/);
  question = { ...question, metadata: { ...question.metadata, worklog_clock: { version: 1, at: START + 200 } } };
  view.rerender(<StepsChat messages={[question, first, firstResult, second]} running />);
  question = { ...question, metadata: { ...question.metadata, worklog_clock: { version: 1, at: START + 1000 } } };
  view.rerender(<StepsChat messages={[question, first, firstResult, second]} running />);
  expect(head()).toHaveTextContent(/^Working · 1s$/);
  expect(stepRows().map(([, time]) => time)).toEqual(['0s', '1s']);
  question = { ...question, metadata: { ...question.metadata, worklog_clock: { version: 1, at: START + 2000 } } };
  view.rerender(<StepsChat messages={[question, first, firstResult, second, secondResult, answer]} />);
  expect(head()).toHaveTextContent(/^Worked for 2s$/);
  fireEvent.click(head());
  const clocks = () => stepRows().filter(([label]) => /first|second/.test(label ?? '')).map(([, time]) => time);
  const displayed = clocks();
  expect(displayed).toEqual(['0s', '2s']);
  view.unmount();
  sessionStorage.clear();
  vi.resetModules();
  const fresh = await import('./worklog');
  const savedQuestion = { ...question, metadata: { ...question.metadata, worklog_clock: { version: 1 } } };
  render(<fresh.Worklog id={first.id} asked={question.id} question={savedQuestion} turn={[first, firstResult, second, secondResult, answer]} running={false}>
    <fresh.ToolStep id="canonical-delivery-c1" name="execute" params={{ command: 'first' }} status="complete" output="Done" />
    <fresh.ToolStep id="canonical-delivery-c2" name="execute" params={{ command: 'second' }} status="complete" output="Done" />
  </fresh.Worklog>);
  fireEvent.click(head());
  expect(clocks()).toEqual(displayed);
});

it('canonical boundaries leave overlapping time with the first parallel call', () => {
  const question = { id: 'canonical-parallel-u', role: 'user', content: 'Compare markets', metadata: { ...stamp(0, 0).metadata, worklog_clock: { version: 1 } } };
  const tools = { id: 'canonical-parallel-a', role: 'assistant', content: '', toolCalls: [call('canonical-slow', 'execute', { command: 'slow' }), call('canonical-fast', 'execute', { command: 'fast' })], ...stamp(0, 0) };
  const slow = { id: 'canonical-parallel-slow', role: 'tool', toolCallId: 'canonical-slow', content: 'Done', ...stamp(0, 5) };
  const fast = { id: 'canonical-parallel-fast', role: 'tool', toolCallId: 'canonical-fast', content: 'Done', ...stamp(0, 2) };
  const answer = { id: 'canonical-parallel-answer', role: 'assistant', content: 'Compared', ...stamp(5, 5) };
  render(<StepsChat messages={[question, tools, fast, slow, answer]} />);
  fireEvent.click(head());
  expect(stepRows().slice(0, 2)).toEqual([['Ran slow', '5s'], ['Ran fast', '0s']]);
  expect(head()).toHaveTextContent(/^Worked for 5s$/);
});

it('keeps a stopped answer clock when its public message id differs from its model timing id', () => {
  const question = { id: 'cut-clock-question', role: 'user', content: 'Explain duration', metadata: {
    ...stamp(0, 0).metadata,
    worklog_clock: { version: 1, question_id: 'cut-clock-question', started_at: START, at: START + 9000, ended_at: START + 9000,
      steps: { 'cut-thought': { started_at: START, ended_at: START + 1000 }, 'model-clock': { started_at: START + 1000, ended_at: START + 9000 } } },
  } };
  const thought = { id: 'cut-thought', role: 'reasoning', content: 'Compare the exposures', ...stamp(0, 1) };
  const answer = { id: 'provider-cut-answer', role: 'assistant', content: 'Duration measures rate risk.', metadata: { ...stamp(1, 2).metadata, timing_id: 'model-clock' } };
  render(<StepsChat messages={[question, thought, answer]} />);
  expect(head()).toHaveTextContent(/^Worked for 9s$/);
  fireEvent.click(head());
  expect(stepRows().map(([, time]) => time)).toEqual(['1s', '8s']);
});

it('keeps the terminal quiet gap on the last completed Thought in fresh history', () => {
  const question = { id: 'quiet-terminal-question', role: 'user', content: 'Compare exposures', metadata: {
    ...stamp(0, 0).metadata,
    worklog_clock: { version: 1, question_id: 'quiet-terminal-question', started_at: START, at: START + 9000, ended_at: START + 9000,
      steps: { 'quiet-terminal-thought': { started_at: START, ended_at: START + 1000 } } },
  } };
  const thought = { id: 'quiet-terminal-thought', role: 'reasoning', content: 'Compare the exposures', ...stamp(0, 1) };
  render(<StepsChat messages={[question, thought]} />);
  expect(head()).toHaveTextContent(/^Worked for 9s$/);
  fireEvent.click(head());
  expect(stepRows().map(([, time]) => time)).toEqual(['9s']);
});

const reconnectSpans: readonly [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 10], [10, 11], [11, 12], [12, 13], [13, 14], [14, 15]];
function reconnectTurn(count: number, through: number, saved = false): TurnMessage[] {
  return reconnectSpans.slice(0, count).flatMap(([began, ended], index) => {
    const timing = `reconnect-model-${index}`;
    const calling = { ...call(`reconnect-call-${index}`, 'execute'), metadata: { timing_id: timing, worklog_started_at: START + began * 1000 } };
    const tool = { id: `${saved ? 'stored' : 'live'}-reconnect-${index}`, role: 'assistant', content: '', toolCalls: [calling], metadata: { ...stamp(began, began).metadata, timing_id: timing } };
    const result = { id: `reconnect-result-${index}`, role: 'tool', toolCallId: calling.id, content: 'Done', ...stamp(began, ended) };
    return ended <= through ? [tool, result] : [tool];
  });
}
function reconnectQuestion(through?: number): TurnMessage {
  const steps = Object.fromEntries(reconnectSpans.slice(0, through === 15 ? 12 : 7).map(([began, ended], index) => [
    `reconnect-model-${index}`, { started_at: START + began * 1000, ...(ended <= (through ?? 0) ? { ended_at: START + ended * 1000 } : {}) },
  ]));
  return { id: 'canonical-reconnect-question', role: 'user', content: 'Compare twelve markets', metadata: { ...stamp(0, 0).metadata,
    worklog_clock: through === undefined ? { version: 1 } : { version: 1, question_id: 'canonical-reconnect-question', started_at: START, at: START + through * 1000, steps },
  } };
}
function reconnectView(lib: typeof import('./worklog'), question: TurnMessage, turn: TurnMessage[], running: boolean) {
  return <lib.Worklog id={turn[0]?.id ?? question.id} asked={question.id} question={question} turn={turn} running={running}>
    {turn.flatMap(message => message.toolCalls ?? []).map(calling => {
      const complete = turn.some(message => message.role === 'tool' && message.toolCallId === calling.id);
      return <lib.ToolStep key={calling.id} id={calling.id} name="execute" params={{ command: calling.id }} status={complete ? 'complete' : 'running'} output={complete ? 'Done' : undefined} />;
    })}
  </lib.Worklog>;
}
it('keeps authoritative Worklog progress through a twelve-step mid-Turn reload and reconnect', async () => {
  vi.useFakeTimers({ now: START + 9000 });
  const lib = await import('./worklog');
  const view = render(reconnectView(lib, reconnectQuestion(9), reconnectTurn(7, 9), true));
  expect(head()).toHaveTextContent(/^Working · 9s$/);
  expect(stepRows().map(([, time]) => time)).toEqual(['1s', '1s', '1s', '1s', '1s', '1s', '3s']);
  const order = () => [...document.querySelectorAll('.worklog-step[data-step-id]')].map(step => step.getAttribute('data-step-id'));
  const before = order();
  view.unmount();
  vi.resetModules();
  vi.setSystemTime(START + 600000);
  const reloaded = await import('./worklog');
  const resumed = render(reconnectView(reloaded, reconnectQuestion(), reconnectTurn(7, 9, true), true));
  expect(head()).toHaveTextContent(/^Working · 9s$/);
  expect(stepRows().map(([, time]) => time)).toEqual(['1s', '1s', '1s', '1s', '1s', '1s', '3s']);
  expect(order()).toEqual(before);
  resumed.rerender(reconnectView(reloaded, reconnectQuestion(10), reconnectTurn(7, 10, true), true));
  expect(head()).toHaveTextContent(/^Working · 10s$/);
  expect(stepRows().map(([, time]) => time)).toEqual(['1s', '1s', '1s', '1s', '1s', '1s', '4s']);
  expect(order()).toEqual(before);
  const completed = [...reconnectTurn(12, 15, true), { id: 'reconnect-final-answer', role: 'assistant', content: 'Compared the markets', ...stamp(15, 15) }];
  resumed.rerender(reconnectView(reloaded, reconnectQuestion(15), completed, false));
  fireEvent.click(head());
  const displayed = stepRows().map(([, time]) => time);
  expect(head()).toHaveTextContent(/^Worked for 15s$/);
  expect(displayed).toEqual(['1s', '1s', '1s', '1s', '1s', '1s', '4s', '1s', '1s', '1s', '1s', '1s', '0s']);
  resumed.unmount();
  sessionStorage.clear();
  vi.resetModules();
  const fresh = await import('./worklog');
  render(reconnectView(fresh, reconnectQuestion(), completed, false));
  fireEvent.click(head());
  expect(head()).toHaveTextContent(/^Worked for 15s$/);
  expect(stepRows().map(([, time]) => time)).toEqual(displayed);
});


it('keeps the terminal server clock through the completed-message handoff', async () => {
  vi.useFakeTimers({ now: START });
  const question = { id: 'terminal-handoff-question', role: 'user', content: 'Compare markets' };
  const thought = { id: 'terminal-handoff-thought', role: 'reasoning', content: 'Compare the sources' };
  const clock = { version: 1, question_id: question.id, started_at: START, at: START + 794000, steps: { [thought.id]: { started_at: START, ended_at: START + 794000 } } };
  const agent = new HttpAgent({ url: 'http://chat.test', initialState: { worklog_clock: clock } });
  const answer = { id: 'terminal-handoff-answer', role: 'assistant', content: 'Compared the markets' };
  const show = (running: boolean, answering = !running) => <WorklogAgent.Provider value={agent}><StepsChat messages={answering ? [question, thought, answer] : [question, thought]} running={running} /></WorklogAgent.Provider>;
  const view = render(show(true));
  expect(head()).toHaveTextContent(/^Working · 13m 14s$/);
  expect(stepRows()).toEqual([['Thinking', '13m 14s']]);
  view.rerender(show(true, true));
  act(() => { vi.setSystemTime(START + 796000); agent.setState({ worklog_clock: { ...clock, at: START + 795000, ended_at: START + 795000, steps: { ...clock.steps, [answer.id]: { started_at: START + 794000, ended_at: START + 795000 } } } }); });
  view.rerender(show(false));
  expect(head()).toHaveTextContent(/^Worked for 13m 15s$/);
  fireEvent.click(head());
  const displayed = [['Thought', '13m 14s'], ['Answered', '1s']];
  expect(stepRows()).toEqual(displayed);
  act(() => { vi.advanceTimersByTime(2000); });
  expect(head()).toHaveTextContent(/^Worked for 13m 15s$/);
  view.unmount();
  sessionStorage.clear();
  vi.resetModules();
  const fresh = await import('./worklog');
  const savedQuestion = { ...question, metadata: { ...stamp(0, 0).metadata, worklog_clock: { version: 1 } } };
  const savedThought = { ...thought, ...stamp(0, 794) };
  const savedAnswer = { ...answer, ...stamp(794, 795) };
  render(<fresh.Worklog id={thought.id} asked={question.id} question={savedQuestion} turn={[savedThought, savedAnswer]} running={false}>
    <fresh.ThoughtStep message={savedThought} />
  </fresh.Worklog>);
  fireEvent.click(head());
  expect(head()).toHaveTextContent(/^Worked for 13m 15s$/);
  expect(stepRows()).toEqual(displayed);
});


it('keeps a saved question independent of another question server clock', () => {
  const question = { id: 'saved-independent-question', role: 'user', content: 'Compare markets', metadata: { ...stamp(0, 0).metadata, worklog_clock: { version: 1 } } };
  const thought = { id: 'saved-independent-thought', role: 'reasoning', content: 'Compare', ...stamp(0, 795) };
  const agent = new HttpAgent({ url: 'http://chat.test', initialState: { worklog_clock: { version: 1, question_id: 'other-question', started_at: START, at: START + 2000000 } } });
  render(<WorklogAgent.Provider value={agent}><StepsChat messages={[question, thought]} /></WorklogAgent.Provider>);
  expect(head()).toHaveTextContent(/^Worked for 13m 15s$/);
  act(() => { agent.setState({ worklog_clock: { version: 1, question_id: 'other-question', at: START + 3000000 } }); });
  expect(head()).toHaveTextContent(/^Worked for 13m 15s$/);
});

it('keeps text a tool call followed on its own timed row, so its time never moves', () => {
  vi.useFakeTimers({ now: START });
  const at = (seconds: number) => START + seconds * 1000;
  type Clocks = Record<string, { started_at: number; ended_at?: number }>;
  const asked = (now: number, steps: Clocks) => ({ id: 'interim-u', role: 'user', content: 'Compare markets', metadata: {
    worklog_clock: { version: 1, question_id: 'interim-u', started_at: START, at: at(now), steps },
  } });
  const timedCall = (id: string, command: string, began: number) => ({ ...call(id, 'execute', { command }), metadata: { timing_id: id, worklog_started_at: at(began) } });
  const first = { id: 'interim-a1', role: 'assistant', content: '', toolCalls: [timedCall('interim-c1', 'rates', 0)] };
  const firstResult = { id: 'interim-t1', role: 'tool', toolCallId: 'interim-c1', content: 'Done' };
  const interim = { id: 'interim-text', role: 'assistant', content: 'Rates are in; checking equities next.', metadata: { timing_id: 'interim-lane-0' } };
  const helper = { id: 'interim-a2', role: 'assistant', content: '', toolCalls: [timedCall('interim-helper', 'helper', 8)] };
  const answer = { id: 'interim-answer', role: 'assistant', content: 'Compared', metadata: { timing_id: 'interim-lane-1' } };
  const done = { 'interim-c1': { started_at: at(0), ended_at: at(2) } };
  const working = { ...done, 'interim-lane-0': { started_at: at(2), ended_at: at(8) }, 'interim-helper': { started_at: at(8) } };
  const frames: [number, Clocks, TurnMessage[]][] = [
    ...[3, 5, 8].map((now): [number, Clocks, TurnMessage[]] => [now, { ...done, 'interim-lane-0': { started_at: at(2) } }, [first, firstResult, interim]]),
    ...[9, 12, 16, 20].map((now): [number, Clocks, TurnMessage[]] => [now, working, [first, firstResult, interim, helper]]),
    ...[20, 21].map((now): [number, Clocks, TurnMessage[]] => [now, { ...working, 'interim-lane-1': { started_at: at(20) } }, [first, firstResult, interim, helper, answer]]),
  ];
  const view = render(<StepsChat messages={[asked(0, {}), first]} running />);
  const timeOf = (id: string) => document.querySelector(`.worklog-step[data-step-id^="${id}"] .worklog-step-time`)?.textContent;
  let previous: { now: number; times: Map<string, number> } | undefined;
  for (const [now, steps, turn] of frames) {
    act(() => { vi.advanceTimersByTime(at(now) - Date.now()); });
    view.rerender(<StepsChat messages={[asked(now, steps), ...turn]} running />);
    expect(head(), `open at ${now}s`).toHaveAttribute('aria-expanded', 'true');
    const times = new Map(['interim-c1', 'interim-text', 'interim-helper'].map(id => [id, secondsIn(timeOf(id))]));
    for (const [id, seconds] of previous?.times ?? []) {
      const shown = times.get(id);
      if (shown === undefined || Number.isNaN(shown) || Number.isNaN(seconds) || !previous) continue;
      expect(shown, `${id} at ${now}s`).toBeGreaterThanOrEqual(seconds);
      expect(shown - seconds, `${id} at ${now}s`).toBeLessThanOrEqual(now - previous.now + 1);
    }
    previous = { now, times };
  }
  expect(timeOf('interim-text')).toBe('6s');
  expect(timeOf('interim-helper')).toBe('13s');
});
