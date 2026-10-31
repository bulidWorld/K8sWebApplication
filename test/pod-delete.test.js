import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server/index.js';
import { createKubernetes } from '../server/kubernetes.js';

async function listen(app) {
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.address().port}`;
}

test('Pod deletion requires authentication, same origin, a single target and UID; preserves API errors', async () => {
  const calls = [];
  let failure;
  const app = createApp({ token: 'test', kubernetes: { request: async (...args) => {
    calls.push(args);
    if (failure) throw Object.assign(new Error('upstream error'), { status: failure });
    return { kind: 'Status', status: 'Success' };
  } } });
  const base = await listen(app);
  const headers = { Authorization: 'Bearer test', Origin: base, 'Content-Type': 'application/json' };
  const send = (body = { uid: 'uid-1' }, overrides = {}, endpoint = '/api/pods/default/web') => fetch(base + endpoint, { method: 'DELETE', headers, body: JSON.stringify(body), ...overrides });
  try {
    assert.equal((await send(undefined, { headers: {} })).status, 401);
    assert.equal((await send(undefined, { headers: { ...headers, Origin: 'https://elsewhere.example' } })).status, 403);
    assert.equal((await send(undefined, { headers: { Authorization: headers.Authorization } })).status, 403);
    assert.equal((await send(undefined, { headers: { ...headers, 'Content-Type': 'text/plain' } })).status, 415);
    for (const body of [null, {}, [], { uid: '' }, { uid: 1 }, { uid: 'uid-1', gracePeriodSeconds: 0 }]) assert.equal((await send(body)).status, 400);
    assert.equal((await send(undefined, { body: '{' })).status, 400);
    assert.equal((await send(undefined, { body: 'x'.repeat(4097) })).status, 413);
    assert.equal((await send(undefined, {}, '/api/pods/default/bad%20name')).status, 400);
    for (const endpoint of ['/api/pods/default', '/api/resources/pods', '/api/resources/nodes/worker']) assert.equal((await send(undefined, {}, endpoint)).status, 405);
    assert.equal((await fetch(base + '/api/pods/default/web', { headers })).status, 405);
    assert.equal(calls.length, 0);
    assert.equal((await send()).status, 200);
    assert.deepEqual(calls[0], ['/api/v1/namespaces/default/pods/web', true, { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'uid-1' } }, { method: 'DELETE', contentType: 'application/json', preserveStatus: true }]);
    for (failure of [403, 404, 409, 502]) assert.equal((await send()).status, failure);
  } finally { await new Promise(resolve => app.close(resolve)); }
});

test('Pod deletion is unavailable without configured token', async () => {
  const app = createApp({ token: '', kubernetes: { request: () => assert.fail('must not call upstream') } });
  const base = await listen(app);
  try {
    assert.equal((await fetch(`${base}/api/pods/default/web`, { method: 'DELETE', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: 'uid-1' }) })).status, 403);
  } finally { await new Promise(resolve => app.close(resolve)); }
});

test('Kubernetes transport sends DELETE with JSON UID precondition and default grace period', async () => {
  let captured;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = { method: req.method, path: req.url, contentType: req.headers['content-type'], body: JSON.parse(Buffer.concat(chunks)) };
    res.end(JSON.stringify({ status: 'Success' }));
  });
  const base = await listen(upstream);
  const client = createKubernetes({ config: { getCurrentCluster: () => ({ server: base }), applyToHTTPSOptions: async () => {} } });
  try {
    const options = { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'uid-1' } };
    await client.request('/api/v1/namespaces/default/pods/web', true, options, { method: 'DELETE', contentType: 'application/json' });
    assert.deepEqual(captured, { method: 'DELETE', path: '/api/v1/namespaces/default/pods/web', contentType: 'application/json', body: options });
  } finally { await new Promise(resolve => upstream.close(resolve)); }
});
