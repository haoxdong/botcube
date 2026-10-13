/**
 * The CDP URL with this ECS task's own address as its host, so a Turn's connection
 * reaches the task that issued its token and holds its Agent Computer; off ECS, unchanged.
 */
export async function onThisTask(url: string | undefined, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const metadata = env.ECS_CONTAINER_METADATA_URI_V4;
  if (url === undefined || !metadata) return url;
  const response = await fetch(metadata, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`ECS container metadata answered ${response.status}`);
  const { Networks } = (await response.json()) as { Networks?: { IPv4Addresses?: string[] }[] };
  const address = Networks?.[0]?.IPv4Addresses?.[0];
  if (!address) throw new Error('ECS container metadata names no IPv4 address for this task');
  const own = new URL(url);
  own.hostname = address;
  return own.toString();
}
