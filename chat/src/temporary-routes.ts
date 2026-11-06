import type { Hono } from 'hono';
import { RunAgentInputSchema } from '@ag-ui/core/schemas';
import { HttpError, type ChatServiceCartridge } from './cartridge.js';
import { TemporaryChats } from './temporary-chat.js';
import { relayTurn, stopTurn } from './turn-stream.js';
import type { TurnQuota } from './turn-quota.js';
import type { Upstream } from './upstream.js';

const HEADER = 'x-botcube-temporary-chat';

export function temporaryRoutes(app: Hono, secret: string, cartridge: ChatServiceCartridge, upstream: Upstream | null, quota: TurnQuota | null) {
  const chats = new TemporaryChats(secret);
  app.post('/temporary-chats', async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(await chats.issue());
  });
  app.post('/', async (c, next) => {
    const token = c.req.header(HEADER);
    if (token === undefined) return next();
    const parsed = RunAgentInputSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) return c.json({ detail: parsed.error.issues }, 422);
    const input = parsed.data;
    if (!await chats.owns(token, input.threadId)) throw new HttpError(401, 'Invalid temporary chat capability');
    if (upstream === null) throw new HttpError(503, 'The temporary chat Runtime is not configured');
    const requested = input.forwardedProps?.model;
    const model = requested === undefined ? cartridge.models[0] : cartridge.models.find(({ key }) => key === requested);
    if (model === undefined) throw new HttpError(422, 'The model is not available to temporary chats');
    await quota?.admit(`temporary:${input.threadId}`, c.req.header('cf-connecting-ip'));
    const forwardedProps = {
      temporary: true, model: model.key,
      ...(typeof input.forwardedProps?.effort === 'string' ? { effort: input.forwardedProps.effort } : {}),
      ...(input.forwardedProps?.opening === true ? { opening: true } : {}),
      ...cartridge.agentDocuments,
    };
    return relayTurn(upstream, {
      body: JSON.stringify({ ...input, forwardedProps }), sessionId: input.threadId,
      accept: c.req.header('accept'), credentials: [token], initialMessages: input.messages,
      saveAgentDocumentEdit: async () => { throw new HttpError(502, 'A temporary chat cannot edit saved agent documents'); },
      finished: () => undefined, failed: () => undefined, ended: async () => undefined,
    });
  });
  app.post('/threads/:id/stop', async (c, next) => {
    const token = c.req.header(HEADER);
    if (token === undefined) return next();
    const sessionId = c.req.param('id');
    if (!await chats.owns(token, sessionId)) throw new HttpError(401, 'Invalid temporary chat capability');
    if (upstream === null) throw new HttpError(503, 'The temporary chat Runtime is not configured');
    const body: unknown = await c.req.json().catch(() => undefined);
    const runId = typeof body === 'object' && body !== null && 'runId' in body ? body.runId : undefined;
    if (typeof runId !== 'string' || !runId) throw new HttpError(422, 'runId is required');
    await stopTurn(upstream, JSON.stringify({ threadId: sessionId, runId, messages: [], tools: [], context: [], state: {}, forwardedProps: { temporary: true, stop: true } }), sessionId);
    return c.body(null, 204);
  });
}
