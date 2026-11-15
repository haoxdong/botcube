import { useEffect, useState } from "react";

import type { AuthUiState } from "../cartridge/index.js";
import type { Published } from "./artifact-published";

export type ArtifactRequest = { accountId: string; artifact: Published; handled: () => void };

export function useArtifactRequest(
  request: ArtifactRequest | undefined,
  accountId: string | undefined,
  seen: (artifact: Published) => void,
  open: (next: { id: string; full: boolean }) => void,
) {
  useEffect(() => {
    if (request === undefined || request.accountId !== accountId) return;
    seen(request.artifact);
    open({ id: request.artifact.id, full: false });
    request.handled();
  }, [request, accountId, seen, open]);
}

export function useArtifactWorkspace({ accountId, isAccountCurrent }: Pick<AuthUiState, "accountId" | "isAccountCurrent">) {
  const [workspace, setWorkspace] = useState<{ accountId: string; request?: ArtifactRequest }>();
  useEffect(() => setWorkspace(undefined), [accountId]);
  const current = workspace?.accountId === accountId ? workspace : undefined;
  const select = (artifact: Published) => {
    if (accountId === undefined || isAccountCurrent?.(accountId) === false) return false;
    const request: ArtifactRequest = { accountId, artifact, handled: () => setWorkspace((before) => before?.request === request ? { accountId } : before) };
    setWorkspace({ accountId, request });
    return true;
  };
  return { request: current?.request, initialized: current !== undefined, select };
}

export function useChatSurfaceKey(accountId: string | undefined, chatId: string | null) {
  const [surface, setSurface] = useState({ accountId, chatId, lastLoadedId: chatId, key: `${accountId}:${chatId ?? ""}` });
  if (surface.accountId !== accountId || surface.chatId !== chatId) {
    const key = surface.accountId !== accountId || (surface.lastLoadedId !== null && chatId !== null && surface.lastLoadedId !== chatId)
      ? `${accountId}:${chatId ?? ""}` : surface.key;
    const lastLoadedId = surface.accountId !== accountId ? chatId : chatId ?? surface.lastLoadedId;
    const next = { accountId, chatId, lastLoadedId, key };
    setSurface(next);
    return key;
  }
  return surface.key;
}
