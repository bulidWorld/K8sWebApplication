import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogCollector, redactLog } from '../server/expansion-logs.js';
import { createExecutor, command } from '../server/expansion-executor.js';

test('日志跨包脱敏、UTF8、token、私钥、超长行与无换行尾部', () => {
  assert(!redactLog('{"token":"arbitrary-api-secret"}').includes('arbitrary-api-secret'));
  const lines = [];
  const c = createLogCollector(['sudo-secret'], (source, line) => lines.push(`${source}: ${line}`));
  c.feed('stderr', Buffer.from('错误 sudo-se'));
  assert.equal(lines.length, 0);
  c.feed('stderr', Buffer.from('cret abcdef.012345'));
  c.feed('stderr', Buffer.from('6789abcdef\n'));
  c.feed('stdout', '-----BEGIN PRIVATE KEY-----\nPRIVATE_DATA\n-----END PRIVATE KEY-----\n');
  c.feed('stdout', 'x'.repeat(9000) + '\n');
  const chinese = Buffer.from('安装失败');
  c.feed('stdout', chinese.subarray(0, 2)); c.feed('stdout', chinese.subarray(2));
  c.flush();
  const text = lines.join('\n');
  assert(!text.includes('sudo-secret')); assert(!text.includes('abcdef.0123456789abcdef'));
  assert(!text.includes('PRIVATE_DATA')); assert(text.includes('私钥内容已隐藏'));
  assert(text.includes('超长日志行已省略')); assert(text.includes('安装失败'));
});

test('本机命令 stderr 在失败前回传并保留退出码', async () => {
  const lines = [];
  await assert.rejects(command('/bin/bash', ['-c', 'printf "APT_ERROR\\n" >&2; exit 7'], '', 1000, { onOutput: (stream, data) => lines.push([stream, String(data)]) }), /退出码 7/);
  assert(lines.some(([stream, data]) => stream === 'stderr' && data.includes('APT_ERROR')));
});

test('安装错误实时持久化到 master，失败后回传诊断，日志限长且凭据不落盘', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'expansion-logs-'));
  let release, entered;
  const paused = new Promise(r => release = r), reached = new Promise(r => entered = r);
  const c = { stateDirectory: dir, knownHosts: '/etc/known_hosts', kubeconfig: '/etc/kubernetes/admin.conf', apiServer: 'https://192.168.1.10:6443', kubernetesVersion: '1.34.1', containerdPackageVersion: 'auto', targets: [{ id: 'worker', nodeName: 'worker', host: '192.168.1.12', port: 22, user: 'ubuntu', auth: 'password', hostFingerprint: `SHA256:${'a'.repeat(43)}` }] };
  const local = async (file, args) => args.includes('version') ? JSON.stringify(file.endsWith('kubectl') ? { serverVersion: { gitVersion: 'v1.34.1' } } : { clientVersion: { gitVersion: 'v1.34.1' } }) : '{"items":[]}';
  let diagnostics = false;
  const remote = async (target, script, password, Client, options) => {
    assert.equal(password, 'ssh-secret');
    if (script.input.includes('apt-get install')) {
      options.onOutput('stdout', Buffer.from(Array.from({ length: 450 }, (_, i) => `安装行 ${i}`).join('\n') + '\n'));
      options.onOutput('stderr', Buffer.from('E: 软件源无法连接 sudo-se'));
      options.onOutput('stderr', Buffer.from('cret ssh-secret abcdef.0123456789abcdef\n'));
      entered(); await paused; throw new Error('安装失败（退出码 100）');
    }
    if (script.input.includes('journalctl --no-pager')) {
      diagnostics = true; assert.equal(options.timeout, 30000);
      options.onOutput('stdout', Buffer.from('kubelet: 容器运行时尚未启动\n')); return '';
    }
    options.onOutput('stdout', Buffer.from('预检通过\n')); return '';
  };
  try {
    const handle = await createExecutor(c, local, remote);
    const task = await handle('POST', '/tasks', { targetId: 'worker', start: true, sudoPassword: 'sudo-secret', sshPassword: 'ssh-secret' });
    await reached; await new Promise(r => setTimeout(r, 350));
    let disk = await readFile(path.join(dir, 'tasks.json'), 'utf8');
    assert(disk.includes('软件源无法连接')); assert(!disk.includes('sudo-secret')); assert(!disk.includes('ssh-secret')); assert(!disk.includes('abcdef.0123456789abcdef'));
    release(); let result;
    for (let i = 0; i < 100; i++) {
      const state = await handle('GET', '/targets');
      if (!state.busy) { result = await handle('GET', `/tasks/${task.id}`); break; }
      await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(result.status, 'failed'); assert(result.error.includes('100')); assert(diagnostics);
    assert(result.logs.some(l => l.includes('容器运行时尚未启动'))); assert(result.logsTruncated); assert(result.logs.length <= 400);
    disk = await readFile(path.join(dir, 'tasks.json'), 'utf8'); assert(!disk.includes('sudo-secret')); assert(!disk.includes('ssh-secret'));
  } finally { release(); await rm(dir, { recursive: true, force: true }); }
});
