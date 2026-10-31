import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequestLogger } from '../server/request-logger.js';

test('请求记录关联编号、耗时、失败堆栈并隐藏凭证，断连只记录一次', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'request-log-'));
  try {
    const logger = createRequestLogger({ directory, secrets: ['secret-value'] });
    for (const status of [200, 401, 500]) {
      const res = new EventEmitter();
      res.statusCode = status;
      res.setHeader = (key, value) => { res[key] = value; };
      await logger.request({ method: 'GET', url: '/api/health?token=never-log-this', socket: { remoteAddress: '127.0.0.1' } }, res, async () => {
        if (status === 500) res.requestError = new Error('failed secret-value Bearer hidden-value');
        res.emit('finish');
        res.emit('close');
      });
      assert.ok(res['X-Request-Id']);
    }
    const res = new EventEmitter();
    res.statusCode = 200;
    res.setHeader = () => {};
    logger.request({ method: 'GET', url: '/', socket: {} }, res, () => res.emit('close'));
    await logger.flush();
    const files = await readdir(directory);
    const content = await readFile(path.join(directory, files[0]), 'utf8');
    const records = content.trim().split('\n').map(JSON.parse);
    assert.equal(records.filter(r => r.event === 'request_started').length, 4);
    assert.equal(records.filter(r => r.event === 'request_completed').length, 4);
    assert.equal(records.filter(r => r.event === 'error').length, 3);
    assert.ok(records.filter(r => r.event === 'error').every(r => r.error.stack.includes('Error:') && r.requestId));
    assert.ok(records.some(r => r.aborted));
    assert.ok(!/secret-value|hidden-value|never-log-this/.test(content));
    assert.equal((await stat(path.join(directory, files[0]))).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
