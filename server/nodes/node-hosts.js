import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { hostsWriteScript } from '../expansion/expansion-hosts.js';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function parseMappings(text) {
  return text.split('\n').flatMap(line => {
    const [ip, ...names] = line.split('#')[0].trim().split(/\s+/);
    return isIP(ip) ? names.map(name => ({ ip, name })) : [];
  });
}
export function modifyHosts(text, change) {
  if (!change || !['add', 'delete'].includes(change.action) || !isIP(change.ip) || typeof change.name !== 'string' || change.name.length > 253 || !/^[a-zA-Z0-9_](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9_])?$/.test(change.name)) fail('请填写有效 IP 地址及域名');
  if (Buffer.byteLength(text) > 65536 || text.includes('\0')) fail('hosts 内容无效或超过 64 KiB');
  const name = change.name.toLowerCase();
  const mappings = parseMappings(text).filter(row => row.name.toLowerCase() === name);
  if (change.action === 'add' && mappings.some(row => row.ip !== change.ip)) fail(`域名 ${change.name} 已映射到其他 IP，请先删除原映射`, 409);
  if (change.action === 'add') return mappings.length ? text : `${text.trimEnd()}\n${change.ip}\t${change.name}\n`;
  return text.split('\n').map(line => {
    const offset = line.indexOf('#');
    const comment = offset < 0 ? '' : line.slice(offset);
    const [ip, ...names] = (offset < 0 ? line : line.slice(0, offset)).trim().split(/\s+/);
    if (ip !== change.ip || !names.some(value => value.toLowerCase() === name)) return line;
    const kept = names.filter(value => value.toLowerCase() !== name);
    return kept.length ? `${ip}\t${kept.join(' ')}${comment ? ` ${comment}` : ''}` : comment;
  }).join('\n');
}
export function createNodeHosts({ kubernetes, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  async function run(node, script, write = false) {
    const name = `kubescope-hosts-${randomUUID()}`;
    const base = '/api/v1/namespaces/kube-system/pods';
    let created = false;
    try {
      await kubernetes.request(base, true, { apiVersion: 'v1', kind: 'Pod', metadata: { name, labels: { 'app.kubernetes.io/name': 'kubescope-hosts' } }, spec: {
        nodeName: node, restartPolicy: 'Never', activeDeadlineSeconds: 60, automountServiceAccountToken: false,
        tolerations: [{ operator: 'Exists' }], containers: [{ name: 'hosts', image: process.env.K8S_HOSTS_IMAGE || 'node:22-bookworm-slim', command: ['bash', '-c', script], securityContext: { runAsUser: 0, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'], add: write ? ['DAC_OVERRIDE', 'FOWNER'] : ['DAC_READ_SEARCH'] } }, volumeMounts: [{ name: 'etc', mountPath: '/host/etc', readOnly: !write }, ...(write ? [{ name: 'run', mountPath: '/host/run' }] : [])] }], volumes: [{ name: 'etc', hostPath: { path: '/etc', type: 'Directory' } }, ...(write ? [{ name: 'run', hostPath: { path: '/run', type: 'Directory' } }] : [])],
      } }, { method: 'POST', contentType: 'application/json' });
      created = true;
      for (let attempt = 0; attempt < 65; attempt++) {
        const pod = await kubernetes.request(`${base}/${name}`);
        if (['Succeeded', 'Failed'].includes(pod.status?.phase)) {
          if (pod.status.phase === 'Failed') fail('节点 hosts 操作失败，文件可能已变化，请重新加载后重试', 409);
          return await kubernetes.request(`${base}/${name}/log`, false);
        }
        await pause(1000);
      }
      fail('节点操作超时，请检查节点状态及操作镜像是否可拉取', 504);
    } finally {
      if (created) await kubernetes.request(`${base}/${name}`, true, { gracePeriodSeconds: 0 }, { method: 'DELETE', contentType: 'application/json' }).catch(() => {});
    }
  }
  const read = node => run(node, 'set -eu; test "$(wc -c < /host/etc/hosts)" -le 65536; cat /host/etc/hosts');
  return async (node, body) => {
    const nodes = (await kubernetes.request('/api/v1/nodes')).items;
    if (!nodes.some(item => item.metadata.name === node)) fail('节点不存在', 404);
    if (!body) { const content = await read(node); return { content, mappings: parseMappings(content), nodes: nodes.map(item => item.metadata.name) }; }
    if (body.confirm !== true || typeof body.before !== 'string' || !Array.isArray(body.syncNodes) || body.syncNodes.length > nodes.length || body.syncNodes.some(name => name === node || !nodes.some(item => item.metadata.name === name))) fail('请确认变更并选择有效的同步节点');
    modifyHosts(body.before, body.change);
    const results = [];
    for (const target of [node, ...new Set(body.syncNodes)]) {
      try {
        const before = target === node ? body.before : await read(target);
        const proposed = modifyHosts(before, body.change);
        if (Buffer.byteLength(proposed) > 65536) fail('修改后 hosts 超过 64 KiB');
        if (proposed !== before) await run(target, hostsWriteScript(before, proposed).replaceAll('/etc/', '/host/etc/').replaceAll('/run/', '/host/run/'), true);
        results.push({ node: target, success: true });
      } catch (error) { results.push({ node: target, success: false, error: error.message }); }
      if (target === node && !results[0].success) break;
    }
    return { results };
  };
}
