import type { RunAgentInput } from '@ag-ui/client';
import { HttpError, type AgentModel, type ChatServiceCartridge, type Requester } from './cartridge.js';

type ModelSource<R extends Requester> = Pick<ChatServiceCartridge<R>, 'models' | 'accountModels'>;

/** Every model the account may run its Turns on: the account's own first (the one a client selects), then the Cartridge's. */
export async function accountModelList<R extends Requester>(cartridge: ModelSource<R>, requester: R): Promise<AgentModel[]> {
  return [...(await cartridge.accountModels(requester)), ...cartridge.models];
}

/** The account's default model: the first of its models, the one a client starts on. */
export function accountDefaultModel(models: readonly AgentModel[]): AgentModel {
  const [first] = models;
  if (first === undefined) throw new Error('The account has no models');
  return first;
}

/** The one of `models` that `key` names; a 422 when it names none of them. */
function allowedModel(models: readonly AgentModel[], key: unknown): AgentModel {
  const allowed = models.find((model) => model.key === key);
  if (allowed === undefined) throw new HttpError(422, `Model ${JSON.stringify(key)} is not available to this account`);
  return allowed;
}

/** The model `key` names: the Cartridge's, else one of the account's own; a 422 when it names none of them. */
export async function namedModel<R extends Requester>(cartridge: ModelSource<R>, requester: R, key: unknown): Promise<AgentModel> {
  // The Cartridge's own models need no lookup of the account's.
  if (cartridge.models.some((model) => model.key === key)) return allowedModel(cartridge.models, key);
  return allowedModel(await cartridge.accountModels(requester), key);
}

/**
 * The model the Turn runs on: the one its `forwardedProps.model` names, or the
 * account's default when it names none, never the Harness's own. Throw a
 * 422 when the named model is not one of the account's models' keys.
 */
export async function requireAllowedModel<R extends Requester>(
  input: RunAgentInput,
  cartridge: ModelSource<R>,
  requester: R,
): Promise<AgentModel> {
  const forwardedProps = (input.forwardedProps ?? {}) as Record<string, unknown>;
  if (!('model' in forwardedProps)) return accountDefaultModel(await accountModelList(cartridge, requester));
  return namedModel(cartridge, requester, forwardedProps.model);
}
