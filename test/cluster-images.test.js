import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { discoverImages, manifestImages, flannelManifest } from '../server/cluster-images.js';
import { createClusterService } from '../server/cluster-service.js';
import { deploymentSteps } from '../server/cluster-steps.js';

const yaml = `kind: List
items:
- kind: DaemonSet
  spec:
    template:
      spec:
        initContainers:
        - image: ghcr.io/flannel-io/flannel-cni-plugin:v1.6.2-flannel1
        containers:
        - image: ghcr.io/flannel-io/flannel:v0.26.7
---
kind: Pod
spec:
  containers:
  - image: ghcr.io/flannel-io/flannel:v0.26.7
`;
const fetchManifest = async url => {
  assert.equal(url, flannelManifest);
  return { ok: true, text: async () => yaml };
};
async function settled(service) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { task } = await service('GET');
    if (task.status !== 'running') return task;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('任务未完成');
}
test('解析多文档 YAML、List 和初始化容器并去重，使用用户指定版本查询 kubeadm', async () => {
  assert.equal(manifestImages(yaml).length, 2);
  const images = await discoverImages('1.34.1', async (file, args) => {
    assert.equal(file, '/usr/bin/kubeadm');
    assert.deepEqual(args, ['config', 'images', 'list', '--kubernetes-version', 'v1.34.1']);
    return 'registry.k8s.io/kube-apiserver:v1.34.1\nregistry.k8s.io/pause:3.10\n';
  }, fetchManifest);
  assert.equal(images.length, 4);
  await assert.rejects(discoverImages('1.34.1;id', () => assert.fail()), /完整补丁版本/);
  await assert.rejects(discoverImages('1.34.1', async () => 'image:tag', async () => ({ ok: false, status: 503 })), /503/);
});
test('Pull 仅允许已解析版本与镜像，记录失败和重试，刷新和重启保留结果', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cluster-images-'));
  let failed = true, script;
  const options = { directory, isRoot: () => true, fetchManifest, reload: () => assert.fail('镜像测试不重载集群'), run: async (file, args, input, timeout, hooks) => {
    if (file === '/usr/bin/kubeadm') return 'registry.k8s.io/pause:3.10\n';
    script = input;
    hooks.onOutput('stderr', 'registry test output\n');
    if (failed) throw new Error('模拟仓库不可达');
  } };
  const service = createClusterService(options);
  try {
    await assert.rejects(service('POST', { action: 'pull', version: '1.34.1', image: 'arbitrary' }), /先解析/);
    await service('POST', { action: 'images', version: '1.34.1' });
    await assert.rejects(service('POST', { action: 'images', version: '1.34.1' }), /正在执行/);
    assert.equal((await settled(service)).images.length, 3);
    await assert.rejects(service('POST', { action: 'pull', version: '1.33.1', image: 'registry.k8s.io/pause:3.10' }), /先解析/);
    await service('POST', { action: 'pull', version: '1.34.1', image: 'registry.k8s.io/pause:3.10' });
    let task = await settled(service);
    assert.equal(task.images[0].status, 'failed');
    assert.match(task.logs.join(''), /registry test output/);
    assert.match(script, /--namespace k8s.io images pull --hosts-dir/);
    assert.match(script, /flock -n 9/);
    failed = false;
    await service('POST', { action: 'pull', version: '1.34.1', image: 'registry.k8s.io/pause:3.10' });
    task = await settled(service);
    assert.equal(task.images[0].status, 'succeeded');
    await assert.rejects(service('POST', { action: 'pull-all', version: '1.33.1' }), /先解析/);
    await service('POST', { action: 'pull-all', version: '1.34.1' });
    assert.ok((await settled(service)).images.every(image => image.status === 'succeeded'));
    // Allow the background task's save to finish before constructing another service.
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((await createClusterService(options)('GET')).task.images[0].status, 'succeeded');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('解析与拉取分离，单项和批量拉取共用结果，失败可单独重试且全部就绪才放行', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cluster-image-workflow-'));
  const version = '1.34.1';
  let failImage = true, changedManifest = false;
  const pulls = [];
  const options = {
    directory, isRoot: () => true,
    fetchManifest: async () => ({ ok: true, text: async () => changedManifest ? `${yaml}\n---\nkind: Pod\nspec:\n  containers:\n  - image: example.com/new:1\n` : yaml }),
    run: async (file, args, input, timeout, hooks) => {
      if (file === '/usr/bin/kubeadm') return 'registry.k8s.io/pause:3.10\n';
      const image = input.match(/images pull --hosts-dir \/etc\/containerd\/certs.d '([^']+)'/)[1];
      pulls.push(image);
      hooks.onOutput('stdout', `检查 ${image}\n`);
      if (failImage && image.includes('flannel-cni-plugin')) throw new Error('测试：镜像源不可达');
    },
  };
  const step = (service, id, fields = {}) => service('POST', { action: 'step', step: id, ...fields });
  const pullStatus = task => task.deployment.steps.find(item => item.id === 'pull-images').status;
  await writeFile(path.join(directory, 'task.json'), JSON.stringify({
    action: 'step', step: 'packages', status: 'succeeded',
    deployment: { version, steps: deploymentSteps.map(item => ({ ...item, status: ['runtime', 'packages'].includes(item.id) ? 'succeeded' : 'pending', logs: [] })) },
  }));
  let service = createClusterService(options);
  try {
    await assert.rejects(step(service, 'pull-images'), /前置步骤/);
    await step(service, 'images');
    let task = await settled(service);
    assert.equal(task.images.length, 3);
    assert.equal(pulls.length, 0, '解析不能触发拉取');
    assert.equal(pullStatus(task), 'pending');
    const first = task.images[0].image, second = task.images[1].image;
    await assert.rejects(step(service, 'pull-images', { image: 'arbitrary:tag' }), /先解析/);
    await assert.rejects(service('POST', { action: 'pull', version: '1.33.1', image: first }), /当前分步部署版本/);
    await step(service, 'pull-images', { image: first });
    task = await settled(service);
    assert.equal(pullStatus(task), 'pending');
    assert.equal(task.images[0].status, 'succeeded');
    assert.equal(task.images[1].status, 'untested');
    await assert.rejects(step(service, 'init'), /前置步骤/);
    await step(service, 'pull-images', { image: second });
    task = await settled(service);
    assert.equal(task.status, 'failed');
    assert.match(task.images[1].error, /镜像源不可达/);
    const beforeBulk = pulls.length;
    await step(service, 'pull-images');
    task = await settled(service);
    assert.equal(pulls.length - beforeBulk, 3, '批量拉取失败后应继续处理其余镜像');
    assert.equal(task.images[2].status, 'succeeded');
    assert.equal(pullStatus(task), 'failed');
    await new Promise(resolve => setTimeout(resolve, 30));
    service = createClusterService(options);
    assert.equal((await service('GET')).task.images[2].status, 'succeeded');
    failImage = false;
    await step(service, 'pull-images', { image: second });
    task = await settled(service);
    assert.equal(pullStatus(task), 'succeeded');
    assert.ok(task.images.every(image => image.status === 'succeeded'));
    assert.equal(task.images[1].error, undefined);
    changedManifest = true;
    await step(service, 'images');
    task = await settled(service);
    assert.equal(task.images.length, 4);
    assert.equal(pullStatus(task), 'pending', '重新解析增加镜像后需重新完成拉取');
    assert.equal(task.images[0].status, 'succeeded', '重新解析保留同版本已完成结果');
    assert.equal(task.images[3].status, 'untested');
    await assert.rejects(step(service, 'init'), /前置步骤/);
    await step(service, 'pull-images', { image: 'example.com/new:1' });
    assert.equal(pullStatus(await settled(service)), 'succeeded');
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('旧合并镜像步骤迁移为解析和拉取步骤，保留已有镜像与部署进度', async () => {
  for (const completed of [false, true]) {
    const directory = await mkdtemp(path.join(tmpdir(), 'cluster-image-migration-'));
    try {
      const legacySteps = deploymentSteps.filter(step => step.id !== 'pull-images').map(step => ({ ...step, status: completed || ['runtime', 'packages'].includes(step.id) ? 'succeeded' : step.id === 'images' ? 'failed' : 'pending', logs: [] }));
      await writeFile(path.join(directory, 'task.json'), JSON.stringify({ action: 'step', step: 'images', status: completed ? 'succeeded' : 'failed', version: '1.34.1', images: [{ image: 'registry.k8s.io/pause:3.10', status: completed ? 'succeeded' : 'failed' }], deployment: { version: '1.34.1', address: '192.168.1.10', steps: legacySteps } }));
      const { task } = await createClusterService({ directory })('GET');
      assert.equal(task.deployment.steps.length, deploymentSteps.length);
      assert.equal(task.deployment.steps.find(step => step.id === 'images').status, 'succeeded');
      assert.equal(task.deployment.steps.find(step => step.id === 'pull-images').status, completed ? 'succeeded' : 'failed');
      assert.equal(task.deployment.address, '192.168.1.10');
      assert.equal(task.step, 'pull-images');
      assert.equal(task.images.length, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
