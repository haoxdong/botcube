import type { AuthUiState } from "../cartridge/index.js";
import { LoadFailed } from "./load-state";

/** Shown instead of the app until the account session is ready. */
export function SessionGate({
  title,
  status,
  loadFailure,
}: {
  title: string;
  status: Exclude<AuthUiState["sessionStatus"], "ready">;
  loadFailure: AuthUiState["loadFailure"];
}) {
  return (
    <div className="account-session-gate">
      {/* Parked says the name once: the notice is the heading. */}
      <h1 className="welcome-title">{status === "parked" ? `${title} is paused, back soon.` : title}</h1>
      {status === "error" &&
        (loadFailure ? (
          <LoadFailed error={loadFailure.error} onRetry={loadFailure.retry} />
        ) : (
          <p className="welcome-error">Account session unavailable.</p>
        ))}
    </div>
  );
}
