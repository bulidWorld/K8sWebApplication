import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expansionClient } from '../server/expansion.js';
import { createExecutor } from '../server/expansion-executor.js';
const settings = { kubeconfig: '/etc/kubernetes/admin.conf', apiServer: 'https://192.168.1.10:6443', kubernetesVersion: '1.34.1', containerdPackageVersion: 'auto' };
const machine = { host: '192.168.1.12', port: 22, user: 'ubuntu', nodeName: 'worker-02' };
const fingerprint = `SHA256:${'a'.repeat(43)}`;

test('首次页面初始化自动创建目录和配置；指纹绑定目标；配置可重载', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'expansion-setup-'));
  const configPath = path.join(dir, 'new', 'config.json');
  let scanCount = 0;
  const options = { uid: () => 0, discover: async () => settings, probe: async () => { scanCount++; return fingerprint; } };
  try {
    const client = expansionClient(configPath, options);
    assert.equal((await client('GET', '/targets')).needsSetup, true);
    assert.equal((await client('GET', '/settings')).initialized, false);
    assert.deepEqual((await client('POST', '/discover', {})).settings, settings);
    await assert.rejects(client('POST', '/settings', { ...settings, kubernetesVersion: 'bad' }));
    await client('POST', '/settings', { ...settings, sudoPassword: 'not-saved' });
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700);
    assert.equal((await client('GET', '/targets')).targets.length, 0);
    const proof = await client('POST', '/probe', machine);
    assert.equal(proof.hostFingerprint, fingerprint);
    await assert.rejects(client('POST', '/targets', { ...machine, ...proof, host: '192.168.1.13' }), { status: 409 });
    await client('POST', '/targets', { ...machine, ...proof, sshPassword: 'not-saved' });
    const state = await client('GET', '/targets');
    assert.equal(state.targets[0].auth, 'password');
    assert.equal(scanCount, 1);
    const disk = await readFile(configPath, 'utf8');
    assert(!disk.includes('not-saved')); assert(!disk.includes('sshPassword')); assert(!disk.includes('sudoPassword'));
    const reloaded = expansionClient(configPath, options);
    assert.equal((await reloaded('GET', '/targets')).targets[0].host, machine.host);
    await assert.rejects(reloaded('POST', '/targets', { ...machine, ...proof }), { status: 409 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('任务执行中禁止修改配置；页面密码登录任务不持久化凭据', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'expansion-password-'));
  const configPath = path.join(dir, 'config.json');
  let release, entered;
  const blocked = new Promise(r => { release = r; });
  const remoteStarted = new Promise(r => { entered = r; });
  const credentials = [];
  const client = expansionClient(configPath, { uid: () => 0, probe: async () => fingerprint,
    create: c => createExecutor(c, async (file, args) => {
      if (args.includes('version')) return JSON.stringify(file.endsWith('kubectl') ? { serverVersion: { gitVersion: 'v1.34.1' } } : { clientVersion: { gitVersion: 'v1.34.1' } });
      return '{"items":[]}';
    }, async (t, remote, password) => { credentials.push({ remote, password }); entered(); await blocked; throw new Error('模拟权限失败'); }),
  });
  try {
    await client('POST', '/settings', settings);
    const proof = await client('POST', '/probe', machine);
    await client('POST', '/targets', { ...machine, ...proof });
    await assert.rejects(client('POST', '/tasks', { targetId: machine.nodeName, start: true }), { status: 400 });
    const task = await client('POST', '/tasks', { targetId: machine.nodeName, start: true, sshPassword: 'login-secret', sudoPassword: 'sudo-secret' });
    await remoteStarted;
    await assert.rejects(client('POST', '/settings', settings), { status: 409 });
    await assert.rejects(client('POST', '/probe', machine), { status: 409 });
    await assert.rejects(client('POST', `/targets/${machine.nodeName}`, machine), /任务执行中/);
    assert.equal(credentials[0].password, 'login-secret');
    assert(credentials[0].remote.input.startsWith('sudo-secret\n'));
    release();
    for (let i = 0; i < 100; i++) {
      const state = await client('GET', '/targets');
      if (!state.busy) break;
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal((await client('GET', `/tasks/${task.id}`)).status, 'failed');
    const current = (await client('GET', '/targets')).targets[0];
    await client('POST', `/targets/${current.id}`, { ...machine, nodeName: 'worker-renamed', user: 'otheruser', revision: current.revision });
    const historical = await client('GET', `/tasks/${task.id}`);
    assert.equal(historical.target.nodeName, machine.nodeName); assert.equal(historical.target.user, machine.user);
    const disk = await readFile(path.join(dir, 'tasks', 'tasks.json'), 'utf8');
    assert(!disk.includes('login-secret')); assert(!disk.includes('sudo-secret'));
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});

test('修改目标保留 ID 与指纹；拦截过期版本、重复名称；持久化新参数', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'expansion-edit-'));
  const file = path.join(dir, 'config.json');
  const client = expansionClient(file, { uid: () => 0, probe: async () => fingerprint });
  try {
    await client('POST', '/settings', settings);
    const proof = await client('POST', '/probe', machine);
    const { target: original } = await client('POST', '/targets', { ...machine, ...proof });
    const edited = { ...machine, user: 'administrator', nodeName: 'worker-renamed', revision: original.revision };
    const { target: saved } = await client('POST', `/targets/${original.id}`, edited);
    assert.equal(saved.id, original.id); assert.equal(saved.nodeName, 'worker-renamed'); assert.equal(saved.user, 'administrator');
    assert.equal(saved.hostFingerprint, fingerprint); assert.notEqual(saved.revision, original.revision);
    await assert.rejects(client('POST', `/targets/${original.id}`, edited), { status: 409 });
    await assert.rejects(client('POST', '/targets/missing', edited), { status: 404 });
    const other = { ...machine, host: '192.168.1.13', nodeName: 'another-worker' };
    const otherProof = await client('POST', '/probe', other);
    await client('POST', '/targets', { ...other, ...otherProof });
    await assert.rejects(client('POST', `/targets/${saved.id}`, { ...edited, nodeName: other.nodeName, revision: saved.revision }), { status: 400 });
    const disk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(disk.targets[0].nodeName, saved.nodeName); assert.equal(disk.targets[0].id, original.id);
    const restored = expansionClient(file, { uid: () => 0 });
    assert.equal((await restored('GET', '/targets')).targets[0].user, 'administrator');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('修改 IP 或端口必须重新确认绑定新目标的指纹', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'expansion-edit-host-'));
  const client = expansionClient(path.join(dir, 'config.json'), { uid: () => 0, probe: async () => fingerprint });
  try {
    await client('POST', '/settings', settings);
    const proof = await client('POST', '/probe', machine);
    const { target: saved } = await client('POST', '/targets', { ...machine, ...proof });
    const changed = { ...machine, host: '192.168.1.14', port: 2222, revision: saved.revision };
    await assert.rejects(client('POST', `/targets/${saved.id}`, changed), { status: 409 });
    await assert.rejects(client('POST', `/targets/${saved.id}`, { ...changed, ...proof }), { status: 409 });
    const fresh = await client('POST', '/probe', changed);
    const { target: updated } = await client('POST', `/targets/${saved.id}`, { ...changed, ...fresh });
    assert.equal(updated.id, saved.id); assert.equal(updated.host, changed.host); assert.equal(updated.port, 2222);
    assert.equal((await client('GET', '/targets')).tasks.length, 0); // Saving never starts expansion.
  } finally { await rm(dir, { recursive: true, force: true }); }
});
