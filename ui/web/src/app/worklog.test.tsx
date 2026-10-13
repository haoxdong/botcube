import { CopilotChatConfigurationProvider, CopilotChatMessageView, CopilotKitProvider } from '@copilotkit/react-core/v2';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

import { ThoughtStep, ToolStep, worklogRows, type TurnMessage } from './worklog';

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
    const view = render(<Chat messages={messages.slice(0, 3)} running />);

    expect(head()).toHaveTextContent(/^Working · 1s$/);
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

  it('stays open, while its Turn runs, as its answer streams in', () => {
    render(<Chat messages={turn('answering')} running />);

    expect(head()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('2s10s steepened to +45bp.')).toBeVisible();
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
  it("reads a running command by its verb and the command, without the cartridge's binary", () => {
    const { container } = render(<ToolStep name="execute" params={{ command: 'acme search "Japan"', timeout: null }} status="running" output={undefined} commandPrefix="acme " />);

    expect(container).toHaveTextContent(/^Runningsearch "Japan"$/);
  });

  it("opens a failed command's card: the full command, its exit code and its output without the trailer", () => {
    const { container } = render(
      <ToolStep
        name="execute"
        params={{ command: 'acme widget view @s3 --json' }}
        status="complete"
        output={'[stderr] Specify one or more comma-separated fields for `--json`\n[Command failed with exit code 1]'}
      />,
    );
    expect(container.querySelector('.lucide-circle-x')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Ran/ }));

    expect(container.querySelector('.worklog-step-input')).toHaveTextContent(/^\$ acme widget view @s3 --jsonExit 1$/);
    expect(container.querySelector('pre')).toHaveTextContent(/^\[stderr\] Specify one or more comma-separated fields for `--json`$/);
  });

  it('holds each word of a command together, so it wraps only at a space', () => {
    const { container } = render(<ToolStep name="execute" params={{ command: 'acme search "US CPI" --limit 1' }} status="complete" output="1 result" />);

    fireEvent.click(screen.getByRole('button', { name: /^Ran/ }));

    expect(Array.from(container.querySelectorAll('.worklog-step-input .code-word'), (word) => word.textContent)).toEqual(['"US', 'CPI"', '--limit']);
    expect(container.querySelector('.worklog-step-input')).toHaveTextContent(/^\$ acme search "US CPI" --limit 1$/);
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

  it('is a plain row, not a control, while it has nothing to open to', () => {
    const { container } = render(<ToolStep name="execute" params={{ command: 'ls' }} status="running" output={undefined} />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(container).toHaveTextContent(/^Runningls$/);
  });

  it("opens a call with no argument to its output alone, with no command row", () => {
    const { container } = render(<ToolStep name="ls" params={{}} status="complete" output="notes.md" />);

    fireEvent.click(screen.getByRole('button', { name: /^Listed/ }));

    expect(container.querySelector('.worklog-step-input')).toBeNull();
    expect(container.querySelector('pre')).toHaveTextContent(/^notes\.md$/);
  });
});

describe('a thought', () => {
  const words = '**Planning the rates pull**\n\nTreasuries and swaps likely live in different widgets.';

  it('shows nothing once finished with no words and no time', () => {
    const { container } = render(<ThoughtStep message={{ id: 'blank', role: 'reasoning', content: '' }} isRunning={false} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('is timed from its stamps, titled by its bold lead, and opens to the rest of its words', () => {
    const { container } = render(<ThoughtStep message={{ id: 'stamped', role: 'reasoning', content: words, ...stamp(2.8, 6.8) }} isRunning={false} />);
    expect(container).toHaveTextContent(/^Thought for 4sPlanning the rates pull$/);

    fireEvent.click(screen.getByRole('button'));

    expect(container.querySelector('.worklog-step-detail')).toHaveTextContent(/^Treasuries and swaps likely live in different widgets\.$/);
  });

  it('says "Thinking" while it streams, then how long it took', () => {
    vi.useFakeTimers({ now: START });
    const message = { id: 'streaming', role: 'reasoning', content: words };
    const view = render(<ThoughtStep message={message} isRunning isLatest />);
    expect(view.container).toHaveTextContent(/^ThinkingPlanning the rates pull$/);

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    view.rerender(<ThoughtStep message={message} isRunning isLatest={false} />);

    expect(view.container).toHaveTextContent(/^Thought for 3sPlanning the rates pull$/);
  });
});
