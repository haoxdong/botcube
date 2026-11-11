"use client";

import "@copilotkit/react-core/v2/styles.css";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { webUiPlugin } from "@cartridge-ui";
import type { AuthUiState } from "../cartridge/index.js";
import { chatServiceUrl } from "../cartridge/chat-service-url";
import { openingMainChat, type StoredMainChatCopy } from "./main-chat-copy";
import { endOpeningMoment, type HistoryMoment } from "./latency";
import { discardOpeningResponse } from "../opening-requests";
import { rumConfig, startRum } from "./rum";
import { keepFileDropsInPage } from "./keep-file-drops";
import { KeptChat, prepareKeptChat } from "./kept-chat";
import { SessionGate } from "./session-gate";
import { Swap } from "./collapse";
import { LoadingSkeleton } from "./load-state";

const App = lazy(() => import("./chat-app"));
const UI_CONFIG = webUiPlugin.config;
const CHAT_SERVICE_URL = chatServiceUrl();

function OpeningChat({ opening, latestShown }: { opening: StoredMainChatCopy | null; latestShown: RefObject<number> }) {
  useEffect(() => {
    if (opening === null) return;
    const frame = requestAnimationFrame(() => endOpeningMoment("history-returning"));
    return () => cancelAnimationFrame(frame);
  }, [opening]);
  return <SessionGate title={UI_CONFIG.title} agentName={UI_CONFIG.agentName} status="loading" loadFailure={undefined} chatServiceUrl={CHAT_SERVICE_URL}>
    <Swap state={opening?.accountId ?? "empty"} className="app-chat app-chat-opening">{opening === null ? <LoadingSkeleton label="Main Chat" /> : <div className="kept-chat" role="status" aria-label="Loading chat controls">
      <KeptChat messages={opening.copy.messages} running={opening.copy.running === true} disclaimer={UI_CONFIG.disclaimer} latestShown={latestShown} />
    </div>}</Swap>
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
  useEffect(() => {
    const { copy, historyMoment: moment } = openingMainChat();
    pageOpeningMoment.current = moment;
    if (!loading) return;
    if (copy === null) { setOpening(null); return; }
    const prepared = prepareKeptChat(copy.copy.messages);
    if (prepared === null) { setOpening(copy); return; }
    const pending = { accountId: copy.accountId, active: true };
    preparingOpening.current = pending;
    void prepared.then(
      () => { if (pending.active) { preparingOpening.current = null; setOpening(copy); } },
      (error: Error) => { if (pending.active) { preparingOpening.current = null; setOpeningError(error); } },
    );
    return () => { pending.active = false; preparingOpening.current = null; };
  }, []);
  useEffect(() => {
    if (auth.sessionStatus !== "loading" && auth.sessionStatus !== "ready") {
      pageOpeningMoment.current = null;
      discardOpeningResponse(`${CHAT_SERVICE_URL}/main-chat`);
    }
  }, [auth.sessionStatus]);
  useEffect(() => {
    if (!loading && (auth.sessionStatus !== "ready" || auth.accountId !== opening?.accountId)) setOpening(null);
  }, [loading, auth.sessionStatus, auth.accountId, opening]);
  if (openingError !== null) throw openingError;
  const matchingOpening = loading || (auth.sessionStatus === "ready" && auth.accountId === opening?.accountId && auth.isAccountCurrent?.(auth.accountId) !== false) ? opening : null;
  return auth.sessionStatus === "ready" || (loading && opening !== null)
    ? <Suspense fallback={<OpeningChat key={matchingOpening?.accountId ?? "empty"} opening={matchingOpening} latestShown={latestShown} />}><App auth={auth} opening={matchingOpening} historyMoment={pageOpeningMoment} keptChatLatestShown={latestShown} /></Suspense>
    : <SessionGate title={UI_CONFIG.title} agentName={UI_CONFIG.agentName} status={auth.sessionStatus} loadFailure={auth.loadFailure} chatServiceUrl={CHAT_SERVICE_URL} />;
}
