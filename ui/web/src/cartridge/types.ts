import type { CustomEvent, Message } from '@ag-ui/client';
import type { ComponentType, ReactNode } from 'react';

/** A site the agent can be signed in to, as the Chat Service's `GET /account/sign-ins` lists it. */
export interface SignIn {
  site: string;
  name: string;
  status: 'linked' | 'relink_required' | 'not_linked';
  username?: string | null | undefined;
}

/** The Sign-ins tab's actions and state, from the page's sign-in provider, which owns the Sign-in Sheet. */
export interface SignInsControl {
  /** Opens the Sign-in Sheet, for a first sign-in or a re-link. */
  signIn: () => void;
  signOut: () => void;
  /** Confirms a sign-out the Chat Service warned about. */
  confirmSignOut: () => void;
  cancelSignOut: () => void;
  /** The Chat Service's last-Sign-in warning, awaiting the user's confirmation. */
  warning: string | null;
  busy: boolean;
  error: string | null;
  /** Bumped by each completed sign-in or sign-out, so the list reloads. */
  revision: number;
  /** The Sign-ins as a product's own service lists them; without it, the Chat Service's `GET /account/sign-ins`. */
  load?: (() => Promise<SignIn[]>) | undefined;
  /** Whether a failed Agent Computer request means a site needs a sign-in, which opens the Sign-in Sheet. */
  needsSignIn?: ((cause: Error) => boolean) | undefined;
}

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
  /** A Guest: a User this browser alone holds until a Sign-in saves it (ADR 0076). */
  guest?: boolean | undefined;
  status: AuthStatus;
  error: string | null;
  /** Why the account's state could not load, and a reload (ADR 0030); the account menu shows it in place of signing in. */
  loadFailure?: { error: string; retry: () => void } | undefined;
  user?: AuthUser | undefined;
  /** The user is still loading: the account menu shows no name or initial yet, rather than the account label it would replace. */
  userLoading?: boolean | undefined;
  /**
   * Saves the user's display name and photo (a `data:` URL; null removes it, undefined keeps it);
   * absent while the account has no profile to edit. Rejects with the reason a save failed.
   */
  editProfile?: ((profile: { name: string; photo: string | null | undefined }) => Promise<void>) | undefined;
  login: () => void;
  relink: () => void;
  logout: () => void;
  overlay?: ReactNode;
  /** The Sign-ins tab's actions and state; without them, the tab has nothing yet. */
  signIns?: SignInsControl | undefined;
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
  /** A request of the Computer failed: the page opens the Sign-in Sheet when it says a site needs a sign-in. */
  onRequestError?: ((cause: Error) => void) | undefined;
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
    pickerModelFamilies?: readonly string[];
  };
  AuthProvider: ComponentType<AuthProviderProps>;
}

export type AgentProfileTab = 'Activity' | 'Sign-ins' | 'Computer' | 'Scheduled' | 'Personalization';
