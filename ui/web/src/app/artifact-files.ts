import { agentFiles } from "./agent-files";
import type { FilesPath } from "./files-path";

/** The panel's one reader of Files. */
async function fetchFile(path: FilesPath): Promise<Response> {
  const response = await fetch(await agentFiles.url(path));
  if (!response.ok) throw new Error(`Files answered ${response.status}`);
  return response;
}

export const readFile = async (path: FilesPath) => (await fetchFile(path)).text();
export const readBytes = async (path: FilesPath) => (await fetchFile(path)).arrayBuffer();
