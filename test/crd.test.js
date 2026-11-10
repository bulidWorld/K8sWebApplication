import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { resourcePath } from '../server/core/kubernetes.js';
import { crdStatus } from '../src/lib/formatters.js';
import { scoped } from '../src/lib/resources.js';

const kind = 'customresourcedefinitions';
const name = 'clusters.postgresql.cnpg.io';
const prefix = '/apis/apiextensions.k8s.io/v1/customresourcedefinitions';

test('CRD lists and details use the cluster-scoped API and preserve schemas', async () => {
  assert.equal(scoped.has(kind), false);
  assert.equal(resourcePath(kind, 'default'), prefix);
  assert.equal(resourcePath(kind, '', name), `${prefix}/${name}`);
  const item = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name }, spec: { scope: 'Namespaced', versions: [{ name: 'v1', served: true, storage: true, schema: { openAPIV3Schema: { type: 'object' } } }] } };
  const calls = [];
  const app = createApp({ token: 'test', kubernetes: { request: async path => {
    calls.push(path);
    return path === prefix ? { items: [item] } : item;
  } } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${app.address().port}/api/resources/${kind}`;
    const headers = { Authorization: 'Bearer test' };
    assert.equal((await fetch(base)).status, 401);
    assert.deepEqual(await (await fetch(`${base}?namespace=default`, { headers })).json(), { items: [item] });
    assert.deepEqual(await (await fetch(`${base}/${name}?namespace=default`, { headers })).json(), item);
    assert.equal((await fetch(base, { method: 'DELETE', headers })).status, 405);
    assert.deepEqual(calls, [prefix, `${prefix}/${name}`]);
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});

test('CRD conditions distinguish establishment, naming conflicts and termination', () => {
  const resource = (...conditions) => ({ status: { conditions } });
  const established = { type: 'Established', status: 'True' };
  assert.equal(crdStatus({}), 'Unknown');
  assert.equal(crdStatus(resource({ ...established, status: 'Unknown' })), 'Unknown');
  assert.equal(crdStatus(resource({ ...established, status: 'False' })), 'NotEstablished');
  assert.equal(crdStatus(resource(established)), 'Established');
  assert.equal(crdStatus(resource(established, { type: 'NamesAccepted', status: 'False' })), 'NameConflict');
  assert.equal(crdStatus(resource(established, { type: 'Terminating', status: 'True' })), 'Terminating');
  assert.equal(crdStatus({ ...resource(established), metadata: { deletionTimestamp: '2026-10-31T00:00:00Z' } }), 'Terminating');
});

test('CR endpoint resolves served versions and scope from the CRD, enforces read-only authentication', async () => {
  let scope = 'Namespaced';
  let versions = [{ name: 'v1beta1', served: true }, { name: 'v1', served: true, storage: true }];
  let denied = false;
  const calls = [];
  const instance = { metadata: { name: 'database', namespace: 'apps' }, spec: { instances: 2 } };
  const app = createApp({ token: 'test', kubernetes: { request: async path => {
    calls.push(path);
    if (path === `${prefix}/${name}`) return { spec: { group: 'postgresql.cnpg.io', names: { plural: 'clusters', kind: 'Cluster' }, scope, versions } };
    if (denied) throw Object.assign(new Error('clusters is forbidden'), { status: 403 });
    return { items: [instance] };
  } } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${app.address().port}/api/custom-resources/${name}`;
    const headers = { Authorization: 'Bearer test' };
    assert.equal((await fetch(base)).status, 401);
    assert.equal((await fetch(base, { method: 'POST', headers })).status, 405);
    assert.equal(calls.length, 0);
    const body = await (await fetch(base, { headers })).json();
    assert.deepEqual(body.items, [instance]);
    assert.equal(body.apiVersion, 'postgresql.cnpg.io/v1');
    assert.equal(calls.at(-1), '/apis/postgresql.cnpg.io/v1/clusters');
    assert.equal((await fetch(`${base}/count`)).status, 401);
    assert.equal((await fetch(`${base}/count`, { method: 'POST', headers })).status, 405);
    assert.deepEqual(await (await fetch(`${base}/count?namespace=apps`, { headers })).json(), { count: 1 });
    assert.equal(calls.at(-1), '/apis/postgresql.cnpg.io/v1/clusters?limit=200');
    await fetch(`${base}?namespace=apps`, { headers });
    assert.equal(calls.at(-1), '/apis/postgresql.cnpg.io/v1/namespaces/apps/clusters');
    assert.equal((await fetch(`${base}?namespace=..%2Fsecrets`, { headers })).status, 400);
    scope = 'Cluster';
    versions = [{ name: 'v1', storage: true, served: false }, { name: 'v2', served: true }];
    await fetch(`${base}?namespace=apps`, { headers });
    assert.equal(calls.at(-1), '/apis/postgresql.cnpg.io/v2/clusters');
    versions = [{ name: 'v1', storage: true, served: false }];
    assert.equal((await fetch(base, { headers })).status, 400);
    versions = [{ name: 'v1', storage: true, served: true }];
    denied = true;
    const response = await fetch(base, { headers });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /forbidden/);
  } finally {
    await new Promise(resolve => app.close(resolve));
  }
});

test('CR counts include all namespaces and pages; empty and failed lists remain distinct', async () => {
  const { listCustomResources } = await import('../server/resources/custom-resources.js');
  const calls = [];
  const crd = { spec: { group: 'example.io', names: { plural: 'widgets' }, scope: 'Namespaced', versions: [{ name: 'v1', served: true, storage: true }] } };
  let empty = false;
  let fail = false;
  const kubernetes = { request: async path => {
    calls.push(path);
    if (path === `${prefix}/widgets.example.io`) return crd;
    if (fail) throw new Error('forbidden');
    if (empty) return { items: [] };
    const url = new URL(path, 'http://cluster');
    assert.equal(url.pathname, '/apis/example.io/v1/widgets');
    assert.equal(url.searchParams.get('limit'), '200');
    if (url.searchParams.has('continue')) {
      assert.equal(url.searchParams.get('continue'), 'next+/=');
      return { items: [{}] };
    }
    return { items: [{}, {}], metadata: { continue: 'next+/=' } };
  } };
  assert.deepEqual(await listCustomResources(kubernetes, 'widgets.example.io', '', true), { count: 3 });
  assert.equal(calls.length, 3);
  empty = true;
  assert.deepEqual(await listCustomResources(kubernetes, 'widgets.example.io', '', true), { count: 0 });
  fail = true;
  await assert.rejects(listCustomResources(kubernetes, 'widgets.example.io', '', true), /forbidden/);
});
