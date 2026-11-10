import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { createClusterService } from '../server/cluster/cluster-service.js';
import { createApp } from '../server/index.js';

test('API Server 端口缺失时提供集群安装提示，认证错误不误判为缺少集群', async () => {
  let code = 'ECONNREFUSED';
  const app = createApp({ token: 'test', kubernetes: { request: async () => { throw Object.assign(new Error('upstream failed'), { code, status: 502 }); } }, clusterService: async () => ({ task: null }) });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const headers = { Authorization: 'Bearer test' };
    const result = await (await fetch(`${base}/api/health`, { headers })).json();
    assert.equal(result.needsCluster, true);
    code = 'CERT_HAS_EXPIRED';
    assert.equal((await fetch(`${base}/api/health`, { headers })).status, 502);
    assert.equal((await fetch(`${base}/api/cluster/service`)).status, 401);
    assert.equal((await fetch(`${base}/api/cluster/service`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"action":"install"}' })).status, 403);
    assert.equal((await fetch(`${base}/api/cluster/service`, { method: 'POST', headers: { ...headers, Origin: base, 'Content-Type': 'application/json' }, body: '{"action":"start"}' })).status, 202);
  } finally { await new Promise(resolve => app.close(resolve)); }
});

test('本机初始化拒绝已有集群、无效参数并序列化后台安装，安装成功后加载新 kubeconfig', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cluster-service-'));
  const address = Object.values(networkInterfaces()).flat().find(n => n.family === 'IPv4' && !n.internal)?.address;
  if (!address) { await rm(directory, { recursive: true }); return t.skip('需要本机 IPv4'); }
  let existing = true, finish, script, reloaded;
  const service = createClusterService({ directory, isRoot: () => true, exists: async () => existing, reload: file => { reloaded = file; }, run: async (file, args, input) => { script = input; await new Promise(resolve => { finish = resolve; }); } });
  try {
    await assert.rejects(service('POST', { action: 'install', address, version: '1.34.1;id' }), /完整补丁版本/);
    await assert.rejects(service('POST', { action: 'install', address: '203.0.113.1', version: '1.34.1' }), /本机网卡/);
    await assert.rejects(service('POST', { action: 'install', address, version: '1.34.1' }), /已有集群配置/);
    existing = false;
    const first = await service('POST', { action: 'install', address, version: '1.34.1' });
    assert.equal(first.task.status, 'running');
    await assert.rejects(service('POST', { action: 'start' }), /正在执行/);
    for (let i = 0; i < 100 && !finish; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(script.includes('kubeadm init'));
    assert.ok(script.indexOf('[[ ! -e /etc/kubernetes/admin.conf') < script.indexOf('swapoff -a'));
    assert.ok(script.includes('--skip-token-print'));
    finish();
    for (let i = 0; i < 100 && (await service('GET')).task.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await service('GET')).task.status, 'succeeded');
    assert.equal(reloaded, '/etc/kubernetes/admin.conf');
  } finally { finish?.(); await new Promise(resolve => setTimeout(resolve, 20)); await rm(directory, { recursive: true, force: true }); }
});

