import type { RunAgentInput } from '@ag-ui/client';
import { HttpError } from './http-error.js';
import type { Requester } from './requester.js';

/** A model an account may run its Turns on; a Turn names it by `key` in `forwardedProps.model`. */
export interface AgentModel {
  readonly key: string;
  readonly label: string;
  readonly description?: string | undefined;
  /** Whose model it is: a Session's Turns all run on its first Turn's provider, so its history never mixes two. */
  readonly provider: string;
}

/** Where a Turn's models come from: the bot settings' own, and the ones an account may also run. */
export interface ModelSource<R extends Requester = Requester> {
  /** The bot settings' models, which every account may run; the first is the default. */
  readonly models: readonly [AgentModel, ...AgentModel[]];
  /** The models this account may also run, such as its plan's; `refresh` asks for them afresh. */
  accountModels(requester: R, options?: { refresh?: boolean }): Promise<readonly AgentModel[]>;
  /** The account model `key` names, or undefined when the account may not run it. */
  accountModel(requester: R, key: string): Promise<AgentModel | undefined>;
}

/** Every model the account may run its Turns on: the account's own first (the one a client selects), then the bot's. */
export async function accountModelList<R extends Requester>(bot: ModelSource<R>, requester: R, options?: { refresh?: boolean }): Promise<AgentModel[]> {
  return [...(await bot.accountModels(requester, options)), ...bot.models];
}

/** The account's default model: the first of its models, the one a client starts on. */
export function accountDefaultModel(models: readonly AgentModel[]): AgentModel {
  const [first] = models;
  if (first === undefined) throw new Error('The account has no models');
  return first;
}

/** The model `key` names: the bot's, else the account's; a 422 when it names neither. */
export async function namedModel<R extends Requester>(bot: Pick<ModelSource<R>, 'models' | 'accountModel'>, requester: R, key: unknown): Promise<AgentModel> {
  const named = bot.models.find((model) => model.key === key) ?? (typeof key === 'string' ? await bot.accountModel(requester, key) : undefined);
  if (named === undefined) throw new HttpError(422, `Model ${JSON.stringify(key)} is not available to this account`);
  return named;
}

/**
 * The model the Turn runs on: the one its `forwardedProps.model` names, or the
 * account's default when it names none, never the Harness's own. Throw a
 * 422 when the named model is neither a bot model nor an account model's key.
 */
export async function requireAllowedModel<R extends Requester>(
  input: RunAgentInput,
  bot: ModelSource<R>,
  requester: R,
): Promise<AgentModel> {
  const forwardedProps = (input.forwardedProps ?? {}) as Record<string, unknown>;
  if (!('model' in forwardedProps)) return accountDefaultModel(await accountModelList(bot, requester));
  return namedModel(bot, requester, forwardedProps.model);
}
