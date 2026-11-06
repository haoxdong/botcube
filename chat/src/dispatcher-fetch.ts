import { fetch, type Dispatcher, type RequestInit } from 'undici';

export async function dispatcherFetch(url: string, init: RequestInit & { dispatcher: Dispatcher }): Promise<Response> {
  const response = await fetch(url, init);
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  const body = reader ? new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel(reason: unknown) {
      return reader.cancel(reason);
    },
  }) : null;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
  });
}
