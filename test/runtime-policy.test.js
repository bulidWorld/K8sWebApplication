import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../server/expansion-executor.js';
const policy = fileURLToPath(new URL('../server/provision/runtime-policy.sh', import.meta.url));
const invoke = (name, ...args) => spawnSync('/bin/bash', ['-c', 'source "$1"; shift; "$@"', '_', policy, name, ...args], { encoding: 'utf8' });

test('Ubuntu LTS 版本识别覆盖 26.04 和维护版本，拒绝其他发行版及版本', () => {
  for (const version of ['22.04', '22.04.5', '24.04', '24.04.3', '26.04', '26.04.1']) assert.equal(invoke('kubescope_supported_ubuntu', 'ubuntu', version).status, 0, version);
  for (const [id, version] of [['debian', '26.04'], ['ubuntu', '20.04'], ['ubuntu', '25.10'], ['ubuntu', '26.10'], ['ubuntu', '26.04;id']]) assert.notEqual(invoke('kubescope_supported_ubuntu', id, version).status, 0);
});

test('containerd 自动模式按候选选择 1.x/2.x，支持固定包版本并拒绝无效候选', () => {
  for (const candidate of ['1.7.28-0ubuntu1', '2.2.2-0ubuntu1.2']) {
    const result = invoke('kubescope_containerd_package_version', 'auto', candidate);
    assert.equal(result.status, 0); assert.equal(result.stdout.trim(), candidate);
  }
  assert.equal(invoke('kubescope_containerd_package_version', '2.2.2-0ubuntu1', '1.7.28-0ubuntu1').stdout.trim(), '2.2.2-0ubuntu1');
  for (const candidate of ['(none)', '', '3.0.0-1', '2.2.2;id']) {
    const result = invoke('kubescope_containerd_package_version', 'auto', candidate);
    assert.notEqual(result.status, 0); assert(result.stderr.includes('无法选择 containerd'));
  }
  const base = { stateDirectory: '/tmp/test', knownHosts: '/tmp/known_hosts', kubeconfig: '/tmp/kubeconfig', apiServer: 'https://192.168.1.10:6443', kubernetesVersion: '1.34.1', targets: [] };
  for (const version of ['auto', '1.7.28-0ubuntu1', '2.2.2-0ubuntu1.2']) assert(validateConfig({ ...base, containerdPackageVersion: version }));
  assert.throws(() => validateConfig({ ...base, containerdPackageVersion: '3.0.0-1' }));
});

test('umask 077 下修复 APT 公钥和源文件权限，包括失败后重试的遗留文件', async () => {
  const { mkdtemp, mkdir, writeFile, stat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'kubescope-apt-mode-'));
  try {
    await mkdir(path.join(dir, 'keyrings'), { mode: 0o700 });
    await mkdir(path.join(dir, 'sources.list.d'), { mode: 0o700 });
    const key = path.join(dir, 'keyrings/kubernetes-apt-keyring.gpg');
    const source = path.join(dir, 'sources.list.d/kubernetes.list');
    await writeFile(key, 'public key fixture', { mode: 0o600 });
    await writeFile(source, 'deb fixture', { mode: 0o600 });
    const result = spawnSync('/bin/bash', ['-c', 'umask 077; source "$1"; kubescope_prepare_apt_permissions "$2"', '_', policy, dir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const folder of ['keyrings', 'sources.list.d']) assert.equal((await stat(path.join(dir, folder))).mode & 0o777, 0o755);
    for (const file of [key, source]) assert.equal((await stat(file)).mode & 0o777, 0o644);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Kubernetes 版本选择读取全部管道输出，避免 pipefail 下 SIGPIPE 141', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'kubescope-pipefail-'));
  try {
    const marker = path.join(dir, 'producer-completed');
    const result = spawnSync('/bin/bash', ['-c', `set -euo pipefail
source "$1"
{
  printf 'kubeadm | 1.34.10-1.1 | repo\\n'
  for ((i=0;i<20000;i++)); do printf 'kubeadm | 1.34.1-1.1 | repo\\n'; done
  printf completed > "$2"
} | kubescope_select_kubernetes_package_version 1.34.1
`, '_', policy, marker], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '1.34.1-1.1');
    assert.equal(await readFile(marker, 'utf8'), 'completed');
    const missing = spawnSync('/bin/bash', ['-c', 'source "$1"; printf "kubeadm | 1.34.10-1.1 | repo\\n" | kubescope_select_kubernetes_package_version 1.34.1', '_', policy], { encoding: 'utf8' });
    assert.equal(missing.status, 0); assert.equal(missing.stdout, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
