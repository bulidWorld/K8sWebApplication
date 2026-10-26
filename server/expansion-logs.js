import { StringDecoder } from 'node:string_decoder';
export function redactLog(text, secrets = []) {
  let value = String(text);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    let encoded; try { encoded = encodeURIComponent(secret); } catch { encoded = secret; }
    for (const variant of new Set([secret, JSON.stringify(secret).slice(1, -1), encoded])) value = value.split(variant).join('[REDACTED]');
  }
  return value
    .replace(/\b[a-z0-9]{6}\.[a-z0-9]{16}\b/gi, '[REDACTED_TOKEN]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:"?(?:password|passwd|token|client-key-data)"?)\s*[=:]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// Buffer complete lines so split packets cannot expose a partial password or token.
export function createLogCollector(secrets, onLine) {
  const streams = new Map();
  const emit = (source, state, line) => {
    if (/-----BEGIN .*PRIVATE KEY-----/.test(line)) state.privateKey = true;
    if (state.privateKey) {
      if (/-----END .*PRIVATE KEY-----/.test(line)) { state.privateKey = false; onLine(source, '[私钥内容已隐藏]'); }
      return;
    }
    const safe = redactLog(line, secrets);
    if (safe.trim()) onLine(source, safe);
  };
  const consume = (source, state, text) => {
    for (const char of text) {
      if (char === '\n' || char === '\r') {
        if (state.dropping) onLine(source, '[超长日志行已省略]'); else emit(source, state, state.pending);
        state.pending = ''; state.dropping = false;
      } else if (!state.dropping) {
        state.pending += char;
        if (state.pending.length > 8192) { state.pending = ''; state.dropping = true; }
      }
    }
  };
  return {
    feed(source, chunk) {
      if (!streams.has(source)) streams.set(source, { decoder: new StringDecoder('utf8'), pending: '', dropping: false, privateKey: false });
      const state = streams.get(source); consume(source, state, Buffer.isBuffer(chunk) ? state.decoder.write(chunk) : String(chunk));
    },
    flush() {
      for (const [source, state] of streams) {
        consume(source, state, state.decoder.end());
        if (state.dropping) onLine(source, '[超长日志行已省略]'); else if (state.pending) emit(source, state, state.pending);
      }
      streams.clear();
    },
  };
}
