export interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

const DENIED_DOMAINS = new Set([
  'Storage',
  'DOMStorage',
  'IndexedDB',
  'CacheStorage',
  'Fetch',
  'Tracing',
]);

const DENIED_METHODS = new Set([
  'Network.getCookies',
  'Network.getAllCookies',
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Page.getCookies',
  'Page.deleteCookie',
  'Network.getResponseBody',
  'Network.getRequestPostData',
  'Network.getResponseBodyForInterception',
  'Network.takeResponseBodyForInterceptionAsStream',
  'Network.searchInResponseBody',
  'Network.loadNetworkResource',
  'Network.setRequestInterception',
  'Network.continueInterceptedRequest',
  'Network.streamResourceContent',
  'Audits.getEncodedResponse',
  'Page.getResourceContent',
  'Page.searchInResource',
  'Target.sendMessageToTarget',
  'Target.exposeDevToolsProtocol',
  'DOM.setFileInputFiles',
  'Browser.setDownloadBehavior',
  'Page.setDownloadBehavior',
]);

const ATTACHING = new Set(['Target.attachToTarget', 'Target.setAutoAttach']);
const NAVIGATING = new Set(['Page.navigate', 'Target.createTarget']);
const WEB_PROTOCOLS = new Set(['http:', 'https:']);
const BLANK_PAGE = 'about:blank';

export function deniesCommand({ method, params }: CdpMessage): boolean {
  if (typeof method !== 'string') return true;
  if (
    DENIED_METHODS.has(method) ||
    DENIED_DOMAINS.has(method.split('.')[0] ?? '')
  )
    return true;
  if (method === 'Input.dispatchDragEvent') {
    const data = params?.data;
    if (typeof data === 'object' && data !== null && 'files' in data)
      return true;
  }
  if (ATTACHING.has(method)) return params?.flatten !== true;
  if (NAVIGATING.has(method)) {
    const target = String(params?.url);
    if (target === BLANK_PAGE) return false;
    const url = URL.parse(target);
    return url === null || !WEB_PROTOCOLS.has(url.protocol);
  }
  return false;
}

const DROPPED_EVENTS = new Set([
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceivedExtraInfo',
]);
const COOKIE_HEADERS = new Set(['cookie', 'set-cookie']);
const COOKIE_FIELDS = new Set([
  'headersText',
  'requestHeadersText',
  'associatedCookies',
  'blockedCookies',
  'exemptedCookies',
]);

function withoutCookies(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCookies);
  if (typeof value !== 'object' || value === null) return value;
  const kept: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (COOKIE_FIELDS.has(key)) continue;
    kept[key] =
      (key === 'headers' || key === 'requestHeaders') &&
      typeof field === 'object' &&
      field !== null
        ? Object.fromEntries(
            Object.entries(field).filter(
              ([name]) => !COOKIE_HEADERS.has(name.toLowerCase())
            )
          )
        : withoutCookies(field);
  }
  return kept;
}

export function filterEvent(message: CdpMessage): CdpMessage | null {
  const { method } = message;
  if (typeof method !== 'string' || !method.startsWith('Network.'))
    return message;
  if (DROPPED_EVENTS.has(method)) return null;
  return withoutCookies(message) as CdpMessage;
}
