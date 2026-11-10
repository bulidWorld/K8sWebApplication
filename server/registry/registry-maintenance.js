import { requestRegistryBundle } from './registry-service.js';
import { isIP } from 'node:net';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID, X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import path from 'node:path';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const publicRecord = ({ password, clientKey, serverKey, ...record }) => ({ ...record, hasPassword: !!password, hasClientKey: !!clientKey, hasServerKey: !!serverKey });
function certificates(pem) {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks?.length || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) fail('证书必须为 PEM 格式');
  return blocks.map(block => new X509Certificate(block));
}
export function certificateRegistryUrls(pem) {
  const names = certificates(pem).flatMap(cert => (cert.subjectAltName || '').split(/,\s*/)).flatMap(value => {
    if (value.startsWith('DNS:')) return [value.slice(4).toLowerCase()];
    if (value.startsWith('IP Address:')) return [value.slice(11)];
    return [];
  }).filter(value => value !== 'localhost' && !value.includes('*') && value !== '127.0.0.1' && value !== '::1');
  return [...new Set(names)].map(name => `https://${isIP(name) === 6 ? `[${name}]` : name}`);
}
export function validateRegistryRecord(body, previous = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('仓库配置无效');
  const allowed = ['name', 'url', 'urls', 'username', 'password', 'ca', 'clientCert', 'clientKey', 'clearPassword', 'clearClientKey', 'version', 'subjectAltName', 'serverCert', 'serverKey', 'clearServerKey', 'hostsIp'];
  if (Object.keys(body).some(key => !allowed.includes(key))) fail('包含不支持的配置字段');
  const record = {};
  for (const key of ['name', 'url', 'username', 'ca', 'clientCert']) {
    if (typeof body[key] !== 'string' || body[key].length > (['ca', 'clientCert'].includes(key) ? 65536 : 512)) fail('配置字段无效或过长');
    record[key] = body[key].trim();
  }
  record.hostsIp = body.hostsIp ?? previous.hostsIp ?? '';
  if (typeof record.hostsIp !== 'string' || (record.hostsIp && !isIP(record.hostsIp))) fail('仓库 hosts IP 地址无效');
  record.serverCert = body.serverCert ?? previous.serverCert ?? '';
  if (typeof record.serverCert !== 'string' || record.serverCert.length > 65536) fail('仓库服务端证书无效或过长');
  const san = body.subjectAltName ?? previous.subjectAltName ?? '';
  if (typeof san !== 'string' || san.length > 8192) fail('SAN 配置无效或过长');
  const values = san.replace(/^subjectAltName=/, '').split(/[,\n]+/).map(value => value.trim()).filter(Boolean);
  for (const value of values) {
    const match = /^(DNS|IP):(.+)$/.exec(value);
    if (!match || (match[1] === 'IP' ? !isIP(match[2]) : match[2].length > 253 || !/^(?:\*\.)?[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(match[2]))) fail('SAN 地址应为 DNS:域名 或 IP:地址');
  }
  record.subjectAltName = [...new Set(values)].join(',');
  if (!record.name) fail('请输入仓库名称');
  let url; try { url = new URL(record.url); } catch { fail('仓库地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname || !['', '/'].includes(url.pathname) || url.search || url.hash) fail('仓库地址应为 http(s)://主机[:端口]，不能包含路径或凭据');
  record.url = url.origin;
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) === 6) fail('暂不支持 IPv6 仓库地址的镜像拉取配置');
  const requestedUrls = body.urls ?? [record.url];
  if (!Array.isArray(requestedUrls) || !requestedUrls.length || requestedUrls.length > 64) fail('仓库地址数量无效');
  record.urls = [...new Set(requestedUrls.map(value => {
    if (typeof value !== 'string' || value.length > 512) fail('仓库地址无效');
    let parsed; try { parsed = new URL(value); } catch { fail('仓库地址无效'); }
    if (parsed.protocol !== url.protocol || parsed.username || parsed.password || !parsed.hostname || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) fail('仓库地址必须使用相同协议，且不能包含路径或凭据');
    if (isIP(parsed.hostname.replace(/^\[|\]$/g, '')) === 6) fail('暂不支持 IPv6 仓库地址的镜像拉取配置');
    return parsed.origin;
  }))];
  if (!record.urls.includes(record.url)) record.urls.unshift(record.url);
  for (const key of ['password', 'clientKey', 'serverKey']) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > 65536)) fail('密码或私钥无效');
    record[key] = body[key === 'password' ? 'clearPassword' : key === 'serverKey' ? 'clearServerKey' : 'clearClientKey'] === true ? '' : body[key] || previous[key] || '';
  }
  if (url.protocol === 'http:' && (record.ca || record.clientCert || record.clientKey || record.serverCert || record.serverKey)) fail('证书配置需要使用 HTTPS');
  try {
    if (record.ca) {
      const certs = certificates(record.ca);
      if (!record.serverCert) record.subjectAltName = [...new Set(certs.flatMap(cert => (cert.subjectAltName || '').split(/,\s*/).filter(Boolean)))].join(',');
      for (const address of record.urls) {
        const host = new URL(address).hostname;
        if (!certs.some(item => isIP(host) ? item.checkIP(host) : item.checkHost(host, { subject: 'never' }))) fail(`仓库地址 ${address} 不在已保存证书的 SAN 中`);
      }
    }
    if (!!record.serverCert !== !!record.serverKey) fail('仓库服务端证书与私钥需同时配置');
    if (record.serverCert) {
      const cert = certificates(record.serverCert)[0];
      const key = createPublicKey(createPrivateKey(record.serverKey)).export({ type: 'spki', format: 'der' });
      if (!key.equals(cert.publicKey.export({ type: 'spki', format: 'der' }))) fail('仓库服务端证书与私钥不匹配');
      for (const value of values) {
        const ip = value.startsWith('IP:');
        const address = value.slice(ip ? 3 : 4);
        const covered = ip ? cert.checkIP(address) : cert.checkHost(address, { subject: 'never' });
        if (!covered) fail(`仓库服务端证书未覆盖 SAN 地址：${value}`);
      }
    }
    if (!!record.clientCert !== !!record.clientKey) fail('客户端证书与私钥需同时配置；删除证书时请同时清除私钥');
    if (record.clientCert) {
      const cert = certificates(record.clientCert)[0];
      const key = createPublicKey(createPrivateKey(record.clientKey)).export({ type: 'spki', format: 'der' });
      if (!key.equals(cert.publicKey.export({ type: 'spki', format: 'der' }))) fail('客户端证书与私钥不匹配');
    }
  } catch (e) { if (e.status) throw e; fail('证书或私钥无法解析，请检查 PEM 格式及未加密私钥'); }
  return record;
}
export function createRegistryMaintenance({ distribute, syncHosts, requestBundle = requestRegistryBundle, file = new URL('../../var/registries.json', import.meta.url) } = {}) {
  let queue = Promise.resolve();
  const tasks = new Map();
  return (method, id, body) => {
    const operation = queue.then(async () => {
      if (method === 'PARSE_CERTIFICATE') {
        if (typeof body?.certificate !== 'string' || body.certificate.length > 65536) fail('请上传有效的 PEM 证书');
        return { urls: certificateRegistryUrls(body.certificate) };
      }
      let records; try { records = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; records = []; }
      if (method === 'DISTRIBUTION_STATUS') {
        const task = tasks.get(body?.taskId);
        if (!task || task.kind !== 'distribution' || task.registryId !== id) fail('下发任务不存在', 404);
        return { task };
      }
      if (method === 'SAVE_STATUS') {
        const task = tasks.get(body?.taskId);
        if (!task || task.kind !== 'save') fail('保存任务不存在或已过期', 404);
        return { task };
      }
      if (method === 'GET') {
        if (!id) return { items: records.map(publicRecord) };
        const found = records.find(record => record.id === id); if (!found) fail('仓库不存在', 404);
        return { item: publicRecord(found) };
      }
      const index = records.findIndex(record => record.id === id);
      if (id && index < 0) fail('仓库不存在', 404);
      if (id && body?.version !== records[index].version) fail('配置已被其他人修改，请重新加载', 409);
      if (method === 'RESOLVE') return structuredClone(records[index]);
      if (method === 'IMPORT_CERTIFICATES') {
        if (typeof body.token !== 'string' || !/^[A-Za-z0-9._~+\/=-]{1,3072}$/.test(body.token) || !['https', 'http'].includes(body.protocol) || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535) fail('请填写有效的证书接口协议、端口和导出 Token');
        const bundle = await requestBundle({ ip: records[index].hostsIp || new URL(records[index].url).hostname, protocol: body.protocol, port: body.port, token: body.token });
        if (typeof bundle?.certificate !== 'string' || bundle.certificate.length > 65536) fail('证书接口未返回有效的公共证书');
        for (const cert of certificates(bundle.certificate)) if (Date.now() < Date.parse(cert.validFrom) || Date.now() >= Date.parse(cert.validTo)) fail('仓库证书尚未生效或已过期');
        const serverCertificate = certificates(bundle.certificate)[0];
        const host = new URL(records[index].url).hostname.replace(/^\[|\]$/g, '');
        if (!(isIP(host) ? serverCertificate.checkIP(host) : serverCertificate.checkHost(host, { subject: 'never' }))) fail('拉取的仓库证书未覆盖仓库地址，请核对证书 SAN');
        // Retain only the public certificate; never persist exported server private keys.
        body = { ...publicRecord(records[index]), ca: bundle.certificate, password: '', clientKey: '', serverKey: '', version: records[index].version };
        for (const key of ['id', 'updatedAt', 'hasPassword', 'hasClientKey', 'hasServerKey']) delete body[key];
      }
      if (method === 'DISTRIBUTE') {
        if (!distribute) fail('节点下发未启用', 503);
        if ([...tasks.values()].some(task => task.kind === 'distribution' && task.status === 'running')) fail('已有仓库下发任务正在执行，请等待完成', 409);
        const task = { id: randomUUID(), kind: 'distribution', registryId: id, status: 'running', results: [], logs: [`准备下发仓库 ${records[index].name} 到 ${body.nodes?.length || 0} 个节点`], createdAt: new Date().toISOString() };
        for (const [key, value] of tasks) if (value.status !== 'running' && tasks.size >= 50) tasks.delete(key);
        tasks.set(task.id, task);
        const log = line => { if (task.logs.length < 500) task.logs.push(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${line}`); };
        Promise.resolve().then(() => distribute(records[index], body, { onProgress: log })).then(result => {
          task.results = result.results; task.status = result.results.some(item => !item.success) ? 'failed' : 'completed';
          log(`下发结束：${result.results.filter(item => item.success).length}/${result.results.length} 个节点成功`);
        }, error => { task.status = 'failed'; task.error = error.message; log(`下发失败：${error.message}`); });
        return { task };
      }
      let record;
      if (method === 'DELETE') records.splice(index, 1);
      else {
        record = { ...validateRegistryRecord(body, index < 0 ? {} : records[index]), id: id || randomUUID(), version: randomUUID(), updatedAt: new Date().toISOString() };
        if (records.some(item => item.id !== record.id && (item.name === record.name || item.url === record.url))) fail('仓库名称或地址已存在', 409);
        const domains = new Set(record.urls.map(value => new URL(value).hostname));
        if (records.some(item => item.id !== record.id && item.hostsIp !== record.hostsIp && (item.urls || [item.url]).some(value => domains.has(new URL(value).hostname)))) fail('仓库域名已被其他仓库使用，无法同时映射不同仓库 IP', 409);
        if (index < 0) records.push(record); else records[index] = record;
      }
      const filename = file instanceof URL ? (await import('node:url')).fileURLToPath(file) : file;
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temp = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(records, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temp, filename);
      if (record && syncHosts && ['POST', 'PATCH'].includes(method)) {
        const task = { id: randomUUID(), kind: 'save', registryId: record.id, status: 'running', logs: ['仓库配置已保存', '准备同步 hosts'], createdAt: new Date().toISOString() };
        for (const [key, value] of tasks) if (value.status !== 'running' && tasks.size >= 50) tasks.delete(key);
        tasks.set(task.id, task);
        const log = line => { if (task.logs.length < 200) task.logs.push(line); };
        Promise.resolve().then(() => syncHosts(record, log)).then(hosts => {
          task.hosts = hosts; task.status = hosts.success ? 'succeeded' : 'failed';
          log(hosts.success ? '全部 hosts 同步完成' : `hosts 同步未完成：${hosts.error}`);
        }, error => { task.status = 'failed'; task.error = error.message; log(`hosts 同步失败：${error.message}`); });
        return { item: publicRecord(record), task };
      }
      return record ? { item: publicRecord(record) } : { deleted: true };
    });
    queue = operation.catch(() => {}); return operation;
  };
}
