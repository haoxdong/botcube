import { assertIdleContinuable } from './sessions.js';
import type { Hono } from 'hono';
import { z } from 'zod';
import { HttpError, type ChatServiceCartridge } from './cartridge.js';
import type { SessionMetadata } from './session-metadata.js';
import type { sessionLifecycle } from './session-lifecycle.js';
import { readTurnEvents } from './turn-events.js';

const steeringMessage = z.object({ id: z.string().min(1), content: z.string().min(1) });
const steeringReceipt = z.object({ value: z.object({ accepted: z.boolean() }) });

export function steeringRoutes(
  app: Hono,
  cartridge: ChatServiceCartridge,
  sessionMetadata: SessionMetadata,
  upstream: ReturnType<typeof sessionLifecycle> | null,
) {
  app.post('/threads/:id/steer', async (c) => {
    if (upstream === null) throw new HttpError(503, 'Harness is not configured');
    const { owner } = await cartridge.requester(c);
    const sessionId = c.req.param('id');
    const parsed = steeringMessage.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) throw new HttpError(422, 'A steering message requires id and content');
    const metadata = await sessionMetadata.get(owner, sessionId);
    if (metadata === null) throw new HttpError(404, 'Session not found');
    if (metadata.turn_preparing === true) return c.json({ accepted: false });
    assertIdleContinuable(metadata);
    const complete = await sessionMetadata.beginDispatch(owner, sessionId);
    const response = await upstream.invokeRegistered(JSON.stringify({
      threadId: sessionId, runId: parsed.data.id,
      messages: [{ ...parsed.data, role: 'user' }],
      tools: [], context: [], state: {},
      forwardedProps: { steering: true, sessionUserId: metadata.filing_user_id },
    }), complete.session ?? metadata, complete);
    const text = await response.text();
    if (!response.ok) throw new HttpError(502, `Steering failed: HTTP ${response.status}`);
    const events = await readTurnEvents(text, []);
    const receipt = steeringReceipt.safeParse(events?.find((event) => event.type === 'CUSTOM' && event.name === 'STEERING_ACCEPTED'));
    if (!receipt.success) throw new HttpError(502, 'Harness did not acknowledge steering');
    return c.json(receipt.data.value);
  });
}
