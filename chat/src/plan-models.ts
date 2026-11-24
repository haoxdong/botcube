import type { AccountStore } from './account-store.js';
import { isPlanModelKey, PLAN_MODEL_PREFIX, type AgentModel } from './models.js';
import { HttpError } from './http-error.js';
import { signCredentialServiceInvocation } from './credential-service-token.js';
import { isRecord } from './payload.js';
import { summarizePlanTurn, type FinishedTurn } from './turn-summaries.js';
import { planUsageRoutes, type OperatorInvocation, type PlanUsageSink } from './plan-usage.js';

// The Session a catalog fetch is signed for: it belongs to the plan, not to any one chat.
const PLAN_CATALOG_SESSION = 'plan-catalog';
const CREDENTIAL_SERVICE_TIMEOUT_MS = 30_000;

export interface PlanModelsConfig {
  /** The Credential Service: its OpenAI provider vaults the owner's Sign-in and relays the plan's catalog. */
  credentialServiceUrl: string | undefined;
  invocationSecret: string;
  /** The deployment's one Plan Usage owner, from trusted configuration. */
  ownerAccountId: string | undefined;
  store(): AccountStore;
}

const unbound = (): never => {
  throw new HttpError(503, 'The Credential Service is not configured: set BOTCUBE_CREDENTIAL_SERVICE_URL');
};

/**
 * Plan Usage (ADR 0078): the operator signs the owner in to OpenAI and out again, and the owner's
 * plan serves the owner and the Test Users the Chat holds with no deletion pending; every other
 * account has no plan models.
 */
export function planModels(config: PlanModelsConfig) {
  const provider = config.credentialServiceUrl === undefined ? null : openaiProvider(config.credentialServiceUrl);

  async function planAccountOf(accountId: string): Promise<string> {
    const owner = config.ownerAccountId;
    if (owner === undefined || accountId === owner) return accountId;
    const account = await config.store().loadAccount(accountId);
    return account?.status === 'test' && account.deletionOperationId === undefined ? owner : accountId;
  }

  async function catalog(refresh: boolean, accountId: string): Promise<AgentModel[]> {
    const plan = await planAccountOf(accountId);
    if (plan !== config.ownerAccountId) return [];
    const account = await config.store().loadAccount(plan);
    const identity = account?.openaiIdentity;
    if (identity === undefined) return [];
    if (provider === null) return unbound();
    if (!refresh && account?.planModels?.length) return account.planModels;
    const models = await provider.catalog(config.invocationSecret, plan);
    if (await config.store().recordPlanModels(plan, identity, models) === null) {
      throw new HttpError(409, 'OpenAI Sign-in changed while fetching the plan catalog');
    }
    return models;
  }

  return {
    /** The operator command's routes, mounted at `/account/plan-usage/openai`. */
    routes: planUsageRoutes({
      store: config.store,
      credentialSink: () => provider?.sink ?? unbound(),
      answerRefusal: (call) => call(),
      binding: { url: config.credentialServiceUrl ?? '', invocationToken: config.invocationSecret },
      ownerAccountId: config.ownerAccountId,
      accountNotFoundMessage: `${config.store().naming.product} account not found`,
    }),
    async summarizeTurn(owner: string, sessionId: string, model: AgentModel, turn: FinishedTurn) {
      if (provider === null) return unbound();
      return provider.summarize(config.invocationSecret, owner, sessionId, model, await planAccountOf(owner), turn);
    },
    accountModels: (owner: string, { refresh = false } = {}) => catalog(refresh, owner),
    /** The account whose plan a Turn on `model` runs on; none for a model off the plan. */
    planAccountId: async (owner: string, model: AgentModel) => (isPlanModelKey(model.key) ? planAccountOf(owner) : undefined),
  };
}

