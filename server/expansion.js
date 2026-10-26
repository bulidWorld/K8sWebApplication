import { readFile, mkdir, writeFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { KubeConfig } from '@kubernetes/client-node';
import { createKubernetes } from './kubernetes.js';
import { createExecutor, validateConfig, command, publicTarget, targetRevision } from './expansion-executor.js';
import { probeHost } from './remote-ssh.js';
const defaultPath = fileURLToPath(new URL('../var/expansion/config.json', import.meta.url));
const error = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const settingsOf = c => ({ kubeconfig: c.kubeconfig, apiServer: c.apiServer, kubernetesVersion: c.kubernetesVersion, containerdPackageVersion: c.containerdPackageVersion });
export async function discoverConfiguration() {
  const kc = new KubeConfig();
  let kubeconfig = (process.env.KUBECONFIG || '/root/.kube/config').split(path.delimiter)[0];
  if (!process.env.KUBECONFIG) {
    try { await access('/etc/kubernetes/admin.conf'); kubeconfig = '/etc/kubernetes/admin.conf'; } catch { /* Fall back to root's current kubeconfig. */ }
  }
  kc.loadFromFile(kubeconfig);
  const current = kc.getCurrentCluster();
  if (!current) error('当前服务没有可用的 kubeconfig，请在页面填写 master 的 kubeconfig 路径');
  const version = await createKubernetes({ config: kc }).request('/version');
  const local = JSON.parse(await command('/usr/bin/kubeadm', ['version', '-o', 'json'])).clientVersion.gitVersion;
  const kubernetesVersion = version.gitVersion.replace(/^v/, '').split('+')[0];
  if (local !== `v${kubernetesVersion}`) error('master kubeadm 与 API Server 版本不一致，请先处理版本问题');
  return { kubeconfig, apiServer: current.server.replace(/\/$/, ''), kubernetesVersion, containerdPackageVersion: 'auto' };
}

// Configuration and targets are initialized by the page and saved automatically.
export function expansionClient(configPath = defaultPath, {
  load = readFile, create = createExecutor, uid = () => process.getuid?.(),
  discover = discoverConfiguration, probe = probeHost,
} = {}) {
  let executor, config, loaded = false, queue = Promise.resolve();
  const probes = new Map();
  const defaults = () => ({ kubeconfig: (process.env.KUBECONFIG || '/etc/kubernetes/admin.conf').split(path.delimiter)[0], apiServer: '', kubernetesVersion: '', containerdPackageVersion: 'auto' });
  const getExecutor = () => {
    if (!executor) { executor = Promise.resolve().then(() => create(config)); executor.catch(() => { executor = undefined; }); }
    return executor;
  };
  async function ensureIdle() {
    if (config) {
      const state = await (await getExecutor())('GET', '/targets');
      if (state.busy || state.tasks?.some(t => ['checking', 'running'].includes(t.status))) error('任务执行中，暂时不能修改扩容配置或机器', 409);
    }
  }
  async function save(next) {
    validateConfig(next);
    const dir = path.dirname(configPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = `${configPath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temp, configPath);
    config = next; executor = undefined;
  }
  function targetFields(body) {
    if (isIP(body.host) !== 4) error('请输入有效的新节点 IPv4 地址');
    if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) error('SSH 端口无效');
    if (!/^[a-z_][a-z0-9_-]*$/.test(body.user || '')) error('SSH 用户名无效');
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(body.nodeName || '')) error('节点名称只能包含小写字母、数字和连字符');
    return { id: body.nodeName, nodeName: body.nodeName, host: body.host, port: body.port, user: body.user, auth: 'password' };
  }
  async function handle(method, route, body = {}) {
    if (!configPath) {
      if (method === 'GET' && route === '/targets') return { enabled: false, targets: [], tasks: [] };
      error('扩容功能未启用', 503);
    }
    if (uid() !== 0) error('节点扩容要求 Web 应用以 root 用户启动', 503);
    if (!loaded) {
      try { config = JSON.parse(await load(configPath, 'utf8')); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        // Import the previous environment-selected config into managed writable storage.
        const legacy = process.env.K8S_EXPANSION_CONFIG;
        if (configPath === defaultPath && legacy && legacy !== configPath) {
          try { const old = JSON.parse(await load(legacy, 'utf8')); await save(old); }
          catch (legacyError) { if (legacyError.code !== 'ENOENT') throw legacyError; }
        }
      }
      loaded = true;
    }
    if (method === 'GET' && route === '/settings') return { initialized: !!config, settings: config ? settingsOf(config) : defaults() };
    if (method === 'POST' && route === '/discover') return { settings: await discover() };
    if (method === 'POST' && route === '/settings') {
      await ensureIdle();
      const next = { ...(config || {}), ...settingsOf(body), targets: config?.targets || [],
        stateDirectory: config?.stateDirectory || path.join(path.dirname(configPath), 'tasks'),
        knownHosts: config?.knownHosts || path.join(path.dirname(configPath), 'known_hosts') };
      await save(next);
      return { initialized: true, settings: settingsOf(config) };
    }
    if (!config) {
      if (method === 'GET' && route === '/targets') return { enabled: false, needsSetup: true, targets: [], tasks: [] };
      error('请先在页面初始化集群扩容配置', 409);
    }
    if (method === 'POST' && route === '/probe') {
      await ensureIdle();
      const target = targetFields(body);
      const hostFingerprint = await probe(target);
      const probeId = randomUUID();
      for (const [id, item] of probes) if (Date.now() > item.expires) probes.delete(id);
      if (probes.size >= 100) probes.delete(probes.keys().next().value);
      probes.set(probeId, { target, hostFingerprint, expires: Date.now() + 5 * 60 * 1000 });
      return { probeId, hostFingerprint };
    }
    if (method === 'POST' && route === '/targets') {
      await ensureIdle();
      const target = targetFields(body);
      const confirmed = probes.get(body.probeId);
      if (!confirmed || confirmed.expires < Date.now() || JSON.stringify(target) !== JSON.stringify(confirmed.target) || body.hostFingerprint !== confirmed.hostFingerprint)
        error('主机指纹确认已过期或目标信息已改变，请重新获取并核对', 409);
      target.hostFingerprint = confirmed.hostFingerprint;
      await save({ ...config, targets: [...config.targets, target] });
      probes.delete(body.probeId);
      return { target: publicTarget(target) };
    }
    const updateTarget = route.match(/^\/targets\/([a-z0-9][a-z0-9-]{0,62})$/);
    if (method === 'POST' && updateTarget) {
      await ensureIdle();
      const index = config.targets.findIndex(t => t.id === updateTarget[1]);
      if (index < 0) error('目标机器不存在，请重新加载', 404);
      const original = config.targets[index];
      if (body.revision !== targetRevision(original)) error('目标配置已变化，请重新加载后修改', 409);
      const fields = targetFields(body);
      const next = { ...original, ...fields, id: original.id, auth: original.auth || 'key' };
      const addressChanged = original.host !== next.host || original.port !== next.port;
      if (addressChanged || body.probeId || body.hostFingerprint) {
        const proof = probes.get(body.probeId);
        if (!proof || proof.expires < Date.now() || JSON.stringify(fields) !== JSON.stringify(proof.target) || body.hostFingerprint !== proof.hostFingerprint)
          error('连接地址已变化或指纹确认无效，请重新获取并核对指纹', 409);
        next.hostFingerprint = proof.hostFingerprint;
      }
      const targets = config.targets.map((t, i) => i === index ? next : t);
      await save({ ...config, targets });
      if (body.probeId) probes.delete(body.probeId);
      return { target: publicTarget(next) };
    }
    return (await getExecutor())(method, route, body);
  }
  return (method, route, body) => {
    const result = queue.then(() => handle(method, route, body)); queue = result.catch(() => {}); return result;
  };
}
