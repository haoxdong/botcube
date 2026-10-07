import { describe, expect, it } from 'vitest';
import { LiveViewInjector } from './live-view.js';

const opened = (sessionId: string) =>
  `data: {"type":"CUSTOM","name":"test:browser-live-view","value":{"open":true,"sessionId":"${sessionId}"}}\n\n`;
const closed = 'data: {"type":"CUSTOM","name":"test:browser-live-view","value":{"open":false}}\n\n';

const data = (event: unknown) => `data: ${JSON.stringify(event)}`;
const delta = (text: string) => data({ type: 'TOOL_CALL_ARGS', toolCallId: 'call-1', delta: text });
const content = (text: string) => data({ type: 'TOOL_CALL_RESULT', messageId: 'result-1', content: text });

const URL_PATH = 'bedrock-agentcore.us-west-2.amazonaws.com/browser-streams/aws.browser.v1/session';

/** The live-view events that follow each frame, one frame per line given. */
const eventsAfter = (...frames: string[]) => {
  const liveView = new LiveViewInjector('test:browser-live-view');
  return frames.map((frame) => liveView.after([frame]).join(''));
};

it('opens the actual Cartridge browser once after a Turn starts and still recognizes a later close', () => {
  const view = new LiveViewInjector('test:browser-live-view', 'cartridge-browser');
  expect(view.after([data({ type: 'RUN_STARTED' })])).toEqual([opened('cartridge-browser')]);
  expect(view.after([data({ type: 'RUN_STARTED' })])).toEqual([]);
  expect(view.after([content('Browser closed')])).toEqual([closed]);
});

describe('a streamed delta', () => {
  it.each([
    ['a Session ID once whitespace follows it', 'Session: Br0.w_s:e-r2 next', 'Br0.w_s:e-r2'],
    ['a Session ID with no space after the colon', 'Session:abc-1 ', 'abc-1'],
    ['a Session ID after several spaces', 'Session:   abc-1\n', 'abc-1'],
    ['a live-view URL followed by a path', `see https://${URL_PATH}/S-1.a:b_c/live-view`, 'S-1.a:b_c'],
    ['a live-view URL followed by a query', `https://${URL_PATH}/S-1?x=1`, 'S-1'],
    ['a live-view URL followed by a fragment', `https://${URL_PATH}/S-1#top`, 'S-1'],
    ['a live-view URL followed by whitespace', `https://${URL_PATH}/S-1 open it`, 'S-1'],
    ['a live-view URL on a host prefix', `https://proxy.${URL_PATH}/S-2/live-view`, 'S-2'],
    ['a plain-HTTP live-view URL', `http://${URL_PATH}/S-3/`, 'S-3'],
  ])('opens the live view on %s', (_, text, sessionId) => {
    expect(eventsAfter(delta(text))).toEqual([opened(sessionId)]);
  });

  it.each([
    ['a Session ID that may still be growing', 'Session: abc'],
    ['a live-view URL that may still be growing', `https://${URL_PATH}/S-1`],
    ['"Session:" inside a longer word', 'xSession: abc '],
    ['a URL inside a longer word', `xhttps://${URL_PATH}/S-1/`],
    ['a URL on another host', 'https://example.com/session/S-1/'],
    ['"browser" run into "closed"', 'browserclosed'],
    ['"browser closed" inside a longer word', 'abrowser closed'],
    ['"closed" run into more letters', 'browser closedown'],
    ['a Session ID with no characters', 'Session: \n'],
  ])('leaves the live view alone on %s', (_, text) => {
    expect(eventsAfter(delta(text))).toEqual(['']);
  });

  it.each([
    ['"browser closed"', 'The browser closed.'],
    ['"browser session closed"', 'Browser Session Closed'],
    ['words spread over several spaces', 'browser  session\t closed'],
  ])('closes the live view on %s', (_, text) => {
    expect(eventsAfter(delta(text))).toEqual([closed]);
  });

  it('prefers a Session ID over a URL, and either over "browser closed"', () => {
    expect(eventsAfter(delta(`browser closed https://${URL_PATH}/S-url/ Session: S-id `))).toEqual([opened('S-id')]);
    expect(eventsAfter(delta(`browser closed https://${URL_PATH}/S-url/`))).toEqual([opened('S-url')]);
  });
});

