import type { RunAgentInput } from '@ag-ui/client';
import { HttpError, type AgentModel, type ChatServiceCartridge, type Requester } from './cartridge.js';

type ModelSource<R extends Requester> = Pick<ChatServiceCartridge<R>, 'models' | 'accountModels' | 'accountModel'>;

/** Every model the account may run its Turns on: the account's own first (the one a client selects), then the Cartridge's. */
export async function accountModelList<R extends Requester>(cartridge: ModelSource<R>, requester: R, options?: { refresh?: boolean }): Promise<AgentModel[]> {
  return [...(await cartridge.accountModels(requester, options)), ...cartridge.models];
}

/** The account's default model: the first of its models, the one a client starts on. */
export function accountDefaultModel(models: readonly AgentModel[]): AgentModel {
  const [first] = models;
  if (first === undefined) throw new Error('The account has no models');
  return first;
}

/** The model `key` names: the Cartridge's, else the account's; a 422 when it names neither. */
export async function namedModel<R extends Requester>(cartridge: Pick<ChatServiceCartridge<R>, 'models' | 'accountModel'>, requester: R, key: unknown): Promise<AgentModel> {
  const named = cartridge.models.find((model) => model.key === key) ?? (typeof key === 'string' ? await cartridge.accountModel(requester, key) : undefined);
  if (named === undefined) throw new HttpError(422, `Model ${JSON.stringify(key)} is not available to this account`);
  return named;
}

/**
 * The model the Turn runs on: the one its `forwardedProps.model` names, or the
 * account's default when it names none, never the Harness's own. Throw a
 * 422 when the named model is neither a Cartridge model nor an account model's key.
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
