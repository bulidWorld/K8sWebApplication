import { isIP } from 'node:net';

export function validateRegistry(registry) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) || Object.keys(registry).some(key => !['ip', 'protocol', 'port', 'token'].includes(key))) fail('仓库配置字段无效');
  if (isIP(registry.ip) !== 4 || /^(127|0)\./.test(registry.ip)) fail('请输入仓库非回环 IPv4 地址');
  if (typeof registry.token !== 'string' || !/^[A-Za-z0-9._~+\/=-]{1,3072}$/.test(registry.token)) fail('仓库 Token 格式无效（最多 3072 字符）');
  const protocol = registry.protocol === undefined ? 'https' : registry.protocol;
  if (!['https', 'http'].includes(protocol)) fail('证书接口协议必须是 https 或 http');
  const port = registry.port === undefined ? (protocol === 'http' ? 80 : 443) : registry.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('证书接口端口必须是 1–65535 的整数');
  return { ip: registry.ip, protocol, port, token: registry.token };
}

// Values are validated before interpolation; credentials travel through script stdin.
export function registryEnvironment(registry) {
  return `export REGISTRY_IP='${registry.ip}'\nexport REGISTRY_PROTOCOL='${registry.protocol ?? 'https'}'\nexport REGISTRY_PORT='${registry.port ?? 443}'\nexport REGISTRY_TLS_EXPORT_TOKEN='${registry.token}'\n`;
}
