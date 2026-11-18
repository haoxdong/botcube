"use client";

import { Presence, presenceMotion } from "./collapse";

import { m as motionElement } from "framer-motion";

import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Blocks, MessageCircle, PanelsTopLeftIcon } from "lucide-react";
import { ModelSelector } from "./model-selector";
import { ChatAlerts } from "./chat-alerts";
import { GuestNotice, UserMenu } from "./user-menu";
import { useAgentWarmup } from "./agent-warmup";
import { ChatHeader, useHeaderWorking } from "./chat-header";
import { KeptChat } from "./kept-chat";
import { usePhoneProfileFocus } from "./phone-profile-focus";
import { useDrawerSwipe } from "./drawer-swipe";
import { useDrawerPreview } from "./drawer-preview";
import { usePhoneViewport } from "./phone-viewport";
import { PHONE_QUERY, useIsPhone } from "./phone-query";
import { isUnread } from "./conversations";
import {
  AGENT_DOCUMENT_EDITED,
  AgentProfile,
  loadAgentProfile,
  type AgentProfileData,
} from "./agent-profile";
import { endOpeningMoment, type HistoryMoment } from "./latency";
import { forgetMainChatCopy, withStorage, type StoredMainChatCopy } from "./main-chat-copy";
import { forgetSteering } from "./steering";
import { useModelSelection } from "./model-selection";
import { useAgentRunning } from "./agent-running";
import { ChatLoadState, LoadingSkeleton } from "./load-state";
import { menuIcon } from "./menu-icon";
import { webUiPlugin } from "@cartridge-ui";
import { AGENT_THEME, BOT_SETTINGS } from "../bot-settings";
import { AgentComputerView } from "../computer/agent-computer-view";
import { LiveBrowserPanel } from "../computer/live-browser-panel";
import type { AuthUiState } from "../cartridge/index.js";
import { chatServiceUrl } from "../cartridge/chat-service-url";
import { SidebarRow } from "@/components/ui/sidebar-row";

import { ChatComputers } from "./chat-computers";
import { SideChats } from "./side-chats";
import { UnreadDot } from "./unread-dot";
import { TurnStart } from "./worklog";
import { WorklogAgent } from "./worklog-clock";
import type { ChatStop } from "./chat-surface";
import { useArtifactWorkspace, useChatSurfaceKey } from "./artifact-request";
import { useSessionNavigation } from "./session-navigation";

const ChatSurface = lazy(() => import("./chat-surface"));
const ChatColumn = lazy(() => import("./artifact-panel").then(({ ArtifactLayout }) => ({ default: ArtifactLayout })));
const ArtifactLibrary = lazy(() => import("./artifact-library").then(({ ArtifactLibrary }) => ({ default: ArtifactLibrary })));
const AppsScreen = lazy(() => import("./plugins").then(({ AppsScreen }) => ({ default: AppsScreen })));

const LiveBrowser = BOT_SETTINGS.agentComputer.liveBrowser ? LiveBrowserPanel : () => null;
const { config: UI_CONFIG } = webUiPlugin;
const AGENT_ID = UI_CONFIG.agentId;
const CHAT_SERVICE_URL = chatServiceUrl();

const SIDEBAR_EXPANDED_KEY = 'botcube.sidebar-expanded';


