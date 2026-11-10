import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultFile = fileURLToPath(new URL('../../var/events/history.jsonl', import.meta.url));
const keyOf = event => event.metadata?.uid || `${event.metadata?.namespace || ''}/${event.metadata?.name || ''}`;
const observedAt = event => event.series?.lastObservedTime || event.lastTimestamp || event.eventTime || event.metadata?.creationTimestamp;

export function createEventHistory({ kubernetes, file = process.env.K8S_EVENT_HISTORY_FILE || defaultFile, interval = 180_000, logger } = {}) {
  const events = new Map();
  let queue = Promise.resolve();
  let polling = false;
  let started = false;
  async function load() {
    try {
      const contents = await readFile(file, 'utf8');
      for (const line of contents.split('\n')) {
        if (!line) continue;
        try { const saved = JSON.parse(line); const event = saved.event || saved; if (keyOf(event)) events.set(keyOf(event), event); } catch {}
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const result = await kubernetes.request('/api/v1/events');
      const items = result.items || [];
      for (const event of items) {
        const key = keyOf(event);
        if (!key) continue;
        const previous = events.get(key);
        if (previous && JSON.stringify(previous) === JSON.stringify(event)) continue;
        events.set(key, event);
        const line = JSON.stringify({ observedAt: new Date().toISOString(), event });
        queue = queue.then(async () => {
          await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          await appendFile(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
        }).catch(error => { logger?.error?.(error, { operation: 'event_history_write' }); });
      }
      await queue;
    } catch (error) { logger?.error?.(error, { operation: 'event_history_poll' }); }
    finally { polling = false; }
  }
  async function start() {
    if (started) return;
    started = true;
    try { await load(); } catch (error) { logger?.error?.(error, { operation: 'event_history_load' }); }
    const timer = setInterval(poll, interval);
    timer.unref?.();
  }
  return { start, list: () => [...events.values()].sort((a, b) => (Date.parse(observedAt(b)) || 0) - (Date.parse(observedAt(a)) || 0)) };
}
