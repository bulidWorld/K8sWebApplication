import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createExecutor, validateConfig } from '../server/expansion-executor.js';
import { createApp } from '../server/index.js';
const config = stateDirectory => ({ stateDirectory, socketPath: '/tmp/test-expansion.sock', kubeconfig: '/etc/kubernetes/admin.conf', knownHosts: '/etc/known_hosts', apiServer: 'https://192.168.1.10:6443', kubernetesVersion: '1.34.1', containerdPackageVersion: '1.7.28-0ubuntu1', targets: [{ id: 'worker-02', host: '192.168.1.12', nodeName: 'worker-02', user: 'root', port: 22, identityFile: '/etc/key' }] });
async function waitFor(handle, id, status) {
  for (let i = 0; i < 200; i++) {
    const t = await handle('GET', `/tasks/${id}`);
    if (t.status === status) return t;
    if (t.status === 'failed' && status !== 'failed') assert.fail(t.logs.join('\n'));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`did not reach ${status}`);
}
test('扩容配置拒绝命令注入、重复机器、不受支持的版本', () => {
  const c = config('/tmp/state');
  assert.equal(validateConfig(c), c);
  for (const change of [{ apiServer: 'https://x;id' }, { kubernetesVersion: '1.36.0' }, { targets: [{ ...c.targets[0], host: 'x;id' }] }, { targets: [c.targets[0], { ...c.targets[0], id: 'other' }] }]) assert.throws(() => validateConfig({ ...c, ...change }));
});
test('一次提交 sudo 密码完成预检、安装、入群，凭据不持久化', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'expansion-'));
  const calls = []; let joined = false;
  const token = 'abcdef.0123456789abcdef';
  const mock = async (file, args, input) => {
    calls.push({ file, args, input });
    if (file.endsWith('ssh')) { if (input.includes('kubeadm join --config')) joined = true; return ''; }
    if (args.includes('version')) return JSON.stringify(file.endsWith('kubectl') ? { serverVersion: { gitVersion: 'v1.34.1' } } : { clientVersion: { gitVersion: 'v1.34.1' } });
    if (args.includes('create')) return `kubeadm join 192.168.1.10:6443 --token ${token} --discovery-token-ca-cert-hash sha256:${'a'.repeat(64)}`;
    if (args.includes('nodes')) return JSON.stringify({ items: joined ? [{ metadata: { name: 'worker-02' }, status: { conditions: [{ type: 'Ready', status: 'True' }], addresses: [{ type: 'InternalIP', address: '192.168.1.12' }], allocatable: { cpu: '4' } } }] : [] });
    if (args.includes('pods')) return JSON.stringify({ items: [{ status: { conditions: [{ type: 'Ready', status: 'True' }] } }] });
    return '';
  };
  try {
    const settings = config(dir); settings.targets[0].user = 'ubuntu';
    const handle = await createExecutor(settings, mock);
    await assert.rejects(handle('POST', '/tasks', { targetId: 'unknown' }));
    await assert.rejects(handle('POST', '/tasks', { targetId: 'worker-02', sudoPassword: 'bad\npassword' }), { status: 400 });
    const task = await handle('POST', '/tasks', { targetId: 'worker-02', source: '127.0.0.1', sudoPassword: 'secret-sudo-value', start: true });
    await assert.rejects(handle('POST', '/tasks', { targetId: 'worker-02' }), { status: 409 });
    const done = await waitFor(handle, task.id, 'succeeded');
    assert.equal(done.capacity.cpu, '4');
    // Allow final persistence/token cleanup to finish.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert(calls.some(x => x.args.includes('delete') && x.args.includes('abcdef')));
    const saved = await readFile(path.join(dir, 'tasks.json'), 'utf8');
    assert(!saved.includes(token));
    assert(!saved.includes('secret-sudo-value'));
    assert(!JSON.stringify(await handle('GET', '/targets')).includes('secret-sudo-value'));
    assert(calls.filter(x => x.file.endsWith('ssh')).every(x => x.input.startsWith('secret-sudo-value\n') && !x.args.join(' ').includes('secret-sudo-value')));
    const ssh = calls.find(x => x.file.endsWith('ssh'));
    assert(ssh.args.includes('StrictHostKeyChecking=yes'));
    assert(!calls.some(x => x.args.some(a => a.includes(token))));
    await assert.rejects(handle('POST', `/tasks/${task.id}/start`), { status: 409 });
    const restored = await createExecutor(config(dir), mock);
    assert.equal((await restored('GET', `/tasks/${task.id}`)).status, 'succeeded');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('预检失败不安装，不能跳过失败阶段开始扩容', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'expansion-'));
  try {
    let installs = 0;
    const mock = async (file, args, input) => {
      if (file.endsWith('ssh')) { if (input.includes('apt-get install')) installs++; throw new Error('SSH failed'); }
      if (args.includes('version')) return JSON.stringify(file.endsWith('kubectl') ? { serverVersion: { gitVersion: 'v1.34.1' } } : { clientVersion: { gitVersion: 'v1.34.1' } });
      return '{"items":[]}';
    };
    const handle = await createExecutor(config(dir), mock);
    const t = await handle('POST', '/tasks', { targetId: 'worker-02' });
    await waitFor(handle, t.id, 'failed');
    assert.equal(installs, 0);
    await assert.rejects(handle('POST', `/tasks/${t.id}/start`), { status: 409 });
  } finally { await new Promise(r => setTimeout(r, 30)); await rm(dir, { recursive: true, force: true }); }
});
test('扩容接口强制令牌、同源、请求限制并代理固定路由', async () => {
  const calls = [];
  const app = createApp({ token: 'test-token', expansion: async (...args) => { calls.push(args); return { enabled: true }; } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/expansion/targets`)).status, 401);
    const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${base}/api/expansion/tasks`, { method: 'POST', headers, body: '{}' })).status, 403);
    headers.Origin = 'https://evil.example';
    assert.equal((await fetch(`${base}/api/expansion/tasks`, { method: 'POST', headers, body: '{}' })).status, 403);
    headers.Origin = base;
    assert.equal((await fetch(`${base}/api/expansion/tasks`, { method: 'POST', headers, body: 'x'.repeat(4097) })).status, 413);
    assert.equal((await fetch(`${base}/api/expansion/tasks`, { method: 'POST', headers, body: '{' })).status, 400);
    const ok = await fetch(`${base}/api/expansion/tasks`, { method: 'POST', headers, body: '{"targetId":"worker-02"}' });
    assert.equal(ok.status, 200); assert.equal(calls.length, 1); assert.equal(calls[0][1], '/tasks');
    const edit = await fetch(`${base}/api/expansion/targets/worker-02`, { method: 'POST', headers, body: '{}' });
    assert.equal(edit.status, 200); assert.equal(calls.at(-1)[1], '/targets/worker-02');
  } finally { await new Promise(resolve => app.close(resolve)); }
});
test('重启中断旧预检并保留历史；已注册机器禁止再次初始化', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'expansion-'));
  let registered = false, sshCalls = 0;
  const mock = async (file, args) => {
    if (file.endsWith('ssh')) { sshCalls++; return ''; }
    if (args.includes('version')) return JSON.stringify(file.endsWith('kubectl') ? { serverVersion: { gitVersion: 'v1.34.1' } } : { clientVersion: { gitVersion: 'v1.34.1' } });
    return JSON.stringify({ items: registered ? [{ metadata: { name: 'worker-02' } }] : [] });
  };
  try {
    let handle = await createExecutor(config(dir), mock);
    const first = await handle('POST', '/tasks', { targetId: 'worker-02' });
    await waitFor(handle, first.id, 'checked');
    await new Promise(r => setTimeout(r, 30));
    handle = await createExecutor(config(dir), mock);
    assert.equal((await handle('GET', `/tasks/${first.id}`)).status, 'interrupted');
    await assert.rejects(handle('POST', `/tasks/${first.id}/start`), { status: 409 });
    registered = true;
    const next = await handle('POST', '/tasks', { targetId: 'worker-02' });
    await waitFor(handle, next.id, 'failed');
    assert.equal(sshCalls, 1);
  } finally { await new Promise(r => setTimeout(r, 30)); await rm(dir, { recursive: true, force: true }); }
});

