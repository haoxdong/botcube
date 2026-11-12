import type { AccountResources } from './account-resources.js';
import type { FilesMount } from './files.js';

/** The AgentCore operations an Agent Computer browser needs. */
export interface AgentComputerBrowser {
  /** The AgentCore browser its Sessions run in. */
  readonly browserId: string;
  /**
   * Start a browser Session, from the browser profile when there is one, with
   * the account's Files mounted as Chrome's download directory; answers its ID.
   */
  start(profileId: string | null, files: FilesMount): Promise<string>;
  /** The page as a JPEG data URL. */
  screenshot(sessionId: string): Promise<string>;
  /** Run the Cartridge's trusted cleanup before a browser profile is saved. */
  beforeProfileSave(sessionId: string): Promise<void>;
  /** Create the account's browser profile; answers its ID. */
  createProfile(accountId: string): Promise<string>;
  /** Save the browser's cookies and local storage into the profile; the last save wins. */
  saveProfile(profileId: string, sessionId: string): Promise<void>;
  /** Delete the account's browser profile; one already gone counts as deleted, so a retried deletion goes on. */
  deleteProfile(profileId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  /** The browser's CDP automation stream, with the headers that open it. */
  automationStream(sessionId: string): Promise<{ endpoint: string; headers: Record<string, string> }>;
  /** Who drives the browser: the user once they have taken it over, else the agent. */
  control(sessionId: string): Promise<BrowserControl>;
  /** End the user's Take-over: the agent drives the browser again. */
  handBack(sessionId: string): Promise<void>;
}

export type BrowserControl = 'user' | 'agent';

export type AgentComputerRecords = Pick<AccountResources, 'assertBrowserAllowed' | 'scheduledBrowserAdmission' | 'agentComputer' | 'saveAgentComputer' | 'agentComputerScreenshot' | 'saveAgentComputerScreenshot' | 'deleteAgentComputer' | 'withAgentComputerLease' | 'runningAgentComputer' | 'runningAgentComputers' | 'saveRunningAgentComputer' | 'deleteRunningAgentComputer' | 'agentComputerStream' | 'claimAgentComputerStream' | 'renewAgentComputerStream' | 'releaseAgentComputerStream'>;

/** The Session's last screenshot comes with either state: it stands in until the live view shows the browser. */
export type AgentComputerState =
  | { state: 'awake'; browserSessionId: string; control: BrowserControl; screenshot: string | null }
  | { state: 'starting' | 'asleep'; screenshot: string | null };

export type AwakeComputer = Extract<AgentComputerState, { state: 'awake' }>;
