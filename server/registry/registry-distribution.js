import { registryHostOptions, mapRegistryHosts } from './registry-hosts.js';
import { randomUUID, X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';
import { configureRegistryToml } from './registry-service.js';
import { registryRemoteScript } from './registry-remote-script.js';
import { remoteSsh } from '../expansion/remote-ssh.js';
import { sudoInput } from '../expansion/expansion-executor.js';
import { readFile } from 'node:fs/promises';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function registryDistributionConfig(record, domains) {
  if (!Array.isArray(domains) || !domains.length || domains.length > 64 || domains.some(domain => typeof domain !== 'string' || domain.length > 253 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(domain))) fail('请选择有效的镜像源域名');
  const urls = [...new Set(record.urls || [record.url])].map(value => new URL(value));
  if (urls.some(url => url.protocol !== 'https:')) fail('证书下发仅支持 HTTPS 仓库');
  let ca = record.ca;
  if (!ca && record.serverCert) {
    const cert = new X509Certificate(record.serverCert);
    if (cert.subject !== cert.issuer || !cert.verify(cert.publicKey)) fail('请配置签发仓库证书的 CA 证书');
    ca = record.serverCert;
  }
  if (!ca) fail('请先保存 CA 证书；自签名仓库也可使用已保存的服务端证书');
  const blocks = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks?.length) fail('CA 证书无效');
  const certs = blocks.map(block => new X509Certificate(block));
  for (const cert of certs) {
    if (Date.now() < Date.parse(cert.validFrom) || Date.now() >= Date.parse(cert.validTo)) fail('CA 证书尚未生效或已过期');
  }
  for (const url of urls) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!certs.some(cert => isIP(host) ? cert.checkIP(host) : cert.checkHost(host, { subject: 'never' }))) fail(`仓库地址 ${url.origin} 不在已保存证书的 SAN 中`);
  }
  if (record.serverCert) {
    const cert = new X509Certificate(record.serverCert);
    if (Date.now() < Date.parse(cert.validFrom) || Date.now() >= Date.parse(cert.validTo)) fail('仓库服务端证书尚未生效或已过期');
    for (const url of urls) {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      if (!(isIP(host) ? cert.checkIP(host) : cert.checkHost(host, { subject: 'never' }))) fail('仓库地址不在服务端证书 SAN 中，请修改仓库地址或证书');
    }
  }
  if (record.clientCert) fail('当前节点下发支持 CA 信任，请使用无需客户端证书认证的仓库端点');
  return { url: urls[0].origin, urls: urls.map(url => url.origin), ca, registryId: record.id || 'registry', domains: [...new Set(domains.map(domain => domain.toLowerCase()))] };
}
// Runs inside the maintenance Pod. Only public trust material enters this script.
export async function applyRegistryNode(config, root, transform, restart, transformHosts = mapRegistryHosts, refreshTrust = async () => {}, progress = () => {}) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const base = path.join(root, 'etc/containerd');
  const configFile = path.join(base, 'config.toml');
  const lock = path.join(root, 'run/kubescope-registry.lock');
  const files = new Map();
  let locked = false, changed = false, trustChanged = false;
  const safe = async file => {
    const resolved = await fs.realpath(file).catch(error => { if (error.code !== 'ENOENT') throw error; return file; });
    if (resolved !== file) throw new Error('配置路径不能包含符号链接');
    const info = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('配置必须为普通文件');
    return info;
  };
  const write = async (file, content) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Check the parent after mkdir as existing directories may be symlinks.
    if (await fs.realpath(path.dirname(file)) !== path.dirname(file)) throw new Error('配置目录不能包含符号链接');
    const info = await safe(file);
    const previous = info ? await fs.readFile(file) : null;
    files.set(file, previous);
    if (previous) await fs.copyFile(file, `${file}.kubescope-${config.backupId}.bak`, fs.constants.COPYFILE_EXCL);
    await fs.writeFile(file, content, { mode: 0o644 });
  };
  const remove = async file => {
    const info = await safe(file);
    if (!info) return;
    const previous = await fs.readFile(file);
    files.set(file, previous);
    await fs.copyFile(file, `${file}.kubescope-${config.backupId}.bak`, fs.constants.COPYFILE_EXCL);
    await fs.rm(file);
  };
  try {
    await fs.mkdir(lock, { mode: 0o700 }); locked = true;
    progress('已获取节点配置锁');
    if (config.mapHosts) {
      progress(`检查 /etc/hosts：${config.hostsDomains.join(', ')}`);
      const hostsFile = path.join(root, 'etc/hosts');
      await safe(hostsFile);
      const beforeHosts = await fs.readFile(hostsFile, 'utf8');
      const afterHosts = transformHosts(beforeHosts, config.hostsIp, config.hostsDomains);
      if (afterHosts !== beforeHosts) { await write(hostsFile, afterHosts); progress('/etc/hosts 映射已更新'); }
      else progress('/etc/hosts 映射已正确，无需修改');
    }
    if (config.hostsOnly) return { restarted: false, hostsUpdated: files.size > 0, backupId: config.backupId };
    const certBlocks = config.ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
    const trustDir = path.join(root, 'usr/local/share/ca-certificates');
    const trustPrefix = `kubescope-registry-${config.registryId}-`;
    for (let index = 0; index < certBlocks.length; index++) {
      const trustFile = path.join(trustDir, `${trustPrefix}${index + 1}.crt`);
      const current = await fs.readFile(trustFile, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (current !== `${certBlocks[index]}\n`) { await write(trustFile, `${certBlocks[index]}\n`); trustChanged = true; }
    }
    const existingTrustFiles = await fs.readdir(trustDir).catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
    for (const name of existingTrustFiles) {
      if (!name.startsWith(trustPrefix) || !/^\d+\.crt$/.test(name.slice(trustPrefix.length))) continue;
      if (Number(name.slice(trustPrefix.length, -4)) <= certBlocks.length) continue;
      await remove(path.join(trustDir, name)); trustChanged = true;
    }
    if (trustChanged) { progress(`安装 ${certBlocks.length} 份系统信任证书`); await refreshTrust(); progress('系统 CA 信任已刷新'); }
    else progress('系统 CA 信任无需更新');
    if (config.trustOnly) return { restarted: false, hostsUpdated: !!config.mapHosts, trustUpdated: trustChanged, backupId: config.backupId };
    await safe(configFile);
    const before = await fs.readFile(configFile, 'utf8');
    const after = transform(before);
    for (const domain of config.domains) {
      progress(`配置镜像源 ${domain}：${(config.urls || [config.url]).join(' → ')}`);
      const directory = path.join(base, 'certs.d', domain);
      const caFile = `/etc/containerd/certs.d/${domain}/kubescope-ca.crt`;
      const endpoints = config.urls || [config.url];
      const source = domain === 'docker.io' ? 'https://registry-1.docker.io' : `https://${domain}`;
      await write(path.join(directory, 'kubescope-ca.crt'), config.ca);
      await write(path.join(directory, 'hosts.toml'), `server = ${JSON.stringify(source)}\n${endpoints.map(endpoint => `[host.${JSON.stringify(endpoint)}]\n  capabilities = ["pull", "resolve"]\n  ca = ${JSON.stringify(caFile)}\n`).join('')}`);
    }
    changed = before !== after;
    if (changed) { progress('更新 containerd config_path 并重启服务'); await write(configFile, after); await restart(); progress('containerd 已重启'); }
    else progress('containerd config_path 无需修改或重启');
    return { restarted: changed, hostsUpdated: !!config.mapHosts, trustUpdated: trustChanged, backupId: config.backupId };
  } catch (error) {
    progress(`配置失败：${error.message}；正在回滚`);
    const rollbackErrors = [];
    for (const [file, content] of [...files].reverse()) {
      try { if (content === null) await fs.rm(file, { force: true }); else await fs.writeFile(file, content); } catch { rollbackErrors.push(file); }
    }
    if (changed) try { await restart(); } catch { rollbackErrors.push('containerd 重启'); }
    if (trustChanged) try { await refreshTrust(); } catch { rollbackErrors.push('系统 CA 信任刷新'); }
    throw new Error(`${error.message}${rollbackErrors.length ? `；回滚失败：${rollbackErrors.join('、')}` : '；已还原本次修改'}`);
  } finally { if (locked) await fs.rmdir(lock).catch(() => {}); }
}
export async function configureSavedRegistry(record, body, { run, root = '/', log = () => {} } = {}) {
  if (body.confirm !== true) fail('请确认仓库配置');
  const options = registryHostOptions(record, body);
  const config = { ...(options.hostsOnly ? {} : registryDistributionConfig(record, body.domains)), ...options, backupId: randomUUID() };
  log(`正在应用仓库 ${record.name} 到本机${options.mapHosts ? `，hosts 映射：${options.hostsIp} → ${options.hostsDomains.join(', ')}` : ''}`);
  const result = await applyRegistryNode(config, root, configureRegistryToml, async () => {
    await run('containerd', ['--config', '/etc/containerd/config.toml', 'config', 'dump']);
    await run('systemctl', ['restart', 'containerd']);
  }, mapRegistryHosts, async () => { await run('update-ca-certificates', []); });
  log(`配置完成；备份标识：${result.backupId}；${result.restarted ? '已重启 containerd' : '无需重启 containerd'}`);
  return result;
}
export function createRegistryDistributor({ kubernetes, logger, access, ssh = remoteSsh }) {
  if (!access) fail('节点登录配置服务未启用', 503);
  return async (record, body, { onProgress = () => {} } = {}) => {
    if (body?.confirm !== true || !Array.isArray(body.nodes) || !body.nodes.length || body.nodes.length > 100) fail('请确认并选择下发节点');
    const options = registryHostOptions(record, body);
    const config = { ...(options.hostsOnly ? {} : registryDistributionConfig(record, body.domains)), ...options };
    const nodes = (await kubernetes.request('/api/v1/nodes')).items;
    if (body.nodes.some(name => !nodes.some(node => node.metadata.name === name))) fail('所选节点不存在');
    const results = [];
    for (const node of [...new Set(body.nodes)]) {
      const payload = { ...config, backupId: randomUUID() };
      try {
        const target = await access.resolve(node);
        const script = registryRemoteScript(payload);
        const remote = target.user === 'root' ? { args: ['bash', '-s'], input: `${script}\n` } : sudoInput(script, target.sudoPassword);
        const privateKey = target.auth === 'key' ? await readFile(target.identityFile) : undefined;
        let pending = '', lastLine = '';
        const onOutput = (_stream, chunk) => {
          pending += chunk.toString('utf8');
          const lines = pending.split('\n'); pending = lines.pop();
          for (const line of lines) if (line.startsWith('LOG:')) { lastLine = line.slice(4); onProgress(`${node}：${lastLine}`); }
          else if (line && !line.startsWith('RESULT:')) onProgress(`${node}：${line}`);
        };
        onProgress(`${node}：通过 SSH 连接宿主机 ${target.host}`);
        const output = await ssh(target, remote, target.loginPassword, undefined, { privateKey, onOutput, timeout: 180000 });
        const resultLine = output.trim().split('\n').findLast(line => line.startsWith('RESULT:'));
        if (!resultLine) throw new Error(lastLine || '远程脚本未返回执行结果');
        results.push({ node, success: true, ...JSON.parse(resultLine.slice(7)) });
      } catch (error) {
        results.push({ node, success: false, error: error.message });
      }
      logger?.write('registry_distribution_node', { registryId: record.id, ...results.at(-1) });
      onProgress(results.at(-1).success ? `工作节点 ${node} 同步完成` : `工作节点 ${node} 同步失败：${results.at(-1).error}`);
    }
    return { results };
  };
}
