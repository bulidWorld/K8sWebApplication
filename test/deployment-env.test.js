import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, symlink, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { validateDeploymentEnvironment } from '../server/deployment-env.js';

const base = { PORT: '3000', K8S_WEB_TOKEN: 'test-token' };
test('首次部署允许无 kubeconfig 或路径尚不存在，仍校验端口、令牌、绝对路径和读取权限', () => {
  assert.deepEqual(validateDeploymentEnvironment(base), { missing: [] });
  const absent = Object.assign(new Error('missing'), { code: 'ENOENT' });
  assert.deepEqual(validateDeploymentEnvironment({ ...base, KUBECONFIG: '/missing/a:/missing/b' }, () => { throw absent; }), { missing: ['/missing/a', '/missing/b'] });
  assert.deepEqual(validateDeploymentEnvironment({ ...base, KUBECONFIG: '/existing' }, () => {}), { missing: [] });
  assert.throws(() => validateDeploymentEnvironment({ ...base, PORT: '65536' }), /PORT/);
  assert.throws(() => validateDeploymentEnvironment({ PORT: '3000' }), /K8S_WEB_TOKEN/);
  assert.throws(() => validateDeploymentEnvironment({ ...base, KUBECONFIG: 'relative' }), /绝对路径/);
  assert.throws(() => validateDeploymentEnvironment({ ...base, KUBECONFIG: '/denied' }, () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), { code: 'EACCES' });
});
test('缺少显式 kubeconfig 返回 NO_CLUSTER，配置补齐后可重读，证书缺失不误判为缺少集群', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kubeconfig-startup-'));
  try {
    await mkdir(path.join(directory, 'server'));
    await copyFile(new URL('../server/kubernetes.js', import.meta.url), path.join(directory, 'server/kubernetes.js'));
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    await symlink(path.resolve('node_modules'), path.join(directory, 'node_modules'));
    const file = path.join(directory, 'missing-config');
    const moduleUrl = pathToFileURL(path.join(directory, 'server/kubernetes.js')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { createKubernetes } from ${JSON.stringify(moduleUrl)};
      const client = createKubernetes();
      await assert.rejects(client.request('/version'), { code: 'NO_CLUSTER' });
      fs.writeFileSync(process.env.KUBECONFIG, JSON.stringify({
        apiVersion: 'v1', kind: 'Config',
        clusters: [{ name: 'cluster', cluster: { server: 'https://127.0.0.1:6443', 'certificate-authority': ${JSON.stringify(path.join(directory, 'missing-ca'))} } }],
        users: [{ name: 'user', user: {} }],
        contexts: [{ name: 'context', context: { cluster: 'cluster', user: 'user' } }],
        'current-context': 'context'
      }));
      assert.equal(client.context(), 'context');
      await assert.rejects(client.request('/version'), { code: 'ENOENT' });
    `], { env: { ...process.env, KUBECONFIG: file }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('deploy.sh 在 kubeconfig 尚不存在时通过环境校验进入服务安装，不触碰系统路径', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deploy-no-cluster-'));
  try {
    for (const file of ['server/index.js', 'server/expansion.js', 'server/expansion-executor.js', 'server/kubernetes.js', 'server/deployment-env.js', 'package.json', 'node_modules/@kubernetes/client-node/package.json', 'dist/index.html', 'deploy/kubescope.service']) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), '');
    }
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    await copyFile(new URL('../server/deployment-env.js', import.meta.url), path.join(directory, 'server/deployment-env.js'));
    await copyFile(new URL('../deploy.sh', import.meta.url), path.join(directory, 'deploy.sh'));
    await writeFile(path.join(directory, '.env'), 'PORT=3000\nK8S_WEB_TOKEN=test-token\n');
    const result = spawnSync('/bin/bash', ['-c', `
      id() { echo 0; }
      chown() { return 0; }
      chmod() { return 0; }
      install() { echo REACHED_SERVICE_INSTALL; return 42; }
      export -f id chown chmod install
      bash "$1"
    `, '_', path.join(directory, 'deploy.sh')], { encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath, KUBECONFIG: path.join(directory, 'missing-kubeconfig') } });
    assert.equal(result.status, 42, result.stderr);
    assert.match(result.stdout, /REACHED_SERVICE_INSTALL/);
    assert.match(result.stderr, /继续部署 Web/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
