import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeHost } from '../expansion/remote-ssh.js';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const defaultFile = fileURLToPath(new URL('../../var/registry-node-access.json', import.meta.url));
const publicItem = ({ loginPassword, sudoPassword, identityFile, ...item }) => ({ ...item, hasLoginPassword: !!loginPassword, hasSudoPassword: !!sudoPassword, hasIdentityFile: !!identityFile });

export function createRegistryNodeAccess({ kubernetes, expansion, file = defaultFile, probe = probeHost } = {}) {
  const probes = new Map(); let queue = Promise.resolve();
  async function records() { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } }
  async function nodeTarget(nodeName) {
    const nodes = (await kubernetes.request('/api/v1/nodes')).items;
    const node = nodes.find(item => item.metadata.name === nodeName);
    if (!node) fail('节点不存在', 404);
    const host = node.status?.addresses?.find(item => item.type === 'InternalIP')?.address;
    if (isIP(host) !== 4) fail('节点没有可用的 InternalIP IPv4 地址');
    return { nodeName, host };
  }
  async function saveRecords(items) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(items, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  }
  const serial = work => { const result = queue.then(work); queue = result.catch(() => {}); return result; };
  const passwordValid = value => typeof value === 'string' && value.length <= 1024 && !/[\r\n\0]/.test(value);
  return {
    list: async () => ({ items: (await records()).map(publicItem) }),
    resolve: async nodeName => {
      const current = (await records()).find(item => item.nodeName === nodeName);
      if (!current) fail(`节点 ${nodeName} 尚未配置 SSH 登录方式，请到“系统维护 → 节点配置”完成配置`, 409);
      const target = await nodeTarget(nodeName);
      if (current.host !== target.host) fail(`节点 ${nodeName} 的 IP 已变化，请重新核对 SSH 主机指纹`, 409);
      return current;
    },
    probe: async body => {
      if (typeof body?.nodeName !== 'string' || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535 || !/^[a-z_][a-z0-9_-]*$/.test(body.user || '')) fail('节点登录参数无效');
      const target = { ...await nodeTarget(body.nodeName), port: body.port, user: body.user };
      const fingerprint = await probe(target);
      const id = randomUUID();
      probes.set(id, { ...target, fingerprint, expires: Date.now() + 5 * 60 * 1000 });
      for (const [key, value] of probes) if (value.expires < Date.now() || probes.size > 100) probes.delete(key);
      return { probeId: id, fingerprint, host: target.host };
    },
    save: body => serial(async () => {
      const verified = probes.get(body?.probeId);
      const target = await nodeTarget(body?.nodeName);
      if (!verified || verified.expires < Date.now() || verified.nodeName !== target.nodeName || verified.host !== target.host || verified.port !== body.port || verified.user !== body.user || verified.fingerprint !== body.fingerprint) fail('请先获取并确认当前节点的 SSH 主机指纹');
      if (!['password', 'key'].includes(body.auth)) fail('请选择 SSH 认证方式');
      if (body.auth === 'password' && (!passwordValid(body.loginPassword) || !body.loginPassword)) fail('请输入有效的 SSH 登录密码');
      if (body.auth === 'key' && (typeof body.identityFile !== 'string' || !path.isAbsolute(body.identityFile))) fail('请输入服务器上的 SSH 私钥绝对路径');
      if (!passwordValid(body.sudoPassword)) fail('sudo 密码无效');
      const items = await records();
      const record = { ...target, port: body.port, user: body.user, auth: body.auth, hostFingerprint: verified.fingerprint, loginPassword: body.auth === 'password' ? body.loginPassword : '', identityFile: body.auth === 'key' ? body.identityFile : '', sudoPassword: body.sudoPassword };
      const index = items.findIndex(item => item.nodeName === target.nodeName);
      if (index < 0) items.push(record); else items[index] = record;
      await saveRecords(items); probes.delete(body.probeId);
      return { item: publicItem(record) };
    }),
    importExpansion: body => serial(async () => {
      if (!expansion || typeof body?.nodeName !== 'string' || typeof body.revision !== 'string') fail('节点扩容配置不可用');
      const target = await expansion('RESOLVE_TARGET', '/targets', { nodeName: body.nodeName, revision: body.revision });
      if (!target.hostFingerprint || !['password', 'key'].includes(target.auth || 'key')) fail('扩容节点尚未确认 SSH 主机指纹');
      if (!passwordValid(body.sshPassword || '') || !passwordValid(body.sudoPassword || '')) fail('节点登录密码无效');
      if (target.auth === 'password' && !body.sshPassword) fail('请输入 SSH 登录密码');
      const record = { nodeName: target.nodeName, host: target.host, port: target.port, user: target.user, auth: target.auth || 'key', hostFingerprint: target.hostFingerprint,
        loginPassword: target.auth === 'password' ? body.sshPassword : '', identityFile: target.auth === 'password' ? '' : target.identityFile, sudoPassword: body.sudoPassword || '' };
      const items = await records();
      const index = items.findIndex(item => item.nodeName === record.nodeName);
      if (index < 0) items.push(record); else items[index] = record;
      await saveRecords(items);
      return { item: publicItem(record) };
    }),
    remove: nodeName => serial(async () => { const items = await records(); await saveRecords(items.filter(item => item.nodeName !== nodeName)); return { deleted: true }; }),
  };
}
