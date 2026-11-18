export function startChunkRecovery(): void {
  const recover = (event: ErrorEvent | PromiseRejectionEvent) => {
    const error: unknown = 'reason' in event ? event.reason : event.error;
    if (!(error instanceof Error) || error.name !== 'ChunkLoadError') return;

    try {
      if (window.sessionStorage.getItem('botcube:chunk-recovery')) return;
      window.sessionStorage.setItem('botcube:chunk-recovery', 'attempted');
    } catch {
      // Without a persistent marker, reloading could loop. The original error remains visible.
      return;
    }
    window.location.reload();
  };
  window.addEventListener('error', recover);
  window.addEventListener('unhandledrejection', recover);
}
