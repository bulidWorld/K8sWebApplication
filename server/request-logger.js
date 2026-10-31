import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { redactLog } from './expansion-logs.js';

const context = new AsyncLocalStorage();
export function createRequestLogger({ directory = process.env.K8S_LOG_DIR || '/var/service/kubescope/log', secrets = [] } = {}) {
  let queue = Promise.resolve();
  function write(event, details = {}) {
    const record = { time: new Date().toISOString(), event, ...context.getStore(), ...details };
    // Never log headers, request/response bodies or query strings.
    const sanitize = value => {
      if (typeof value === 'string') return redactLog(value, secrets).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]');
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
      return value;
    };
    const line = JSON.stringify(sanitize(record));
    const file = path.join(directory, `${record.time.slice(0, 10)}.jsonl`);
    queue = queue.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(file, line + '\n', { mode: 0o600 });
    }).catch(error => console.error('请求日志写入失败:', error.code || error.name));
  }
  return {
    write,
    error(error, details = {}) {
      write('error', { ...details, error: { name: error.name, message: error.message, code: error.code, stack: error.stack || new Error(String(error)).stack, cause: error.cause ? String(error.cause.stack || error.cause) : undefined } });
    },
    request(req, res, handler) {
      const requestId = randomUUID();
      const start = performance.now();
      const info = { requestId, method: req.method, path: (req.url || '/').split('?')[0], remoteAddress: req.socket.remoteAddress };
      res.setHeader('X-Request-Id', requestId);
      return context.run(info, () => {
        write('request_started');
        let finished = false;
        const complete = aborted => {
          if (finished) return;
          finished = true;
          const error = res.requestError || (aborted ? new Error('客户端连接提前关闭') : res.statusCode >= 400 ? new Error(`HTTP ${res.statusCode}`) : null);
          if (error) this.error(error, { ...info, status: res.statusCode });
          write('request_completed', { ...info, status: res.statusCode, aborted, durationMs: Math.round((performance.now() - start) * 100) / 100 });
        };
        res.once('finish', () => complete(false));
        res.once('close', () => complete(!res.writableFinished));
        return handler();
      });
    },
    flush: () => queue,
  };
}
