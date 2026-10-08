export function startHeartbeat(
  callback: (signal: AbortSignal) => Promise<void>,
  intervalMs = 30000,
  timeoutMs = 15000,
): { signal: AbortSignal; stop: () => Promise<void> } {
  const work = new AbortController();
  const active = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let pending: Promise<void> = Promise.resolve();

  const schedule = () => {
    timer = setTimeout(() => {
      pending = Promise.resolve().then(() =>
        callback(
          AbortSignal.any([active.signal, AbortSignal.timeout(timeoutMs)]),
        )
      ).catch((error) => {
        if (!stopped) work.abort(error);
      }).finally(() => {
        if (!stopped && !work.signal.aborted) schedule();
      });
    }, intervalMs);
  };
  schedule();

  return {
    signal: work.signal,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      active.abort();
      await pending;
    },
  };
}
