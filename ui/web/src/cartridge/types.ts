import type { CustomEvent, Message } from '@ag-ui/client';
import type { ComponentType, ReactNode } from 'react';

export type AuthStatus = 'unknown' | 'loading' | 'unauthed' | 'authed' | 'error';

/** The user the account menu shows; without a name, the account label stands in. */
export interface AuthUser {
  name?: string | undefined;
  /** The user's photo, shown in place of their initial. */
  photo?: string | undefined;
}

export interface AuthUiState {
  /** `parked`: the Chat Service answered that production is Parked. */
  sessionStatus: 'loading' | 'ready' | 'parked' | 'error';
  /** The account this page is signed in to, once known; the page reloads the account's data when a sign-in changes it. */
  accountId?: string | undefined;
  /** Synchronous account ownership check, including a cookie-changing switch before React renders. */
  isAccountCurrent?: ((accountId: string | undefined) => boolean) | undefined;
  status: AuthStatus;
  error: string | null;
  /** Why the account's state could not load, and a reload (ADR 0030); the account menu shows it in place of signing in. */
  loadFailure?: { error: string; retry: () => void } | undefined;
  user?: AuthUser | undefined;
  /**
   * Saves the user's display name and photo (a `data:` URL; null removes it, undefined keeps it);
   * absent while the account has no profile to edit. Rejects with the reason a save failed.
   */
  editProfile?: ((profile: { name: string; photo: string | null | undefined }) => Promise<void>) | undefined;
  login: () => void;
  relink: () => void;
  logout: () => void;
  overlay?: ReactNode;
  /** Shown with the chat's composer, above its text box. */
  composerAccessory?: ReactNode;
}

export interface AuthProviderProps {
  chatServiceUrl: string;
  children: (auth: AuthUiState) => ReactNode;
}

export interface AuxiliaryPanelHostProps {
  agentId: string;
  conversation: { id: string; service: 'chat-service' | 'sandbox' };
}

/** The Agent Computer's props: the open chat, and the agent's current name, as the chat's header shows it. */
export interface ComputerViewProps extends AuxiliaryPanelHostProps {
  agentName: string;
  /** Whether the Computer tab is showing; hidden, the view stays mounted for the user's return. */
  shown: boolean;
  /** Whether this view has an established browser connection that survives chat navigation. */
  onConnectionChange?: (connected: boolean) => void;
  activity: {
    messages: readonly Message[];
    running: boolean;
    stop: (() => void) | null;
    subscribeToCustomEvents: (listener: (event: CustomEvent) => void) => () => void;
  };
}

export interface WebUiPlugin {
  config: {
    agentId: string;
    title: string;
    /** The agent's name until its Agent Identity loads. */
    agentName: string;
    subtitle: string;
    disclaimer: string;
    loginLabel: string;
    relinkLabel: string;
    /** `Log out` without one. */
    logoutLabel?: string;
    /** What the user's own account is called in the account menu. */
    accountLabel: string;
  };
  toolResultRenderers?: ComponentType[];
  auxiliaryPanels?: ComponentType<AuxiliaryPanelHostProps>[];
  /** The pop-out window's view; BotCube's live browser view without one. */
  AuxiliaryView?: ComponentType;
  /** The Agent Computer, shown in the Agent Profile's Computer tab for the open chat. */
  ComputerView?: ComponentType<ComputerViewProps>;
  AuthProvider: ComponentType<AuthProviderProps>;
  /** Panels for the Agent Profile's tabs, rendered inside `AuthProvider`; a tab without one has nothing yet. */
  agentProfileTabs?: Partial<Record<AgentProfileTab, ComponentType>>;
  /** The binary every agent command runs, with its trailing space, such as `tool `: a command's step label drops it. */
  commandPrefix?: string;
  /** CSS custom-property values over the shell's tokens (`globals.css`). */
  theme?: Record<string, string>;
}

export type AgentProfileTab = 'Activity' | 'Sign-ins' | 'Computer' | 'Scheduled' | 'Personalization';
