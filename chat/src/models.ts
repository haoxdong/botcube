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
  /** The plan catalog, or an empty list when there is no plan sign-in. */
  accountModels(requester: R, options?: { refresh?: boolean }): Promise<readonly AgentModel[]>;
}

export async function accountModelList<R extends Requester>(bot: ModelSource<R>, requester: R, options?: { refresh?: boolean }): Promise<readonly AgentModel[]> {
  const plan = await bot.accountModels(requester, options);
  return plan.length ? plan : bot.models;
}

export function accountDefaultModel(models: readonly AgentModel[]): AgentModel {
  const [first] = models;
  if (first === undefined) throw new Error('The account has no models');
  return first;
}

export async function namedModel<R extends Requester>(bot: ModelSource<R>, requester: R, key: unknown): Promise<AgentModel> {
  const models = await accountModelList(bot, requester);
  if (key === undefined || (isPlanModelKey(models[0]?.key ?? '') && bot.models.some((model) => model.key === key))) {
    return accountDefaultModel(models);
  }
  const named = models.find((model) => model.key === key);
  if (named === undefined) throw new HttpError(422, `Model ${JSON.stringify(key)} is not available to this account`);
  return named;
}
