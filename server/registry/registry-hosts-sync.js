import { isIP } from 'node:net';
import { configureSavedRegistry } from './registry-distribution.js';

export async function syncRegistryHosts(record, { kubernetes, distribute, configureLocal = configureSavedRegistry, onProgress = () => {} }) {
  const ip = record.hostsIp;
  if (!isIP(ip) || /^(127\.|0\.)/.test(ip) || ['::', '::1'].includes(ip)) throw new Error('请填写仓库可访问的非回环 IP 地址');
  const domains = [...new Set((record.urls || [record.url]).map(value => new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase()).filter(name => !isIP(name) && name !== 'localhost'))];
  if (!domains.length && !record.ca && !record.serverCert) throw new Error('仓库地址中没有可映射的域名');
  const body = { confirm: true, mode: record.ca || record.serverCert ? 'trust' : 'hosts', hostsIp: ip, domains };
  onProgress(`正在同步本机 hosts${body.mode === 'trust' ? ' 与系统证书信任' : ''}：${ip} → ${domains.join(', ')}`);
  await configureLocal(record, body, { run: () => {} });
  onProgress('本机 hosts 同步完成');
  onProgress('正在读取集群工作节点');
  let nodes;
  try { nodes = (await kubernetes.request('/api/v1/nodes')).items.filter(node => !Object.hasOwn(node.metadata.labels || {}, 'node-role.kubernetes.io/control-plane') && !Object.hasOwn(node.metadata.labels || {}, 'node-role.kubernetes.io/master')); }
  catch (error) { throw new Error(`本机 hosts 已更新，无法读取工作节点：${error.message}`); }
  if (!nodes.length) { onProgress('集群中没有其他工作节点'); return { success: true, nodes: [] }; }
  const result = await distribute(record, { ...body, nodes: nodes.map(node => node.metadata.name) }, { onProgress });
  const failed = result.results.filter(item => !item.success);
  if (failed.length) return { success: false, nodes: result.results, error: `本机已更新，工作节点同步失败：${failed.map(item => `${item.node}（${item.error}）`).join('、')}` };
  return { success: true, nodes: result.results };
}
