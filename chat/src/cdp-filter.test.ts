import { describe, expect, it } from 'vitest';
import { deniesCommand, filterEvent } from './index.js';

describe('deniesCommand', () => {
  it.each([
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
    'Storage.getCookies',
    'DOMStorage.getDOMStorageItems',
    'IndexedDB.requestData',
    'CacheStorage.requestEntries',
    'Fetch.enable',
    'Tracing.start',
  ])('denies %s', (method) => {
    expect(deniesCommand({ id: 1, method })).toBe(true);
  });

  it('denies a message with no method', () => {
    expect(deniesCommand({ id: 1 })).toBe(true);
  });

  it.each([
    'Runtime.evaluate',
    'Page.captureScreenshot',
    'Network.enable',
    'Input.dispatchMouseEvent',
    'Target.getTargets',
  ])('allows %s', (method) => {
    expect(deniesCommand({ id: 1, method })).toBe(false);
  });

  it.each(['Target.attachToTarget', 'Target.setAutoAttach'])(
    'allows %s only flattened',
    (method) => {
      expect(deniesCommand({ id: 1, method, params: { flatten: true } })).toBe(
        false
      );
      expect(deniesCommand({ id: 1, method, params: { flatten: false } })).toBe(
        true
      );
      expect(deniesCommand({ id: 1, method })).toBe(true);
    }
  );

  it.each(['Page.navigate', 'Target.createTarget'])(
    'lets %s open only web pages',
    (method) => {
      for (const url of [
        'https://example.test/s/',
        'http://example.com',
        'about:blank',
      ]) {
        expect(deniesCommand({ id: 1, method, params: { url } })).toBe(false);
      }
      for (const url of [
        'chrome://settings/cookies',
        'devtools://devtools',
        'file:///etc/passwd',
        'not a url',
        // Chrome maps every about: page but about:blank to its chrome:// page.
        'about:settings',
        'about:version',
        'about:blank#x',
      ]) {
        expect(deniesCommand({ id: 1, method, params: { url } })).toBe(true);
      }
      expect(deniesCommand({ id: 1, method })).toBe(true);
    }
  );
});

describe('filterEvent', () => {
  it('passes non-network messages untouched', () => {
    const message = { id: 3, result: { headers: { Cookie: 'kept' } } };
    expect(filterEvent(message)).toBe(message);
    const event = {
      method: 'Page.loadEventFired',
      params: { headers: { Cookie: 'kept' } },
    };
    expect(filterEvent(event)).toBe(event);
  });

  it.each([
    'Network.requestWillBeSentExtraInfo',
    'Network.responseReceivedExtraInfo',
  ])('drops %s', (method) => {
    expect(filterEvent({ method, params: {} })).toBeNull();
  });

  it('strips cookie headers and cookie fields from network events, at any depth', () => {
    expect(
      filterEvent({
        method: 'Network.responseReceived',
        sessionId: 'page',
        params: {
          requestId: '1',
          response: {
            url: 'https://example.test/',
            headers: {
              'Set-Cookie': 'SampleSession=x',
              'content-type': 'text/html',
            },
            requestHeaders: { Cookie: 'SampleSession=x', Accept: '*/*' },
            headersText: 'Set-Cookie: SampleSession=x',
            requestHeadersText: 'Cookie: SampleSession=x',
          },
          associatedCookies: [{ name: 'SampleSession' }],
          blockedCookies: [],
          exemptedCookies: [],
          redirects: [
            { headers: { cookie: 'x', Host: 'a' }, requestHeaders: null },
          ],
          count: 2,
          headers: 'not an object',
        },
      })
    ).toEqual({
      method: 'Network.responseReceived',
      sessionId: 'page',
      params: {
        requestId: '1',
        response: {
          url: 'https://example.test/',
          headers: { 'content-type': 'text/html' },
          requestHeaders: { Accept: '*/*' },
        },
        redirects: [{ headers: { Host: 'a' }, requestHeaders: null }],
        count: 2,
        headers: 'not an object',
      },
    });
  });
});
