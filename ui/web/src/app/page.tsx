"use client";

import "@copilotkit/react-core/v2/styles.css";
import { Arrives } from "./motion";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { flushSync } from "react-dom";
import { webUiPlugin } from "@bot-ui";
import type { AuthUiState } from "../plugin/index.js";
import { chatServiceUrl } from "../plugin/chat-service-url";
import { openingMainChat, type MainChatCopy, type StoredMainChatCopy } from "./main-chat-copy";
import { endOpeningMoment, type HistoryMoment } from "./latency";
import { discardOpeningResponse, peekOpeningResponse } from "../opening-requests";
import { rumConfig, startRum } from "./rum";
import { keepFileDropsInPage } from "./keep-file-drops";
import { KeptChat, preloadKeptChat, prepareKeptChat } from "./kept-chat";
import { SessionGate } from "./session-gate";
import { LoadingSkeleton } from "./load-state";

const App = lazy(async () => {
  if (typeof window !== "undefined" && openingMainChat().copy !== null) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }
  return import("./chat-app");
});
const UI_CONFIG = webUiPlugin.config;
const CHAT_SERVICE_URL = chatServiceUrl();

if (typeof window !== "undefined") {
  const { copy } = openingMainChat();
  if (copy !== null) preloadKeptChat(copy.copy.messages);
}

function OpeningChat({ opening, latestShown, moment }: { opening: StoredMainChatCopy | null; latestShown: RefObject<number>; moment: HistoryMoment | null }) {
  useEffect(() => {
    if (opening === null || moment === null) return;
    const frame = requestAnimationFrame(() => endOpeningMoment(moment));
    return () => cancelAnimationFrame(frame);
  }, [opening, moment]);
  return <SessionGate title={UI_CONFIG.title} agentName={UI_CONFIG.agentName} status="loading" loadFailure={undefined} chatServiceUrl={CHAT_SERVICE_URL}>
    <Arrives state={opening?.accountId ?? "empty"} className="app-chat app-chat-opening">{opening === null ? <LoadingSkeleton label="Main Chat" /> : <div className="kept-chat" role="status" aria-label="Loading chat controls">
      <KeptChat messages={opening.copy.messages} running={opening.copy.running === true} disclaimer={UI_CONFIG.disclaimer} latestShown={latestShown} />
    </div>}</Arrives>
  </SessionGate>;
}

export default function Page() {
  const AuthProvider = webUiPlugin.AuthProvider;
  const [rumError, setRumError] = useState<Error | null>(null);
  useEffect(() => {
    const config = rumConfig();
    let active = true;
    if (config !== null) void startRum(config).catch((error: Error) => {
      if (active) setRumError(error);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => keepFileDropsInPage(window), []);
  if (rumError !== null) throw rumError;
  return (
    <AuthProvider chatServiceUrl={CHAT_SERVICE_URL}>
      {(auth) => <Session auth={auth} />}
    </AuthProvider>
  );
}

function Session({ auth }: { auth: AuthUiState }) {
  const loading = auth.sessionStatus === "loading";
  const [opening, setOpening] = useState<StoredMainChatCopy | null>(null);
  const [openingError, setOpeningError] = useState<Error | null>(null);
  const pageOpeningMoment = useRef<HistoryMoment | null>(null);
  const latestShown = useRef(1);
  const firstVisitResponse = useRef<ReturnType<typeof peekOpeningResponse>>(null);
  const preparingOpening = useRef<{ accountId: string; active: boolean } | null>(null);
  useLayoutEffect(() => {
    const pending = preparingOpening.current;
    if (pending === null) return;
    const matching = auth.accountId === pending.accountId;
    const waiting = auth.sessionStatus === "loading" && (auth.accountId === undefined || matching);
    if (waiting || (auth.sessionStatus === "ready" && matching)) return;
    pending.active = false;
    preparingOpening.current = null;
  }, [auth.sessionStatus, auth.accountId]);
  useLayoutEffect(() => {
    const { copy, historyMoment: moment } = openingMainChat();
    pageOpeningMoment.current = moment;
    if (moment === "history-first-visit") firstVisitResponse.current = peekOpeningResponse(`${CHAT_SERVICE_URL}/main-chat`);
    if (!loading) return;
    if (copy === null) { setOpening(null); return; }
    const prepared = prepareKeptChat(copy.copy.messages);
    if (prepared === null) { setOpening(copy); return; }
    const pending = { accountId: copy.accountId, active: true };
    preparingOpening.current = pending;
    void prepared.then(
      () => { if (pending.active) { preparingOpening.current = null; flushSync(() => setOpening(copy)); } },
      (error: Error) => { if (pending.active) { preparingOpening.current = null; setOpeningError(error); } },
    );
    return () => { pending.active = false; preparingOpening.current = null; };
  }, []);
  useEffect(() => {
    const response = firstVisitResponse.current;
    if (response === null || auth.sessionStatus !== "ready" || auth.accountId === undefined) return;
    firstVisitResponse.current = null;
    const pending = { accountId: auth.accountId, active: true };
    preparingOpening.current = pending;
    void response.then(async (result) => {
      if ("error" in result) return null;
      const answered = result.response;
      if (!answered.ok) return null;
      const copy = await answered.json() as MainChatCopy;
      if (copy.messages.length === 0) return null;
      await prepareKeptChat(copy.messages);
      return { accountId: pending.accountId, copy };
    }).then(
      (copy) => { if (pending.active && copy !== null && auth.isAccountCurrent?.(pending.accountId) !== false) { preparingOpening.current = null; flushSync(() => setOpening(copy)); } },
      (error: Error) => { if (pending.active) { preparingOpening.current = null; setOpeningError(error); } },
    );
    return () => { pending.active = false; preparingOpening.current = null; };
  }, [auth.sessionStatus, auth.accountId]);
  useEffect(() => {
    if (auth.sessionStatus !== "loading" && auth.sessionStatus !== "ready") {
      pageOpeningMoment.current = null;
      firstVisitResponse.current = null;
      discardOpeningResponse(`${CHAT_SERVICE_URL}/main-chat`);
    }
  }, [auth.sessionStatus]);
  useEffect(() => {
    if (!loading && (auth.sessionStatus !== "ready" || auth.accountId !== opening?.accountId)) setOpening(null);
  }, [loading, auth.sessionStatus, auth.accountId, opening]);
  if (openingError !== null) throw openingError;
  const matchingOpening = loading || (auth.sessionStatus === "ready" && auth.accountId === opening?.accountId && auth.isAccountCurrent?.(auth.accountId) !== false) ? opening : null;
  return auth.sessionStatus === "ready" || (loading && opening !== null)
    ? <Suspense fallback={<OpeningChat key={matchingOpening?.accountId ?? "empty"} opening={matchingOpening} latestShown={latestShown} moment={pageOpeningMoment.current} />}><App auth={auth} opening={matchingOpening} historyMoment={pageOpeningMoment} keptChatLatestShown={latestShown} /></Suspense>
    : <SessionGate title={UI_CONFIG.title} agentName={UI_CONFIG.agentName} status={auth.sessionStatus} loadFailure={auth.loadFailure} chatServiceUrl={CHAT_SERVICE_URL} />;
}
