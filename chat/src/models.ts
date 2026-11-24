import { HttpError } from './http-error.js';
import type { Requester } from './requester.js';

/** A model an account may run its Turns on; a Turn names it by `key` in `forwardedProps.model`. */
export interface AgentModel {
  readonly key: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly provider: string;
}

export const PLAN_MODEL_PREFIX = 'openai-plan:';
export const isPlanModelKey = (key: string) => key.startsWith(PLAN_MODEL_PREFIX);

export interface ModelSource<R extends Requester = Requester> {
  readonly models: readonly [AgentModel, ...AgentModel[]];
  accountModels(requester: R, options?: { refresh?: boolean }): Promise<readonly AgentModel[]>;
}

export async function accountModelList<R extends Requester>(bot: ModelSource<R>, requester: R, options?: { refresh?: boolean }): Promise<readonly AgentModel[]> {
  const plan = await bot.accountModels(requester, options);
  return bot.models.filter(({ key }) => !isPlanModelKey(key) || plan.some((model) => model.key === key));
}

export function accountDefaultModel(models: readonly AgentModel[]): AgentModel {
  const [first] = models;
  if (first === undefined) throw new Error('The account has no models');
  return first;
}

export async function namedModel<R extends Requester>(bot: ModelSource<R>, requester: R, key: unknown): Promise<AgentModel> {
  if (key === undefined) return accountDefaultModel(await accountModelList(bot, requester));
  const named = bot.models.find((model) => model.key === key);
  if (named && (!isPlanModelKey(named.key) || (await bot.accountModels(requester)).some((model) => model.key === key))) {
    return named;
  }
  throw new HttpError(422, `Model ${JSON.stringify(key)} is not available to this account`);
}
