import { HttpError } from './cartridge.js';
import { TurnIdentity, turnIdentityConfigFromEnv } from './turn-identity.js';
import { USER_TOKEN_AUDIENCE } from './user-token.js';

/** The user token's claim naming the Agent Computer browser BotCube just started. */
const AGENT_COMPUTER_SESSION_CLAIM = 'agentComputerSession';
const TOKEN_SECONDS = 120;
// Longer than a product's service may wait for a Sign-in still being saved before it answers.
const TIMEOUT_MS = 90_000;

/** Told of each Agent Computer browser BotCube starts, before the agent may use it; a failure stops that browser. */
export type AgentComputerStarted = (accountId: string, threadId: string, browserSessionId: string) => Promise<void>;

interface AgentComputerStartedOptions {
  /** BOTCUBE_AGENT_COMPUTER_STARTED_URL: the product's own service, which may prepare the browser (ADR 0091). */
  url: string;
  signer: Pick<TurnIdentity, 'signToken'>;
  /** Whether the account has not signed in, for the token's `anonymous` claim. */
  anonymous: (accountId: string) => Promise<boolean>;
  fetch?: typeof fetch;
}

/**
 * BotCube posts the User's signed user token, naming the new browser in its `agentComputerSession` claim, to the
 * configured URL and waits for a 2xx. The browser goes only to the service the deployment names, and only the
 * token's own claim says which browser it is, so a User cannot point it at another.
 */
export function agentComputerStarted({ url, signer, anonymous, fetch: send = fetch }: AgentComputerStartedOptions): AgentComputerStarted {
  return async (accountId, threadId, browserSessionId) => {
    const token = await signer.signToken({
      audience: USER_TOKEN_AUDIENCE, subject: accountId, lifetimeSeconds: TOKEN_SECONDS,
      claims: { anonymous: await anonymous(accountId), [AGENT_COMPUTER_SESSION_CLAIM]: browserSessionId, threadId },
    });
    let response: Response;
    try {
      response = await send(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw Object.assign(new HttpError(502, `The Agent Computer could not be prepared: ${url} did not answer`), { cause: error });
    }
    if (response.ok) return;
    const refusal = response.status === 401 || response.status === 403 ? refusalMessage(await response.text()) : undefined;
    if (refusal !== undefined) throw new HttpError(response.status, refusal);
    throw new HttpError(502, `The Agent Computer could not be prepared: ${url} answered HTTP ${response.status}`);
  };
}

/**
 * The service's own words when it refuses the User (401 or 403), as `{detail: string}` or `{detail: {message}}`: the
 * wake answers with them, so the product's page can tell the User what to do (ADR 0091).
 */
function refusalMessage(body: string): string | undefined {
  let detail: unknown;
  try {
    detail = (JSON.parse(body) as { detail?: unknown }).detail;
  } catch {
    return undefined;
  }
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (typeof detail === 'object' && detail !== null && 'message' in detail && typeof detail.message === 'string' && detail.message.trim()) {
    return detail.message;
  }
  return undefined;
}

/** The announcer BOTCUBE_AGENT_COMPUTER_STARTED_URL names, signing with the Turn identity keys; unset, none. */
export function agentComputerStartedFromEnv(env: NodeJS.ProcessEnv, anonymous: (accountId: string) => Promise<boolean>): AgentComputerStarted | undefined {
  const url = env.BOTCUBE_AGENT_COMPUTER_STARTED_URL?.trim();
  if (!url) return undefined;
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) throw new Error('BOTCUBE_AGENT_COMPUTER_STARTED_URL must be an http(s) URL');
  const identity = turnIdentityConfigFromEnv(env);
  if (identity === undefined) throw new Error('BOTCUBE_AGENT_COMPUTER_STARTED_URL is set, so BOTCUBE_TURN_IDENTITY_KEYS must be too: they sign the user token it is sent');
  return agentComputerStarted({ url, signer: new TurnIdentity(identity), anonymous });
}