describe('complete text', () => {
  it.each([
    ['a Session ID at its end', 'Session: abc-1', 'abc-1'],
    ['a Session ID followed by whitespace', 'Session: abc-1 then', 'abc-1'],
    ['a Session ID with no space after the colon', 'Session:abc-1', 'abc-1'],
    ['a live-view URL at its end', `https://${URL_PATH}/S-1`, 'S-1'],
    ['a live-view URL followed by a path', `https://${URL_PATH}/S-1/live-view`, 'S-1'],
    ['a live-view URL followed by whitespace', `https://${URL_PATH}/S-1 open it`, 'S-1'],
    ['a live-view URL on a host prefix', `https://proxy.${URL_PATH}/S-2`, 'S-2'],
    ['a plain-HTTP live-view URL', `http://${URL_PATH}/S-3`, 'S-3'],
  ])('opens the live view on %s', (_, text, sessionId) => {
    expect(eventsAfter(content(text))).toEqual([opened(sessionId)]);
  });

  it('leaves the live view alone on a Session ID run into other text', () => {
    expect(eventsAfter(content('Session: abc!'))).toEqual(['']);
  });

  it('closes the live view on "browser closed"', () => {
    expect(eventsAfter(content('browser closed'))).toEqual([closed]);
  });
});

describe('a text message', () => {
  const message = (type: string, extra: Record<string, unknown> = {}) => data({ type, messageId: 'msg-1', ...extra });

  it('is read whole at its end, since an ID can span deltas', () => {
    expect(
      eventsAfter(
        message('TEXT_MESSAGE_START', { role: 'assistant' }),
        message('TEXT_MESSAGE_CONTENT', { delta: 'Session: ab' }),
        message('TEXT_MESSAGE_CONTENT', { delta: 'c-1' }),
        message('TEXT_MESSAGE_END'),
      ),
    ).toEqual(['', '', '', opened('abc-1')]);
  });

  it('starts afresh when its ID is reused', () => {
    expect(
      eventsAfter(
        message('TEXT_MESSAGE_CONTENT', { delta: 'Session: abc-1' }),
        message('TEXT_MESSAGE_END'),
        message('TEXT_MESSAGE_CONTENT', { delta: 'browser closed' }),
        message('TEXT_MESSAGE_END'),
      ),
    ).toEqual(['', opened('abc-1'), '', closed]);
  });

  it('ignores a delta that is not text', () => {
    expect(
      eventsAfter(
        message('TEXT_MESSAGE_CONTENT', { delta: 'Session: ' }),
        message('TEXT_MESSAGE_CONTENT', { delta: null }),
        message('TEXT_MESSAGE_END'),
      ),
    ).toEqual(['', '', '']);
  });

  it('is scanned as a delta when it has no message ID', () => {
    expect(eventsAfter(data({ type: 'TEXT_MESSAGE_CONTENT', delta: 'Session: abc-1 ' }))).toEqual([opened('abc-1')]);
  });

  it('ends with nothing to show when it had no text', () => {
    expect(eventsAfter(message('TEXT_MESSAGE_END'))).toEqual(['']);
  });
});

describe('a frame', () => {
  it('is read only from its data lines', () => {
    const liveView = new LiveViewInjector('test:browser-live-view');

    expect(liveView.after(['event: message', 'id: 7', delta('Session: abc-1 ')])).toEqual([opened('abc-1')]);
    expect(liveView.after([`event:${JSON.stringify({ type: 'X', delta: 'Session: abc-1 ' })}`])).toEqual([]);
  });

  it.each([
    ['non-JSON data', 'data: Session: abc-1 '],
    ['JSON null', 'data: null'],
    ['a JSON string', `data: ${JSON.stringify('Session: abc-1 ')}`],
    ['a JSON array', `data: ${JSON.stringify(['Session: abc-1 '])}`],
    ['an event with no text', data({ type: 'RUN_STARTED' })],
  ])('carries no live-view text in %s', (_, line) => {
    expect(new LiveViewInjector('test:browser-live-view').after([line])).toEqual([]);
  });

  it('answers an event for each data line that opens or closes the live view', () => {
    const liveView = new LiveViewInjector('test:browser-live-view');

    expect(liveView.after([delta('Session: abc-1 '), delta('browser closed')])).toEqual([opened('abc-1'), closed]);
  });
});
