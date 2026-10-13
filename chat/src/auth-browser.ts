import { BrowserSessions, type AgentCoreBrowser, type StartedBrowserSession } from './browser-sessions.js';
import { Cdp } from './cdp.js';
export interface AgentCoreBrowserConfig extends AgentCoreBrowser {
  extension: { bucket: string; prefix: string; versionId: string };
  sessionName: string;
  captureCookies(cookies: Record<string, unknown>[]): JarCookie[];
}
/** A login page as a read of it reports: where it is and its fields' types and names, never their values. */
interface LoginPage {
  url: string;
  fields: { type: string; name: string }[];
}

export const AUTH_BROWSER_SESSION_TTL_SECONDS = 180;
/** A cookie in a cookie-jar file, as the auth browser reads and writes it. */
export type JarCookie = Record<string, unknown> & { name: string; value: string };
const NAVIGATION_TIMEOUT_MS = 15_000;
/** Reads the page's visible inputs' types and names; never a value. */
const LOGIN_PAGE_EXPRESSION = `({
  fields: [...document.querySelectorAll('input')]
    .filter((input) => input.type !== 'hidden')
    .map((input) => ({ type: input.type, name: input.name || input.id })),
})`;
/** How long a login page may take to render its form's fields; Some pages render about 1 s after navigating. */
const LOGIN_FORM_TIMEOUT_MS = 20_000;
/** How much longer than the page's own wait its read may take to answer. */
const LOGIN_FORM_READ_MARGIN_MS = 5_000;
/** CDP's answers when a navigation replaced the page a read ran in: the read runs again on the new page. */
const PAGE_REPLACED = /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed/;

/** The page's own wait for its form: LOGIN_PAGE_EXPRESSION's read once a field renders, or as it stands after `timeoutMs`. */
const loginFormExpression = (timeoutMs: number) => `new Promise((resolve) => {
  const read = () => ${LOGIN_PAGE_EXPRESSION};
  const answer = () => {
    observer.disconnect();
    clearTimeout(timer);
    resolve(read());
  };
  const observer = new MutationObserver(() => {
    if (read().fields.length > 0) answer();
  });
  const timer = setTimeout(answer, ${timeoutMs});
  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['type'] });
  if (read().fields.length > 0) answer();
})`;

export interface Viewport {
  width: number;
  height: number;
}

/** The AgentCore browser a site sign-in signs the user in through. */
export interface AuthBrowser {
  /** The AgentCore browser its Sessions run in. */
  readonly browserId: string;
  start(options: {
    viewport: Viewport;
    emulatedViewport: Viewport | null;
    userAgent: string | null;
    sessionTimeoutSeconds: number;
  }): Promise<StartedBrowserSession>;
  /**
   * Navigate to `url` and answer the login page it lands on once its form's fields render,
   * or as it stands after LOGIN_FORM_TIMEOUT_MS: a fieldless challenge is still checked against the origin allowlist and offered Take-over.
   */
  openLoginPage(sessionId: string, url: string): Promise<LoginPage>;
  /** The page's URL, read from its target without touching the page. */
  pageUrl(sessionId: string): Promise<string>;
  /** The page's URL and form fields, for the Sign-in Sheet's origin and form checks; field values are never read. */
  loginPage(sessionId: string): Promise<LoginPage>;
  /**
   * The value `script` answers in the page, its promise awaited; undefined when a
   * navigation replaced the page mid-script, so a poll reads the next page instead.
   */
  evaluate(sessionId: string, script: string): Promise<unknown>;
  /** Hand the browser to the user: the automation stream is disabled while they sign in. */
  takeControl(sessionId: string, showBrowserChrome?: boolean): Promise<void>;
  releaseControl(sessionId: string): Promise<void>;
  /** The site cookies selected by the Cartridge's trusted capture policy. */
  getAllCookies(sessionId: string): Promise<JarCookie[]>;
  stop(sessionId: string): Promise<void>;
}

