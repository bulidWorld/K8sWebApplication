import { isIP } from 'node:net';
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
export function registryHostOptions(record, body) {
  if (body.mode !== undefined && !['hosts', 'configure', 'trust'].includes(body.mode)) fail('仓库操作类型无效');
  if (!Array.isArray(body.domains) || (!body.domains.length && body.mode !== 'trust') || body.domains.length > 64 || body.domains.some(domain => typeof domain !== 'string' || domain.length > 253 || !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(domain) || domain.toLowerCase() === 'localhost' || isIP(domain))) fail('请选择有效的非 localhost 仓库域名');
  if (body.mapHosts !== undefined && typeof body.mapHosts !== 'boolean') fail('hosts 选项无效');
  const url = new URL(record.url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const domains = [...new Set(body.domains.map(domain => domain.toLowerCase()))];
  const addressHosts = (record.urls || [record.url]).map(value => new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase());
  if (body.mode !== 'hosts') for (const address of addressHosts) if (!domains.includes(address) && isIP(address) !== 6) domains.push(address);
  if (domains.length > 64) fail('仓库地址与镜像源域名总数不能超过 64 个');
  const mapHosts = body.mapHosts === true || body.mode === 'hosts' || (body.mode === 'trust' && domains.some(domain => !isIP(domain)));
  const hostsIp = body.hostsIp || record.hostsIp || (isIP(host) ? host : '');
  if (mapHosts && (!isIP(hostsIp) || /^(127\.|0\.)/.test(hostsIp) || ['::1', '::', '0:0:0:0:0:0:0:1'].includes(hostsIp))) fail('请填写仓库可访问的非回环 IP 地址');
  const hostsDomains = domains.filter(domain => !isIP(domain));
  if (mapHosts) for (const address of addressHosts) if (!isIP(address) && address !== 'localhost' && !hostsDomains.includes(address)) hostsDomains.push(address);
  return { mapHosts, hostsIp, hostsDomains, domains, hostsOnly: body.mode === 'hosts', trustOnly: body.mode === 'trust' };
}
// Self-contained for execution inside the maintenance Pod.
export function mapRegistryHosts(source, ip, domains) {
  if (Buffer.byteLength(source) > 65536 || source.includes('\0')) throw new Error('hosts 内容无效或超过 64 KiB');
  const names = new Set(domains.map(domain => domain.toLowerCase()));
  const mappings = new Map([...names].map(name => [name, []]));
  for (const line of source.split('\n')) {
    const [address, ...aliases] = line.split('#')[0].trim().split(/\s+/);
    for (const alias of aliases) if (names.has(alias.toLowerCase())) mappings.get(alias.toLowerCase()).push(address);
  }
  const changes = new Set([...mappings].filter(([, addresses]) => addresses.length !== 1 || addresses[0] !== ip).map(([name]) => name));
  if (!changes.size) return source;
  const lines = source.split('\n').map(line => {
    const offset = line.indexOf('#');
    const content = offset < 0 ? line : line.slice(0, offset);
    const comment = offset < 0 ? '' : line.slice(offset);
    const [address, ...aliases] = content.trim().split(/\s+/);
    if (!aliases.some(alias => changes.has(alias.toLowerCase()))) return line;
    const kept = aliases.filter(alias => !changes.has(alias.toLowerCase()));
    return kept.length ? `${address}\t${kept.join(' ')}${comment ? ` ${comment}` : ''}` : comment.trim() === '# kubescope registry' ? '' : comment;
  });
  const proposed = `${lines.join('\n').trimEnd()}\n${ip}\t${[...changes].join(' ')} # kubescope registry\n`;
  if (Buffer.byteLength(proposed) > 65536) throw new Error('修改后 hosts 超过 64 KiB');
  return proposed;
}
