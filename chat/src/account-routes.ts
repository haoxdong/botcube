import { Hono } from 'hono';
import { agentIdentity, soul, type AgentDocuments, type AgentDocumentSet } from './agent-documents.js';
import type { Requester, RequesterSource } from './requester.js';
import { HttpError } from './http-error.js';
import { isRecord } from './payload.js';
import { picture, pictureUrl } from './pictures.js';
import { accountModelList, namedModel, type ModelSource } from './models.js';
import { isScheduledInstant } from './schedule-time.js';
import type { ScheduledTasks, ScheduledTask, ScheduledTaskDefinition, TaskChanges } from './scheduled-tasks.js';
import type { SessionMetadata } from './session-metadata.js';
import { type sessionOperations } from './sessions.js';

const TASK_FIELDS = ['title', 'prompt', 'schedule', 'timezone'] as const;

function taskDefinition(body: unknown, required: boolean): TaskChanges {
  if (!isRecord(body)) throw new HttpError(422, 'Expected a JSON object');
  const definition: TaskChanges = {};
  for (const field of TASK_FIELDS) {
    const value = body[field];
    if (value === undefined && !required) continue;
    if (typeof value !== 'string' || !value.trim()) throw new HttpError(422, `${field} is required`);
    definition[field] = value.trim();
  }
  if ('maxRuns' in body || 'count' in body) throw new HttpError(422, 'Use startDate and endDate instead of a run count');
  for (const field of ['startDate', 'endDate'] as const) {
    const value = taskInstant(body[field], field, required);
    if (value !== undefined) definition[field] = value;
  }
  if (definition.schedule?.startsWith('at(') && (typeof definition.startDate === 'string' || typeof definition.endDate === 'string')) throw new HttpError(422, 'One-off tasks do not support startDate or endDate');
  if (typeof definition.startDate === 'string' && typeof definition.endDate === 'string' && Date.parse(definition.endDate) <= Date.parse(definition.startDate)) {
    throw new HttpError(422, 'endDate must be after startDate');
  }

  return definition;
}

function taskInstant(value: unknown, field: 'startDate' | 'endDate', required: boolean): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && !required) return null;
  if (!isScheduledInstant(value)) throw new HttpError(422, `${field} must be an ISO instant with a timezone`);
  return new Date(value).toISOString();
}

