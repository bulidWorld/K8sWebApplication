import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRegistryMaintenance, validateRegistryRecord, certificateRegistryUrls } from '../server/registry/registry-maintenance.js';
const record = { name: '测试仓库', url: 'https://registry.example.com:5000', username: 'admin', password: 'secret', ca: '', clientCert: '', clientKey: '' };
test('仓库增删改查、持久化、敏感信息和并发版本校验', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'registries-'));
  try {
    const file = path.join(dir, 'registries.json');
    const service = createRegistryMaintenance({ file });
    const { item } = await service('POST', undefined, record);
    assert.equal(item.hasPassword, true); assert.equal(item.password, undefined); assert.equal(item.clientKey, undefined);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await createRegistryMaintenance({ file })('GET')).items.length, 1);
    await assert.rejects(service('POST', undefined, record), /已存在/);
    await assert.rejects(service('PATCH', item.id, { ...record, version: 'stale' }), /重新加载/);
    const updated = (await service('PATCH', item.id, { ...record, name: '新名称', password: '', version: item.version })).item;
    assert.equal(JSON.parse(await readFile(file))[0].password, 'secret');
    const cleared = (await service('PATCH', item.id, { ...record, password: '', clearPassword: true, version: updated.version })).item;
    assert.equal(cleared.hasPassword, false);
    await service('DELETE', item.id, { version: cleared.version });
    assert.equal((await service('GET')).items.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('保存任务立即返回，并逐步提供 hosts 同步日志和结果', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'registry-save-task-'));
  let finish;
  try {
    const service = createRegistryMaintenance({ file: path.join(dir, 'registries.json'), syncHosts: async (_record, log) => {
      log('本机 hosts 同步完成');
      await new Promise(resolve => { finish = resolve; });
      log('工作节点 worker-a 同步完成');
      return { success: true, nodes: [{ node: 'worker-a', success: true }] };
    } });
    const { task } = await service('POST', undefined, record);
    assert.equal(task.status, 'running');
    await new Promise(resolve => setImmediate(resolve));
    assert.match((await service('SAVE_STATUS', undefined, { taskId: task.id })).task.logs.join('\n'), /本机 hosts 同步完成/);
    finish();
    await new Promise(resolve => setImmediate(resolve));
    const done = (await service('SAVE_STATUS', undefined, { taskId: task.id })).task;
    assert.equal(done.status, 'succeeded');
    assert.match(done.logs.join('\n'), /worker-a/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('拒绝无效仓库地址和证书配置', () => {
  for (const url of ['file:///etc/passwd', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?x=1']) assert.throws(() => validateRegistryRecord({ ...record, url }));
  assert.throws(() => validateRegistryRecord({ ...record, ca: 'invalid' }), /PEM/);
  assert.throws(() => validateRegistryRecord({ ...record, clientCert: 'invalid' }), /同时配置/);
  assert.throws(() => validateRegistryRecord({ ...record, url: 'http://example.com', ca: 'invalid' }), /HTTPS/);
});

test('客户端证书与私钥配对校验', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'registry-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=client', '-addext', 'subjectAltName=DNS:registry-1.docker.io,DNS:docker.io,DNS:ghcr.io,DNS:registry.k8s.io,DNS:localhost,DNS:lingxi.image.io,IP:127.0.0.1,IP:192.168.100.133', '-keyout', path.join(dir, 'key'), '-out', path.join(dir, 'cert')], { stdio: 'ignore', timeout: 10000 });
    const clientCert = await readFile(path.join(dir, 'cert'), 'utf8');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=mirror', '-addext', 'subjectAltName=DNS:mirror.example.com', '-keyout', path.join(dir, 'mirror-key'), '-out', path.join(dir, 'mirror-cert')], { stdio: 'ignore', timeout: 10000 });
    const mirrorCert = await readFile(path.join(dir, 'mirror-cert'), 'utf8');
    const combined = validateRegistryRecord({ ...record, url: 'https://lingxi.image.io', urls: ['https://lingxi.image.io', 'https://mirror.example.com'], ca: `${clientCert}\n${mirrorCert}` });
    assert.match(combined.subjectAltName, /DNS:lingxi.image.io/);
    assert.match(combined.subjectAltName, /DNS:mirror.example.com/);
    assert.ok(certificateRegistryUrls(`${clientCert}\n${mirrorCert}`).includes('https://mirror.example.com'));
    assert.deepEqual(certificateRegistryUrls(clientCert), ['https://registry-1.docker.io', 'https://docker.io', 'https://ghcr.io', 'https://registry.k8s.io', 'https://lingxi.image.io', 'https://192.168.100.133']);
    assert.deepEqual((await createRegistryMaintenance({ file: path.join(dir, 'parse.json') })('PARSE_CERTIFICATE', undefined, { certificate: clientCert })).urls, certificateRegistryUrls(clientCert));
    assert.deepEqual(validateRegistryRecord({ ...record, urls: ['https://registry.example.com:5000', 'https://ghcr.io'] }).urls, ['https://registry.example.com:5000', 'https://ghcr.io']);
    const clientKey = await readFile(path.join(dir, 'key'), 'utf8');
    assert.equal(validateRegistryRecord({ ...record, url: 'https://lingxi.image.io', ca: clientCert, clientCert, clientKey }).clientKey, clientKey);
    const subjectAltName = 'DNS:registry-1.docker.io,DNS:docker.io,DNS:ghcr.io,DNS:registry.k8s.io,DNS:localhost,DNS:lingxi.image.io,IP:127.0.0.1,IP:192.168.100.133';
    const server = { ...record, url: 'https://lingxi.image.io', subjectAltName, serverCert: clientCert, serverKey: clientKey };
    assert.equal(validateRegistryRecord(server).subjectAltName, subjectAltName);
    assert.throws(() => validateRegistryRecord({ ...server, subjectAltName: 'DNS:missing.example.com' }), /未覆盖/);
    assert.throws(() => validateRegistryRecord({ ...server, subjectAltName: 'IP:192.168.100.134' }), /未覆盖/);
    assert.throws(() => validateRegistryRecord({ ...server, subjectAltName: 'IP:not-ip' }), /SAN 地址/);
    const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    assert.throws(() => validateRegistryRecord({ ...record, clientCert, clientKey: otherKey }), /不匹配/);
    assert.throws(() => validateRegistryRecord({ ...server, serverKey: otherKey }), /不匹配/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('下发后台任务、状态查询和并发任务限制', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'registry-task-'));
  let finish;
  try {
    const service = createRegistryMaintenance({ file: path.join(dir, 'registries.json'), distribute: async (_record, _body, { onProgress }) => { onProgress('worker-a：正在更新系统证书'); return new Promise(resolve => { finish = resolve; }); } });
    const { item } = await service('POST', undefined, record);
    const { task } = await service('DISTRIBUTE', item.id, { version: item.version });
    assert.equal(task.status, 'running');
    await new Promise(resolve => setImmediate(resolve));
    assert.match((await service('DISTRIBUTION_STATUS', item.id, { taskId: task.id })).task.logs.join('\n'), /正在更新系统证书/);
    await assert.rejects(service('DISTRIBUTE', item.id, { version: item.version }), /正在执行/);
    finish({ results: [{ node: 'node-a', success: true }] });
    await new Promise(resolve => setImmediate(resolve));
    const status = (await service('DISTRIBUTION_STATUS', item.id, { taskId: task.id })).task;
    assert.equal(status.status, 'completed'); assert.equal(status.results[0].node, 'node-a');
    await assert.rejects(service('DISTRIBUTION_STATUS', 'other-id', { taskId: task.id }), /不存在/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('原安装向导证书接口复用于保存的仓库，仅持久化公共证书', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'registry-import-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=registry', '-addext', 'subjectAltName=DNS:registry.example.com', '-keyout', path.join(dir, 'key'), '-out', path.join(dir, 'cert')], { stdio: 'ignore', timeout: 10000 });
    const certificate = await readFile(path.join(dir, 'cert'), 'utf8');
    const file = path.join(dir, 'records.json');
    const service = createRegistryMaintenance({ file, requestBundle: async input => {
      assert.equal(input.ip, '192.168.100.133'); assert.equal(input.token, 'ONE-TIME-TOKEN');
      assert.equal(input.port, 80); return { certificate, privateKey: 'EXPORTED-SERVER-PRIVATE-KEY' };
    } });
    const { item } = await service('POST', undefined, { ...record, hostsIp: '192.168.100.133' });
    const result = await service('IMPORT_CERTIFICATES', item.id, { version: item.version, protocol: 'http', port: 80, token: 'ONE-TIME-TOKEN' });
    assert.equal(result.item.ca, certificate.trim()); assert.equal(result.item.hasServerKey, false);
    const persisted = await readFile(file, 'utf8');
    assert.doesNotMatch(persisted, /EXPORTED-SERVER-PRIVATE-KEY|ONE-TIME-TOKEN/);
    await assert.rejects(service('RESOLVE', item.id, { version: item.version }), /重新加载/);
    const resolved = await service('RESOLVE', item.id, { version: result.item.version });
    assert.equal(resolved.hostsIp, '192.168.100.133');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
