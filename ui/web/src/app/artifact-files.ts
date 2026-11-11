import { agentFiles } from "./agent-files";

/**
 * The panel's one reader of Files, by a Files path as the harness writes it (`/artifacts/q3 100%.md.versions/1.md`):
 * `agentFiles.url` takes a path percent-encoded, as a reply's link spells it.
 */
export const fileUrl = (path: string) => agentFiles.url(encodeURI(path));

async function fetchFile(path: string): Promise<Response> {
  const response = await fetch(await fileUrl(path));
  if (!response.ok) throw new Error(`Files answered ${response.status}`);
  return response;
}

export const readFile = async (path: string) => (await fetchFile(path)).text();
export const readBytes = async (path: string) => (await fetchFile(path)).arrayBuffer();
