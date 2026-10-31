import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createClusterService } from '../server/cluster-service.js';
import { deploymentSteps, deploymentScript } from '../server/cluster-steps.js';

async function settled(service) {
  for (let i = 0; i < 200; i++) {
    const { task } = await service('GET');
    if (task.status !== 'running') {
      await new Promise(resolve => setTimeout(resolve, 15));
      return task;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('任务未完成');
}
test('每步生成独立可解析脚本；运行时和工具安装隔离；初始化重试不 reset', async () => {
  for (const step of deploymentSteps.filter(step => !['images', 'pull-images'].includes(step.id))) {
    const script = await deploymentScript(step.id);
    assert.equal(spawnSync('/bin/bash', ['-n'], { input: script, encoding: 'utf8' }).status, 0, step.id);
    assert.match(script, /flock -n 9/);
    if (step.id === 'runtime') {
      assert.match(script, /KUBESCOPE_INSTALL_PHASE=runtime/);
      assert.ok(script.indexOf('6443 端口已占用') < script.indexOf('swapoff -a'));
      assert.doesNotMatch(script, /kubeadm init/);
    }
    if (step.id === 'packages') {
      assert.match(script, /KUBESCOPE_INSTALL_PHASE=packages/);
      assert.match(script, /kubectl=\$PACKAGE_VERSION/);
      assert.doesNotMatch(script, /kubeadm init/);
    }
    if (step.id === 'init') {
      assert.match(script, /不重复执行 kubeadm init/);
      assert.doesNotMatch(script, /kubeadm reset/);
    }
  }
});
test('部署按序手动推进、失败不进入下一步、可重试、持久化恢复且锁定配置', async t => {
  const address = Object.values(networkInterfaces()).flat().find(n => n.family === 'IPv4' && !n.internal)?.address;
  if (!address) return t.skip('需要本机 IPv4');
  const directory = await mkdtemp(path.join(tmpdir(), 'cluster-steps-'));
  const base = { action: 'step', version: '1.34.1', address };
  let packageFailure = true, reloads = 0;
  const scripts = [];
  const options = {
    directory, isRoot: () => true, exists: async () => false,
    reload: async () => { reloads++; },
    fetchManifest: async () => ({ ok: true, text: async () => 'kind: Pod\nspec:\n  containers:\n  - image: ghcr.io/flannel-io/flannel:v0.26.7\n' }),
    run: async (file, args, input, timeout, hooks) => {
      if (file === '/usr/bin/kubeadm') return 'registry.k8s.io/pause:3.10\n';
      scripts.push(input);
      hooks?.onOutput('stdout', 'step output\n');
      if (input.includes('KUBESCOPE_INSTALL_PHASE=packages') && packageFailure) throw new Error('包安装失败');
    },
  };
  let service = createClusterService(options);
  try {
    await assert.rejects(service('POST', { ...base, step: 'packages' }), /从安装 containerd/);
    await service('POST', { action: 'step', step: 'runtime' });
    await assert.rejects(service('POST', { ...base, step: 'packages' }), /正在执行/);
    let task = await settled(service);
    assert.equal(task.deployment.steps[0].status, 'succeeded');
    assert.equal(task.deployment.steps[1].status, 'pending');
    assert.equal(scripts.length, 1);
    assert.equal(task.deployment.version, undefined);
    assert.equal(task.deployment.address, undefined);
    assert.doesNotMatch(scripts[0], /export (K8S_VERSION|TARGET_IP)=/);
    await service('POST', { action: 'step', step: 'runtime' });
    assert.equal((await settled(service)).status, 'succeeded');
    await assert.rejects(service('POST', { ...base, step: 'init' }), /按顺序/);
    await assert.rejects(service('POST', { action: 'step', step: 'packages' }), /完整补丁版本/);
    await service('POST', { ...base, step: 'packages' });
    task = await settled(service);
    assert.equal(task.deployment.steps[1].status, 'failed');
    assert.equal(task.deployment.version, base.version);
    assert.equal(task.deployment.address, undefined);
    await assert.rejects(service('POST', { ...base, version: '1.33.1', step: 'packages' }), /不允许修改/);
    await assert.rejects(service('POST', { ...base, step: 'images' }), /按顺序/);
    packageFailure = false;
    service = createClusterService(options);
    assert.equal((await service('GET')).task.deployment.steps[1].status, 'failed');
    for (const step of deploymentSteps.slice(1)) {
      await service('POST', { action: 'step', step: step.id, ...(step.id === 'packages' ? { version: base.version } : {}), ...(step.id === 'init' ? { address } : {}) });
      task = await settled(service);
      assert.equal(task.status, 'succeeded', task.error);
      if (step.id === 'images') {
        assert.ok(task.images.every(image => image.status === 'untested'));
        assert.equal(task.deployment.steps.find(item => item.id === 'pull-images').status, 'pending');
        assert.ok(!scripts.some(script => script.includes('images check --quiet')));
      }
    }
    assert.equal(reloads, 1);
    assert.ok(task.deployment.steps.every(step => step.status === 'succeeded'));
    assert.match(task.deployment.steps[0].logs.join(''), /step output/);
    assert.equal(task.images.length, 2);
    const imageScript = scripts.find(script => script.includes('images check --quiet'));
    assert.ok(imageScript);
    for (const cached of [true, false]) {
      const result = spawnSync('/bin/bash', ['-s'], {
        input: `ctr() { case "$*" in *'images check'*) ${cached ? "echo 'registry.k8s.io/pause:3.10'" : ':'} ;; *'images pull'*) echo 'PULL_CALLED' ;; *) return 99 ;; esac; }\n` + imageScript.replaceAll('/run/kubescope-cluster.lock', `${directory}/images.lock`),
        encoding: 'utf8', timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.includes('PULL_CALLED'), !cached);
    }
    for (const step of deploymentSteps) {
      await service('POST', { ...base, step: step.id });
      assert.equal((await settled(service)).status, 'succeeded');
    }
    await assert.rejects(service('POST', { ...base, step: 'init', address: '203.0.113.1' }), /本机网卡/);
    assert.equal((await service('GET')).task.deployment.address, address);
    // A service restart must not treat an interrupted step as completed.
    const stored = JSON.parse(await readFile(path.join(directory, 'task.json'), 'utf8'));
    stored.status = 'running';
    stored.deployment.steps.find(step => step.id === 'verify').status = 'running';
    await writeFile(path.join(directory, 'task.json'), JSON.stringify(stored));
    const restarted = createClusterService(options);
    assert.equal((await restarted('GET')).task.deployment.steps.find(step => step.id === 'verify').status, 'interrupted');
    await restarted('POST', { ...base, step: 'verify' });
    assert.equal((await settled(restarted)).deployment.steps.find(step => step.id === 'verify').status, 'succeeded');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('已有组件重复执行只做校验，不重装或覆盖配置；版本冲突明确失败', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cluster-repeat-'));
  try {
    const run = async (step, mocks, version = '1.34.1') => {
      // Redirect absolute host paths even if a regression reaches an unexpected branch.
      const script = (await deploymentScript(step)).replaceAll('/run/', `${directory}/`).replaceAll('/etc/', `${directory}/etc/`).replaceAll('/var/', `${directory}/var/`);
      return spawnSync('/bin/bash', ['-s'], {
        input: `export K8S_VERSION=${version}\n${mocks}\n${script}`,
        encoding: 'utf8', timeout: 5000,
      });
    };
    const runtimeMocks = `
containerd() { if [[ "$1" == --version ]]; then echo 'containerd 1.7.24'; else echo 'SystemdCgroup = true'; fi; }
systemctl() { echo "systemctl $*"; }
ctr() { echo 'io.containerd.grpc.v1 cri linux/amd64 ok'; }
apt-get() { echo 'unexpected package install' >&2; return 99; }
`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await run('runtime', runtimeMocks);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /保留现有配置/);
      assert.doesNotMatch(result.stdout, /restart/);
    }
    const badRuntime = await run('runtime', runtimeMocks.replace('SystemdCgroup = true', 'SystemdCgroup = false'));
    assert.notEqual(badRuntime.status, 0);
    assert.match(badRuntime.stderr, /未启用 SystemdCgroup/);
    const toolsMocks = `
dpkg-query() { echo 'install ok installed 1.34.1-1.1'; }
kubeadm() { :; }
kubelet() { :; }
kubectl() { :; }
systemctl() { :; }
apt-get() { echo 'unexpected package install' >&2; return 99; }
`;
    const installed = await run('packages', toolsMocks);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /保留现有安装/);
    const conflict = await run('packages', toolsMocks, '1.33.1');
    assert.notEqual(conflict.status, 0);
    assert.match(conflict.stderr, /版本.*不一致/);
    const network = await run('network', `
kubectl() {
  case "$*" in
    *'get daemonset'*) echo 'daemonset.apps/kube-flannel-ds' ;;
    *'rollout status'*) echo 'ready' ;;
    *) echo 'unexpected network mutation' >&2; return 99 ;;
  esac
}
`);
    assert.equal(network.status, 0, network.stderr);
    assert.match(network.stdout, /Flannel 已安装/);
    await mkdir(path.join(directory, 'etc/kubernetes/manifests'), { recursive: true });
    await writeFile(path.join(directory, 'etc/kubernetes/admin.conf'), 'existing config');
    await writeFile(path.join(directory, 'etc/kubernetes/manifests/kube-apiserver.yaml'), '    - --advertise-address=192.168.1.10\n');
    const initMocks = `
export TARGET_IP=192.168.1.10
kubectl() { case "$*" in *'get configmap'*) echo 'kubernetesVersion: v1.34.1' ;; *'/readyz'*) echo ok ;; *) return 99 ;; esac; }
kubeadm() { echo 'unexpected initialization' >&2; return 99; }
`;
    const initialized = await run('init', initMocks);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(initialized.stdout, /不重复执行 kubeadm init/);
    const wrongIp = await run('init', initMocks.replace('TARGET_IP=192.168.1.10', 'TARGET_IP=192.168.1.11'));
    assert.notEqual(wrongIp.status, 0);
    assert.match(wrongIp.stderr, /IP.*不一致/);
    const wrongVersion = await run('init', initMocks, '1.33.1');
    assert.notEqual(wrongVersion.status, 0);
    assert.match(wrongVersion.stderr, /版本.*不一致/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
