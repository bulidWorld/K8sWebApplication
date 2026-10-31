import { deploymentSteps, deploymentScript } from './cluster-steps.js';
import { discoverImages, validateVersion, flannelManifest } from './cluster-images.js';
import { configureRegistry } from './registry-service.js';
import { validateRegistry } from './registry-config.js';
import { readFile, access, mkdir, writeFile, rename } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { redactLog, createLogCollector } from './expansion-logs.js';
import { command } from './expansion-executor.js';
import { detectLocalAddress } from './local-address.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function createClusterService({ logger, run = command, configure = configureRegistry, directory = new URL('../var/cluster/', import.meta.url), exists = async file => { try { await access(file); return true; } catch (e) { if (e.code !== 'ENOENT') throw e; return false; } }, reload = () => {}, fetchManifest = fetch, isRoot = () => process.getuid?.() === 0 } = {}) {
  let task = null;
  let initialized;
  const state = new URL('task.json', directory instanceof URL ? directory : new URL(`file://${directory}/`));
  let saveQueue = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(task);
    const result = saveQueue.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = new URL('task.json.tmp', state);
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, state);
    });
    saveQueue = result.catch(() => {});
    return result;
  };
  const initialize = () => initialized ||= (async () => {
    try {
      task = JSON.parse(await readFile(state, 'utf8'));
      // Upgrade persisted combined image steps without losing completed installation work.
      if (task.deployment && !task.deployment.steps.some(step => step.id === 'pull-images')) {
        const legacy = task.deployment.steps.find(step => step.id === 'images');
        const parsed = task.version === task.deployment.version && task.images?.length > 0;
        task.deployment.steps = deploymentSteps.map(definition => {
          if (definition.id === 'images') return { ...definition, status: parsed ? 'succeeded' : 'pending', logs: [] };
          if (definition.id === 'pull-images') return { ...legacy, ...definition, status: parsed ? (task.images.every(image => image.status === 'succeeded') ? 'succeeded' : legacy?.status === 'succeeded' ? 'pending' : legacy?.status || 'pending') : 'pending', logs: legacy?.logs || [] };
          return { ...definition, ...task.deployment.steps.find(step => step.id === definition.id) };
        });
        if (task.action === 'step' && task.step === 'images' && parsed) task.step = 'pull-images';
        await save();
      }
      if (task.status === 'running') { task.status = 'interrupted'; for (const step of task.deployment?.steps || []) if (step.status === 'running') step.status = 'interrupted'; for (const image of task.images || []) if (image.status === 'running') image.status = 'interrupted'; task.error = '服务重启，请检查主机状态后再操作'; await save(); } }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  })();
  const handle = async (method, body = {}) => {
    await initialize();
    if (method === 'GET') return { task, steps: deploymentSteps, localAddress: await detectLocalAddress() };
    if (task?.status === 'running') fail('已有集群任务正在执行', 409);
    if (task?.deployment && ['images', 'pull', 'pull-all'].includes(body.action)) {
      if (body.version !== task.deployment.version) fail('请使用当前分步部署版本解析或拉取镜像', 409);
      if (body.action === 'pull' && typeof body.image !== 'string') fail('请选择列表中的镜像拉取');
      body = { ...body, action: 'step', step: body.action === 'images' ? 'images' : 'pull-images' };
    }
    if (!['start', 'install', 'registry', 'images', 'pull', 'pull-all', 'step'].includes(body.action)) fail('请选择启动、安装、仓库配置、解析镜像或拉取测试');
    if (!isRoot()) fail('集群服务操作需要以 root 运行 Web 后端', 403);
    let deployment = task?.deployment;
    let currentStep;
    if (body.action === 'step') {
      if (!deployment) {
        if (body.step !== 'runtime') fail('请从安装 containerd 开始');
        deployment = { steps: deploymentSteps.map(step => ({ ...step, status: 'pending', logs: [] })) };
      }
      // Work on a copy so a rejected request cannot change persisted configuration.
      deployment = structuredClone(deployment);
      const index = deployment.steps.findIndex(step => step.id === body.step);
      if (index < 0 || deployment.steps.slice(0, index).some(step => step.status !== 'succeeded')) fail('请按顺序完成前置步骤后再执行', 409);
      currentStep = deployment.steps[index];
      if (body.step === 'packages') {
        validateVersion(body.version);
        if (deployment.version && deployment.version !== body.version) fail('工具安装已开始，Kubernetes 版本不允许修改', 409);
        deployment.version = body.version;
      }
      if (body.step === 'init') {
        const local = Object.values(networkInterfaces()).flat().some(n => n.family === 'IPv4' && !n.internal && n.address === body.address);
        if (isIP(body.address) !== 4 || !local) fail('控制平面 IP 必须是本机网卡的非回环 IPv4 地址');
        if (deployment.address && deployment.address !== body.address) fail('初始化已开始，控制平面 IP 不允许修改', 409);
        deployment.address = body.address;
      }
      if (!['runtime', 'packages'].includes(body.step)) validateVersion(deployment.version);
      if (['init', 'network', 'verify'].includes(body.step) && !deployment.address) fail('请先配置控制平面 IP');
    }
    if (body.action === 'install' && deployment) fail('已有分步部署记录，请继续当前步骤', 409);
    if (body.action === 'images') validateVersion(body.version);
    const parsingImages = body.action === 'images' || (body.action === 'step' && body.step === 'images');
    const pullingImages = ['pull', 'pull-all'].includes(body.action) || (body.action === 'step' && body.step === 'pull-images');
    const images = structuredClone(task?.images || []);
    const imageVersion = task?.version;
    const selectedImage = pullingImages && body.image !== undefined ? images.find(item => item.image === body.image) : undefined;
    if (pullingImages) {
      const expectedVersion = deployment?.version || body.version;
      if (!images.length || imageVersion !== expectedVersion || (body.action === 'pull' && !selectedImage) || (body.image !== undefined && !selectedImage) || images.some(item => !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,511}$/.test(item.image))) fail('请先解析当前版本镜像，再选择列表中的镜像拉取');
    }
    let env = `export FLANNEL_MANIFEST='${flannelManifest}'\n`;
    const registry = body.registry !== undefined || body.action === 'registry' ? validateRegistry(body.registry) : undefined;
    if (body.action === 'install') {
      if (!/^1\.(3[1-5])\.\d{1,3}$/.test(body.version || '')) fail('请输入 Kubernetes 1.31–1.35 的完整补丁版本');
      const local = Object.values(networkInterfaces()).flat().some(n => n.family === 'IPv4' && !n.internal && n.address === body.address);
      if (isIP(body.address) !== 4 || !local) fail('控制平面 IP 必须是本机网卡的非回环 IPv4 地址');
      if (await exists('/etc/kubernetes/admin.conf') || await exists('/etc/kubernetes/kubelet.conf') || await exists('/var/lib/etcd/member')) fail('检测到已有集群配置，请选择启动集群；禁止覆盖或重复初始化', 409);
      env += `export K8S_VERSION='${body.version}'\nexport TARGET_IP='${body.address}'\nexport CONTAINERD_VERSION=auto\n`;
    } else if (body.action === 'start' && !await exists('/etc/kubernetes/manifests/kube-apiserver.yaml')) fail('未发现本机 kubeadm 控制平面，请选择安装 K8s 集群服务', 409);
    if (deployment) env += `${deployment.version ? `export K8S_VERSION='${deployment.version}'\n` : ''}${deployment.address ? `export TARGET_IP='${deployment.address}'\n` : ''}export CONTAINERD_VERSION=auto\n`;
    task = { registryConfigured: task?.registryConfigured || false, deployment, step: currentStep?.id, action: body.action, ...(parsingImages ? { version: deployment?.version || body.version, images: [] } : { version: imageVersion, images }), status: 'running', logs: [], createdAt: new Date().toISOString() };
    if (currentStep) { currentStep.status = 'running'; currentStep.logs = []; delete currentStep.error; delete currentStep.finishedAt; }
    await save();
    const snapshot = task;
    const collector = createLogCollector([registry?.token], (stream, line) => {
      snapshot.logs.push(line + '\n');
      if (currentStep) { currentStep.logs.push(line + '\n'); while (currentStep.logs.join('').length > 48000) currentStep.logs.shift(); }
      while (snapshot.logs.join('').length > 48000) snapshot.logs.shift();
    });
    setImmediate(async () => {
      const configureLocalRegistry = () => configure(registry, {
        log: message => collector.feed('stdout', message + '\n'),
        run: (file, args) => run(file, args, '', 120000, { onOutput: (stream, chunk) => {
          // config dump may contain existing registry credentials; retain only diagnostics.
          if (stream !== 'stdout' || file !== 'containerd') collector.feed(stream, chunk);
        } }),
      });
      try {
        if (body.action === 'registry') {
          await configureLocalRegistry();
          snapshot.registryConfigured = true;
        } else if (parsingImages) {
          const parsed = await discoverImages(snapshot.version, (file, args) => run(file, args, '', 120000, { onOutput: (stream, chunk) => collector.feed(stream, chunk) }), fetchManifest);
          snapshot.images = parsed.map(image => {
            const previous = imageVersion === snapshot.version && images.find(item => item.image === image.image);
            return previous ? { ...previous, source: image.source } : image;
          });
          collector.feed('stdout', `已解析 ${snapshot.images.length} 个镜像，确认清单后可一键或逐个拉取。\n`);
          if (currentStep) {
            currentStep.status = 'succeeded';
            currentStep.finishedAt = new Date().toISOString();
            const pullStep = deployment.steps.find(step => step.id === 'pull-images');
            pullStep.status = snapshot.images.every(image => image.status === 'succeeded') ? 'succeeded' : 'pending';
            pullStep.logs = [];
            delete pullStep.error;
            delete pullStep.finishedAt;
          }
        } else if (pullingImages) {
          const targets = selectedImage ? [selectedImage] : snapshot.images;
          const failures = [];
          for (const image of targets) {
            image.status = 'running';
            delete image.error;
            collector.feed('stdout', `检查镜像 ${image.image}\n`);
            await save();
            try {
              await run('/bin/bash', ['-s'], `set -Eeuo pipefail
exec 9>/run/kubescope-cluster.lock
flock -n 9 || { echo '已有集群操作正在执行' >&2; exit 1; }
command -v ctr >/dev/null || { echo '请先安装并启动 containerd' >&2; exit 1; }
if ready=$(ctr --address /run/containerd/containerd.sock --namespace k8s.io images check --quiet 'name==${image.image}'); then
  if printf '%s\n' "$ready" | grep -Fx '${image.image}' >/dev/null; then
    echo '[跳过] 镜像内容完整且已解包：${image.image}'
    exit 0
  fi
fi
echo '[拉取] 补齐镜像：${image.image}'
ctr --address /run/containerd/containerd.sock --namespace k8s.io images pull --hosts-dir /etc/containerd/certs.d '${image.image}'
`, 10 * 60 * 1000, { onOutput: (stream, chunk) => collector.feed(stream, chunk) });
              image.status = 'succeeded';
            } catch (error) {
              image.status = 'failed';
              image.error = redactLog(error.message);
              failures.push(image.image);
              collector.feed('stderr', `拉取失败 ${image.image}：${image.error}\n`);
            }
            image.testedAt = new Date().toISOString();
            await save();
          }
          if (failures.length) throw new Error(`${failures.length} 个镜像拉取失败，请查看列表中的错误并重试`);
          if (currentStep) {
            currentStep.status = snapshot.images.every(image => image.status === 'succeeded') ? 'succeeded' : snapshot.images.some(image => ['failed', 'interrupted'].includes(image.status)) ? 'failed' : 'pending';
            if (currentStep.status === 'succeeded') currentStep.finishedAt = new Date().toISOString();
            else if (currentStep.status === 'failed') currentStep.error = '仍有镜像未就绪，请逐个重试或一键拉取';
          }
        } else if (body.action === 'step') {
          await run('/bin/bash', ['-s'], env + await deploymentScript(currentStep.id), 30 * 60 * 1000, { onOutput: (stream, chunk) => collector.feed(stream, chunk) });
          if (currentStep.id === 'verify') await reload('/etc/kubernetes/admin.conf');
          currentStep.status = 'succeeded';
          currentStep.finishedAt = new Date().toISOString();
        } else {
          const policy = await readFile(new URL('./provision/runtime-policy.sh', import.meta.url), 'utf8');
          const install = body.action === 'install' ? await readFile(new URL('./provision/install.sh', import.meta.url), 'utf8') : '';
          const bootstrap = await readFile(new URL('./provision/cluster.sh', import.meta.url), 'utf8');
          // install.sh runs only after the bootstrap's checks and lock acquisition.
          const script = env + `export CLUSTER_ACTION='${body.action}'\n` + policy + '\n' + bootstrap.replace('# INSTALL_RUNTIME', install);
          const execute = input => run('/bin/bash', ['-s'], input, 30 * 60 * 1000, { onOutput: (stream, chunk) => collector.feed(stream, chunk) });
          try {
            if (registry && body.action === 'install') {
              const boundary = script.indexOf("  echo '[安装] 初始化控制平面'");
              const endInstall = script.indexOf('\nelse\n', boundary);
              const verify = bootstrap.lastIndexOf('export KUBECONFIG=/etc/kubernetes/admin.conf');
              await execute(script.slice(0, boundary) + '\nfi\n');
              await configureLocalRegistry();
              await execute(env + 'set -Eeuo pipefail\nexec 9>/run/kubescope-cluster.lock\nflock -n 9 || exit 1\n' + script.slice(boundary, endInstall) + '\n' + bootstrap.slice(verify));
            } else {
              if (registry) await configureLocalRegistry();
              await execute(script);
            }
          } finally { collector.flush(); }
          if (body.action !== 'registry') await reload('/etc/kubernetes/admin.conf');
        }
        snapshot.status = 'succeeded';
      } catch (error) { collector.flush(); logger?.error(Object.assign(new Error(redactLog(error.message, [registry?.token])), { stack: redactLog(error.stack || error.message, [registry?.token]), code: error.code }), { operation: 'cluster_task', action: body.action, step: currentStep?.id, logs: snapshot.logs.join('') }); if (currentStep) { currentStep.status = 'failed'; currentStep.error = error.message; } snapshot.status = 'failed';
        collector.flush();
        const readOnly = error.code === 'EROFS' || /read-only file system/i.test(snapshot.logs.join('') + error.message);
        snapshot.error = readOnly
          ? '服务运行环境为只读，无法写入本机配置。请更新 kubescope 的 systemd 服务设置 ProtectSystem=false，执行 daemon-reload 并重启服务后重试；仅刷新页面不会生效。'
          : redactLog(error.message, [registry?.token]); }
      collector.flush();
      snapshot.finishedAt = new Date().toISOString();
      await save().catch(error => console.error('保存集群任务失败:', error.message));
    });
    return { task };
  };
  let queue = Promise.resolve();
  return (method, body) => {
    const result = queue.then(() => handle(method, body));
    queue = result.catch(() => {});
    return result;
  };
}
