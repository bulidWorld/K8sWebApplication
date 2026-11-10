import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRegistryNodeAccess } from '../server/registry/registry-node-access.js';
import { registryRemoteScript } from '../server/registry/registry-remote-script.js';

test('节点登录配置核对指纹、限制读取密码并检查节点 IP', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'registry-access-'));
  let host = '192.168.1.10';
  try {
    const file = path.join(root, 'access.json');
    const service = createRegistryNodeAccess({ file, kubernetes: { request: async () => ({ items: [{ metadata: { name: 'worker-01' }, status: { addresses: [{ type: 'InternalIP', address: host }] } }] }) }, probe: async () => 'SHA256:confirmed' });
    const checked = await service.probe({ nodeName: 'worker-01', port: 22, user: 'root' });
    await assert.rejects(service.save({ nodeName: 'worker-01', port: 22, user: 'root', auth: 'password', loginPassword: 'secret', sudoPassword: '', probeId: checked.probeId, fingerprint: 'wrong' }), /指纹/);
    const { item } = await service.save({ nodeName: 'worker-01', port: 22, user: 'root', auth: 'password', loginPassword: 'secret', sudoPassword: '', probeId: checked.probeId, fingerprint: checked.fingerprint });
    assert.equal(item.loginPassword, undefined);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await service.resolve('worker-01')).loginPassword, 'secret');
    host = '192.168.1.11';
    await assert.rejects(service.resolve('worker-01'), /IP 已变化/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('添加节点时复用已确认的扩容目标并保存 SSH 与 sudo 信息', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'registry-expansion-access-'));
  try {
    const service = createRegistryNodeAccess({ file: path.join(root, 'access.json'), expansion: async (method, _route, body) => {
      assert.equal(method, 'RESOLVE_TARGET'); assert.equal(body.revision, 'revision-1');
      return { nodeName: 'worker-02', host: '192.168.1.12', port: 22, user: 'ubuntu', auth: 'password', hostFingerprint: 'SHA256:confirmed' };
    } });
    const result = await service.importExpansion({ nodeName: 'worker-02', revision: 'revision-1', sshPassword: 'ssh-secret', sudoPassword: 'sudo-secret' });
    assert.equal(result.item.loginPassword, undefined);
    const saved = JSON.parse(await readFile(path.join(root, 'access.json'), 'utf8'))[0];
    assert.equal(saved.loginPassword, 'ssh-secret'); assert.equal(saved.sudoPassword, 'sudo-secret');
    assert.equal((await stat(path.join(root, 'access.json'))).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('宿主机脚本直接修改 hosts 并报告详细步骤', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'registry-ssh-script-'));
  try {
    await mkdir(path.join(root, 'etc')); await mkdir(path.join(root, 'run'));
    await writeFile(path.join(root, 'etc/hosts'), '127.0.0.1 localhost\n10.0.0.1 registry.example.com\n');
    const script = registryRemoteScript({ root, mode: 'hosts', hostsOnly: true, mapHosts: true, hostsIp: '192.168.1.10', hostsDomains: ['registry.example.com'], backupId: 'test' });
    const output = execFileSync('bash', ['-s'], { input: script, encoding: 'utf8' });
    assert.match(output, /LOG:.*hosts 映射已更新/);
    assert.match(output, /RESULT:/);
    assert.match(await readFile(path.join(root, 'etc/hosts'), 'utf8'), /192.168.1.10\tregistry.example.com/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('宿主机脚本为镜像源写入证书与备用入口配置', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'registry-ssh-config-'));
  try {
    await mkdir(path.join(root, 'etc/containerd'), { recursive: true }); await mkdir(path.join(root, 'run'));
    await writeFile(path.join(root, 'etc/containerd/config.toml'), 'version = 2\n');
    const script = registryRemoteScript({ root, registryId: 'sample', backupId: 'test', mapHosts: false, hostsOnly: false, trustOnly: false, ca: 'PUBLIC-CERT', urls: ['https://registry.example.com', 'https://mirror.example.com'], domains: ['docker.io'] });
    const output = execFileSync('bash', ['-s'], { input: script, encoding: 'utf8' });
    assert.match(output, /LOG:配置镜像源 docker.io/);
    const hosts = await readFile(path.join(root, 'etc/containerd/certs.d/docker.io/hosts.toml'), 'utf8');
    assert.match(hosts, /https:\/\/registry.example.com/);
    assert.match(hosts, /https:\/\/mirror.example.com/);
    assert.match(await readFile(path.join(root, 'etc/containerd/config.toml'), 'utf8'), /config_path = "\/etc\/containerd\/certs.d"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('宿主机脚本将公共证书安装到系统信任目录', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'registry-ssh-trust-'));
  try {
    await mkdir(path.join(root, 'run'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=registry', '-keyout', path.join(root, 'key'), '-out', path.join(root, 'cert')], { stdio: 'ignore' });
    const ca = await readFile(path.join(root, 'cert'), 'utf8');
    const script = registryRemoteScript({ root, registryId: 'sample', backupId: 'trust', mapHosts: false, hostsOnly: false, trustOnly: true, ca });
    const output = execFileSync('bash', ['-s'], { input: script, encoding: 'utf8' });
    assert.match(output, /LOG:刷新系统 CA 信任/);
    assert.match(await readFile(path.join(root, 'usr/local/share/ca-certificates/kubescope-registry-sample-1.crt'), 'utf8'), /BEGIN CERTIFICATE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
