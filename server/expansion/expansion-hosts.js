import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = text => createHash('sha256').update(text).digest('hex');
const local = ip => ip.startsWith('127.') || ip === '::1' || ip === '0:0:0:0:0:0:0:1';
function entries(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536 || text.includes('\0')) fail('hosts 内容无效或超过 64 KiB');
  return text.split(/\r?\n/).map(line => {
    const [content, ...comment] = line.split('#');
    const [ip, ...names] = content.trim().split(/\s+/);
    if (!ip) return { line };
    if (!isIP(ip) || !names.length || names.some(name => !/^[a-zA-Z0-9_.-]+$/.test(name))) fail('hosts 存在无法识别的条目，请手动检查');
    return { line, ip, names, comment: comment.length ? ` #${comment.join('#')}` : '' };
  });
}
export function compareHosts(master, node) {
  const masterEntries = entries(master), nodeEntries = entries(node);
  const mappings = list => new Set(list.filter(e => e.ip && !local(e.ip)).flatMap(e => e.names.map(name => `${e.ip}\t${name.toLowerCase()}`)));
  const masterSet = mappings(masterEntries), nodeSet = mappings(nodeEntries);
  const masterOnly = [...masterSet].filter(line => !nodeSet.has(line)).sort();
  const nodeOnly = [...nodeSet].filter(line => !masterSet.has(line)).sort();
  const shared = masterEntries.filter(e => e.ip && !local(e.ip));
  const names = new Set(shared.flatMap(e => e.names.map(name => name.toLowerCase())));
  // A master mapping must never replace a node-local hostname / localhost alias.
  const protectedNames = new Set(nodeEntries.filter(e => e.ip && local(e.ip)).flatMap(e => e.names.map(name => name.toLowerCase())));
  const conflicts = [...names].filter(name => protectedNames.has(name));
  const kept = nodeEntries.map(e => {
    if (!e.ip || local(e.ip)) return e.line;
    const remaining = e.names.filter(name => !names.has(name.toLowerCase()));
    return remaining.length ? `${e.ip}\t${remaining.join(' ')}${e.comment}` : '';
  });
  const proposed = `${kept.join('\n').trimEnd()}\n${shared.map(e => e.line).join('\n')}\n`;
  return { master, node, masterOnly, nodeOnly, different: !!(masterOnly.length || nodeOnly.length), proposed, conflicts };
}

export function selectedHosts(snapshot, selectedEntries, customEntries = []) {
  if (!Array.isArray(selectedEntries) || !Array.isArray(customEntries) || selectedEntries.length + customEntries.length > 2048) fail('hosts 条目列表无效');
  if (selectedEntries.some(line => !snapshot.masterOnly.includes(line))) fail('所选条目不在本次对比结果中');
  const additions = [...new Set(selectedEntries)];
  for (const entry of customEntries) {
    if (!entry || typeof entry.ip !== 'string' || typeof entry.names !== 'string' || !isIP(entry.ip) || local(entry.ip) || !entry.names.trim() || !/^[a-zA-Z0-9_.\- \t]+$/.test(entry.names)) fail('自定义条目需要有效的非回环 IP 和主机名');
    additions.push(`${entry.ip}\t${entry.names.trim()}`);
  }
  if (!additions.length) fail('请至少选择或添加一个 hosts 条目');
  const parsed = entries(additions.join('\n'));
  const names = new Map();
  for (const entry of parsed) for (const name of entry.names) {
    const key = name.toLowerCase();
    if (names.has(key) && names.get(key) !== entry.ip) fail(`主机名 ${name} 选择了多个不同 IP`);
    names.set(key, entry.ip);
  }
  const original = entries(snapshot.node);
  if (original.some(entry => entry.ip && local(entry.ip) && entry.names.some(name => names.has(name.toLowerCase())))) fail('所选条目与新节点回环主机名冲突', 409);
  const kept = original.map(entry => {
    if (!entry.ip || local(entry.ip)) return entry.line;
    const remaining = entry.names.filter(name => !names.has(name.toLowerCase()));
    if (remaining.length === entry.names.length) return entry.line;
    return remaining.length ? `${entry.ip}\t${remaining.join(' ')}${entry.comment}` : entry.comment.trimStart();
  });
  const proposed = `${kept.join('\n').trimEnd()}\n${[...new Set(additions)].join('\n')}\n`;
  entries(proposed);
  return proposed;
}

export function hostsWriteScript(before, proposed, backupId = randomUUID()) {
  // Only hashes, server-created IDs and base64 enter the shell script.
  return `set -Eeuo pipefail
umask 077
[[ ! -L /etc/hosts && -f /etc/hosts ]]
exec 9>/run/kubescope-hosts.lock
flock -x 9
[[ $(sha256sum /etc/hosts | cut -d' ' -f1) == '${hash(before)}' ]] || { echo 'hosts 已变化，请重新对比' >&2; exit 73; }
backup='/etc/hosts.kubescope-${backupId}.bak'
cp -p /etc/hosts "$backup"
temp=$(mktemp /etc/.kubescope-hosts.XXXXXX)
trap 'rm -f "$temp"' EXIT
printf '%s' '${Buffer.from(proposed).toString('base64')}' | base64 -d > "$temp"
# Write in place to support bind-mounted /etc/hosts and preserve its permissions.
if ! cat "$temp" > /etc/hosts; then cat "$backup" > /etc/hosts; exit 74; fi
[[ $(sha256sum /etc/hosts | cut -d' ' -f1) == '${hash(proposed)}' ]] || { cat "$backup" > /etc/hosts; exit 74; }
printf '%s' "$backup"
`;
}

export function createHostsService({ ssh, readMaster = () => readFile('/etc/hosts', 'utf8'), now = Date.now }) {
  const comparisons = new Map();
  return async (route, target, body, password, sshPassword) => {
    if (route === '/hosts/compare') {
      const master = await readMaster();
      const node = await ssh(target, 'set -eu\n[[ $(wc -c < /etc/hosts) -le 65536 ]]\ncat /etc/hosts', password, sshPassword, 30000);
      const result = compareHosts(master, node);
      for (const [key, value] of comparisons) if (value.expires <= now()) comparisons.delete(key);
      if (comparisons.size >= 100) comparisons.delete(comparisons.keys().next().value);
      const comparisonId = randomUUID();
      comparisons.set(comparisonId, { ...result, target: JSON.stringify(target), expires: now() + 5 * 60 * 1000 });
      return { ...result, comparisonId };
    }
    const snapshot = comparisons.get(body.comparisonId);
    if (!snapshot || snapshot.expires <= now() || snapshot.target !== JSON.stringify(target)) fail('对比已过期或目标已变化，请重新对比', 409);
    if (body.confirm !== true) fail('请确认 hosts 修改');
    let proposed = snapshot.proposed;
    if (body.selectedEntries !== undefined || body.customEntries !== undefined) proposed = selectedHosts(snapshot, body.selectedEntries, body.customEntries);
    else if (snapshot.conflicts.length) fail('master 映射与新节点回环主机名冲突，请手动处理后重新对比', 409);
    if (await readMaster() !== snapshot.master) fail('master hosts 已变化，请重新对比', 409);
    let backup;
    try { backup = await ssh(target, hostsWriteScript(snapshot.node, proposed), password, sshPassword, 30000); }
    catch (error) {
      if (/退出码 73/.test(error.message)) fail('新节点 hosts 已变化，请重新对比', 409);
      throw error;
    }
    comparisons.delete(body.comparisonId);
    return { applied: true, backup: backup.trim() };
  };
}
