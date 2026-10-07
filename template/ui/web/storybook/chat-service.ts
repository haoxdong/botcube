import { http, HttpResponse } from 'msw';
import { CHAT_SERVICE_ORIGIN } from '../../../../ui/web/.storybook/chat-origin';
import { TEMPLATE_IDENTITY } from '../../../identity';

export const unhandledChatRequests: string[] = [];

const now = Date.parse('2026-10-06T05:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const DATA_CALL = 'call-data';
const messages = [
  { id: 'm0', role: 'user', content: 'What is on the template site?' },
  {
    id: 'm1',
    role: 'assistant',
    content: '',
    toolCalls: [
      {
        id: DATA_CALL,
        type: 'function',
        function: { name: 'execute', arguments: JSON.stringify({ command: 'template-cli data' }) },
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
    content: 'The template site lists one item: **Sample item**, with a value of **42**.',
  },
];
/** The fake site's login page, as the Agent Computer's browser shows it. */
const SCREEN = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#fff"/><text x="16" y="52" font-family="Times New Roman, serif" font-size="32" font-weight="bold" fill="#000">Template site</text><rect x="16" y="76" width="64" height="24" rx="3" fill="#efefef" stroke="#767676"/><text x="48" y="93" font-family="Arial, sans-serif" font-size="13" text-anchor="middle" fill="#000">Sign in</text></svg>'
)}`;

export const SESSION = { accountId: 'template-account', signInNeeded: false };
const ANSWERS: Record<string, unknown> = {
  '/account/session': SESSION,
  '/account/sign-ins': { signIns: [{ site: 'template-site', status: 'linked' }] },
  '/agent/identity': {
    name: TEMPLATE_IDENTITY.name,
    character: 'A template agent',
    vibe: 'Plain and friendly',
    avatar: TEMPLATE_IDENTITY.avatar,
  },
  '/agent/soul': { content: 'Be helpful and honest. Say so when you do not know.' },
  '/agent/memory': { lines: [] },
  '/agent-computer': { state: 'asleep', screenshot: null },
  '/main-chat': { id: 'main-shots', messages },
  '/threads': {
    threads: [
      { id: 't1', title: 'Read the template site', updatedAt: ago(30) },
      { id: 't2', title: 'say hi', updatedAt: ago(3000) },
    ],
  },
  '/agent': { name: TEMPLATE_IDENTITY.name, avatar: TEMPLATE_IDENTITY.avatar, picture: null, status: 'online' },
  '/agent/models': { models: [{ key: 'echo', label: 'Echo', provider: 'echo' }] },
  '/scheduled-tasks': { tasks: [] },
  '/activity': {
    tasks: [{ title: 'Read the template site', summary: 'Read one item from the template site', completedAt: ago(30) }],
  },
};

export function reply(path: string, body: unknown, status = 200) {
  return http.get(`${CHAT_SERVICE_ORIGIN}${path}`, () =>
    HttpResponse.json(body as Record<string, unknown>, { status })
  );
}

const AWAKE = { state: 'awake', browserSessionId: 'browser-shot', control: 'agent', screenshot: null };

/** The awake computer's view: its state, wake, and the browser's image. */
export const awakeComputer = {
  '/agent-computer': reply('/agent-computer', AWAKE),
  wake: http.post(`${CHAT_SERVICE_ORIGIN}/agent-computer/wake`, () => HttpResponse.json(AWAKE)),
  view: http.get(`${CHAT_SERVICE_ORIGIN}/agent-computer/view`, async () =>
    new HttpResponse(await (await fetch(SCREEN)).blob(), { headers: { 'content-type': 'image/svg+xml' } })
  ),
};

export const handlers = Object.fromEntries(
  Object.entries(ANSWERS).map(([path, body]) => [path, reply(path, body)])
);
handlers.warmup = http.post(`${CHAT_SERVICE_ORIGIN}/warmup`, () => HttpResponse.json({}));
handlers.wake = http.post(`${CHAT_SERVICE_ORIGIN}/agent-computer/wake`, () =>
  HttpResponse.json(ANSWERS['/agent-computer'] as Record<string, unknown>)
);
handlers.sample = http.get(`${CHAT_SERVICE_ORIGIN}/files/download-url`, () =>
  HttpResponse.json({ url: `${CHAT_SERVICE_ORIGIN}/files/sample.txt` })
);