export function accountRoutes(
  bot: RequesterSource & ModelSource & { readonly agentDocuments: AgentDocumentSet },
  sessionMetadata: SessionMetadata,
  agentDocuments: AgentDocuments,
  sessions: ReturnType<typeof sessionOperations>,
  scheduledTasks: ScheduledTasks | null,
  online: boolean,
) {
  const app = new Hono<{ Variables: { requester: Requester; auth: [number, number] } }>();
  app.use('*', async (c, next) => {
    const started = performance.now();
    c.set('requester', await bot.requester(c));
    c.set('auth', [started, performance.now()]);
    await next();
  });
  const documentsOf = (owner: string) => agentDocuments.get(owner, bot.agentDocuments);

  app.get('/agent', async (c) => {
    const { owner } = c.var.requester;
    const [{ agentIdentity: identity }, agentPicture] = await Promise.all([documentsOf(owner), agentDocuments.picture(owner)]);
    return c.json({
      name: identity.name,
      avatar: identity.avatar,
      picture: agentPicture && pictureUrl(agentPicture),
      status: online ? 'online' : 'offline',
    });
  });

  app.put('/agent/picture', async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as { picture?: unknown } | undefined;
    await agentDocuments.savePicture(c.var.requester.owner, picture(body?.picture, "The agent's picture"));
    return c.body(null, 204);
  });

  app.delete('/agent/picture', async (c) => {
    await agentDocuments.savePicture(c.var.requester.owner, null);
    return c.body(null, 204);
  });

  app.get('/agent/models', async (c) => c.json({ models: await accountModelList(bot, c.var.requester, { refresh: true }) }));

  app.get('/agent/identity', async (c) => c.json((await documentsOf(c.var.requester.owner)).agentIdentity));

  app.put('/agent/identity', async (c) => {
    const content = agentIdentity(await c.req.json().catch(() => undefined));
    await agentDocuments.save(c.var.requester.owner, { document: 'agentIdentity', content });
    return c.body(null, 204);
  });

  app.get('/agent/soul', async (c) => c.json({ content: (await documentsOf(c.var.requester.owner)).soul }));

  app.put('/agent/soul', async (c) => {
    const body = (await c.req.json().catch(() => undefined)) as { content?: unknown } | undefined;
    await agentDocuments.save(c.var.requester.owner, { document: 'soul', content: soul(body?.content) });
    return c.body(null, 204);
  });

  app.post('/agent/extracted-memory/forget', async (c) => {
    const { owner, anonymous } = c.var.requester;
    if (anonymous) throw new HttpError(403, 'Sign in to use Forget');
    sessions.startForgettingExtractedMemory(owner);
    return c.body(null, 202);
  });

  app.post('/threads', async (c) => c.json(await sessions.createSideChat(c.var.requester.owner), 201));
  app.get('/threads', async (c) => c.json(await sessions.chatList(c.var.requester.owner)));

  app.get('/main-chat', async (c) => {
    const { auth: [started, authenticated], requester: { owner } } = c.var;
    const transcript = await sessions.mainChat(owner, c.req.query('before'));
    const replayed = performance.now();
    const response = c.json(transcript);
    const encoded = performance.now();
    const durations = {
      auth: authenticated - started,
      history: replayed - authenticated,
      json: encoded - replayed,
      total: encoded - started,
    };
    response.headers.set('Server-Timing', Object.entries(durations).map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`).join(', '));
    return response;
  });

  app.get('/activity', async (c) => c.json({ tasks: await sessions.activity(c.var.requester.owner) }));

  const tasks = (): ScheduledTasks => {
    if (scheduledTasks === null) throw new HttpError(503, 'Scheduled tasks are not configured');
    return scheduledTasks;
  };

  const opened = async (owner: string, sessionId: string | undefined) => sessionId !== undefined && (await sessionMetadata.get(owner, sessionId)) !== null;
  const taskView = async (owner: string, { sideChatId, ...task }: ScheduledTask) => ({
    ...task, sideChat: await opened(owner, sideChatId) ? sideChatId : await opened(owner, task.id) ? task.id : null,
  });

  app.get('/scheduled-tasks', async (c) => {
    const { owner } = c.var.requester;
    return c.json({ tasks: await Promise.all((await tasks().list(owner)).map((task) => taskView(owner, task))) });
  });

  app.post('/scheduled-tasks', async (c) => {
    const requester = c.var.requester;
    const { owner } = requester;
    const scheduled = tasks();
    const body: unknown = await c.req.json().catch(() => undefined);
    const definition = taskDefinition(body, true) as ScheduledTaskDefinition;
    const model = isRecord(body) ? body.model : undefined;
    if (model !== undefined) definition.model = (await namedModel(bot, requester, model)).key;
    const proposalId = (body as Record<string, unknown>).proposalId;
    if (typeof proposalId !== 'string' || !proposalId.trim()) throw new HttpError(422, 'proposalId is required');
    const { task, created } = await scheduled.create(owner, proposalId, definition);
    return c.json(await taskView(owner, task), created ? 201 : 200);
  });

  app.patch('/scheduled-tasks/:id', async (c) => {
    const requester = c.var.requester;
    const { owner } = requester;
    const body: unknown = await c.req.json().catch(() => undefined);
    const changes = taskDefinition(body, false);
    const paused = isRecord(body) ? body.paused : undefined;
    if (paused !== undefined && typeof paused !== 'boolean') throw new HttpError(422, 'paused must be true or false');
    const model = isRecord(body) ? body.model : undefined;
    if (model !== undefined) changes.model = (await namedModel(bot, requester, model)).key;
    const updated = await tasks().update(owner, c.req.param('id'), paused === undefined ? changes : { ...changes, paused });
    if (updated === null) throw new HttpError(404, 'Scheduled task not found');
    return c.json(await taskView(owner, updated));
  });

  app.delete('/scheduled-tasks/:id', async (c) => {
    if (!(await tasks().delete(c.var.requester.owner, c.req.param('id')))) throw new HttpError(404, 'Scheduled task not found');
    return c.body(null, 204);
  });

  app.post('/threads/:id/read', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const runId = isRecord(body) ? body.runId : undefined;
    const completedAt = isRecord(body) ? body.completedAt : undefined;
    let observed: string | { runId: string };
    if (runId !== undefined) {
      if (typeof runId !== 'string' || !runId.trim()) throw new HttpError(422, 'runId must be a non-empty string');
      observed = { runId };
    } else {
      if (typeof completedAt !== 'string' || !Number.isFinite(Date.parse(completedAt))) throw new HttpError(422, 'completedAt must be a timestamp');
      observed = completedAt;
    }
    await sessionMetadata.markRead(c.var.requester.owner, c.req.param('id'), observed);
    return c.body(null, 204);
  });

  app.get('/threads/:id', async (c) => c.json(await sessions.replay(c.var.requester.owner, c.req.param('id'), c.req.query('before'))));

  app.patch('/threads/:id', async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const title = isRecord(body) ? body.title : undefined;
    if (typeof title !== 'string' || !title.trim()) throw new HttpError(422, 'title must be a non-empty string');
    return c.json(await sessions.renameSideChat(c.var.requester.owner, c.req.param('id'), title));
  });

  // Fence the Session at once, then purge its events in the background (ADR 0067 §6).
  app.delete('/threads/:id', async (c) => {
    await sessions.removeSideChat(c.var.requester.owner, c.req.param('id'));
    return c.body(null, 204);
  });
  return app;
}
