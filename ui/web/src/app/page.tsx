"use client";

import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Blocks, ChevronDown, ChevronRight, MessageCircle, Pencil, Plus } from "lucide-react";
import "@copilotkit/react-core/v2/styles.css";
import { KeptChat } from "./kept-chat";
import { usePhoneSidebarSwipe } from "./phone-sidebar-swipe";
import { ChatServiceError } from "./conversations";
import {
  AGENT_DOCUMENT_EDITED,
  AgentProfile,
  loadAgentProfile,
  type AgentProfileData,
} from "./agent-profile";
import { openingMainChat, useSessionNavigation, type HistoryMoment } from "./session-navigation";
import { forgetMainChatCopy, withStorage, type StoredMainChatCopy } from "./main-chat-copy";
import { endOpeningMoment } from "./latency";
import { rumConfig, startRum } from "./rum";
import { useModelSelection, type ModelList } from "./model-selection";
import { Avatar } from "./avatar";
import { PluginsScreen } from "./plugins";
import { ProfileEditor } from "./profile-editor";
import { LoadFailed, LoadingSkeleton } from "./load-state";
import { SessionGate } from "./session-gate";
import { webUiPlugin } from "@cartridge-ui";
import type { AuthStatus, AuthUiState, AuthUser } from "../cartridge/index.js";
import { SidebarRow } from "@/components/ui/sidebar-row";

const ChatSurface = lazy(() => import("./chat-surface"));

const { config: UI_CONFIG, ComputerView } = webUiPlugin;
const AGENT_ID = UI_CONFIG.agentId;
const CHAT_SERVICE_URL = process.env.NEXT_PUBLIC_CHAT_SERVICE_URL ?? UI_CONFIG.chatServiceUrl;
// Phones (globals.css's 640px breakpoint) show the expanded sidebar as a drawer beside the chat.
const PHONE_QUERY = "(max-width: 640px)";

const subscribeToPhoneQuery = (onChange: () => void) => {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/** Whether the window is phone-sized (PHONE_QUERY), following resizes; a server render is not. */
function useIsPhone() {
  return useSyncExternalStore(subscribeToPhoneQuery, () => window.matchMedia(PHONE_QUERY).matches, () => false);
}

/** Closes an open menu on Escape, returning focus to its trigger. */
function useCloseOnEscape(open: boolean, setOpen: (open: boolean) => void, triggerRef: RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, setOpen, triggerRef]);
}

const menuIcon = (
  <svg className="sidebar-icon-menu" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M2 8h20" />
    <path d="M2 16h12.5" />
  </svg>
);