/** The Credential Service's OpenAI provider; a refusal or transport failure is a 503 naming it. */
function openaiProvider(url: string) {
  const root = `${new URL(url).origin}/openai`;

  function request(path: string, { token, accountId, sessionId }: OperatorInvocation, init: RequestInit = {}) {
    return fetch(`${root}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'x-botcube-account-id': accountId,
        'x-botcube-session-id': sessionId,
        'content-type': 'application/json',
      },
      signal: AbortSignal.timeout(CREDENTIAL_SERVICE_TIMEOUT_MS),
    }).catch((error: unknown) => {
      throw new HttpError(503, `Credential Service request failed: ${String(error)}`);
    });
  }

  async function call(step: string, path: string, operator: OperatorInvocation, init?: RequestInit) {
    const response = await request(path, operator, init);
    const body: unknown = await response.json().catch(() => {
      throw new HttpError(503, `Credential Service ${step} returned HTTP ${response.status} with a non-JSON body`);
    });
    return { ok: response.ok, status: response.status, body };
  }

  const sink: PlanUsageSink = {
    async ingestPlanUsage(operator, signIn) {
      const { ok, status, body } = await call('OpenAI ingest', '/auth/link/ingest', operator, { method: 'POST', body: JSON.stringify(signIn) });
      if (status === 400) throw new HttpError(400, text(record(body)?.detail) ?? 'Credential Service refused the Sign-in');
      const subject = text(record(body)?.subject);
      if (!ok || subject === undefined) throw new HttpError(503, `Credential Service OpenAI ingest failed with HTTP ${status}`);
      return subject;
    },
    async revokePlanUsage(operator) {
      const { ok, status } = await call('OpenAI revoke', '/auth/link/revoke', operator, { method: 'POST', body: '{}' });
      if (!ok) throw new HttpError(503, `Credential Service OpenAI revoke failed with HTTP ${status}`);
    },
  };

  return {
    sink,
    summarize(secret: string, accountId: string, sessionId: string, model: AgentModel, planAccountId: string, turn: FinishedTurn) {
      const slug = model.key.slice(PLAN_MODEL_PREFIX.length);
      const token = signCredentialServiceInvocation(secret, accountId, sessionId, {
        model: { provider: model.provider, id: slug }, planAccountId,
      });
      return summarizePlanTurn(slug, turn, (body) => request('/v1/responses', { token, accountId, sessionId }, { method: 'POST', body }));
    },
    async catalog(secret: string, accountId: string): Promise<AgentModel[]> {
      const token = signCredentialServiceInvocation(secret, accountId, PLAN_CATALOG_SESSION);
      const { ok, status, body } = await call('plan catalog', '/v1/models', { token, accountId, sessionId: PLAN_CATALOG_SESSION });
      if (!ok) throw new HttpError(503, planUsageError(body) ?? `Credential Service plan catalog failed with HTTP ${status}`);
      return listedModels(body);
    },
  };
}

/** The catalog's models the plan lists to its users, in the catalog's order; hidden ones are the plan's own. */
function listedModels(catalog: unknown): AgentModel[] {
  const models = record(catalog)?.models;
  if (!Array.isArray(models)) throw new HttpError(503, 'Credential Service plan catalog returned no models');
  const listed = models.flatMap((entry): AgentModel[] => {
    const model = record(entry);
    const slug = text(model?.slug);
    const label = text(model?.display_name);
    if (model === null || slug === undefined || label === undefined) {
      throw new HttpError(503, 'Credential Service plan catalog returned a model without a slug and name');
    }
    if (model.visibility !== 'list') return [];
    const description = text(model.description);
    return [{ key: `${PLAN_MODEL_PREFIX}${slug}`, label, ...(description ? { description } : {}), provider: 'openai' }];
  });
  if (listed.length === 0) throw new HttpError(503, 'Credential Service plan catalog returned no listed models');
  return listed;
}

/** The message of the Credential Service's classified Plan Usage error, in OpenAI's error shape. */
function planUsageError(body: unknown): string | undefined {
  const error = record(record(body)?.error);
  return error?.type === 'plan_usage' ? text(error.message) : undefined;
}

const record = (value: unknown) => (isRecord(value) ? value : null);

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
