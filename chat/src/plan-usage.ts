import { HttpError } from './cartridge.js';
import { Hono, type Context } from 'hono';
import { OpenAIIdentityTaken } from './account-resources.js';
import { verifyCredentialServiceInvocation } from './credential-service-token.js';
import { jsonPayload } from './payload.js';
export interface OperatorInvocation { token: string; accountId: string; sessionId: string; }
export interface PlanUsageSink { ingestPlanUsage(operator: OperatorInvocation, signIn: Record<string, unknown>): Promise<string>; revokePlanUsage(operator: OperatorInvocation): Promise<void>; }
export interface PlanUsageAccounts { loadAccount(accountId: string): Promise<unknown | null>; requireOpenAIIdentityFree(accountId: string, identity: string): Promise<void>; recordOpenAISignIn(accountId: string, identity: string): Promise<unknown>; removeOpenAISignIn(accountId: string): Promise<unknown>; }
/** The Credential Service's URL and the invocation token that signs requests to it. */
export interface CredentialServiceBinding { url: string; invocationToken: string; }

export interface PlanUsageDeps {
  store(): PlanUsageAccounts;
  /** Throws a 503 HttpError while the Credential Service is unbound. */
  credentialSink(): PlanUsageSink;
  answerRefusal<T>(call: () => Promise<T>): Promise<T>;
  /** Its invocation token is the secret the operator signs with, read through their AWS access. */
  binding: CredentialServiceBinding;
  /** Trusted deployment configuration, never an account chosen by an operator token. */
  ownerAccountId: string | undefined;
  accountNotFoundMessage: string;
}

/**
 * The operator command's routes for the owner's Plan Usage (ADR 0078 decision 5).
 * The Credential Service is private, so the command reaches its OpenAI ingest
 * and revoke through these; the verified token must name the configured owner.
 * A Sign-in is recorded only after its Vault row is stored, and
 * removed before its Vault row is revoked, so none is ever left without one.
 */
export function planUsageRoutes(deps: PlanUsageDeps): Hono {
  const routes = new Hono();

  const operator = async (c: Context, scope: string): Promise<[OperatorInvocation, PlanUsageSink]> => {
    const sink = deps.credentialSink();
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const invocation = verifyCredentialServiceInvocation(deps.binding.invocationToken, token);
    if (invocation === null || invocation.scope !== scope) {
      throw new HttpError(401, `Plan Usage needs a ${scope}-scoped Credential Service invocation token`);
    }
    if (deps.ownerAccountId === undefined) {
      throw new HttpError(503, 'Plan Usage owner account is not configured');
    }
    if (invocation.accountId !== deps.ownerAccountId) {
      throw new HttpError(403, 'Plan Usage is only available to the configured owner account');
    }
    if ((await deps.store().loadAccount(invocation.accountId)) === null) {
      throw new HttpError(404, deps.accountNotFoundMessage);
    }
    return [{ token, accountId: invocation.accountId, sessionId: invocation.sessionId }, sink];
  };

  routes.post('/', async (c) => {
    const [invocation, sink] = await operator(c, 'credential_capture');
    const signIn = (await jsonPayload(c)) ?? {};
    // A Sign-in whose identity another Account holds stores nothing: checked before the Vault row is replaced.
    const claimed = typeof signIn.subject === 'string' ? signIn.subject : null;
    if (claimed !== null) await conflictAsHttp(() => deps.store().requireOpenAIIdentityFree(invocation.accountId, claimed));
    const subject = await deps.answerRefusal(() => sink.ingestPlanUsage(invocation, signIn));
    await conflictAsHttp(() => deps.store().recordOpenAISignIn(invocation.accountId, subject));
    return c.json({ status: 'stored', subject });
  });

  routes.delete('/', async (c) => {
    const [invocation, sink] = await operator(c, 'credential_revocation');
    await deps.store().removeOpenAISignIn(invocation.accountId);
    await deps.answerRefusal(() => sink.revokePlanUsage(invocation));
    return c.json({ status: 'removed' });
  });

  return routes;
}

async function conflictAsHttp<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof OpenAIIdentityTaken) throw new HttpError(409, error.message);
    throw error;
  }
}
