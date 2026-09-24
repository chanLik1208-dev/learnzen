/**
 * A server-sent-events client built on fetch.
 *
 * `EventSource` cannot send an Authorization header — it only carries cookies
 * — and the alternative, putting the access token in the query string, writes
 * a credential into every proxy log and browser history entry. So the stream
 * is read by hand. What EventSource would have given for free and is
 * reimplemented here: automatic reconnection, with a backoff so a server that
 * is down is not hammered by every device in the room at once.
 */
import { api } from './api.js';

const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;

export function openStream(path, { onEvent, onStatus, getToken }) {
  let controller = null;
  let closed = false;
  let retry = INITIAL_RETRY_MS;
  let timer = null;

  const setStatus = (status, detail) => onStatus?.(status, detail);

  async function connect() {
    if (closed) return;
    controller = new AbortController();
    try {
      const res = await fetch(path, {
        headers: { authorization: `Bearer ${getToken()}` },
        signal: controller.signal,
      });

      if (res.status === 401) {
        // The access token is short-lived; renew once and come straight back
        // rather than treating it as the stream having failed.
        await api.refresh();
        throw new Error('token renewed');
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        let message = `連線失敗（${res.status}）`;
        try { message = JSON.parse(body).error.message ?? message; } catch { /* not json */ }
        // A refusal will not become an acceptance by retrying.
        if (res.status === 403 || res.status === 404) {
          setStatus('refused', message);
          closed = true;
          return;
        }
        throw new Error(message);
      }

      setStatus('open');
      retry = INITIAL_RETRY_MS;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Frames are separated by a blank line; anything after the last one
        // is a partial frame and waits for the next chunk.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const name = frame.match(/^event: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.*)$/m)?.[1];
          if (!name || data === undefined) continue;
          try { onEvent(name, JSON.parse(data)); } catch { /* malformed frame */ }
        }
      }
      throw new Error('stream ended');
    } catch (err) {
      if (closed || err.name === 'AbortError') return;
      setStatus('reconnecting', err.message);
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, MAX_RETRY_MS);
    }
  }

  connect();

  return () => {
    closed = true;
    clearTimeout(timer);
    controller?.abort();
  };
}
