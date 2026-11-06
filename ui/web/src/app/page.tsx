"use client";

import { Presence, presenceMotion } from "./collapse";

import { m as motionElement } from "framer-motion";

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Blocks, MessageCircle } from "lucide-react";
import "@copilotkit/react-core/v2/styles.css";
import { ModelEffortPicker } from "./model-effort-picker";
import { ChatAlerts } from "./chat-alerts";
import { UserMenu } from "./user-menu";
import { useAgentWarmup } from "./agent-warmup";
import { ChatHeader, useHeaderWorking } from "./header-status";
import { KeptChat } from "./kept-chat";
import { usePhoneProfileFocus } from "./phone-profile-focus";
import { useDrawerSwipe } from "./drawer-swipe";
import { usePhoneViewport } from "./phone-viewport";
import { PHONE_QUERY, useIsPhone } from "./phone-query";
import { isUnread } from "./conversations";
import {
  AGENT_DOCUMENT_EDITED,
  AgentProfile,
  loadAgentProfile,
  type AgentProfileData,
} from "./agent-profile";
import { openingMainChat, type HistoryMoment } from "./session-navigation";
import { useChatSession } from "./temporary-session";
import { forgetMainChatCopy, withStorage, type StoredMainChatCopy } from "./main-chat-copy";
import { forgetSteering } from "./steering";
import { endOpeningMoment } from "./latency";
import { discardOpeningResponse } from "../opening-requests";
import { rumConfig, startRum } from "./rum";
import { useModelSelection } from "./model-selection";
import { useAgentRunning } from "./agent-running";
import { LoadFailed, LoadingSkeleton } from "./load-state";
import { SessionGate } from "./session-gate";
import { menuIcon } from "./menu-icon";
import { webUiPlugin } from "@cartridge-ui";
import type { AuthUiState } from "../cartridge/index.js";
import { chatServiceUrl } from "../cartridge/chat-service-url";
import { SidebarRow } from "@/components/ui/sidebar-row";

import { ChatComputers } from "./chat-computers";
import { keepFileDropsInPage } from "./composer-attach";
import { SideChats } from "./side-chats";
import { UnreadDot } from "./unread-dot";
import { TurnStart } from "./worklog";
import type { ChatStop } from "./chat-surface";

const ChatSurface = lazy(() => import("./chat-surface"));
const PluginsScreen = lazy(() => import("./plugins").then(({ PluginsScreen }) => ({ default: PluginsScreen })));

const { config: UI_CONFIG, ComputerView } = webUiPlugin;
const AGENT_ID = UI_CONFIG.agentId;
const CHAT_SERVICE_URL = chatServiceUrl();

const SIDEBAR_EXPANDED_KEY = 'botcube.sidebar-expanded';


