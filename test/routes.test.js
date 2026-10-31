import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeHash } from '../src/lib/routes.js';
import { navigation, activeBranchIds } from '../src/lib/navigation.js';

test('all sidebar destinations survive URL serialization and restoration', () => {
  function check(entries) {
    for (const entry of entries) {
      if (entry.children) check(entry.children);
      else assert.deepEqual(parseRoute(routeHash(entry.section, entry.module)), {
        section: entry.section, deploymentModule: entry.module || '',
      });
    }
  }
  check(navigation);
});

test('direct module links restore the correct parent menus', () => {
  const route = parseRoute('#/deployments/environment');
  assert.deepEqual(activeBranchIds(route.section, route.deploymentModule), ['applications', 'deployment-group']);
  assert.equal(routeHash('nodes', 'image'), '#/nodes');
  assert.equal(routeHash('deployments'), '#/deployments');
});

test('empty and invalid routes fall back to valid pages', () => {
  for (const hash of ['', '#', '#/missing', '#/nodes/extra/path', '#/%broken']) {
    assert.deepEqual(parseRoute(hash), { section: 'overview', deploymentModule: '' });
  }
  for (const module of ['missing', '__proto__', 'constructor']) {
    assert.deepEqual(parseRoute(`#/deployments/${module}`), { section: 'deployments', deploymentModule: '' });
  }
});

test('resource dialogs retain page, namespace and tab in shareable URLs', () => {
  for (const modal of [
    { dialog: 'resource', kind: 'nodes', name: 'worker-1', tab: 'labels' },
    { dialog: 'resource', kind: 'customresourcedefinitions', name: 'clusters.postgresql.cnpg.io', tab: 'detail' },
    { dialog: 'resource', kind: 'pods', name: 'web-1', namespace: 'apps', tab: 'logs' },
    { dialog: 'resource', kind: 'deployments', name: 'web', namespace: 'apps', tab: 'config:environment' },
    { dialog: 'resource', kind: 'services', name: 'web', namespace: 'apps', tab: 'detail' },
  ]) {
    const hash = routeHash('deployments', 'environment', modal);
    assert.deepEqual(parseRoute(hash), { section: 'deployments', deploymentModule: 'environment', modal });
    assert.equal(routeHash('deployments', 'environment'), '#/deployments/environment');
    assert.equal(routeHash(...['deployments', 'environment', parseRoute(hash).modal]), hash);
  }
});

test('all workflow dialogs survive refresh without action payloads or credentials', () => {
  for (const dialog of ['add-node', 'node-history', 'registry-progress']) {
    const hash = routeHash('nodes', '', { dialog, password: 'secret', token: 'secret', action: 'start' });
    assert.equal(hash, `#/nodes?dialog=${dialog}`);
    assert.deepEqual(parseRoute(hash).modal, { dialog });
  }
  assert.equal(parseRoute('#/pods?dialog=add-node').modal, undefined);
});

test('invalid modal routes safely return to their page and tab scope is enforced', () => {
  for (const query of [
    'dialog=unknown',
    'dialog=resource&kind=secrets&name=secret',
    'dialog=resource&kind=nodes&name=..%2Fworker',
    'dialog=resource&kind=pods&name=web',
    'dialog=resource&kind=pods&name=web&namespace=..%2Fdefault',
    'dialog=resource&kind=nodes&name=%',
  ]) assert.deepEqual(parseRoute(`#/nodes?${query}`), { section: 'nodes', deploymentModule: '' });
  const modal = parseRoute('#/nodes?dialog=resource&kind=nodes&name=worker-1&tab=logs&token=secret').modal;
  assert.deepEqual(modal, { dialog: 'resource', kind: 'nodes', name: 'worker-1', tab: 'detail' });
  assert.equal(routeHash('nodes', '', modal), '#/nodes?dialog=resource&kind=nodes&name=worker-1&tab=detail');
});
