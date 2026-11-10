import * as fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { X509Certificate, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { validateRegistry } from './registry-config.js';

const domains = ['docker.io', 'ghcr.io', 'registry-1.docker.io', 'registry.k8s.io'];

export function configureRegistryToml(source, certsPath = '/etc/containerd/certs.d') {
  const version = Number(source.match(/^\s*version\s*=\s*(\d+)\s*(?:#.*)?$/m)?.[1] || 1);
  if (![2, 3].includes(version)) throw new Error(`containerd config.toml 配置版本 ${version} 不受支持，请先生成 version=2 或 version=3 的配置`);
  const plugin = version === 3 ? 'io.containerd.cri.v1.images' : 'io.containerd.grpc.v1.cri';
  const lines = source.split('\n');
  let active = false, found = false, inserted = false;
  const output = [];
  for (const line of lines) {
    if (/^\s*\[/.test(line)) {
      if (active && !inserted) { output.push(`  config_path = ${JSON.stringify(certsPath)}`); inserted = true; }
      active = line.trim().replace(/\s+#.*$/, '').replaceAll("'", '"') === `[plugins."${plugin}".registry]`;
      if (active) found = true;
    }
    if (active && /^\s*config_path\s*=/.test(line)) {
      output.push(`  config_path = ${JSON.stringify(certsPath)}`); inserted = true;
    } else output.push(line);
  }
  if (active && !inserted) output.push(`  config_path = ${JSON.stringify(certsPath)}`);
  if (!found) output.push(`\n[plugins."${plugin}".registry]\n  config_path = ${JSON.stringify(certsPath)}`);
  return output.join('\n');
}

export function registryHosts(source, ip) {
  const lines = source.trimEnd().split('\n').map(line => {
    const index = line.indexOf('#');
    const content = index < 0 ? line : line.slice(0, index);
    const comment = index < 0 ? '' : line.slice(index);
    const fields = content.trim().split(/\s+/);
    if (fields.length < 2 || !fields.slice(1).some(host => domains.includes(host.toLowerCase()))) return line;
    const aliases = fields.slice(1).filter(host => !domains.includes(host.toLowerCase()));
    return aliases.length ? [fields[0], ...aliases].join(' ') + (comment ? ` ${comment}` : '') : comment;
  }).filter(Boolean);
  return [...lines, `${ip} ${domains.join(' ')} # kubescope registry`, ''].join('\n');
}

export async function requestRegistryBundle(registry, log = () => {}) {
  const url = `${registry.protocol}://${registry.ip}:${registry.port}/api/tls/bundle`;
  log(`直连 ${url}（不使用代理）`);
  for (let attempt = 0; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const transport = registry.protocol === 'http' ? http : https;
        const request = transport.get(url, { agent: false, rejectUnauthorized: false, headers: { Authorization: `Bearer ${registry.token}` } }, response => {
          log(`HTTP=${response.statusCode}，目标=${registry.ip}:${registry.port}`);
          if (response.statusCode !== 200) {
            response.resume();
            reject(Object.assign(new Error(`证书接口 HTTP ${response.statusCode}；401/403 请检查 Token，503 请检查仓库服务及路由`), { retryable: [408, 429, 500, 502, 503, 504].includes(response.statusCode) }));
            return;
          }
          const chunks = []; let size = 0;
          response.on('data', chunk => {
            size += chunk.length;
            if (size > 1048576) { response.destroy(new Error('证书接口响应超过 1 MiB')); return; }
            chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(new Error('证书接口响应不是有效 JSON')); }
          });
        });
        const timer = setTimeout(() => request.destroy(new Error('证书接口请求超时（60 秒）')), 60000);
        request.on('close', () => clearTimeout(timer));
        request.on('error', reject);
      });
    } catch (error) {
      if (!error.retryable || attempt >= 2) throw error;
      log(`证书接口暂不可用，正在重试（${attempt + 1}/2）`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}

// Runs in the Web backend process. Only containerd/systemctl use system commands.
export async function configureRegistry(input, { run, log = () => {}, root = '/', requestBundle = requestRegistryBundle } = {}) {
  const registry = validateRegistry(input);
  const file = name => path.join(root, name);
  const hosts = file('etc/hosts'), config = file('etc/containerd/config.toml');
  const certs = file('etc/containerd/certs.d'), credentials = file('etc/kubescope/registry');
  const lock = file('run/kubescope-registry.lock');
  const temporary = `${config}.kubescope-${randomUUID()}.tmp`;
  let locked = false, stage = '获取证书';
  const step = async (name, action) => { stage = name; log(`[镜像源] ${name}`); return action(); };
  try {
    await step('获取配置锁', async () => {
      try { await fs.mkdir(lock, { mode: 0o700 }); locked = true; }
      catch (error) { if (error.code === 'EEXIST') throw new Error(`已有仓库配置正在执行，或上次进程异常退出留下锁目录：${lock}`); throw error; }
    });
    const contents = await step('检查 hosts 和 containerd 配置文件', async () => {
      for (const name of [hosts, config]) {
        let stat;
        try { stat = await fs.lstat(name); }
        catch (cause) {
          if (cause.code !== 'ENOENT' || name !== config) throw cause;
          throw new Error(`未找到 ${config}。新部署请先完成第一步“安装 containerd”，再配置自建镜像仓库，最后执行“解析并拉取镜像”；已有运行时请检查实际配置路径及服务启动参数。`, { cause });
        }
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`配置必须是普通文件且不能是符号链接：${name}`);
      }
      return { hosts: await fs.readFile(hosts, 'utf8'), config: await fs.readFile(config, 'utf8') };
    });
    const bundle = await step('请求证书接口', () => requestBundle(registry, message => log(`[镜像源] ${message}`)));
    await step('验证证书有效期、公私钥及镜像域名', async () => {
      for (const field of ['certificate', 'privateKey']) if (typeof bundle?.[field] !== 'string' || bundle[field].length > 131072) throw new Error(`证书接口 ${field} 字段无效`);
      const certificate = new X509Certificate(bundle.certificate);
      const now = Date.now();
      if (now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo)) throw new Error('仓库证书尚未生效或已过期');
      const key = createPublicKey(createPrivateKey(bundle.privateKey)).export({ type: 'spki', format: 'der' });
      if (!certificate.publicKey.export({ type: 'spki', format: 'der' }).equals(key)) throw new Error('仓库证书与私钥不匹配');
      for (const domain of domains) if (!certificate.checkHost(domain)) throw new Error(`仓库证书不包含域名 ${domain}`);
    });
    const updated = await step('补齐 containerd registry.config_path 并验证配置', async () => {
      const value = configureRegistryToml(contents.config, certs);
      await fs.writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
      await run('containerd', ['--config', temporary, 'config', 'dump']);
      return value;
    });
    const backup = `${Date.now()}-${randomUUID()}`;
    await step('备份 hosts 和 containerd 配置', async () => {
      for (const name of [hosts, config]) { const target = `${name}.kubescope-registry-${backup}.bak`; await fs.copyFile(name, target, fs.constants.COPYFILE_EXCL); log(`[镜像源] 备份：${target}`); }
    });
    await step('写入仓库证书及 containerd 信任配置', async () => {
      await fs.mkdir(credentials, { recursive: true, mode: 0o700 });
      await fs.chmod(credentials, 0o700);
      for (const [name, value, mode] of [['private-key.pem', bundle.privateKey, 0o600], ['certificate.pem', bundle.certificate, 0o644]]) {
        const target = path.join(credentials, name);
        const handle = await fs.open(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, mode);
        try { await handle.chmod(mode); await handle.writeFile(value); } finally { await handle.close(); }
      }
      for (const domain of domains) {
        const directory = path.join(certs, domain);
        await fs.mkdir(directory, { recursive: true, mode: 0o755 });
        await fs.writeFile(path.join(directory, 'ca.crt'), bundle.certificate, { mode: 0o644 });
        await fs.writeFile(path.join(directory, 'hosts.toml'), `server = "https://${domain}"\n[host."https://${domain}"]\n  capabilities = ["pull", "resolve"]\n  ca = ${JSON.stringify(path.join(directory, 'ca.crt'))}\n`, { mode: 0o644 });
      }
      await fs.writeFile(hosts, registryHosts(contents.hosts, registry.ip));
      await fs.writeFile(config, updated);
    });
    await step('重启 containerd', () => run('systemctl', ['restart', 'containerd']));
    log('[镜像源] 配置完成');
  } catch (cause) {
    const error = new Error(`镜像仓库配置失败：阶段=${stage}；${cause.message}`, { cause });
    error.code = cause.code;
    log(`${error.stack}\n原因：${cause.stack || cause.message}`);
    throw error;
  } finally {
    // Cleanup errors must not hide the original failure and its stack.
    try { await fs.rm(temporary, { force: true }); } catch (error) { log(`[镜像源] 清理临时配置失败：${error.stack}`); }
    if (locked) {
      try { await fs.rmdir(lock); } catch (error) { log(`[镜像源] 清理锁目录失败：${error.stack}`); }
    }
  }
}
