import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyRegistryNode, registryDistributionConfig, createRegistryDistributor } from '../server/registry/registry-distribution.js';
import { configureRegistryToml } from '../server/registry/registry-service.js';
const original = 'version = 2\n[plugins."io.containerd.grpc.v1.cri".registry]\n  config_path = ""\n';
async function rootDir() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'registry-node-'));
  await mkdir(path.join(root, 'etc/containerd'), { recursive: true }); await mkdir(path.join(root, 'run'));
  await writeFile(path.join(root, 'etc/containerd/config.toml'), original);
  return root;
}
test('节点配置备份、镜像源重定向以及重复下发不重启', async () => {
  const root = await rootDir(); let restarts = 0;
  try {
    const config = { domains: ['docker.io'], url: 'https://192.168.100.133', ca: 'PUBLIC-CA', backupId: 'first' };
    const result = await applyRegistryNode(config, root, configureRegistryToml, async () => { restarts++; });
    assert.equal(result.restarted, true); assert.equal(restarts, 1);
    const hosts = await readFile(path.join(root, 'etc/containerd/certs.d/docker.io/hosts.toml'), 'utf8');
    assert.match(hosts, /host."https:\/\/192.168.100.133"/); assert.match(hosts, /registry-1.docker.io/); assert.doesNotMatch(hosts, /skip_verify/);
    assert.equal(await readFile(path.join(root, 'etc/containerd/config.toml.kubescope-first.bak'), 'utf8'), original);
    await applyRegistryNode({ ...config, backupId: 'second' }, root, configureRegistryToml, async () => { restarts++; });
    assert.equal(restarts, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('重启失败还原原配置、移除新文件并尝试恢复服务', async () => {
  const root = await rootDir(); let attempts = 0;
  try {
    await assert.rejects(applyRegistryNode({ domains: ['ghcr.io'], url: 'https://registry.example.com', ca: 'PUBLIC', backupId: 'rollback' }, root, configureRegistryToml, async () => { if (++attempts === 1) throw new Error('restart failed'); }), /已还原/);
    assert.equal(await readFile(path.join(root, 'etc/containerd/config.toml'), 'utf8'), original);
    await assert.rejects(readFile(path.join(root, 'etc/containerd/certs.d/ghcr.io/hosts.toml')), { code: 'ENOENT' });
    assert.equal(attempts, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('下发校验及 SSH 脚本不包含仓库私钥或密码', async () => {
  const root = await rootDir();
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=registry', '-addext', 'subjectAltName=IP:192.168.100.133', '-keyout', path.join(root, 'key'), '-out', path.join(root, 'cert')], { stdio: 'ignore' });
    const record = { url: 'https://192.168.100.133', serverCert: await readFile(path.join(root, 'cert'), 'utf8'), serverKey: 'SERVER-PRIVATE-SECRET', password: 'PASSWORD-SECRET' };
    assert.throws(() => registryDistributionConfig(record, ['../../etc']), /有效/);
    assert.throws(() => registryDistributionConfig({ ...record, url: 'https://192.168.100.134' }, ['ghcr.io']), /SAN/);
    let called = false;
    const distribute = createRegistryDistributor({ kubernetes: { request: async url => {
      if (url === '/api/v1/nodes') return { items: [{ metadata: { name: 'node-a' } }] };
      assert.fail('不应创建维护 Pod');
    } }, access: { resolve: async () => ({ host: '192.168.100.133', port: 22, user: 'root', auth: 'password', loginPassword: 'login', hostFingerprint: 'SHA256:confirmed' }) }, ssh: async (_target, remote) => {
      called = true; assert.doesNotMatch(remote.input, /SERVER-PRIVATE-SECRET|PASSWORD-SECRET/);
      assert.match(remote.input, /python3/); return 'RESULT:{"restarted":false,"backupId":"id"}\n';
    } });
    await assert.rejects(distribute(record, { confirm: false, nodes: ['node-a'], domains: ['ghcr.io'] }), /确认/);
    const result = await distribute(record, { confirm: true, nodes: ['node-a'], domains: ['ghcr.io'] });
    assert.equal(result.results[0].success, true); assert.ok(called);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('多个仓库地址逐一校验证书，并安装系统级证书信任', async () => {
  const root = await rootDir(); let refreshed = 0;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=registry', '-addext', 'subjectAltName=DNS:registry.example.com,DNS:mirror.example.com', '-keyout', path.join(root, 'key'), '-out', path.join(root, 'cert')], { stdio: 'ignore' });
    const ca = await readFile(path.join(root, 'cert'), 'utf8');
    const record = { id: 'sample', url: 'https://registry.example.com', urls: ['https://registry.example.com', 'https://mirror.example.com'], ca };
    const config = registryDistributionConfig(record, ['registry.example.com', 'mirror.example.com']);
    assert.deepEqual(config.urls, record.urls);
    assert.throws(() => registryDistributionConfig({ ...record, urls: [...record.urls, 'https://missing.example.com'] }, ['registry.example.com']), /SAN/);
    await applyRegistryNode({ ...config, trustOnly: true, backupId: 'trust' }, root, configureRegistryToml, async () => assert.fail('不应重启 containerd'), undefined, async () => { refreshed++; });
    assert.match(await readFile(path.join(root, 'usr/local/share/ca-certificates/kubescope-registry-sample-1.crt'), 'utf8'), /BEGIN CERTIFICATE/);
    assert.equal(refreshed, 1);
    await applyRegistryNode({ ...config, trustOnly: true, backupId: 'trust-repeat' }, root, configureRegistryToml, async () => {}, undefined, async () => { refreshed++; });
    assert.equal(refreshed, 1);
    await applyRegistryNode({ ...config, backupId: 'configure' }, root, configureRegistryToml, async () => {}, undefined, async () => { refreshed++; });
    const mirrorHosts = await readFile(path.join(root, 'etc/containerd/certs.d/mirror.example.com/hosts.toml'), 'utf8');
    assert.ok(mirrorHosts.indexOf('[host."https://registry.example.com"]') < mirrorHosts.indexOf('[host."https://mirror.example.com"]'));
    assert.equal((mirrorHosts.match(/ca = /g) || []).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('节点未配置 SSH 登录方式时提供操作指引', async () => {
  const distribute = createRegistryDistributor({ kubernetes: { request: async url => ({ items: [{ metadata: { name: 'worker-01' } }] }) }, access: { resolve: async () => { throw new Error('请到“系统维护 → 节点配置”完成配置'); } } });
  const record = { id: 'sample', url: 'https://registry.example.com' };
  const result = await distribute(record, { confirm: true, mode: 'hosts', hostsIp: '192.168.100.133', nodes: ['worker-01'], domains: ['registry.example.com'] });
  assert.equal(result.results[0].success, false);
  assert.match(result.results[0].error, /节点配置/);
});
test('配置了节点登录方式时通过 SSH 执行，不创建维护 Pod', async () => {
  const messages = []; let called = false;
  const distribute = createRegistryDistributor({
    kubernetes: { request: async url => { if (url === '/api/v1/nodes') return { items: [{ metadata: { name: 'worker-01' } }] }; assert.fail('不应创建维护 Pod'); } },
    access: { resolve: async () => ({ host: '192.168.1.10', port: 22, user: 'root', auth: 'password', loginPassword: 'secret', hostFingerprint: 'SHA256:confirmed' }) },
    ssh: async (_target, remote, password, _client, { onOutput }) => {
      called = true; assert.equal(password, 'secret'); assert.match(remote.input, /python3/);
      onOutput('stdout', Buffer.from('LOG:系统 CA 信任已刷新\n'));
      return 'LOG:系统 CA 信任已刷新\nRESULT:{"backupId":"id","restarted":false}\n';
    },
  });
  const result = await distribute({ url: 'https://registry.example.com', hostsIp: '192.168.1.10' }, { confirm: true, mode: 'hosts', nodes: ['worker-01'], domains: ['registry.example.com'] }, { onProgress: message => messages.push(message) });
  assert.ok(called); assert.equal(result.results[0].success, true);
  assert.ok(messages.some(message => message.includes('系统 CA 信任已刷新')));
});
