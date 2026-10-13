import { HttpError } from './cartridge.js';
import { upgradeWebSocket } from '@hono/node-server';
import type { WSContext } from 'hono/ws';
import { computerTrace, traceSelector, traceFailure, traceClose } from './agent-computer-trace.js';
import type { AgentComputerBrowser } from './agent-computer.js';
import { sharedCdpTransport, type CdpChannel } from './agent-computer-cdp-transport.js';
import { deniesCommand, filterEvent, type CdpMessage } from './cdp-filter.js';

/** The Agent Computer operations the CDP channel needs. */
interface Computers {
  wake(
    accountId: string,
    threadId: string,
  ): Promise<{ state: 'awake'; browserSessionId: string; control: 'user' | 'agent' } | { state: 'asleep' }>;
  use(accountId: string, sessionId: string): boolean;
  claimStream(accountId: string, sessionId: string, letGo: () => Promise<void>): (() => void) | null;
}

const USER_HAS_CONTROL = "The user has control of the Agent Computer's browser until they hand it back";

/** A WebSocket close reason is at most 123 bytes. */
const closeReason = (message: string) => Buffer.from(message).subarray(0, 123).toString();

/**
 * The agent's only way into its Agent Computer (ADR 0075 decision 5): a CDP
 * WebSocket that wakes the Session's browser, signed in to its site, and relays
 * the agent's commands through the CDP filter. A re-link-required account is
 * closed with the Credential Service's message, which cues the Sign-in Sheet.
 */
export function agentComputerCdp({
  computers,
  browser,
  verify,
}: {
  computers: Computers;
  browser: () => Pick<AgentComputerBrowser, 'automationStream' | 'control'>;
  verify: (token: string) => { accountId: string; threadId: string } | null;
}) {
  const { connect } = sharedCdpTransport({
    open: (_accountId, sessionId) => browser().automationStream(sessionId),
    claim: (accountId, sessionId, letGo) => computers.claimStream(accountId, sessionId, letGo),
  });
  return upgradeWebSocket((c) => {
    const session = verify(c.req.query('token') ?? '');
    if (session === null) throw new HttpError(401, 'Invalid Agent Computer token');
    const { accountId, threadId } = session;
    const trace = computerTrace(threadId);
    let stage = 'wake';
    let upstream: CdpChannel | null = null;
    let browserSessionId = '';
    const waiting: string[] = [];
    /** Commands relayed to the browser and not yet answered, by id, with their CDP session. */
    const inFlight = new Map<number | undefined, string | undefined>();
    let agentClosed = false;
    // agent-browser reports any close as "CDP response channel closed", so a Take-over refuses each command instead.
    let refusal: string | null = null;

    const refuse = (agent: WSContext, command: { id?: number | undefined; sessionId?: string | undefined }, message: string) =>
      agent.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, error: { code: -32000, message } }));

    const relay = (agent: WSContext, data: string) => {
      const command = JSON.parse(data) as CdpMessage;
      if (refusal !== null) {
        refuse(agent, command, refusal);
        return;
      }
      if (deniesCommand(command)) {
        refuse(agent, command, `${String(command.method)} is not allowed on the Agent Computer`);
        return;
      }
      if (!computers.use(accountId, browserSessionId)) {
        refusal = 'Agent Computer browser is no longer available to this account';
        waiting.length = 0;
        refuse(agent, command, refusal);
        agent.close(1008, refusal);
        return;
      }
      inFlight.set(command.id, command.sessionId);
      upstream?.send(data);
    };

    /** The user took the browser over: refuse what the browser left unanswered and every command from now on. */
    const takeOver = (agent: WSContext) => {
      refusal = USER_HAS_CONTROL;
      for (const [id, sessionId] of inFlight) refuse(agent, { id, sessionId }, refusal);
      inFlight.clear();
      for (const data of waiting.splice(0)) relay(agent, data);
    };

    async function open(agent: WSContext): Promise<void> {
      trace('wake.start');
      const state = await computers.wake(accountId, threadId);
      trace('wake.result', state.state === 'awake' ? { state: state.state, control: state.control, browser: traceSelector(state.browserSessionId) } : { state: state.state });
      if (state.state !== 'awake') throw new Error('Agent Computer did not wake');
      browserSessionId = state.browserSessionId;
      // A Take-over shuts the automation stream to the agent until the user hands the browser back.
      if (state.control === 'user') {
        takeOver(agent);
        return;
      }
      stage = 'connect';
      const channel = await connect(accountId, browserSessionId, {
        message(received) {
          inFlight.delete(received.id);
          const message = filterEvent(received);
          if (message !== null) agent.send(JSON.stringify(message));
        },
        closed() {
          trace('downstream.upstream-closed');
          upstream = null;
          if (agentClosed) return;
          browser()
            .control(browserSessionId)
            .then(
              (control) => (control === 'user' ? takeOver(agent) : agent.close(1011, 'Agent Computer browser closed')),
              (error: unknown) => agent.close(1011, closeReason(error instanceof Error ? error.message : String(error))),
            );
        },
      }, trace);
      trace('client.attached');
      if (agentClosed) {
        await channel.close();
        return;
      }
      upstream = channel;
      for (const data of waiting.splice(0)) relay(agent, data);
    }

    return {
      onOpen(_event, agent) {
        trace('downstream.open');
        open(agent).catch((error: unknown) => {
          trace('downstream.setup-error', { stage, ...traceFailure(error) });
          const message = error instanceof Error ? error.message : String(error);
          agent.close(error instanceof HttpError && error.status === 401 ? 1008 : 1011, closeReason(message));
        });
      },
      onMessage(event, agent) {
        const { data } = event;
        if (typeof data !== 'string') {
          agent.close(1003, 'CDP messages are text');
          return;
        }
        if (upstream === null && refusal === null) waiting.push(data);
        else relay(agent, data);
      },
      onClose(event, agent) {
        trace('downstream.close', traceClose(event));
        agentClosed = true;
        upstream?.close().catch((error: unknown) => {
          agent.close(1011, closeReason(error instanceof Error ? error.message : String(error)));
        });
      },
    };
  });
}
