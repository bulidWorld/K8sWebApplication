import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registryHostOptions, mapRegistryHosts } from '../server/registry/registry-hosts.js';
import { configureSavedRegistry, applyRegistryNode, createRegistryDistributor } from '../server/registry/registry-distribution.js';
import { configureRegistryToml } from '../server/registry/registry-service.js';
import { syncRegistryHosts } from '../server/registry/registry-hosts-sync.js';
const before = '# existing\n127.0.0.1 localhost\n10.0.0.1 lingxi.image.io other # keep\n10.0.0.2 ghcr.io\n';
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'registry-hosts-'));
  await mkdir(path.join(root, 'etc')); await mkdir(path.join(root, 'run'));
  await writeFile(path.join(root, 'etc/hosts'), before);
  return root;
}
test('hosts 替换仓库映射，保留 localhost、其他别名及注释', () => {
  const record = { url: 'https://lingxi.image.io', hostsIp: '192.168.100.133' };
  const options = registryHostOptions(record, { mode: 'hosts', domains: ['ghcr.io'] });
  assert.deepEqual(options.hostsDomains, ['ghcr.io', 'lingxi.image.io']);
  const multi = registryHostOptions({ ...record, urls: ['https://lingxi.image.io', 'https://mirror.example.com'] }, { mode: 'configure', domains: ['ghcr.io'], mapHosts: true });
  assert.deepEqual(multi.domains, ['ghcr.io', 'lingxi.image.io', 'mirror.example.com']);
  assert.deepEqual(multi.hostsDomains, multi.domains);
  const withIp = registryHostOptions({ ...record, urls: ['https://lingxi.image.io', 'https://192.168.100.133'] }, { mode: 'configure', domains: ['ghcr.io'], mapHosts: true });
  assert.ok(withIp.domains.includes('192.168.100.133'));
  assert.ok(!withIp.hostsDomains.includes('192.168.100.133'));
  const ipOnly = registryHostOptions({ url: 'https://192.168.100.133', hostsIp: '192.168.100.133' }, { mode: 'trust', domains: [] });
  assert.deepEqual(ipOnly.domains, ['192.168.100.133']);
  assert.equal(ipOnly.mapHosts, false);
  const mapped = mapRegistryHosts(before, options.hostsIp, options.hostsDomains);
  assert.match(mapped, /127.0.0.1 localhost/); assert.match(mapped, /10.0.0.1\tother # keep/);
  assert.match(mapped, /192.168.100.133\tghcr.io lingxi.image.io/);
  assert.equal(mapRegistryHosts(mapped, options.hostsIp, options.hostsDomains), mapped);
  assert.equal(mapRegistryHosts('192.168.100.133 lingxi.image.io\n192.168.100.133 ghcr.io\n', options.hostsIp, options.hostsDomains), '192.168.100.133 lingxi.image.io\n192.168.100.133 ghcr.io\n');
  assert.match(mapRegistryHosts('192.168.100.133 lingxi.image.io # keep exact line\n10.0.0.2 ghcr.io\n', options.hostsIp, options.hostsDomains), /^192.168.100.133 lingxi.image.io # keep exact line/m);
  assert.throws(() => registryHostOptions(record, { mode: 'hosts', domains: ['localhost'] }), /localhost/);
  assert.throws(() => registryHostOptions(record, { mode: 'hosts', domains: ['lingxi.image.io'], hostsIp: '127.0.0.1' }), /非回环/);
  assert.match(mapRegistryHosts('127.0.0.1 localhost lingxi.image.io\n', options.hostsIp, options.hostsDomains), /127.0.0.1\tlocalhost/);
});
test('保存仓库时同步所有地址到本机和工作节点，并报告失败节点', async () => {
  const calls = [];
  const record = { url: 'https://lingxi.image.io', urls: ['https://lingxi.image.io', 'https://ghcr.io'], hostsIp: '192.168.100.133' };
  const kubernetes = { request: async () => ({ items: [
    { metadata: { name: 'control', labels: { 'node-role.kubernetes.io/control-plane': '' } } },
    { metadata: { name: 'worker-a', labels: {} } }, { metadata: { name: 'worker-b', labels: {} } },
  ] }) };
  const result = await syncRegistryHosts(record, { kubernetes,
    configureLocal: async (_record, body) => { calls.push(body); },
    distribute: async (_record, body) => { calls.push(body); return { results: [{ node: 'worker-a', success: true }, { node: 'worker-b', success: false, error: 'offline' }] }; },
  });
  assert.deepEqual(calls[0].domains, ['lingxi.image.io', 'ghcr.io']);
  assert.deepEqual(calls[1].nodes, ['worker-a', 'worker-b']);
  assert.equal(result.success, false);
  assert.match(result.error, /worker-b/);
});
test('未安装 containerd 或 K8s 时仍可单独配置本机 hosts', async () => {
  const root = await fixture();
  try {
    const result = await configureSavedRegistry({ name: 'repo', url: 'https://lingxi.image.io', hostsIp: '192.168.100.133' }, { confirm: true, mode: 'hosts', domains: ['ghcr.io'] }, { root, run: () => assert.fail('不得调用 containerd') });
    assert.equal(result.hostsUpdated, true); assert.equal(result.restarted, false);
    assert.equal(await readFile(path.join(root, `etc/hosts.kubescope-${result.backupId}.bak`), 'utf8'), before);
    await assert.rejects(readFile(path.join(root, 'etc/containerd/config.toml')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('containerd 配置失败会回滚同时修改的 hosts', async () => {
  const root = await fixture();
  try {
    await assert.rejects(applyRegistryNode({ mapHosts: true, hostsIp: '192.168.100.133', hostsDomains: ['lingxi.image.io'], domains: ['ghcr.io'], backupId: 'rollback' }, root, configureRegistryToml, async () => {}), /已还原/);
    assert.equal(await readFile(path.join(root, 'etc/hosts'), 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('节点 hosts 快捷操作通过 SSH 下发，不依赖维护 Pod', async () => {
  const progress = [];
  const distribute = createRegistryDistributor({ kubernetes: { request: async url => {
    if (url === '/api/v1/nodes') return { items: [{ metadata: { name: 'a' } }] };
    assert.fail('不应创建维护 Pod');
  } }, access: { resolve: async () => ({ host: '192.168.100.133', port: 22, user: 'root', auth: 'password', loginPassword: 'login', hostFingerprint: 'SHA256:confirmed' }) }, ssh: async (_target, remote, _password, _client, { onOutput }) => {
    assert.match(remote.input, /python3/);
    onOutput('stdout', Buffer.from('LOG:/etc/hosts 映射已更新\n'));
    return 'RESULT:{"hostsUpdated":true,"backupId":"id"}\n';
  } });
  const result = await distribute({ url: 'https://lingxi.image.io', hostsIp: '192.168.100.133' }, { confirm: true, mode: 'hosts', nodes: ['a'], domains: ['ghcr.io'] }, { onProgress: line => progress.push(line) });
  assert.equal(result.results[0].success, true); assert.equal(result.results[0].hostsUpdated, true);
  assert.ok(progress.some(line => line.includes('/etc/hosts 映射已更新')));
});
