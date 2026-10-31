import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { KubeConfig } from '@kubernetes/client-node';
import { createKubernetes } from '../server/kubernetes.js';
import { applyManifest, validateApply, clientMergePatch } from '../server/apply.js';
import { createApp } from '../server/index.js';

const manifest = 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: demo\n';
test('apply validates input and size', () => {
  for (const body of [null, {}, { manifest: ' ' }, { manifest, serverSide: 'false' }])
    assert.throws(() => validateApply(body), { status: 400 });
  assert.doesNotThrow(() => validateApply({ manifest: 'x'.repeat(10 * 1024 * 1024) }));
  assert.throws(() => validateApply({ manifest: 'x'.repeat(10 * 1024 * 1024 + 1) }), { status: 413 });
  assert.throws(() => validateApply({ manifest: '界'.repeat(Math.ceil(10 * 1024 * 1024 / 3)) }), { status: 413 });
});
test('apply API enforces authorization, origin, method, type and preserves result', async () => {
  const calls = [];
  const app = createApp({ token: 'test-token', kubernetes: { apply: async body => { calls.push(body); return { success: false, output: 'partial', diagnostics: 'conflict' }; } }, logger: { request: (_req, _res, handler) => handler(), write() {} } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const url = `${origin}/api/manifests/apply`;
  const headers = { Authorization: 'Bearer test-token', Origin: origin, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(url, { headers })).status, 405);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'http://evil.example' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    for (const body of ['invalid', 'null', JSON.stringify({ manifest, serverSide: '--force' })])
      assert.equal((await fetch(url, { method: 'POST', headers, body })).status, 400);
    assert.equal(calls.length, 0);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ manifest, serverSide: true }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: false, output: 'partial', diagnostics: 'conflict' });
    assert.deepEqual(calls, [{ manifest, serverSide: true }]);
  } finally { await new Promise(resolve => app.close(resolve)); }
});

const discovery = { resources: [{ kind: 'ConfigMap', name: 'configmaps', namespaced: true }, { kind: 'Namespace', name: 'namespaces', namespaced: false }] };
const annotation = 'kubectl.kubernetes.io/last-applied-configuration';
const configMap = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'demo' }, data: { keep: 'new' } };

test('server-side API discovers resource path, defaults namespace and does not force conflicts', async () => {
  const calls = [];
  const result = await applyManifest(async (...args) => { calls.push(args); return discovery; }, { manifest: JSON.stringify(configMap), serverSide: true }, 'apps');
  assert.equal(result.success, true);
  assert.equal(calls[0][0], '/api/v1');
  assert.equal(calls[1][0], '/api/v1/namespaces/apps/configmaps/demo?fieldManager=kubescope&fieldValidation=Strict');
  assert.equal(calls[1][1].metadata.namespace, 'apps');
  assert.deepEqual(calls[1][2], { method: 'PATCH', contentType: 'application/apply-patch+yaml' });
});

test('client-side create uses POST; update removes prior fields and retains unmanaged fields', async () => {
  const previous = { ...configMap, data: { keep: 'old', removed: 'old' } };
  for (const exists of [false, true]) {
    const calls = [];
    const result = await applyManifest(async (target, payload, options) => {
      calls.push({ target, payload, options });
      if (target === '/api/v1') return discovery;
      if (!payload) {
        if (!exists) throw Object.assign(new Error('missing'), { status: 404 });
        return { ...configMap, metadata: { name: 'demo', namespace: 'default', resourceVersion: '17', annotations: { [annotation]: JSON.stringify(previous), external: 'kept' } }, data: { keep: 'old', removed: 'old', external: 'keep' } };
      }
      return {};
    }, { manifest: JSON.stringify(configMap), serverSide: false });
    assert.equal(result.success, true);
    const write = calls.at(-1);
    assert.equal(write.options.method, exists ? 'PATCH' : 'POST');
    assert.equal(write.options.contentType, exists ? 'application/merge-patch+json' : 'application/json');
    assert.equal(write.payload.data.keep, 'new');
    assert.equal(write.payload.data.removed, exists ? null : undefined);
    assert.equal(write.payload.data.external, undefined);
    if (exists) assert.equal(write.payload.metadata.resourceVersion, '17');
    assert.equal(JSON.parse(write.payload.metadata.annotations[annotation]).data.keep, 'new');
  }
});

test('multi-document apply reports partial failure and handles cluster-scoped CRDs', async () => {
  const calls = [];
  const result = await applyManifest(async (target, payload) => {
    calls.push(target);
    if (target === '/api/v1') return discovery;
    if (target === '/apis/example.org/v1') return { resources: [{ name: 'widgets', kind: 'Widget', namespaced: false }] };
    if (payload.kind === 'Widget') throw Object.assign(new Error('field conflict'), { status: 409 });
    return {};
  }, { manifest: `${manifest}\n---\napiVersion: example.org/v1\nkind: Widget\nmetadata:\n  name: sample`, serverSide: true });
  assert.equal(result.success, false);
  assert.match(result.output, /Namespace\/demo serverside-applied/);
  assert.match(result.diagnostics, /Widget\/sample: field conflict/);
  assert.ok(calls.includes('/apis/example.org/v1/widgets/sample?fieldManager=kubescope&fieldValidation=Strict'));
});

