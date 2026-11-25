import { throwIfRefused } from "./refusal";

/** A model the account may run its Turns on, as `GET /agent/models` lists it. */
export interface AgentModel {
  key: string;
  label: string;
  description?: string;
  provider: string;
}

/** The models the account may run its Turns on; the first is the default. */
export async function fetchAgentModels({
  chatServiceUrl,
  fetchImpl = fetch,
}: {
  chatServiceUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<AgentModel[]> {
  const response = await fetchImpl(`${chatServiceUrl}/agent/models`, { cache: "no-store", credentials: "include" });
  await throwIfRefused(response, "Failed to load the models");
  return ((await response.json()) as { models: AgentModel[] }).models;
}
