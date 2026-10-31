import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { resourcePath } from '../server/kubernetes.js';
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