test('sudo 密码只走 SSH 标准输入；特殊字符不执行，错误密码停止脚本', async () => {
  const { sudoInput } = await import('../server/expansion-executor.js');
  const { writeFile, chmod } = await import('node:fs/promises');
  const { spawn } = await import('node:child_process');
  const dir = await mkdtemp(path.join(tmpdir(), 'sudo-input-'));
  try {
    // No authentication cache: each password-mode call must authenticate and execute once.
    const fake = path.join(dir, 'sudo');
    await writeFile(fake, `#!/bin/bash
printf 'call\\n' >> "$SUDO_CALL_LOG"
if [[ "$1" == -S ]]; then
  if [[ "\${SUDO_NO_PASSWORD:-0}" != 1 ]]; then
    IFS= read -r actual
    [[ "$actual" == "$EXPECTED_PASSWORD" ]] || exit 1
  fi
  [[ "$2" == -k && "$3" == -p && "$5" == -- ]] || exit 2
  shift 5
else
  [[ "$1" == -n ]] || exit 2
  shift
fi
exec "$@"
`);
    await chmod(fake, 0o700);
    const password = 'a $() `touch SHOULD_NOT_EXIST` \' " \\ space';
    const invoke = (supplied, noPassword = false) => new Promise((resolve, reject) => {
      const remote = sudoInput('printf "SCRIPT_OK\\n"; if IFS= read -r unexpected; then exit 9; fi', supplied);
      assert(!remote.args.join(' ').includes(password));
      const child = spawn('/bin/bash', ['-c', remote.args.join(' ')], { cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, EXPECTED_PASSWORD: password, SUDO_CALL_LOG: path.join(dir, 'calls'), SUDO_NO_PASSWORD: noPassword ? '1' : '0' } });
      let out = ''; child.stdout.on('data', chunk => out += chunk); child.stderr.resume();
      child.on('error', reject); child.on('close', code => resolve({ code, out })); child.stdin.end(remote.input);
    });
    assert.deepEqual(await invoke(password), { code: 0, out: 'SCRIPT_OK\n' });
    assert.deepEqual(await invoke('incorrect'), { code: 1, out: '' });
    assert.deepEqual(await invoke(password, true), { code: 0, out: 'SCRIPT_OK\n' });
    assert.equal((await readFile(path.join(dir, 'calls'), 'utf8')).trim().split('\n').length, 3);
    await assert.rejects(readFile(path.join(dir, 'SHOULD_NOT_EXIST')), { code: 'ENOENT' });
    assert.deepEqual(sudoInput('id -u', '').args, ['sudo', '-n', 'bash', '-s']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('内置扩容引擎要求 root，只初始化一次，不需要独立服务', async () => {
  const { expansionClient } = await import('../server/expansion.js');
  let created = 0;
  const denied = expansionClient('/config.json', { uid: () => 1000 });
  await assert.rejects(denied('GET', '/targets'), { status: 503 });
  const client = expansionClient('/config.json', { uid: () => 0, load: async () => '{}', create: async () => { created++; return async (method, route) => ({ method, route }); } });
  const replies = await Promise.all([client('GET', '/targets'), client('GET', '/tasks/id')]);
  assert.equal(created, 1); assert.equal(replies[0].route, '/targets');
  assert.equal((await expansionClient('')('GET', '/targets')).enabled, false);
});
