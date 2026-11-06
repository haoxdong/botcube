export function installBrowserLocks(): void {
  let held: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, options: unknown, granted?: () => unknown) => {
        const callback = typeof options === 'function' ? options as () => unknown : granted;
        if (!callback) throw new Error('A Web Lock callback is required');
        const result = held.then(callback);
        held = result.catch(() => undefined);
        return result;
      },
    },
  });
}
