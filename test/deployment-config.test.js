import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KubeConfig } from '@kubernetes/client-node';
import { buildModulePatch, quantity } from '../server/deployment-config.js';
import { createApp } from '../server/index.js';
import { createKubernetes } from '../server/kubernetes.js';

function deployment() {
  return { metadata: { name: 'office', namespace: 'apps', uid: 'uid-1', resourceVersion: '123', generation: 1 }, spec: { replicas: 1, template: { spec: { containers: [
    { name: 'sidecar', image: 'sidecar:1' },
    { name: 'app', image: 'office:1', imagePullPolicy: 'Always', env: [{ name: 'TOKEN', valueFrom: { secretKeyRef: { name: 'office-secret', key: 'JWT' } } }], envFrom: [{ configMapRef: { name: 'defaults' } }], resources: { requests: { cpu: '100m', memory: '128Mi', 'ephemeral-storage': '1Gi' }, limits: { cpu: '1', memory: '1Gi' } }, readinessProbe: { tcpSocket: { port: 8080 } } },
  ] } } } };
}
const payload = values => ({ resourceVersion: '123', uid: 'uid-1', container: 'app', values });
test('模块更新限定到所选容器，原子检测 UID 与版本', () => {
  const current = deployment();
  const patch = buildModulePatch(current, 'image', payload({ image: 'office:2', imagePullPolicy: 'IfNotPresent' }));
  assert.deepEqual(patch.slice(0, 2), [{ op: 'test', path: '/metadata/uid', value: 'uid-1' }, { op: 'test', path: '/metadata/resourceVersion', value: '123' }]);
  assert.deepEqual(patch.slice(2).map(v => v.path), ['/spec/template/spec/containers/1/image', '/spec/template/spec/containers/1/imagePullPolicy']);
  assert.throws(() => buildModulePatch(current, 'image', { ...payload({}), uid: 'recreated' }), { status: 409 });
  assert.throws(() => buildModulePatch(current, 'image', { ...payload({}), resourceVersion: '122' }), { status: 409 });
  assert.throws(() => buildModulePatch(current, 'image', payload({ image: 'office:2', imagePullPolicy: 'Always', command: ['sh'] })), { status: 400 });
  assert.equal(current.spec.template.spec.containers[1].image, 'office:1');
});
test('资源单位、申请与上限校验，并保留其他资源配置', () => {
  assert.equal(quantity('500m', 'cpu'), .5); assert.equal(quantity('1Gi', 'memory'), 1024 ** 3);
  for (const value of ['-1', 'NaN', '0.0001', '1Gi']) assert.throws(() => quantity(value, 'cpu'), { status: 400 });
  const values = { replicas: 0, requests: { cpu: '200m', memory: '' }, limits: { cpu: '500m', memory: '512Mi' } };
  const patch = buildModulePatch(deployment(), 'resources', payload(values));
  const resources = patch.find(p => p.path.endsWith('/resources')).value;
  assert.equal(resources.requests['ephemeral-storage'], '1Gi'); assert.equal(resources.requests.memory, undefined);
  assert.equal(patch.find(p => p.path === '/spec/replicas').value, 0);
  assert.throws(() => buildModulePatch(deployment(), 'resources', payload({ ...values, requests: { cpu: '1' } })), { status: 400 });
  assert.throws(() => buildModulePatch(deployment(), 'resources', payload({ ...values, replicas: -1 })), { status: 400 });
});
test('环境变量引用、去重与作用域保护', () => {
  const current = deployment(), env = current.spec.template.spec.containers[1].env;
  const patch = buildModulePatch(current, 'environment', payload({ env }));
  assert.equal(patch.at(-1).path, '/spec/template/spec/containers/1/env');
  assert.throws(() => buildModulePatch(current, 'environment', payload({ env: [env[0], env[0]] })), { status: 400 });
  assert.throws(() => buildModulePatch(current, 'environment', payload({ env: [{ ...env[0], value: 'secret' }] })), { status: 400 });
  assert.throws(() => buildModulePatch(current, 'environment', payload({ env: [{ name: 'JWT', valueFrom: { secretKeyRef: { name: '../secret', key: 'JWT' } } }] })), { status: 400 });
});
test('健康检查编辑、删除与非 HTTP 探针保留', () => {
  const current = deployment();
  const values = { livenessProbe: { httpGet: { path: '/healthz', port: 'http' }, successThreshold: 1 }, readinessProbe: current.spec.template.spec.containers[1].readinessProbe };
  assert.equal(buildModulePatch(current, 'probes', payload(values)).at(-1).value.tcpSocket.port, 8080);
  assert.throws(() => buildModulePatch(current, 'probes', payload({ ...values, livenessProbe: { ...values.livenessProbe, successThreshold: 2 } })), { status: 400 });
  assert.throws(() => buildModulePatch(current, 'probes', payload({ ...values, livenessProbe: { httpGet: { port: 70000 } } })), { status: 400 });
  const removed = buildModulePatch(current, 'probes', payload({ livenessProbe: null, readinessProbe: null }));
  assert.deepEqual(removed.at(-1), { op: 'remove', path: '/spec/template/spec/containers/1/readinessProbe' });
  assert.equal(removed.length, 3);
});
async function listening(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function close(server) { await new Promise(resolve => server.close(resolve)); }
test('模块接口校验令牌、内容类型、来源、大小和冲突；操作日志不包含变量值', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kubescope-modules-'));
  const calls = [], auditFile = path.join(directory, 'audit.jsonl');
  const current = deployment();
  const app = createApp({ token: 'access', auditFile, kubernetes: { request: async (target, json, patch) => { calls.push({ target, patch }); return current; } } });
  const base = await listening(app);
  const endpoint = `${base}/api/deployments/apps/office/modules/environment`;
  const body = JSON.stringify(payload({ env: [{ name: 'PASSWORD', value: 'private-value-do-not-log' }] }));
  const headers = { Authorization: 'Bearer access', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(endpoint, { method: 'PATCH', body })).status, 401);
    assert.equal((await fetch(endpoint, { method: 'PATCH', headers: { Authorization: 'Bearer access' }, body })).status, 415);
    assert.equal((await fetch(endpoint, { method: 'PATCH', headers: { ...headers, Origin: 'https://other.example' }, body })).status, 403);
    assert.equal((await fetch(endpoint, { method: 'PATCH', headers, body: '{broken' })).status, 400);
    assert.equal((await fetch(endpoint, { method: 'PATCH', headers, body: 'x'.repeat(131073) })).status, 413);
    assert.equal(calls.length, 0);
    assert.equal((await fetch(endpoint, { method: 'PATCH', headers, body: JSON.stringify({ ...JSON.parse(body), resourceVersion: 'stale' }) })).status, 409);
    assert.equal(calls.some(c => c.patch), false);
    const response = await fetch(endpoint, { method: 'PATCH', headers, body });
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).resource, current);
    assert.equal(calls.at(-1).patch.at(-1).path, '/spec/template/spec/containers/1/env');
    const audit = await readFile(auditFile, 'utf8'); assert.ok(audit.includes('submitted')); assert.ok(!audit.includes('private-value-do-not-log')); assert.ok(!audit.includes('Bearer'));
    assert.equal((await fetch(`${base}/api/resources/pods`, { method: 'PATCH', headers, body })).status, 405);
  } finally { await close(app); await rm(directory, { recursive: true, force: true }); }
});
test('Kubernetes PATCH 传输使用 JSON Patch、认证和真实错误状态', async () => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    received = { method: req.method, contentType: req.headers['content-type'], auth: req.headers.authorization, body: JSON.parse(text) };
    res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'resource modified' }));
  });
  const base = await listening(upstream);
  try {
    const config = new KubeConfig(); config.loadFromOptions({ clusters: [{ name: 'test', server: base, skipTLSVerify: true }], users: [{ name: 'test', token: 'cluster-token' }], contexts: [{ name: 'test', cluster: 'test', user: 'test' }], currentContext: 'test' });
    const patch = [{ op: 'test', path: '/metadata/resourceVersion', value: '1' }];
    await assert.rejects(createKubernetes({ config }).request('/test', true, patch), { status: 409 });
    assert.deepEqual(received, { method: 'PATCH', contentType: 'application/json-patch+json', auth: 'Bearer cluster-token', body: patch });
  } finally { await close(upstream); }
});
