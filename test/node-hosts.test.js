import test from 'node:test';
import assert from 'node:assert/strict';
import { modifyHosts, parseMappings, createNodeHosts } from '../server/nodes/node-hosts.js';
test('hosts 新增校验及保留注释和其他别名', () => {
  const before = '127.0.0.1 localhost\n10.0.0.1 one two # note\n';
  assert.equal(modifyHosts(before, { action: 'delete', ip: '10.0.0.1', name: 'one' }), '127.0.0.1 localhost\n10.0.0.1\ttwo # note\n');
  assert.equal(modifyHosts(before, { action: 'delete', ip: '10.0.0.2', name: 'one' }), before);
  assert.equal(modifyHosts(before, { action: 'add', ip: '10.0.0.1', name: 'one' }), before);
  assert.throws(() => modifyHosts(before, { action: 'add', ip: '10.0.0.2', name: 'one' }), /其他 IP/);
  assert.throws(() => modifyHosts(before, { action: 'add', ip: '10.0.0.2', name: 'x; rm' }), /有效/);
  assert.deepEqual(parseMappings('::1 localhost # comment'), [{ ip: '::1', name: 'localhost' }]);
});
test('拒绝未确认或不存在的同步节点，且不创建操作 Pod', async () => {
  const service = createNodeHosts({ kubernetes: { request: async path => { assert.equal(path, '/api/v1/nodes'); return { items: [{ metadata: { name: 'a' } }] }; } } });
  await assert.rejects(service('a', { confirm: false, syncNodes: [] }), /确认/);
  await assert.rejects(service('a', { confirm: true, before: '', syncNodes: ['unknown'] }), /确认/);
});