test('invalid YAML or resource identity makes no API calls; read forbidden never triggers create', async () => {
  for (const manifest of ['# empty', 'a: [', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: ../bad', 'kind: List\napiVersion: v1\nitems: [null]']) {
    await assert.rejects(applyManifest(() => assert.fail('must not call API'), { manifest }), { status: 400 });
  }
  let calls = 0;
  const result = await applyManifest(async () => { if (++calls === 1) return discovery; throw Object.assign(new Error('Forbidden'), { status: 403 }); }, { manifest });
  assert.equal(calls, 2);
  assert.equal(result.success, false);
  assert.match(result.diagnostics, /Forbidden/);
});

test('Kubernetes HTTP transport sends apply media type, credentials and handles 404 create', async () => {
  const writes = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer api-token');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/v1') return res.end(JSON.stringify(discovery));
    if (req.method === 'GET') { res.statusCode = 404; return res.end(JSON.stringify({ message: 'NotFound' })); }
    let input = '';
    for await (const chunk of req) input += chunk;
    writes.push({ method: req.method, type: req.headers['content-type'], body: JSON.parse(input) });
    res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const kc = new KubeConfig();
    kc.loadFromOptions({ clusters: [{ name: 'test', skipTLSVerify: true, server: `http://127.0.0.1:${server.address().port}` }], users: [{ name: 'test', token: 'api-token' }], contexts: [{ name: 'test', cluster: 'test', user: 'test', namespace: 'apps' }], currentContext: 'test' });
    const client = createKubernetes({ config: kc });
    const applied = await client.apply({ manifest: JSON.stringify(configMap), serverSide: true });
    assert.equal(applied.success, true, applied.diagnostics);
    assert.equal((await client.apply({ manifest: JSON.stringify(configMap), serverSide: false })).success, true);
    assert.deepEqual(writes.map(({ method, type }) => ({ method, type })), [{ method: 'PATCH', type: 'application/apply-patch+yaml' }, { method: 'POST', type: 'application/json' }]);
    assert.equal(writes[0].body.metadata.namespace, 'apps');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

 test('client JSON merge replaces arrays atomically and preserves unmanaged map keys', () => {
  const patch = clientMergePatch({ spec: { ports: [1], obsolete: true } }, { spec: { ports: [2] } }, { spec: { ports: [1, 3], obsolete: true, external: 4 } });
  assert.deepEqual(JSON.parse(JSON.stringify(patch)), { spec: { ports: [2], obsolete: null } });
});

test('CRD apply preserves schema wire keys and fields unknown to SDK models', async () => {
  const schema = {
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        properties: {
          mode: { type: 'string', default: 'auto', enum: ['auto', 'manual'] },
          entries: { type: 'array', 'x-kubernetes-list-type': 'map', 'x-kubernetes-list-map-keys': ['name'], items: { type: 'object' } },
        },
        'x-kubernetes-validations': [{ rule: 'true', message: 'valid' }],
      },
    },
  };
  const crd = {
    apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition',
    metadata: { name: 'widgets.example.org' },
    spec: { group: 'example.org', names: { kind: 'Widget', plural: 'widgets' }, scope: 'Namespaced',
      versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: schema } }],
      futureField: { preserved: true },
    },
  };
  for (const serverSide of [true, false]) {
    let sent;
    const result = await applyManifest(async (target, payload) => {
      if (target === '/apis/apiextensions.k8s.io/v1') return { resources: [{ kind: crd.kind, name: 'customresourcedefinitions', namespaced: false }] };
      if (!payload) throw Object.assign(new Error('NotFound'), { status: 404 });
      sent = JSON.parse(JSON.stringify(payload));
      return {};
    }, { manifest: JSON.stringify(crd), serverSide });
    assert.equal(result.success, true, result.diagnostics);
    assert.deepEqual(sent.spec, crd.spec);
  }
});

test('YAML parsing preserves schema keys, ignores empty documents and rejects duplicate keys and cycles', async () => {
  let sent;
  const result = await applyManifest(async (target, payload) => {
    if (!payload) return discovery;
    sent = payload;
    return {};
  }, { manifest: `---\n# empty\n---\n${manifest}data:\n  default: original\n  x-kubernetes-list-type: atomic\n---\n`, serverSide: true });
  assert.equal(result.success, true, result.diagnostics);
  assert.deepEqual(sent.data, { default: 'original', 'x-kubernetes-list-type': 'atomic' });
  for (const invalid of [`${manifest}kind: Pod\n`, `${manifest}spec: &cycle\n  self: *cycle\n`]) {
    await assert.rejects(applyManifest(() => assert.fail('must not call API'), { manifest: invalid }), { status: 400 });
  }
});