function App({
  auth,
  opening,
  historyMoment,
}: {
  auth: AuthUiState;
  opening: StoredMainChatCopy | null;
  historyMoment: RefObject<HistoryMoment | null>;
}) {
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const isPhone = useIsPhone();
  const viewport = usePhoneViewport();
  const viewportStyle = { "--keyboard-inset": `${viewport.inset}px`, "--viewport-top": `${viewport.top}px` };
  const [agentProfileOpen, setAgentProfileOpen] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  const [layoutElement, setLayoutElement] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => setLayoutElement(layoutRef.current), []);
  const drawerRef = useRef<HTMLElement>(null);
  const swipe = useDrawerSwipe({ layoutRef, drawerRef, side: "left", name: "sidebar", enabled: isPhone, expanded: sidebarExpanded, onExpandedChange: setSidebarExpanded });
  useEffect(() => {
    if (!window.matchMedia(PHONE_QUERY).matches && withStorage(() => localStorage.getItem(SIDEBAR_EXPANDED_KEY)) === 'true') setSidebarExpanded(true);
  }, []);
  const toggleSidebar = () => {
    swipe.toggle();
    if (!isPhone) withStorage(() => localStorage.setItem(SIDEBAR_EXPANDED_KEY, String(!sidebarExpanded)));
  };
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [keptChatShown, setKeptChatShown] = useState(true);
  const [openedChat, setOpenedChat] = useState<string | null>(null);
  const keptChatLatestShown = useRef(1);
  const ready = auth.sessionStatus === "ready";
  const { accountId } = auth;
  const temporary = auth.temporary === true;
  const {
    current: { id: activeId, accountId: activeAccountId, openAt, newChat, provider: activeProvider, readOnly, agent, selfManagedAgents, showWelcome, stopServerTurn, turnFailure, turnRunning, turnRunsOnServer, turnMayRun, runningSince },
    mainChatId,
    mainChatUnread,
    sideChats: { entries: sideChats, error: sideChatsError, listed: sideChatsListed },
    failures: { mainChat: mainChatError, linkedChat: linkedChatError, refresh: mainChatRefreshError, stop: stopError },
    openMainChat,
    selectMainChat,
    newSideChat: handleNewConversation,
    selectSideChat: handleSelectConversation,
    renameSideChat,
    deleteSideChat: handleDeleteConversation,
    messageSubmitted,
    turnStarting,
    accountReady,
  } = useChatSession({ ready, temporary, accountId, chatServiceUrl: CHAT_SERVICE_URL, agentId: AGENT_ID, opening, reading: !pluginsOpen && !(isPhone && (agentProfileOpen || sidebarExpanded)) });
  const { catalog: models, picker, properties, choiceError } = useModelSelection({
    ready, accountId, activeProvider, showWelcome, chatServiceUrl: CHAT_SERVICE_URL,
  });
  const { model: offeredModel, effort } = picker;
  useEffect(() => {
    const moment = historyMoment.current;
    if (moment === null || (activeId === null && mainChatError === null)) return;
    if (activeId !== null && activeId === mainChatId) requestAnimationFrame(() => endOpeningMoment(moment));
    historyMoment.current = null;
  }, [activeId, mainChatId, mainChatError]);

  const [loadedAgentProfile, setAgentProfile] = useState<{ accountId: typeof accountId; profile: AgentProfileData } | null>(null);
  const agentProfile = loadedAgentProfile !== null && loadedAgentProfile.accountId === accountId ? loadedAgentProfile.profile : null;
  const [agentProfileError, setAgentProfileError] = useState<string | null>(null);
  const [profileKept, setProfileKept] = useState(false);
  const [chatStop, setChatStop] = useState<ChatStop | null>(null);

  const agentProfileRef = useRef<HTMLDivElement>(null);
  const profileSwipe = useDrawerSwipe({
    layoutRef, drawerRef: agentProfileRef, side: "right", name: "profile", slides: true,
    enabled: isPhone && activeId !== null && accountReady && !pluginsOpen && !sidebarExpanded && !swipe.dragging,
    expanded: agentProfileOpen,
    onExpandedChange: (open) => { if (open) setAgentProfileOpen(true); else setAgentProfileOpen(false); },
  });
  useEffect(() => {
    if (profileSwipe.visible) setProfileKept(true);
  }, [profileSwipe.visible]);
  const profileVisible = profileSwipe.visible || profileKept;
  const agentProfileOpenerRef = useRef<HTMLButtonElement>(null);
  usePhoneProfileFocus({ open: profileSwipe.open, expanded: agentProfileOpen, profileRef: agentProfileRef, openerRef: agentProfileOpenerRef, close: profileSwipe.close });
  const agentName = agentProfile?.name ?? UI_CONFIG.agentName;
  const [agentDocumentsRevision, setAgentDocumentsRevision] = useState(0);

  const agentProfileAccount = useRef(accountId);
  agentProfileAccount.current = accountId;
  const agentProfileRequest = useRef(0);
  const refreshAgentProfile = () => {
    if (accountId !== agentProfileAccount.current || auth.isAccountCurrent?.(accountId) === false) return;
    const request = ++agentProfileRequest.current;
    return loadAgentProfile({ chatServiceUrl: CHAT_SERVICE_URL }).then(
      (profile) => {
        if (request !== agentProfileRequest.current) return;
        setAgentProfile({ accountId, profile });
        setAgentProfileError(null);
      },
      (error: Error) => {
        console.error(error);
        if (request === agentProfileRequest.current) setAgentProfileError(error.message);
      },
    );
  };

  useEffect(
    () => {
      if (!accountReady) return;
      void refreshAgentProfile();
      return () => { ++agentProfileRequest.current; };
    },
    [accountReady, accountId],
  );

  const showMain = (view: 'chat' | 'plugins') => {
    setPluginsOpen(view === 'plugins');
    if (isPhone) swipe.close();
  };

  const { error: warmupError, turnStarting: warmupTurnStarting, composing } = useAgentWarmup({ auth, ready: accountReady, accountId, activeId, activeAccountId, mainChatId, newChat, models, offeredModel, effort, turnRunning, agent });

  useEffect(() => {
    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        if (event.name !== AGENT_DOCUMENT_EDITED || accountId !== agentProfileAccount.current) return;
        void refreshAgentProfile();
        setAgentDocumentsRevision((revision) => revision + 1);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, accountId]);

  const [agentRunning] = useAgentRunning(agent);
  const working = useHeaderWorking(activeId, turnRunsOnServer || agentRunning);

  const chatHeader = (
    <ChatHeader opener={agentProfileOpenerRef} working={working} ready={accountReady} chatId={activeId} open={profileSwipe.show}
      picture={agentProfile?.picture} emoji={agentProfile?.avatar} name={agentName} />
  );
  const noChat = linkedChatError !== null ? (
    <LoadFailed error={linkedChatError} onRetry={() => void openMainChat()} action="Go to Main Chat" />
  ) : mainChatError === null ? (
    <LoadingSkeleton label="Main Chat" />
  ) : (
    <LoadFailed error={mainChatError} onRetry={() => void openMainChat()} />
  );
  const covered = keptChatShown || (activeId !== null && openAt == null && openedChat !== activeId);
  const keptChat = (
    <div className="kept-chat" role="status" aria-label="Loading chat controls">
      <KeptChat messages={agent.messages} running={turnRunsOnServer} disclaimer={UI_CONFIG.disclaimer} composerAccessory={auth.composerAccessory} latestShown={keptChatLatestShown} onOpenRun={({ sideChat, title, messageId }) => void handleSelectConversation({ id: sideChat, title }, messageId)} />
    </div>
  );

  return (
    <div ref={layoutRef} className="app-layout" data-sidebar-swiping={swipe.swiping || undefined} data-sidebar-dragging={swipe.dragging || undefined} data-profile-swiping={profileSwipe.swiping || undefined} data-profile-dragging={profileSwipe.dragging || undefined} style={{ ...webUiPlugin.theme, ...swipe.style, ...profileSwipe.style, ...viewportStyle }}>
      <aside ref={drawerRef} className={`sidebar ${swipe.visible ? "sidebar-expanded" : "sidebar-collapsed"}`} inert={profileSwipe.open}>
        <div className="sidebar-top">
          <div className="sidebar-brand">
            <button
              className="sidebar-logo-btn"
              onClick={toggleSidebar}
              aria-label="Toggle sidebar"
              aria-expanded={sidebarExpanded}
              title={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
            >
              {menuIcon}
              <UnreadDot unread={isPhone && (mainChatUnread || sideChats.some(isUnread))} drawer />
            </button>
            <span className="sidebar-brand-text">{UI_CONFIG.title}</span>
          </div>

          <nav className="sidebar-nav sidebar-main">
            <SidebarRow
              className="sidebar-main-chat"
              active={!pluginsOpen && activeId !== null && activeId === mainChatId}
              onClick={() => {
                showMain('chat');
                selectMainChat();
              }}
              aria-label="Main Chat"
            >
              <MessageCircle className="sidebar-nav-icon" aria-hidden />
              <span className="sidebar-nav-label">Main chat</span>
              <UnreadDot unread={mainChatUnread} />
            </SidebarRow>
            <SidebarRow
              active={pluginsOpen}
              onClick={() => showMain('plugins')}
              aria-label="Plugins"
              title="Plugins"
            >
              <Blocks className="sidebar-nav-icon" aria-hidden />
              <span className="sidebar-nav-label">Plugins</span>
            </SidebarRow>
          </nav>
        </div>

        <Presence>{!temporary && <SideChats exit={{ opacity: 0 }} accountId={accountId} activeId={activeId} pluginsOpen={pluginsOpen} visible={swipe.visible} entries={sideChats} listed={sideChatsListed} error={sideChatsError} rename={renameSideChat} remove={handleDeleteConversation} select={handleSelectConversation} create={handleNewConversation} showChat={() => showMain('chat')} />}</Presence>

        <div className="sidebar-bottom">
          <UserMenu
            expanded={sidebarExpanded}
            auth={auth}
            onLogout={() => {
              try {
                forgetMainChatCopy();
              } finally {
                try {
                  forgetSteering();
                } finally {
                  auth.logout();
                }
              }
            }}
          />
        </div>
      </aside>
      <Presence>{swipe.visible && (
        <motionElement.button {...presenceMotion} className="sidebar-strip-close" onClick={swipe.close} aria-label="Close sidebar">
          <span className="sidebar-strip-close-menu">{menuIcon}</span>
        </motionElement.button>
      )}</Presence>

      <div className="app-stage">
      <Presence>{pluginsOpen && (
        <motionElement.main {...presenceMotion} className="app-shell app-plugins">
          <Suspense fallback={<LoadingSkeleton label="Plugins" />}><PluginsScreen agentName={agentName} /></Suspense>
        </motionElement.main>
      )}</Presence>
      <main className="app-shell" style={{ visibility: pluginsOpen ? "hidden" : undefined }} aria-hidden={pluginsOpen} inert={pluginsOpen || profileSwipe.open || (isPhone && sidebarExpanded)}>
        {chatHeader}
        {activeId === null ? noChat : (
          <Suspense fallback={<div className="app-chat app-chat-opening">{keptChat}</div>}>
          <ChatSurface
            key={activeId}
            chatId={activeId}
            stopRef={setChatStop}
            selfManagedAgents={selfManagedAgents}
            properties={properties}
          >
            {(ChatThread) => <>
            <ChatAlerts errors={[auth.error, mainChatRefreshError, stopError, choiceError, warmupError?.accountId === accountId ? warmupError?.message : null]} failure={mainChatError === null ? null : { error: mainChatError, retry: () => void openMainChat() }} />
            <div className={covered ? "app-chat app-chat-opening" : "app-chat"}>
              <TurnStart.Provider value={runningSince}>
              <ChatThread
                key={activeId}
                agent={agent}
                threadId={activeId}
                accountId={accountId}
                turnRunning={turnRunning}
                turnRunsOnServer={turnRunsOnServer}
                turnMayRun={turnMayRun}
                onOpened={() => { setKeptChatShown(false); setOpenedChat(activeId); }}
                showWelcome={showWelcome}
                isMainChat={activeId === mainChatId}
                newChat={newChat}
                startNewChat={readOnly ? () => void handleNewConversation() : null}
                userName={auth.user?.name}
                composerAccessory={auth.composerAccessory}
                temporary={temporary}
                models={models}
                selectedModel={offeredModel}
                isAccountCurrent={() => auth.isAccountCurrent?.(accountId) !== false}
                onMessageSubmitted={messageSubmitted}
                onTurnStarting={(provider) => { warmupTurnStarting(); turnStarting(provider); }}
                onCompose={composing}
                stopServerTurn={stopServerTurn}
                savedFailure={turnFailure}
                openAt={openAt}
                onOpenRun={({ sideChat, title, messageId }) => void handleSelectConversation({ id: sideChat, title }, messageId)}
              >
                <div className="chat-model-picker">
                  <ModelEffortPicker {...picker} />
                </div>
              </ChatThread>
              </TurnStart.Provider>
              {covered && keptChat}
            </div>
            {layoutElement !== null && createPortal(<>
              {webUiPlugin.auxiliaryPanels?.map((Panel, index) => (
                <Panel
                  key={index}
                  agentId={AGENT_ID}
                  conversation={{ id: activeId, service: "chat-service" }}
                />
              ))}
              {webUiPlugin.toolResultRenderers?.map((Renderer, index) => <Renderer key={index} />)}
              {auth.overlay}
            </>, layoutElement)}
            </>}
          </ChatSurface>
          </Suspense>
        )}
      </main>
      </div>
      {layoutElement !== null && accountReady && profileVisible && createPortal(
        <AgentProfile
          key={accountId}
          ref={agentProfileRef}
          open={profileSwipe.visible}
          chatServiceUrl={CHAT_SERVICE_URL}
          profile={agentProfile}
          error={agentProfileError}
          computer={ComputerView && ((shown) => (
            <ChatComputers
              View={ComputerView}
              agentId={AGENT_ID}
              agentName={agentName}
              current={activeId === null ? null : { conversation: { id: activeId, service: "chat-service" }, agent }}
              shown={shown}
              stop={chatStop?.chatId === activeId ? () => {
                if (auth.isAccountCurrent?.(accountId) !== false) chatStop.stop();
              } : null}
            />
          ))}
          onClose={profileSwipe.close}
          revision={agentDocumentsRevision}
          onSaved={() => void refreshAgentProfile()}
          onOpenChat={(id, title) => {
            profileSwipe.close();
            showMain('chat');
            void handleSelectConversation({ id, title });
          }}
          isAccountCurrent={() => auth.isAccountCurrent?.(accountId) !== false}
          tabs={webUiPlugin.agentProfileTabs}
        />,
        layoutElement,
      )}
    </div>
  );
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
    if (!loading) setOpening(null);
  }, [loading]);
  return auth.sessionStatus === "ready" || (loading && opening !== null)
    ? <App auth={auth} opening={opening} historyMoment={pageOpeningMoment} />
    : <SessionGate title={UI_CONFIG.title} agentName={UI_CONFIG.agentName} status={auth.sessionStatus} loadFailure={auth.loadFailure} chatServiceUrl={CHAT_SERVICE_URL} />;
}
