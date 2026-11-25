import { delay, http, HttpResponse } from 'msw';
import { CHAT_SERVICE_ORIGIN } from '../.storybook/chat-origin';

export function reply(path: string, body: unknown, status = 200) {
  return http.get(`${CHAT_SERVICE_ORIGIN}${path}`, () =>
    HttpResponse.json(body as Record<string, unknown>, { status })
  );
}

export const mainChat = (messages: unknown[], id = 'main-shots') => ({
  '/main-chat': reply('/main-chat', { id, messages }),
});

export function chatHandlers(answers: Record<string, unknown>) {
  return {
    ...Object.fromEntries(Object.entries(answers).map(([path, body]) => [path, reply(path, body)])),
    read: http.post(`${CHAT_SERVICE_ORIGIN}/threads/:id/read`, () => new HttpResponse(null, { status: 204 })),
    warmup: http.post(`${CHAT_SERVICE_ORIGIN}/warmup`, () => HttpResponse.json({})),
    wake: http.post(`${CHAT_SERVICE_ORIGIN}/agent-computer/wake`, () =>
      HttpResponse.json(answers['/agent-computer'] as Record<string, unknown>)
    ),
  };
}

const FILES_UPLOAD = 'https://files.test/upload';

/**
 * The Chat Service's upload URLs for files attached in the composer, and the storage's PUTs to them: a `pending` name
 * never gets its URL, so its chip stays uploading, and a `refused` one gets the Chat Service's reason. A file uploaded
 * is kept, and its download URL serves it back.
 */
export function filesUpload({ pending = [], refused = [] }: { pending?: string[]; refused?: string[] } = {}) {
  const kept = new Map<string, Blob>();
  const uploads = new Map<string, Map<number, Blob>>();
  return {
    uploadUrl: http.post(`${CHAT_SERVICE_ORIGIN}/files/upload-url`, async ({ request }) => {
      const { name } = (await request.json()) as { name: string };
      if (pending.includes(name)) await delay('infinite');
      if (refused.includes(name)) return HttpResponse.json({ detail: 'Files are not configured' }, { status: 503 });
      return HttpResponse.json({ url: `${FILES_UPLOAD}/${encodeURIComponent(name)}?t=storybook` });
    }),
    uploadPut: http.put(`${FILES_UPLOAD}/:name`, async ({ request, params }) => {
      const name = decodeURIComponent(String(params.name));
      const query = new URL(request.url).searchParams;
      const offset = Number(query.get('offset'));
      if (query.has('done')) {
        if (kept.has(name)) return new HttpResponse('A file with this name is already in Files', { status: 409 });
        const file = new Blob([...(uploads.get(name) ?? [])].sort(([a], [b]) => a - b).map(([, blob]) => blob));
        if (file.size !== Number(query.get('done'))) return new HttpResponse('Incomplete upload', { status: 409 });
        kept.set(name, file);
        uploads.delete(name);
      } else {
        const chunks = offset === 0 ? new Map<number, Blob>() : uploads.get(name) ?? new Map<number, Blob>();
        chunks.set(offset, await request.blob());
        uploads.set(name, chunks);
      }
      return new HttpResponse(null, { status: 200 });
    }),
    downloadUrl: http.get(`${CHAT_SERVICE_ORIGIN}/files/download-url`, ({ request }) => {
      const name = new URL(request.url).searchParams.get('name') ?? '';
      const file = kept.get(name);
      if (!file) return HttpResponse.json({ detail: `No file named ${name}` }, { status: 404 });
      return HttpResponse.json({ url: URL.createObjectURL(file) });
    }),
  };
}