export default function App({
  auth,
  opening,
  historyMoment,
  keptChatLatestShown,
}: {
  auth: AuthUiState;
  opening: StoredMainChatCopy | null;
  historyMoment: RefObject<HistoryMoment | null>;
  keptChatLatestShown: RefObject<number>;
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
  useDrawerPreview(layoutRef, swipe.visible, isPhone);
  const toggleSidebar = () => {
    swipe.toggle();
    if (!isPhone) withStorage(() => localStorage.setItem(SIDEBAR_EXPANDED_KEY, String(!sidebarExpanded)));
  };
  const [screen, setScreen] = useState<'chat' | 'apps' | 'artifacts'>('chat');
  const screenOpen = screen !== 'chat';
  const { request: artifactRequest, initialized: artifactWorkspace, select: selectArtifact } = useArtifactWorkspace(auth);
  const [keptChatShown, setKeptChatShown] = useState(true);
  const [openedChat, setOpenedChat] = useState<string | null>(null);
  const ready = auth.sessionStatus === "ready";
  const { accountId } = auth;
  useEffect(() => setScreen('chat'), [accountId]);
  const {
    current: { id: activeId, accountId: activeAccountId, openAt, newChat, provider: activeProvider, readOnly, agent, selfManagedAgents, entrances, showWelcome, stopServerTurn, turnFailure, turnRunning, turnRunsOnServer, turnMayRun, runningSince },
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
  } = useSessionNavigation({ ready, accountId, chatServiceUrl: CHAT_SERVICE_URL, agentId: AGENT_ID, opening, reading: !screenOpen && !(isPhone && (agentProfileOpen || sidebarExpanded)) });
  const surfaceKey = useChatSurfaceKey(accountId, activeId, artifactWorkspace);
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
    enabled: isPhone && activeId !== null && ready && !screenOpen && !sidebarExpanded && !swipe.dragging,
    expanded: agentProfileOpen,
    onExpandedChange: setAgentProfileOpen,
  });
  useEffect(() => {
    if (profileSwipe.visible) setProfileKept(true);
  }, [profileSwipe.visible]);
  const profileVisible = profileSwipe.visible || profileKept;
  const agentProfileOpenerRef = useRef<HTMLButtonElement>(null);
  const { closeRef: agentProfileCloseRef } = usePhoneProfileFocus({ open: profileSwipe.open, expanded: agentProfileOpen, profileRef: agentProfileRef, openerRef: agentProfileOpenerRef, close: profileSwipe.close });
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
      if (!ready) return;
      void refreshAgentProfile();
      return () => { ++agentProfileRequest.current; };
    },
    [ready, accountId],
  );

  const showMain = (view: 'chat' | 'apps' | 'artifacts') => {
    setScreen(view);
    if (isPhone) swipe.close();
  };

  const { error: warmupError, turnStarting: warmupTurnStarting, composing } = useAgentWarmup({ auth, ready, accountId, activeId, activeAccountId, mainChatId, newChat, models, offeredModel, effort, turnRunning, agent });

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

  const headerInPane = !isPhone;
  const composerAccessory = auth.guest === true ? <><GuestNotice onSignIn={auth.login} />{auth.composerAccessory}</> : auth.composerAccessory;
  const chatHeader = (
    <ChatHeader opener={agentProfileOpenerRef} working={working} ready={ready} chatId={activeId} open={profileSwipe.show}
      picture={agentProfile?.picture} emoji={agentProfile?.avatar} name={agentName} />
  );
  const paneHeader = <>{headerInPane && chatHeader}</>;
  const noChat = <ChatLoadState linkedError={linkedChatError} error={mainChatError} retry={() => void openMainChat()} />;
  const covered = keptChatShown || (activeId !== null && openAt == null && openedChat !== activeId);
  const keptChat = (
    <div className="kept-chat" role="status" aria-label="Loading chat controls">
      <KeptChat messages={agent.messages} running={turnRunsOnServer} disclaimer={UI_CONFIG.disclaimer} composerAccessory={composerAccessory} latestShown={keptChatLatestShown} onOpenRun={({ sideChat, title, messageId }) => void handleSelectConversation({ id: sideChat, title }, messageId)} />
    </div>
  );

  const screenContent = {
    chat: { label: "Chat", content: null },
    apps: { label: "Apps", content: <AppsScreen agentName={agentName} /> },
    artifacts: { label: "Artifacts", content: <ArtifactLibrary accountId={accountId} onSelect={(artifact) => {
      if (selectArtifact(artifact)) setScreen('chat');
    }} /> },
  }[screen];

  return (
    <div ref={layoutRef} className="app-layout" data-sidebar-swiping={swipe.swiping || undefined} data-sidebar-dragging={swipe.dragging || undefined} data-profile-swiping={profileSwipe.swiping || undefined} data-profile-dragging={profileSwipe.dragging || undefined} style={{ ...AGENT_THEME, ...swipe.style, ...profileSwipe.style, ...viewportStyle }}>
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
              active={!screenOpen && activeId !== null && activeId === mainChatId}
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
              active={screen === 'apps'}
              onClick={() => showMain('apps')}
              aria-label="Apps"
              title="Apps"
            >
              <Blocks className="sidebar-nav-icon" aria-hidden />
              <span className="sidebar-nav-label">Apps</span>
            </SidebarRow>
            <SidebarRow active={screen === 'artifacts'} disabled={!ready} onClick={() => showMain('artifacts')} aria-label="Artifacts" title="Artifacts">
              <PanelsTopLeftIcon className="sidebar-nav-icon" aria-hidden />
              <span className="sidebar-nav-label">Artifacts</span>
            </SidebarRow>
          </nav>
        </div>

        <SideChats accountId={accountId} activeId={activeId} pluginsOpen={screenOpen} visible={swipe.visible} entries={sideChats} listed={sideChatsListed} error={sideChatsError} rename={renameSideChat} remove={handleDeleteConversation} select={handleSelectConversation} create={handleNewConversation} showChat={() => showMain('chat')} />

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
      <Presence>{screenOpen && (
        <motionElement.main {...presenceMotion} layout={false} className="app-shell app-plugins">
          <Suspense fallback={<LoadingSkeleton label={screenContent.label} />}>{screenContent.content}</Suspense>
        </motionElement.main>
      )}</Presence>
      <main className="app-shell" style={{ visibility: screenOpen ? "hidden" : undefined }} aria-hidden={screenOpen} inert={screenOpen || profileSwipe.open || (isPhone && sidebarExpanded)}>
        {!headerInPane && chatHeader}
        {activeId === null && !artifactWorkspace ? <>{paneHeader}{noChat}</> : (
          <Suspense fallback={<>{paneHeader}<div className="app-chat app-chat-opening">{keptChat}</div></>}>
          <ChatSurface
            key={surfaceKey}
            chatId={activeId ?? ""}
            stopRef={setChatStop}
            selfManagedAgents={selfManagedAgents}
            entrances={entrances}
            properties={properties}
          >
            {(ChatThread) => <>
            <ChatAlerts errors={activeId === null ? [] : [auth.error, mainChatRefreshError, stopError, choiceError, warmupError?.accountId === accountId ? warmupError?.message : null]} failure={activeId === null || mainChatError === null ? null : { error: mainChatError, retry: () => void openMainChat() }} />
            <ChatColumn agent={agent} accountId={accountId} header={headerInPane ? chatHeader : undefined} request={artifactRequest}>
            <Presence>{activeId === null ? noChat : (
            <motionElement.div {...presenceMotion} layout={false} className={covered ? "app-chat app-chat-opening" : "app-chat"}>
              <TurnStart.Provider value={runningSince}>
              <WorklogAgent.Provider value={agent}>
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
                composerAccessory={composerAccessory}
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
                  <ModelSelector {...picker} />
                </div>
              </ChatThread>
              </WorklogAgent.Provider></TurnStart.Provider>
              {covered && keptChat}
            </motionElement.div>
            )}</Presence>
            </ChatColumn>
            {layoutElement !== null && activeId !== null && createPortal(<>
              <LiveBrowser agentId={AGENT_ID} conversation={{ id: activeId, service: "chat-service" }} />
              {auth.overlay}
            </>, layoutElement)}
            </>}
          </ChatSurface>
          </Suspense>
        )}
      </main>
      </div>
      {layoutElement !== null && ready && profileVisible && createPortal(
        <AgentProfile
          key={accountId}
          ref={agentProfileRef}
          closeRef={agentProfileCloseRef}
          open={profileSwipe.visible}
          chatServiceUrl={CHAT_SERVICE_URL}
          profile={agentProfile}
          error={agentProfileError}
          computer={BOT_SETTINGS.agentComputer.enabled ? ((shown) => (
            <ChatComputers
              View={AgentComputerView}
              agentId={AGENT_ID}
              agentName={agentName}
              current={activeId === null ? null : { conversation: { id: activeId, service: "chat-service" }, agent }}
              shown={shown}
              stop={chatStop?.chatId === activeId ? () => {
                if (auth.isAccountCurrent?.(accountId) !== false) chatStop.stop();
              } : null}
              signIns={auth.signIns}
            />
          )) : undefined}
          onClose={profileSwipe.close}
          revision={agentDocumentsRevision}
          onSaved={() => void refreshAgentProfile()}
          onOpenChat={(id, title) => {
            profileSwipe.close();
            showMain('chat');
            void handleSelectConversation({ id, title });
          }}
          isAccountCurrent={() => auth.isAccountCurrent?.(accountId) !== false}
          signIns={auth.signIns}
          memory={BOT_SETTINGS.memory}
        />,
        layoutElement,
      )}
    </div>
  );
}
