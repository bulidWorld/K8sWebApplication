import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildNodeLabelsPatch } from '../server/node-labels.js';
import { createApp } from '../server/index.js';
const current = { metadata: { name: 'worker-1', uid: 'uid-1', resourceVersion: '10', labels: { 'example.com/zone': 'a', role: '', keep: 'yes' } } };
const body = changes => ({ uid: 'uid-1', resourceVersion: '10', changes });
test('标签更新只修改目标键，转义路径，允许空值和删除，保护 UID 与版本', () => {
  const patch = buildNodeLabelsPatch(current, body({ 'example.com/zone': 'b', role: null, new: '' }));
  assert.deepEqual(patch, [
    { op: 'test', path: '/metadata/uid', value: 'uid-1' },
    { op: 'test', path: '/metadata/resourceVersion', value: '10' },
    { op: 'add', path: '/metadata/labels/example.com~1zone', value: 'b' },
    { op: 'remove', path: '/metadata/labels/role' },
    { op: 'add', path: '/metadata/labels/new', value: '' },
  ]);
  assert.equal(current.metadata.labels.keep, 'yes');
  for (const field of ['uid', 'resourceVersion']) assert.throws(() => buildNodeLabelsPatch(current, { ...body({ role: null }), [field]: 'old' }), { status: 409 });
  const unlabeled = { metadata: { ...current.metadata, labels: undefined } };
  assert.deepEqual(buildNodeLabelsPatch(unlabeled, body({ role: 'worker' }))[2], { op: 'add', path: '/metadata/labels', value: {} });
});
test('标签输入校验拒绝越界修改和无效键值', () => {
  for (const changes of [null, [], {}, { '/bad': 'x' }, { 'Bad.domain/key': 'x' }, { 'a/b/c': 'x' }, { key: 'bad value' }, { key: 1 }, { key: 'x'.repeat(64) }]) assert.throws(() => buildNodeLabelsPatch(current, body(changes)), { status: 400 });
  assert.throws(() => buildNodeLabelsPatch(current, { ...body({ role: null }), spec: {} }), { status: 400 });
});
test('节点标签接口认证、校验、PATCH、审计和上游冲突处理', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'node-labels-'));
  const calls = []; let upstreamError;
  const app = createApp({ token: 'access', auditFile: path.join(dir, 'audit.jsonl'), kubernetes: { request: async (target, json, patch) => { calls.push({ target, patch }); if (patch && upstreamError) throw upstreamError; return current; } } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const endpoint = `${base}/api/nodes/worker-1/labels`;
  const headers = { Authorization: 'Bearer access', 'Content-Type': 'application/json' };
  const send = (payload, overrides = {}) => fetch(endpoint, { method: 'PATCH', headers, body: JSON.stringify(payload), ...overrides });
  try {
    assert.equal((await send(body({ role: null }), { headers: {} })).status, 401);
    assert.equal((await send(body({ role: null }), { headers: { Authorization: 'Bearer access' } })).status, 415);
    assert.equal((await send(body({ role: null }), { headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
    assert.equal((await send(null, { body: '{' })).status, 400);
    assert.equal((await send(null, { body: 'x'.repeat(131073) })).status, 413);
    assert.equal(calls.length, 0);
    assert.equal((await send({ ...body({ role: null }), resourceVersion: 'old' })).status, 409);
    assert.equal(calls.some(call => call.patch), false);
    const response = await send(body({ role: null }));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).resource, current);
    assert.equal(calls.at(-1).target, '/api/v1/nodes/worker-1');
    assert.deepEqual(calls.at(-1).patch.at(-1), { op: 'remove', path: '/metadata/labels/role' });
    assert.match(await readFile(path.join(dir, 'audit.jsonl'), 'utf8'), /"resource":"nodes"/);
    upstreamError = Object.assign(new Error('test failed'), { status: 422 });
    assert.equal((await send(body({ role: null }))).status, 409);
    upstreamError = Object.assign(new Error('Forbidden'), { status: 403 });
    assert.equal((await send(body({ role: null }))).status, 403);
  } finally { await new Promise(resolve => app.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});
