import { http, HttpResponse } from 'msw';
import { CHAT_SERVICE_ORIGIN } from '../.storybook/chat-origin';
import { BOT_SETTINGS as bot } from '../src/bot-settings';

export const unhandledChatRequests: string[] = [];

const now = Date.parse('2026-10-06T05:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const DATA_CALL = 'call-data';
const messages = [
  { id: 'm0', role: 'user', content: 'What is on the example site?' },
  {
    id: 'm1',
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        id: DATA_CALL,
        type: 'function',
        function: { name: 'execute', arguments: JSON.stringify({ command: 'fake-cli data' }) },
      },
    ],
  },
  {
    id: 'm2',
    role: 'tool',
    toolCallId: DATA_CALL,
    content: '{"items": [{"name": "Sample item", "value": 42}]}\n',
  },
  {
    id: 'm3',
    role: 'assistant',
    content: 'The example site lists one item: **Sample item**, with a value of **42**.',
  },
];
/** The fake site's login page, as the Agent Computer's browser shows it. */
const SCREEN = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#fff"/><text x="16" y="52" font-family="Times New Roman, serif" font-size="32" font-weight="bold" fill="#000">Example site</text><rect x="16" y="76" width="64" height="24" rx="3" fill="#efefef" stroke="#767676"/><text x="48" y="93" font-family="Arial, sans-serif" font-size="13" text-anchor="middle" fill="#000">Sign in</text></svg>'
)}`;

const SESSION = { accountId: 'example-account', signInNeeded: false };
const ANSWERS: Record<string, unknown> = {
  '/account/session': SESSION,
  '/account/sign-ins': { signIns: [{ site: 'fake-site', name: 'Example site', status: 'linked' }] },
  '/agent/identity': {
    name: bot.agentIdentity.name,
    character: 'An example agent',
    vibe: 'Direct, precise, and calm',
    avatar: bot.agentIdentity.avatar,
  },
  '/agent/soul': { content: 'Lead with the answer, then the evidence behind it.\nBe candid about what you found, what you could not find, and how sure you are.\nRespect the user\'s time: no filler, no flattery.\nLearn how this user likes to work, and adapt to it.' },
  '/files/written-memory': { content: '' },
  '/agent-computer': { state: 'asleep', screenshot: null },
  '/main-chat': { id: 'main-shots', messages },
  '/threads': {
    threads: [
      { id: 't1', title: 'Read the example site', updatedAt: ago(30) },
      { id: 't2', title: 'say hi', updatedAt: ago(3000) },
    ],
  },
  '/agent': { name: bot.agentIdentity.name, avatar: bot.agentIdentity.avatar, picture: null, status: 'online' },
  '/agent/models': { models: [{ key: 'echo', label: 'Echo', provider: 'echo' }] },
  '/scheduled-tasks': { tasks: [] },
};

export function reply(path: string, body: unknown, status = 200) {
  return http.get(`${CHAT_SERVICE_ORIGIN}${path}`, () =>
    HttpResponse.json(body as Record<string, unknown>, { status })
  );
}

const AWAKE = { state: 'awake', browserSessionId: 'browser-shot', control: 'agent', screenshot: null, liveView: 'screenshots' };

/** The awake computer's view: its state, wake, and the browser's image. */
export const awakeComputer = {
  '/agent-computer': reply('/agent-computer', AWAKE),
  liveUrl: reply('/browser-live-view-url', { signedUrl: `${CHAT_SERVICE_ORIGIN}/agent-computer/view?thread_id=chat-1` }),
  wake: http.post(`${CHAT_SERVICE_ORIGIN}/agent-computer/wake`, () => HttpResponse.json(AWAKE)),
  view: http.get(`${CHAT_SERVICE_ORIGIN}/agent-computer/view`, async () =>
    new HttpResponse(await (await fetch(SCREEN)).blob(), { headers: { 'content-type': 'image/svg+xml' } })
  ),
};

const NO_LIVE_VIEW = { ...AWAKE, liveView: 'none' };

/** An awake computer under the BotCube Config's `liveView: none`: its state and wake, and no live view to fetch. */
export const noLiveViewComputer = {
  '/agent-computer': reply('/agent-computer', NO_LIVE_VIEW),
  wake: http.post(`${CHAT_SERVICE_ORIGIN}/agent-computer/wake`, () => HttpResponse.json(NO_LIVE_VIEW)),
};

export const handlers = Object.fromEntries(
  Object.entries(ANSWERS).map(([path, body]) => [path, reply(path, body)])
);
handlers.read = http.post(`${CHAT_SERVICE_ORIGIN}/threads/:id/read`, () => new HttpResponse(null, { status: 204 }));
handlers.warmup = http.post(`${CHAT_SERVICE_ORIGIN}/warmup`, () => HttpResponse.json({}));
handlers.wake = http.post(`${CHAT_SERVICE_ORIGIN}/agent-computer/wake`, () =>
  HttpResponse.json(ANSWERS['/agent-computer'] as Record<string, unknown>)
);
handlers.sample = http.get(`${CHAT_SERVICE_ORIGIN}/files/download-url`, () =>
  HttpResponse.json({ url: `${CHAT_SERVICE_ORIGIN}/files/sample.txt` })
);
