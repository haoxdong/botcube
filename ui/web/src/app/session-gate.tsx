import type { ReactNode } from "react";
import { Swap } from "./collapse";
import { AGENT_THEME } from "../bot-settings";
import type { AuthUiState } from "../plugin/index.js";
import { Button } from "@/components/ui/button";
import { Avatar } from "./avatar";
import { LoadFailed, LoadingSkeleton } from "./load-state";
import { MenuButton } from "./menu-icon";
import { Sidebar } from "./sidebar";
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
  children,
}: {
  children?: ReactNode;
  chatServiceUrl: string;
  title: string;
  agentName: string;
  status: Exclude<AuthUiState["sessionStatus"], "ready">;
  loadFailure: AuthUiState["loadFailure"];
}) {
  if (status === "loading") {
    return (
      <div className="app-layout" data-session-gate="loading" style={AGENT_THEME}>
        <Sidebar inert>
          <div className="sidebar-top">
            <div className="sidebar-brand">
              <MenuButton />
              <span className="sidebar-brand-text">{title}</span>
            </div>
          </div>
        </Sidebar>
        <main className="app-shell">
          <header className="chat-header" inert>
            <Button variant="ghost" className="chat-header-agent" disabled aria-label="Agent profile">
              <Avatar name={agentName} agent size={72} />
              <span className="chat-header-name"><span className="chat-header-label">{agentName}</span></span>
            </Button>
          </header>
          {children ?? <LoadingSkeleton label="Main Chat" />}
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
