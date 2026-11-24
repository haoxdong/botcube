import pLimit from 'p-limit';
import { Agent, type Dispatcher } from 'undici';
import { awsFetch } from './aws.js';
import { dispatcherFetch } from './dispatcher-fetch.js';
import { HttpError } from './http-error.js';
import { isRecord } from './payload.js';
import contract from '../../harness/deepagents/src/botcube_harness_deepagents/session-api.json' with { type: 'json' };

type Operations = typeof contract.operations;
type Operation = keyof Operations;
type ErrorCode = keyof typeof contract.errors;

/** Contract arrays use an exemplar item, or an empty array for opaque items. A trailing ? marks an optional object field. */
type Shape<T> =
  T extends readonly (infer Item)[] ? ([Item] extends [never] ? unknown : Shape<Item>)[] :
  T extends object ? {
    [K in keyof T as K extends `${string}?` ? never : K]: Shape<T[K]>;
  } & {
    [K in keyof T as K extends `${infer Optional}?` ? Optional : never]?: Shape<T[K]>;
  } : T;

type Args<O extends Operation> = Shape<Operations[O]['required']> & Partial<Shape<Operations[O]['optional']>>;
type Result<O extends Operation> = Shape<Operations[O]['result']> & Partial<Shape<Operations[O]['optionalResult']>>;
export type ScheduledRunCard = NonNullable<Args<'post'>['scheduledRun']> & {
  status: 'done' | 'failed' | 'sign-in' | 'skipped';
};

export type SessionApiFor<O extends Operation> =
  (operation: O, args: Args<NoInfer<O>>, leaseExpiresAt?: O extends 'post' ? number : never) => Promise<Result<O>>;
export type SessionApi = <O extends Operation>(...call: Parameters<SessionApiFor<O>>) => Promise<Result<O>>;

/** Where the session API runs: the deployed function, invoked with SigV4, or its local plain-HTTP mode. */
export type SessionApiConfig =
  | { functionArn: string; region: string; endpoint?: string }
  | { localUrl: string }
  | null;

export class SessionApiError extends HttpError {
  constructor(status: number, detail: string, readonly sessionCode?: ErrorCode, options?: ErrorOptions) {
    super(status, detail, sessionCode !== undefined && contract.errors[sessionCode].publicCode ? sessionCode : undefined);
    if (options !== undefined) this.cause = options.cause;
  }
}

// Match the maximum provisioned concurrency of the Session API alias.
const SESSION_API_CALLS_AT_ONCE = 5;

function timeoutSeconds(operation: Operation): number {
  const deadline = contract.operations[operation].deadline;
  if (!Object.hasOwn(contract.deadlines, deadline)) throw new Error(`Unknown Session API deadline: ${deadline}`);
  return contract.deadlines[deadline as keyof typeof contract.deadlines] + contract.clientGraceSeconds;
}

export function sessionApi(config: SessionApiConfig): SessionApi {
  const limit = pLimit(SESSION_API_CALLS_AT_ONCE);
  // Undici defaults to 300 s for headers and body, shorter than a purge.
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  return (operation, args, postLeaseExpiresAt) =>
    limit(async () => {
      if (config === null) throw new SessionApiError(503, 'The session API is not configured');
      const timeout = timeoutSeconds(operation);
      if (postLeaseExpiresAt !== undefined && Date.now() + (timeout + contract.deadlines.invocation) * 1000 >= postLeaseExpiresAt) {
        throw new SessionApiError(503, 'Scheduled post lease expires before Session API can finish');
      }
      const { status, body } = await invoke(config, { ...args, operation }, timeout, dispatcher);
      return sessionApiResult(operation, status, body);
    });
}

function matchesShape(shape: unknown, value: unknown): boolean {
  if (Array.isArray(shape)) {
    return Array.isArray(value) && (shape.length === 0 || value.every((item) => matchesShape(shape[0], item)));
  }
  if (isRecord(shape)) {
    return isRecord(value) && Object.entries(shape).every(([key, field]) => matchesShape(field, value[key]));
  }
  return typeof value === typeof shape;
}

function sessionApiResult<O extends Operation>(operation: O, status: number, body: unknown): Result<O> {
  const spec = contract.operations[operation];
  if (status !== 200) throw sessionApiFailure(spec.errors, status, body);
  if (!isRecord(body) || !matchesShape(spec.result, body) ||
      !Object.entries(spec.optionalResult).every(([key, shape]) => !Object.hasOwn(body, key) || matchesShape(shape, body[key]))) {
    throw new SessionApiError(503, operation === 'get' ? 'Session API returned an invalid replay result' : 'Session API returned an invalid result');
  }
  return body as Result<O>;
}

function sessionApiFailure(allowed: readonly string[], status: number, body: unknown): SessionApiError {
  const payload = isRecord(body) ? body : {};
  const code = payload.code;
  if (typeof code === 'string' && allowed.includes(code) && Object.hasOwn(contract.errors, code)) {
    const sessionCode = code as ErrorCode;
    const error = contract.errors[sessionCode];
    if (error.status === status) {
      return error.publicCode || status === 404
        ? new SessionApiError(status, String(payload.error), sessionCode)
        : new SessionApiError(503, `Session API returned HTTP ${status}`, sessionCode, { cause: body });
    }
  }
  if (status === 404) return new SessionApiError(404, String(payload.error));
  return new SessionApiError(503, `Session API returned HTTP ${status}`, undefined, { cause: body });
}

async function invoke(
  config: NonNullable<SessionApiConfig>,
  event: { operation: Operation },
  seconds: number,
  dispatcher: Dispatcher,
): Promise<{ status: number; body: unknown }> {
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(seconds * 1000),
    dispatcher,
  };
  let response: Response;
  let text: string;
  try {
    response = 'functionArn' in config
      ? await awsFetch('lambda', config.region, lambdaInvokeUrl(config), init)
      : await dispatcherFetch(`${config.localUrl}/invocations`, init);
    text = await response.text();
  } catch (error) {
    throw new SessionApiError(503, 'Session API request failed', undefined, { cause: error });
  }
  return 'functionArn' in config
    ? lambdaResult(response, text)
    : { status: response.status, body: jsonBody(text, `Session API returned HTTP ${response.status}`) };
}

function lambdaInvokeUrl({ functionArn, region, endpoint }: Extract<SessionApiConfig, { functionArn: string }>): string {
  const baseUrl = (endpoint || `https://lambda.${region}.amazonaws.com`).replace(/\/+$/, '');
  return `${baseUrl}/2015-03-31/functions/${encodeURIComponent(functionArn)}/invocations`;
}

function lambdaResult(response: Response, text: string): { status: number; body: unknown } {
  if (!response.ok) {
    throw new SessionApiError(503, `Session API request failed: Lambda Invoke returned HTTP ${response.status}`, undefined, { cause: text });
  }
  if (response.headers.has('x-amz-function-error')) {
    throw new SessionApiError(503, 'Session API function failed', undefined, { cause: text });
  }
  const result = jsonBody(text, 'Session API function returned a result') as { statusCode: number; body: unknown };
  return { status: result.statusCode, body: result.body };
}

/** A session API answer's JSON; anything else is a 503 naming what answered. */
function jsonBody(text: string, answered: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SessionApiError(503, `${answered} with a non-JSON body`);
  }
}
