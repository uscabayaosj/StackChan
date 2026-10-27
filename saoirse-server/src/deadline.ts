/** Turn an abort caused by our own deadline into a readable error; leave caller aborts and other errors alone. */
function relabel(err: unknown, label: string, ms: number, timeout: AbortSignal, signal: AbortSignal): unknown {
  return timeout.aborted && !signal.aborted ? new Error(`${label} timed out after ${ms} ms`) : err;
}

/**
 * Run `call` with `signal` plus a deadline of `ms`. The call receives the combined signal (so a fetch
 * is cancelled), and the promise settles on abort even if the call ignores its signal.
 */
export async function callWithDeadline<T>(
  label: string, ms: number, signal: AbortSignal, call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(ms);
  const combined = AbortSignal.any([signal, timeout]);
  let onAbort = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(combined.reason);
      if (combined.aborted) { onAbort(); return; }
      combined.addEventListener('abort', onAbort, { once: true });
      call(combined).then(resolve, reject);
    });
  } catch (err) {
    throw relabel(err, label, ms, timeout, signal);
  } finally {
    combined.removeEventListener('abort', onAbort);
  }
}

/**
 * Stream `produce` with `signal` plus a deadline of `ms` on the producer. The producer is drained
 * eagerly into a buffer, so the deadline bounds the upstream call (time to receive the whole
 * response), not how slowly the consumer plays the result out (TTS pacing, sentences spoken while
 * the LLM stream is open). Stopping early aborts the producer's signal.
 */
export async function* streamWithDeadline<T>(
  label: string, ms: number, signal: AbortSignal, produce: (signal: AbortSignal) => AsyncIterable<T>,
): AsyncGenerator<T> {
  const timeout = AbortSignal.timeout(ms);
  const stop = new AbortController();
  const combined = AbortSignal.any([signal, timeout, stop.signal]);
  const buf: T[] = [];
  let done = false;
  let failed = false;
  let error: unknown;
  let wake: (() => void) | null = null;
  const notify = () => { const w = wake; wake = null; w?.(); };
  combined.addEventListener('abort', notify, { once: true });
  void (async () => {
    try {
      for await (const v of produce(combined)) { buf.push(v); notify(); }
    } catch (err) {
      failed = true;
      error = err;
    } finally {
      done = true;
      notify();
    }
  })();
  try {
    while (true) {
      // An abort before the producer finished wins even if it ignores its signal.
      if (!done && combined.aborted) throw relabel(combined.reason, label, ms, timeout, signal);
      if (buf.length > 0) { yield buf.shift()!; continue; }
      if (done) break;
      await new Promise<void>(r => { wake = r; });
    }
    if (failed) throw relabel(error, label, ms, timeout, signal);
  } finally {
    combined.removeEventListener('abort', notify);
    stop.abort();
  }
}