function UserMenu({
  expanded,
  authStatus,
  loadFailure,
  userInfo,
  onEditProfile,
  onLogin,
  onRelink,
  onLogout,
}: {
  expanded: boolean;
  authStatus: AuthStatus;
  loadFailure: AuthUiState["loadFailure"];
  userInfo?: AuthUser | undefined;
  onEditProfile?: AuthUiState["editProfile"];
  onLogin: () => void;
  onRelink: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const isPhone = useIsPhone();
  const name = userInfo?.name ?? UI_CONFIG.accountLabel;
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      // Stryker disable next-line OptionalChaining: the ref holds the element while this listener is attached
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  });

  useCloseOnEscape(open, setOpen, triggerRef);

  return (
    <div className="user-menu" ref={menuRef}>
      <button
        ref={triggerRef}
        className={`user-menu-trigger${open ? " menu-open" : ""}`}
        onClick={() => {
          setOpen((v) => !v);
          setEditing(false);
        }}
        aria-label="Account"
        data-tooltip={userInfo?.name}
      >
        {/* iOS's 29pt list icon in the phone drawer */}
        <Avatar picture={userInfo?.photo} name={name} size={isPhone && expanded ? 29 : 28} />
        {expanded && <span className="sidebar-nav-label">{userInfo?.name?.split(" ")[0] ?? UI_CONFIG.accountLabel}</span>}
      </button>
      {open && (
        <div className="user-menu-dropdown">
          {editing && onEditProfile ? (
            <ProfileEditor
              user={userInfo}
              onSave={onEditProfile}
              onSaved={() => setOpen(false)}
              onCancel={() => setEditing(false)}
              onClose={() => setOpen(false)}
            />
          ) : (
            <>
              {(authStatus === "authed" || userInfo) && (
                <>
                  <div className="user-menu-header">
                    <Avatar picture={userInfo?.photo} name={name} size={32} />
                    <div className="user-menu-name">{name}</div>
                  </div>
                  <div className="user-menu-sep" />
                </>
              )}
              {onEditProfile && (
                <button className="user-menu-item" onClick={() => setEditing(true)}>
                  <Pencil size={16} aria-hidden />
                  <span>Edit profile</span>
                </button>
              )}
              {loadFailure ? (
                <LoadFailed error={loadFailure.error} onRetry={loadFailure.retry} />
              ) : authStatus === "authed" ? (
                <>
                  <button className="user-menu-item" onClick={() => { onRelink(); setOpen(false); }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                      <path d="M21 3v5h-5" />
                      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                      <path d="M3 21v-5h5" />
                    </svg>
                    <span>{UI_CONFIG.relinkLabel}</span>
                  </button>
                  <button className="user-menu-item" onClick={() => { onLogout(); setOpen(false); }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                      <polyline points="16 17 21 12 16 7" />
                      <line x1="21" y1="12" x2="9" y2="12" />
                    </svg>
                    <span>{UI_CONFIG.logoutLabel}</span>
                  </button>
                </>
              ) : (
                <button
                  className="user-menu-item"
                  onClick={() => { onLogin(); setOpen(false); }}
                  disabled={authStatus === "loading"}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                    <polyline points="10 17 15 12 10 7" />
                    <line x1="15" y1="12" x2="3" y2="12" />
                  </svg>
                  <span>{authStatus === "loading" ? "Connecting..." : UI_CONFIG.loginLabel}</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ModelEffortPicker({
  models,
  model,
  effort,
  onModelChange,
  onEffortChange,
}: {
  models: ModelList;
  model: string | undefined;
  effort: string;
  onModelChange: (v: string) => void;
  onEffortChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"main" | "effort">("main");
  const pickerRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);

  const options = models.loaded ? models.models : [];
  const modelLabel = models.loaded ? options.find((item) => item.key === model)?.label : (models.error ?? "Loading models…");
  const effortLabel = UI_CONFIG.agentOptions.effortLevels.find((item) => item.key === effort)?.label ?? effort;

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      // Stryker disable next-line OptionalChaining: the ref holds the element while this listener is attached
      if (!pickerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  });

  useCloseOnEscape(open, setOpen, pillRef);

  return (
    <div className="mep" ref={pickerRef}>
      <button
        ref={pillRef}
        className="mep-pill"
        type="button"
        aria-expanded={open}
        aria-label={`Model ${modelLabel}, reasoning ${effortLabel}`}
        onClick={() => { setOpen((v) => !v); setPanel("main"); }}
      >
        <span className="mep-pill-model">
          {modelLabel === "GPT-6-Astra" ? <>
            <span className="mep-pill-model-desktop">{modelLabel}</span>
            <span className="mep-pill-model-phone">6 Astra</span>
          </> : modelLabel}
        </span>
        <span className="mep-pill-effort">{effortLabel}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="none">
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="mep-dropdown">
          {panel === "main" ? (
            <>
              {options.map((m) => (
                <button
                  key={m.key}
                  className="mep-option"
                  onClick={() => onModelChange(m.key)}
                >
                  <div>
                    <div className="mep-option-name">{m.label}</div>
                    {m.description && <div className="mep-option-desc">{m.description}</div>}
                  </div>
                  {m.key === model && (
                    <svg className="mep-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))}
              <div className="mep-separator" />
              <button className="mep-option" onClick={() => setPanel("effort")}>
                <span className="mep-option-name">Effort</span>
                <span className="mep-option-right">
                  {effortLabel}
                  <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
                    <path d="M1 1l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </button>
            </>
          ) : (
            <>
              <button className="mep-option mep-back" onClick={() => setPanel("main")}>
                <svg width="7" height="12" viewBox="0 0 7 12" fill="none">
                  <path d="M6 1L1 6l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="mep-option-name">Effort</span>
              </button>
              <div className="mep-separator" />
              {UI_CONFIG.agentOptions.effortLevels.map((e) => (
                <button
                  key={e.key}
                  className="mep-option"
                  onClick={() => { onEffortChange(e.key); setPanel("main"); }}
                >
                  <span className="mep-option-name">{e.label}</span>
                  {e.key === effort && (
                    <svg className="mep-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function App({
  auth,
  opening,
  historyMoment,
}: {
  auth: AuthUiState;
  opening: StoredMainChatCopy | null;
  /** The moment the page's opening waits on until the Main Chat's history shows; null once it ended or cannot. */
  historyMoment: RefObject<HistoryMoment | null>;
}) {
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const isPhone = useIsPhone();
  const layoutRef = useRef<HTMLDivElement>(null);
  // What the chat controls render beside the shell rather than in it, such as the Agent Profile, goes here.
  const [layoutElement, setLayoutElement] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => setLayoutElement(layoutRef.current), []);
  const drawerRef = useRef<HTMLElement>(null);
  const swipe = usePhoneSidebarSwipe({ layoutRef, drawerRef, side: "left", name: "sidebar", enabled: isPhone, expanded: sidebarExpanded, onExpandedChange: setSidebarExpanded });
  // The sidebar's Plugins screen shows in the chat's place, which stays mounted under it.
  const [pluginsOpen, setPluginsOpen] = useState(false);
  // The kept Main Chat shows in the chat's place until the chat surface opens at its latest message (#3697).
  const [keptChatShown, setKeptChatShown] = useState(true);
  const ready = auth.sessionStatus === "ready";
  // A sign-in can move the page to another account: its models, Side Chats and agent load again.
  const { accountId } = auth;
  const sideChatsListId = useId();
  const [sideChatsPreference, setSideChatsPreference] = useState<{ accountId: typeof accountId; collapsed: boolean } | null>(null);
  const sideChatsCollapsed = sideChatsPreference !== null && sideChatsPreference.accountId === accountId
    ? sideChatsPreference.collapsed : false;

  useEffect(() => {
    const collapsed = accountId !== undefined && withStorage(() => localStorage.getItem(`botcube.side-chats-collapsed:${accountId}`)) === 'true';
    setSideChatsPreference(previous => previous !== null && previous.accountId === accountId
      ? previous : { accountId, collapsed });
  }, [accountId]);

  function toggleSideChats(): void {
    const collapsed = !sideChatsCollapsed;
    setSideChatsPreference({ accountId, collapsed });
    if (accountId !== undefined) {
      withStorage(() => localStorage.setItem(`botcube.side-chats-collapsed:${accountId}`, String(collapsed)));
    }
  }
  const {
    current: { id: activeId, provider: activeProvider, agent, selfManagedAgents, showWelcome, stopServerTurn, turnFailure },
    mainChatId,
    sideChats: { entries: sideChats, error: sideChatsError },
    failures: { mainChat: mainChatError, linkedChat: linkedChatError, refresh: mainChatRefreshError, stop: stopError },
    openMainChat,
    selectMainChat,
    newSideChat: handleNewConversation,
    selectSideChat: handleSelectConversation,
    deleteSideChat: handleDeleteConversation,
    messageSubmitted,
  } = useSessionNavigation({ ready, accountId, chatServiceUrl: CHAT_SERVICE_URL, agentId: AGENT_ID, opening });
  const { catalog: models, picker, properties, choiceError } = useModelSelection({
    ready, accountId, activeProvider, showWelcome, chatServiceUrl: CHAT_SERVICE_URL,
  });
  const { model: offeredModel, effort } = picker;

  // The opening's history moment ends in the frame after the commit that first shows the Main Chat, its rows or its
  // welcome screen: the chat renders its agent's messages as it mounts. An opening that first shows another chat or a
  // failure leaves it.
  useEffect(() => {
    const moment = historyMoment.current;
    if (moment === null || (activeId === null && mainChatError === null)) return;
    if (activeId !== null && activeId === mainChatId) requestAnimationFrame(() => endOpeningMoment(moment));
    historyMoment.current = null;
  }, [activeId, mainChatId, mainChatError]);

  const [loadedAgentProfile, setAgentProfile] = useState<{ accountId: typeof accountId; profile: AgentProfileData } | null>(null);
  const agentProfile = loadedAgentProfile !== null && loadedAgentProfile.accountId === accountId ? loadedAgentProfile.profile : null;
  const [agentProfileError, setAgentProfileError] = useState<string | null>(null);
  const [agentProfileOpen, setAgentProfileOpen] = useState(false);
  // The chat the profile was closed in: it stays mounted there, hidden, keeping its computer's live view connected.
  const [agentProfileChat, setAgentProfileChat] = useState<string | null>(null);
  const closeAgentProfile = () => {
    setAgentProfileOpen(false);
    setAgentProfileChat(activeId);
  };
  // A phone's left swipe across the chat slides it off the profile beneath, as its avatar opens it.
  const agentProfileRef = useRef<HTMLDivElement>(null);
  const profileSwipe = usePhoneSidebarSwipe({
    layoutRef, drawerRef: agentProfileRef, side: "right", name: "profile",
    enabled: isPhone && activeId !== null && !pluginsOpen && !swipe.visible,
    expanded: agentProfileOpen,
    onExpandedChange: (open) => { if (open) setAgentProfileOpen(true); else closeAgentProfile(); },
  });
  const agentName = agentProfile?.name ?? UI_CONFIG.agentName;
  // Bumped when the agent edits its Agent Identity or Soul, so the Identity tab reloads them.
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

  /** Choosing a chat, or Plugins, shows it in the main area; on a phone it closes the sidebar drawer to show it. */
  const showMain = (view: 'chat' | 'plugins') => {
    setPluginsOpen(view === 'plugins');
    if (isPhone) setSidebarExpanded(false);
  };

  const [warmupError, setWarmupError] = useState<{ accountId: typeof accountId; message: string } | null>(null);
  const warmupRequest = useRef(0);
  const pendingWarmups = useRef(new Map<string, Promise<void>>());

  // Pre-warm the Session's Sandbox and the requester's agent for its model, so the first message starts without either.
  // Only the latest warmup, the one for the open chat, its model and account, may report or clear a failure.
  const warmup = (target: { threadId: string } | { mainChat: true }) => {
    const request = ++warmupRequest.current;
    // Replay names the same Main Chat that boot used before its id was known. Its Sandbox must
    // finish provisioning before another warmup invokes it; other chats and accounts stay independent.
    const runtime = "mainChat" in target || target.threadId === mainChatId ? { mainChat: true } : target;
    const key = JSON.stringify({ accountId, ...runtime });
    const prepare = () => fetch(`${CHAT_SERVICE_URL}/warmup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ...target, model: offeredModel, effort }),
    }).then((response) => {
      if (!response.ok) throw new ChatServiceError("prepare the agent", response.status);
      if (request === warmupRequest.current) setWarmupError(null);
    }).catch((error: unknown) => {
      if (request === warmupRequest.current) {
        setWarmupError({ accountId, message: `Your agent could not be prepared: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
    const previous = pendingWarmups.current.get(key);
    const pending = previous === undefined ? prepare() : previous.then(() => {
      // A chat, model or account switch can make a queued request obsolete before it starts.
      if (request === warmupRequest.current && accountId === agentProfileAccount.current && auth.isAccountCurrent?.(accountId) !== false) return prepare();
      return undefined;
    });
    pendingWarmups.current.set(key, pending);
    void pending.then(() => {
      if (pendingWarmups.current.get(key) === pending) pendingWarmups.current.delete(key);
    });
  };
  // The Main Chat warms alongside its replay, before its id is known.
  useEffect(() => {
    if (ready) warmup({ mainChat: true });
  }, [ready, accountId]);
  useEffect(() => {
    if (ready && activeId !== null) warmup({ threadId: activeId });
  }, [ready, activeId, offeredModel, effort]);

  useEffect(() => {
    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        if (event.name !== AGENT_DOCUMENT_EDITED || accountId !== agentProfileAccount.current) return;
        void refreshAgentProfile();
        // Stryker disable next-line ArithmeticOperator: any change of revision reloads the files, whichever way it counts
        setAgentDocumentsRevision((revision) => revision + 1);
      },
    });
    return () => subscription.unsubscribe();
  }, [agent, accountId]);

  // The agent's avatar and name, on the loading Main Chat too, so the page keeps its layout when the chat loads;
  // the Agent Profile opens on a chat, so its button waits for one.
  const chatHeader = (
    <header className="chat-header">
      <button className="chat-header-agent" disabled={activeId === null} onClick={() => setAgentProfileOpen(true)} aria-label="Agent profile" title="Agent profile">
        <Avatar picture={agentProfile?.picture ?? undefined} emoji={agentProfile?.avatar} name={agentName} agent size={72} />
        <span className="chat-header-name">{agentName}</span>
      </button>
    </header>
  );
  // Before a chat opens: the Main Chat loading, or why it or a linked chat failed to.
  const noChat = linkedChatError !== null ? (
    <LoadFailed error={linkedChatError} onRetry={() => void openMainChat()} action="Go to Main Chat" />
  ) : mainChatError === null ? (
    <LoadingSkeleton label="Main Chat" />
  ) : (
    <LoadFailed error={mainChatError} onRetry={() => void openMainChat()} />
  );
  // The kept Main Chat, over the chat's place from the moment it shows until the chat opens on it (#3697).
  const keptChat = (
    <div className="kept-chat" role="status" aria-label="Loading chat controls">
      <KeptChat messages={agent.messages} disclaimer={UI_CONFIG.disclaimer} composerAccessory={auth.composerAccessory} />
    </div>
  );

  return (
    // A desktop click on the main stage collapses the sidebar (#3604); a phone closes its drawer from the chat
    // strip beside it (memo 0049 Fig 21).
    <div onClickCapture={(event) => {
      if (!isPhone && event.target instanceof Element && event.target.closest(".app-shell")) setSidebarExpanded(false);
    }} ref={layoutRef} className="app-layout" data-sidebar-swiping={swipe.swiping || undefined} data-sidebar-dragging={swipe.dragging || undefined} data-profile-swiping={profileSwipe.swiping || undefined} data-profile-dragging={profileSwipe.dragging || undefined} style={{ ...webUiPlugin.theme, ...swipe.style, ...profileSwipe.style }}>
      {/* ── Sidebar (outside CopilotKit so it doesn't remount on conversation switch) ── */}
      <aside ref={drawerRef} className={`sidebar ${swipe.visible ? "sidebar-expanded" : "sidebar-collapsed"}`}>
        <div className="sidebar-top">
          {/* Brand row */}
          <div className="sidebar-brand">
            {isPhone && <button
              className="sidebar-logo-btn"
              onClick={() => setSidebarExpanded((v) => !v)}
              aria-label="Toggle sidebar"
              title={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
            >
              <svg className="sidebar-icon-panel" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M9 3v18" />
              </svg>
              {menuIcon}
            </button>}
            <span className="sidebar-brand-text">{UI_CONFIG.title}</span>
          </div>

          {/* Main chat and Plugins as icon rows, the open one a filled pill (Muse Fig 12) */}
          <nav className="sidebar-nav sidebar-main">
            <SidebarRow
              className="sidebar-main-chat"
              active={!pluginsOpen && activeId !== null && activeId === mainChatId}
              onClick={() => {
                showMain('chat');
                if (!isPhone) setSidebarExpanded(true);
                if (isPhone) void openMainChat();
                else selectMainChat();
              }}
              aria-expanded={isPhone ? undefined : sidebarExpanded}
              aria-label="Main Chat"
            >
              <MessageCircle className="sidebar-nav-icon" aria-hidden />
              <span className="sidebar-nav-label">Main chat</span>
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

        <div className="sidebar-recents">
          <div className="sidebar-section-header">
            <button className="sidebar-side-chats-toggle" onClick={toggleSideChats} aria-expanded={!sideChatsCollapsed} aria-controls={sideChatsListId}>
              <span>Side chats</span>
              {sideChatsCollapsed ? <ChevronRight aria-hidden /> : <ChevronDown aria-hidden />}
            </button>
            {/* The collapsed desktop rail keeps only Main chat and Plugins (#3604) */}
            {(isPhone || sidebarExpanded) && <button className="header-btn sidebar-new-chat" onClick={() => { showMain('chat'); handleNewConversation(); }} aria-label="New side chat" title="New side chat">
              <Plus aria-hidden />
            </button>}
          </div>
          {sideChatsError !== null && (
            <div className="sidebar-error" role="alert" hidden={!swipe.visible}>{sideChatsError}</div>
          )}
          <div className="sidebar-list" id={sideChatsListId} hidden={sideChatsCollapsed}>
            {sideChats.length === 0 && sideChatsError === null && (
              <div className="sidebar-empty">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  <path d="M20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1" />
                </svg>
                <strong className="sidebar-empty-title">Start a side chat</strong>
                <span>Side chats are an optional way to organize your conversations by topic.</span>
              </div>
            )}
            {sideChats.map((c) => (
              <div
                key={c.id}
                className={`sidebar-item ${!pluginsOpen && c.id === activeId ? "sidebar-item-active" : ""}`}
              >
                <button
                  className="sidebar-item-btn"
                  onClick={() => { showMain('chat'); void handleSelectConversation(c); }}
                >
                  {c.title}
                </button>
                <button
                  className="sidebar-item-delete"
                  onClick={() => { void handleDeleteConversation(c); }}
                  aria-label="Delete conversation"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="sidebar-bottom">
          <UserMenu
            expanded={sidebarExpanded}
            authStatus={auth.status}
            loadFailure={auth.loadFailure}
            userInfo={auth.user}
            onEditProfile={auth.editProfile}
            onLogin={auth.login}
            onRelink={auth.relink}
            onLogout={() => {
              // The sign-out goes ahead even when the copy cannot be forgotten, whose failure still surfaces.
              try {
                forgetMainChatCopy();
              } finally {
                auth.logout();
              }
            }}
          />
        </div>
      </aside>
      {swipe.visible && (
        <button className="sidebar-strip-close" onClick={() => setSidebarExpanded(false)} aria-label="Close sidebar">
          {/* The peeking chat keeps its menu chip (memo 0049 Fig 21) */}
          <span className="sidebar-strip-close-menu">{menuIcon}</span>
        </button>
      )}

      {pluginsOpen && (
        <main className="app-shell">
          <PluginsScreen agentName={agentName} />
        </main>
      )}
      {/* One shell for the chat however far it has loaded, so its header, and the press of a tap on its avatar,
          outlast the chat controls replacing their stand-in. */}
      <main className="app-shell" hidden={pluginsOpen}>
        {chatHeader}
        {activeId === null ? noChat : (
          <Suspense fallback={<div className="app-chat app-chat-opening">{keptChat}</div>}>
          <ChatSurface
            key={activeId}
            selfManagedAgents={selfManagedAgents}
            properties={properties}
          >
            {(ChatThread) => <>
            {/* ADR 0030: a failed sign-in, sign-out or Sheet action shows why, even with the Sheet closed. */}
            {auth.error && <p className="chat-account-error" role="alert">{auth.error}</p>}
            {mainChatError !== null && <LoadFailed error={mainChatError} onRetry={() => void openMainChat()} />}
            {mainChatRefreshError !== null && <p className="chat-account-error" role="alert">{mainChatRefreshError}</p>}
            {stopError !== null && <p className="chat-account-error" role="alert">{stopError}</p>}
            {choiceError !== null && <p className="chat-account-error" role="alert">{choiceError}</p>}
            {warmupError !== null && warmupError.accountId === accountId && <p className="chat-account-error" role="alert">{warmupError.message}</p>}
            <div className={keptChatShown ? "app-chat app-chat-opening" : "app-chat"}>
              <ChatThread
                key={activeId}
                agent={agent}
                threadId={activeId}
                onOpened={() => setKeptChatShown(false)}
                showWelcome={showWelcome}
                userName={auth.user?.name}
                composerAccessory={auth.composerAccessory}
                models={models}
                isAccountCurrent={() => auth.isAccountCurrent?.(accountId) !== false}
                onMessageSubmitted={messageSubmitted}
                stopServerTurn={stopServerTurn}
                savedFailure={turnFailure}
              >
                <div className="chat-model-picker">
                  <ModelEffortPicker {...picker} />
                </div>
              </ChatThread>
              {keptChatShown && keptChat}
            </div>
            {layoutElement !== null && createPortal(<>
              {webUiPlugin.auxiliaryPanels.map((Panel, index) => (
                <Panel
                  key={index}
                  agentId={AGENT_ID}
                  conversation={{ id: activeId, service: "chat-service" }}
                />
              ))}
              {webUiPlugin.toolResultRenderers.map((Renderer, index) => <Renderer key={index} />)}
              {(profileSwipe.visible || agentProfileChat === activeId) && (
                <AgentProfile
                  key={accountId}
                  ref={agentProfileRef}
                  open={profileSwipe.visible}
                  chatServiceUrl={CHAT_SERVICE_URL}
                  profile={agentProfile}
                  error={agentProfileError}
                  computer={ComputerView && ((shown) => (
                    <ComputerView agentId={AGENT_ID} agentName={agentName} conversation={{ id: activeId, service: "chat-service" }} shown={shown} />
                  ))}
                  onClose={profileSwipe.close}
                  revision={agentDocumentsRevision}
                  onSaved={() => void refreshAgentProfile()}
                  isAccountCurrent={() => auth.isAccountCurrent?.(accountId) !== false}
                  tabs={webUiPlugin.agentProfileTabs}
                />
              )}
              {auth.overlay}
            </>, layoutElement)}
            </>}
          </ChatSurface>
          </Suspense>
        )}
      </main>
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
  if (rumError !== null) throw rumError;
  return (
    <AuthProvider chatServiceUrl={CHAT_SERVICE_URL}>
      {(auth) => <Session auth={auth} />}
    </AuthProvider>
  );
}

/**
 * The app once the account session is ready. Until the session first answers, the app shows the Main Chat copy this
 * browser kept, if any, so the page opens on it at once; a session that fails or is parked takes it off screen.
 */
function Session({ auth }: { auth: AuthUiState }) {
  const loading = auth.sessionStatus === "loading";
  const [opening, setOpening] = useState<StoredMainChatCopy | null>(null);
  // Kept here, not in the app, which mounts again as the session parks and comes back: the page opens once.
  const historyMoment = useRef<HistoryMoment | null>(null);
  // Read after hydration: the server's page has no browser storage.
  useEffect(() => {
    const { copy, historyMoment: moment } = openingMainChat();
    if (loading) setOpening(copy);
    historyMoment.current = moment;
  }, []);
  // A session that fails or parks before the Main Chat shows leaves the opening's history moment unmeasured.
  useEffect(() => {
    if (auth.sessionStatus !== "loading" && auth.sessionStatus !== "ready") historyMoment.current = null;
  }, [auth.sessionStatus]);
  useEffect(() => {
    if (!loading) setOpening(null);
  }, [loading]);
  return auth.sessionStatus === "ready" || (loading && opening !== null)
    ? <App auth={auth} opening={opening} historyMoment={historyMoment} />
    : <SessionGate title={UI_CONFIG.title} status={auth.sessionStatus} loadFailure={auth.loadFailure} />;
}
