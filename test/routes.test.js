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