test('自建仓库校验输入、传递 bundle 配置并过滤分段 Token 和私钥，不持久化密钥', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'registry-service-'));
  let configured;
  const secret = 'registry-secret-123';
  const service = createClusterService({ directory, isRoot: () => true, reload: () => assert.fail('仓库配置不重载 kubeconfig'), configure: async (registry, { run }) => { configured = registry; await run('systemctl', ['restart', 'containerd']); }, run: async (file, args, input, timeout, { onOutput }) => {
    assert.equal(file, 'systemctl');
    assert.equal(input, '');
    onOutput('stdout', 'registry-secret-');
    onOutput('stdout', '123\n-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----\n');
  } });
  try {
    await assert.rejects(service('POST', { action: 'registry', registry: { ip: '1.2.3.4;id', token: secret } }), /IPv4/);
    await assert.rejects(service('POST', { action: 'registry', registry: { ip: '10.0.0.5', token: "x'\nid" } }), /Token/);
    await service('POST', { action: 'registry', registry: { ip: '10.0.0.5', token: secret } });
    for (let i = 0; i < 100 && (await service('GET')).task.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const result = (await service('GET')).task;
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(configured, { ip: '10.0.0.5', protocol: 'https', port: 443, token: secret });
    const { readFile } = await import('node:fs/promises');
    const persisted = await readFile(path.join(directory, 'task.json'), 'utf8');
    assert.ok(!persisted.includes(secret));
    assert.ok(!persisted.includes('secret-material'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('任务错误日志包含未换行的 stderr 诊断并隐藏 Token', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'registry-error-'));
  let record;
  const secret = 'registry-error-secret';
  const service = createClusterService({ directory, isRoot: () => true,
    configure: async (registry, { run }) => run('systemctl', ['restart', 'containerd']),
    logger: { error: (error, details) => { record = details; } },
    run: async (file, args, input, timeout, { onOutput }) => {
      onOutput('stderr', `curl: (22) HTTP 503 Bearer ${secret}`);
      throw new Error('bash 执行失败（退出码 22）');
    },
  });
  try {
    await service('POST', { action: 'registry', registry: { ip: '10.0.0.5', token: secret } });
    for (let i = 0; i < 100 && !(await service('GET')).task.finishedAt; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(record.logs, /curl: \(22\) HTTP 503/);
    assert.ok(!record.logs.includes(secret));
    assert.equal((await service('GET')).task.status, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('带仓库配置的完整安装在安装运行时后直接调用 JS，随后初始化，凭据不进入 shell', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'registry-install-'));
  const address = Object.values(networkInterfaces()).flat().find(n => n.family === 'IPv4' && !n.internal)?.address;
  if (!address) { await rm(directory, { recursive: true }); return t.skip('需要本机 IPv4'); }
  const events = [];
  const secret = 'registry-install-secret';
  const service = createClusterService({ directory, isRoot: () => true, exists: async () => false,
    configure: async registry => { assert.equal(registry.token, secret); events.push('js'); },
    run: async (file, args, input) => {
      assert.ok(!input.includes(secret));
      assert.ok(!input.includes('REGISTRY_TLS_EXPORT_TOKEN'));
      const { execFileSync } = await import('node:child_process');
      execFileSync('bash', ['-n'], { input });
      events.push(input.includes('kubeadm init') ? 'init' : 'runtime');
    },
  });
  try {
    await service('POST', { action: 'install', address, version: '1.34.1', registry: { ip: '10.0.0.20', token: secret } });
    for (let i = 0; i < 100 && (await service('GET')).task.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await service('GET')).task.status, 'succeeded');
    assert.deepEqual(events, ['runtime', 'js', 'init']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('新建集群复用已保存仓库，无需连接 Kubernetes，并保留部署进度', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'saved-registry-cluster-'));
  const calls = [];
  const service = createClusterService({ directory, isRoot: () => true, run: async () => {},
    resolveRegistry: async (id, version) => { assert.equal(id, 'saved'); assert.equal(version, 'v1'); return { id, name: 'saved', url: 'https://lingxi.image.io', hostsIp: '192.168.100.133' }; },
    configureSaved: async (record, body) => { calls.push(body.mode); assert.equal(record.id, 'saved'); assert.equal(body.mapHosts, true); },
  });
  async function done() { for (let i = 0; i < 100 && (await service('GET')).task.status === 'running'; i++) await new Promise(resolve => setTimeout(resolve, 5)); }
  try {
    await service('POST', { action: 'step', step: 'runtime' }); await done();
    const options = { action: 'registry', registryId: 'saved', registryVersion: 'v1', domains: ['ghcr.io'], mapHosts: true, confirm: true };
    await assert.rejects(service('POST', { ...options, confirm: false }), /确认/);
    await service('POST', { ...options, mode: 'hosts' }); await done();
    assert.equal((await service('GET')).task.registryConfigured, false);
    await service('POST', { ...options, mode: 'configure' }); await done();
    const task = (await service('GET')).task;
    assert.equal(task.registryConfigured, true); assert.equal(task.registryId, 'saved');
    assert.equal(task.deployment.steps.find(step => step.id === 'runtime').status, 'succeeded');
    assert.deepEqual(calls, ['hosts', 'configure']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