/** An AgentCore browser driven over its SigV4-authenticated CDP automation stream. */
export function agentCoreAuthBrowser(config: AgentCoreBrowserConfig): AuthBrowser {
  const sessions = new BrowserSessions(config);
  const emulatedViewports = new Map<string, Viewport>();
  const userAgents = new Map<string, string>();
  const withBrowser = <T>(sessionId: string, body: (cdp: Cdp) => Promise<T>) => sessions.withBrowser(sessionId, body);

  const withPage = <T>(sessionId: string, body: (cdp: Cdp, page: string) => Promise<T>): Promise<T> =>
    withBrowser(sessionId, async (cdp) => body(cdp, await cdp.attachToPage()));

  return {
    browserId: config.browserId,
    async start({ viewport, emulatedViewport, userAgent, sessionTimeoutSeconds }) {
      const started = await sessions.start({
        name: config.sessionName,
        sessionTimeoutSeconds,
        viewPort: viewport,
        extensions: [{ location: { s3: config.extension } }],
      });
      if (emulatedViewport !== null) emulatedViewports.set(started.sessionId, emulatedViewport);
      if (userAgent !== null) userAgents.set(started.sessionId, userAgent);
      return started;
    },
    openLoginPage: (sessionId, url) =>
      withPage(sessionId, async (cdp, page) => {
        const emulated = emulatedViewports.get(sessionId);
        const userAgent = userAgents.get(sessionId);
        // Independent settings, sent together: each waits only for the browser's answer.
        await Promise.all([
          cdp.enablePageDomains(page),
          setBrowserWindow(cdp, page, 'fullscreen'),
          emulated === undefined
            ? undefined
            : cdp.send('Emulation.setDeviceMetricsOverride', {
              params: { ...emulated, deviceScaleFactor: 1, mobile: emulated.width <= 900 },
              sessionId: page,
            }),
          userAgent === undefined
            ? undefined
            : cdp.send('Network.setUserAgentOverride', { params: { userAgent }, sessionId: page }),
        ]);
        await cdp.send('Page.navigate', { params: { url }, sessionId: page, timeoutMs: NAVIGATION_TIMEOUT_MS });
        // The page answers once its form renders, which some login forms do before the page finishes loading.
        const deadline = Date.now() + LOGIN_FORM_TIMEOUT_MS;
        for (;;) {
          const remaining = Math.max(0, deadline - Date.now());
          try {
            // eslint-disable-next-line no-await-in-loop -- reads again only on the page a redirect put in place
            const form = loginForm(await cdp.send('Runtime.evaluate', {
              params: { expression: loginFormExpression(remaining), awaitPromise: true, returnByValue: true },
              sessionId: page,
              timeoutMs: remaining + LOGIN_FORM_READ_MARGIN_MS,
            }));
            // eslint-disable-next-line no-await-in-loop -- the loop ends here, with the page the form is on
            return { url: (await cdp.pageTarget()).url, ...form };
          } catch (error) {
            if (!(error instanceof Error && PAGE_REPLACED.test(error.message)) || Date.now() >= deadline) throw error;
          }
        }
      }),
    pageUrl: (sessionId) => withBrowser(sessionId, async (cdp) => (await cdp.pageTarget()).url),
    loginPage: (sessionId) =>
      withBrowser(sessionId, async (cdp) => {
        const { url } = await cdp.pageTarget();
        const page = await cdp.attachToPage();
        const read = await cdp.send('Runtime.evaluate', {
          params: { expression: LOGIN_PAGE_EXPRESSION, returnByValue: true },
          sessionId: page,
        });
        return { url, ...loginForm(read) };
      }),
    evaluate: (sessionId, script) =>
      withPage(sessionId, async (cdp, page) => {
        try {
          const read = await cdp.send('Runtime.evaluate', {
            params: { expression: script, awaitPromise: true, returnByValue: true },
            sessionId: page,
          });
          return (read as { result?: { value?: unknown } }).result?.value;
        } catch (error) {
          if (error instanceof Error && PAGE_REPLACED.test(error.message)) return undefined;
          throw error;
        }
      }),
    takeControl: async (sessionId, showBrowserChrome = false) => {
      if (showBrowserChrome) await withPage(sessionId, (cdp, page) => setBrowserWindow(cdp, page, 'normal'));
      await sessions.updateAutomationStream(sessionId, 'DISABLED');
    },
    releaseControl: async (sessionId) => void (await sessions.updateAutomationStream(sessionId, 'ENABLED')),
    getAllCookies: (sessionId) =>
      withPage(sessionId, async (cdp, page) => {
        await cdp.send('Network.enable', { sessionId: page });
        return config.captureCookies(await cdp.allCookies(page));
      }),
    stop: async (sessionId) => void (await sessions.stop(sessionId)),
  };
}

/** A login page read's fields, failing loud on a read that returned no form. */
function loginForm(read: Record<string, unknown>): Omit<LoginPage, 'url'> {
  const { fields } = (read as { result?: { value?: { fields?: unknown } } }).result?.value ?? {};
  if (!Array.isArray(fields)) throw new Error('Login page read returned no form');
  return { fields: fields as LoginPage['fields'] };
}

/**
 * Fullscreen approved pages; preserve the address bar when a rejected page is
 * handed to the user. The window keeps its state after automation disconnects.
 */
async function setBrowserWindow(cdp: Cdp, page: string, windowState: 'fullscreen' | 'normal'): Promise<void> {
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { sessionId: page });
  if (typeof windowId !== 'number') throw new Error('Browser.getWindowForTarget returned no windowId');
  await cdp.send('Browser.setWindowBounds', { params: { windowId, bounds: { windowState } } });
}

/** A listed browser Session's ID when it is a site sign-in browser past its TTL. */
function expiredAuthBrowserSession(item: Record<string, unknown>, now: number, sessionName: string, ttlSeconds: number): string | null {
  const createdAt = typeof item.createdAt === 'string' ? Date.parse(item.createdAt) / 1000 : NaN;
  if (item.name !== sessionName || typeof item.sessionId !== 'string' || Number.isNaN(createdAt)) {
    return null;
  }
  return now - createdAt > ttlSeconds ? item.sessionId : null;
}

/**
 * Stop site sign-in browser Sessions older than their TTL: the backstop for a
 * link whose teardown failed or whose Chat Service task went away. Answers the
 * IDs it stopped.
 */
export async function reapExpiredAuthBrowserSessions(
  config: AgentCoreBrowser,
  { sessionName, ttlSeconds = AUTH_BROWSER_SESSION_TTL_SECONDS }: { sessionName: string; ttlSeconds?: number },
  now: number = Date.now() / 1000,
): Promise<string[]> {
  const sessions = new BrowserSessions(config);
  const expired: string[] = [];
  let nextToken: string | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop -- pagination: each page needs the previous nextToken
    const response = await sessions.call('POST', 'list', {
      body: { status: 'READY', maxResults: 50, ...(nextToken ? { nextToken } : {}) },
    });
    for (const item of (response.items ?? []) as Record<string, unknown>[]) {
      const sessionId = expiredAuthBrowserSession(item, now, sessionName, ttlSeconds);
      if (sessionId !== null) expired.push(sessionId);
    }
    nextToken = typeof response.nextToken === 'string' && response.nextToken ? response.nextToken : undefined;
  } while (nextToken !== undefined);
  // eslint-disable-next-line no-await-in-loop -- stops at the first failure without sending the rest
  for (const sessionId of expired) await sessions.stop(sessionId);
  return expired;
}
