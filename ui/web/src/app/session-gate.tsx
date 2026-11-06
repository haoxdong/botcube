import { Swap } from "./collapse";
import { webUiPlugin } from "@cartridge-ui";
import type { AuthUiState } from "../cartridge/index.js";
import { Avatar } from "./avatar";
import { HeaderName } from "./header-status";
import { LoadFailed, LoadingSkeleton } from "./load-state";
import { menuIcon } from "./menu-icon";
import { WakeUpButton } from "./wake-up-button";

/**
 * Shown instead of the app until the account session is ready. While it loads, the app's own loading view: its
 * sidebar button, its header with the agent as the app first shows it, and the Main Chat's skeleton, all inert, so the
 * app takes over in place.
 */
export function SessionGate({
  title,
  agentName,
  status,
  loadFailure,
  chatServiceUrl,
}: {
  chatServiceUrl: string;
  title: string;
  agentName: string;
  status: Exclude<AuthUiState["sessionStatus"], "ready">;
  loadFailure: AuthUiState["loadFailure"];
}) {
  if (status === "loading") {
    return (
      <div className="app-layout" data-session-gate="loading" style={webUiPlugin.theme}>
        <aside className="sidebar sidebar-collapsed" inert>
          <div className="sidebar-top">
            <div className="sidebar-brand">
              <button type="button" className="sidebar-logo-btn" aria-label="Toggle sidebar">{menuIcon}</button>
              <span className="sidebar-brand-text">{title}</span>
            </div>
          </div>
        </aside>
        <main className="app-shell">
          <header className="chat-header" inert>
            <button type="button" className="chat-header-agent" disabled aria-label="Agent profile">
              <Avatar name={agentName} agent size={72} />
              <HeaderName name={agentName} working={false} />
            </button>
          </header>
          <LoadingSkeleton label="Main Chat" />
        </main>
      </div>
    );
  }
  return (
    <div className="account-session-gate">
      {/* Parked says the name once: the notice is the heading. */}
      <h1 className="welcome-title">{status === "parked" ? `${title} is paused, back soon.` : title}</h1>
      <Swap state={status === "error" ? (loadFailure ? "retry" : "unavailable") : status}>{status === "parked" ? (
        <WakeUpButton title={title} chatServiceUrl={chatServiceUrl} />
      ) : (
        loadFailure ? (
          <LoadFailed error={loadFailure.error} onRetry={loadFailure.retry} />
        ) : (
          <p className="welcome-error">Account session unavailable.</p>
        )
      )}</Swap>
    </div>
  );
}
