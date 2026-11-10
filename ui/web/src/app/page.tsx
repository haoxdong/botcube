"use client";

import "@copilotkit/react-core/v2/styles.css";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { webUiPlugin } from "@cartridge-ui";
import type { AuthUiState } from "../cartridge/index.js";
import { chatServiceUrl } from "../cartridge/chat-service-url";
import { openingMainChat, type StoredMainChatCopy } from "./main-chat-copy";
import { endOpeningMoment, type HistoryMoment } from "./latency";
import { discardOpeningResponse } from "../opening-requests";
import { rumConfig, startRum } from "./rum";
import { keepFileDropsInPage } from "./composer-attach";
import { KeptChat } from "./kept-chat";
import { SessionGate } from "./session-gate";

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
    {opening === null ? null : <div className="app-chat app-chat-opening"><div className="kept-chat" role="status" aria-label="Loading chat controls">
      <KeptChat messages={opening.copy.messages} running={opening.copy.running === true} disclaimer={UI_CONFIG.disclaimer} latestShown={latestShown} />
    </div></div>}
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
  const pageOpeningMoment = useRef<HistoryMoment | null>(null);
  const latestShown = useRef(1);
  useEffect(() => {
    const { copy, historyMoment: moment } = openingMainChat();
    if (loading) setOpening(copy);
    pageOpeningMoment.current = moment;
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
  const matchingOpening = loading || (auth.sessionStatus === "ready" && auth.accountId === opening?.accountId && auth.isAccountCurrent?.(auth.accountId) !== false) ? opening : null;
  return auth.sessionStatus === "ready" || (loading && opening !== null)
    ? <Suspense fallback={<OpeningChat opening={matchingOpening} latestShown={latestShown} />}><App auth={auth} opening={matchingOpening} historyMoment={pageOpeningMoment} keptChatLatestShown={latestShown} /></Suspense>
    : <SessionGate title={UI_CONFIG.title} agentName={UI_CONFIG.agentName} status={auth.sessionStatus} loadFailure={auth.loadFailure} chatServiceUrl={CHAT_SERVICE_URL} />;
}
