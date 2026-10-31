export const NODE_XML_MAX_BYTES = 64 * 1024;
const fail = message => { throw new Error(`XML 导入失败：${message}`); };
const ipv4 = value => /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value) && value.split('.').every(n => Number(n) <= 255);
const ipAddress = value => {
  if (ipv4(value)) return true;
  if (!/^[\da-f:]+$/i.test(value) || !value.includes(':')) return false;
  try { return new URL(`http://[${value}]/`).hostname.startsWith('['); } catch { return false; }
};
const port = (value, fallback) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) fail('端口必须为 1–65535 的整数');
  return Number(value);
};
const secret = (value = '', label) => {
  if (value.length > 3072 || /[\r\n\0]/.test(value)) fail(`${label}不能包含换行或空字符，且不能超过 3072 个字符`);
  return value;
};

// Semantic checks complement the document structure checks below and the downloadable XSD.
export function validateNodeImport({ target, credentials = {}, hosts = [], registry }) {
  if (!ipv4(target.host)) fail('target.host 必须是有效的 IPv4 地址');
  if (!/^[a-z_][a-z0-9_-]*$/.test(target.user || '')) fail('target.user 必须是有效的 SSH 用户名');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(target.nodeName || '')) fail('target.nodeName 需为 1–63 位小写字母、数字或连字符，并以字母或数字开头');
  if (hosts.length > 2048) fail('hosts 映射不能超过 2048 条');
  const seen = new Map();
  const mappings = hosts.map(entry => {
    if (!ipAddress(entry.ip) || entry.ip.startsWith('127.') || (entry.ip.includes(':') && new URL(`http://[${entry.ip}]/`).hostname === '[::1]')) fail('hosts 映射需要有效的非回环 IPv4 或 IPv6 地址');
    const names = (entry.names || '').trim().split(/\s+/);
    if (names.some(name => !/^[a-zA-Z0-9_.-]+$/.test(name))) fail('hosts.names 必须是以空格分隔的主机名');
    for (const name of names) {
      const key = name.toLowerCase();
      if (seen.has(key) && seen.get(key) !== entry.ip) fail(`hosts 主机名 ${name} 指定了不同 IP`);
      seen.set(key, entry.ip);
    }
    return { ip: entry.ip, names: names.join(' ') };
  });
  let parsedRegistry = null;
  if (registry) {
    if (!ipv4(registry.ip)) fail('registry.ip 必须是有效的 IPv4 地址');
    const protocol = registry.protocol ?? 'https';
    if (!['http', 'https'].includes(protocol)) fail('仓库协议只支持 http 或 https');
    parsedRegistry = { ip: registry.ip, protocol, port: port(registry.port, protocol === 'https' ? 443 : 80), token: secret(registry.token, '仓库 Token') };
  }
  return {
    target: { ...target, port: port(target.port, 22) },
    credentials: { sshPassword: secret(credentials.sshPassword, 'SSH 密码'), sudoPassword: secret(credentials.sudoPassword, 'sudo 密码'), samePassword: credentials.sudoPassword === undefined },
    hosts: mappings, registry: parsedRegistry,
  };
}

export function parseNodeImportXml(text) {
  if (new TextEncoder().encode(text).length > NODE_XML_MAX_BYTES) fail('文件不能超过 64 KiB');
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail('不支持 DOCTYPE 或实体声明');
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.getElementsByTagName('parsererror').length || !document.documentElement) fail('文件不是有效的 XML');
  const root = document.documentElement;
  function inspect(element, attributes, children) {
    if (element.namespaceURI) fail('请使用无命名空间的 XML 元素');
    for (const attr of Array.from(element.attributes)) {
      if (attr.name === 'xmlns:xsi' && attr.value === 'http://www.w3.org/2001/XMLSchema-instance') continue;
      if (element === root && attr.namespaceURI === 'http://www.w3.org/2001/XMLSchema-instance' && attr.localName === 'noNamespaceSchemaLocation') continue;
      if (!attributes.includes(attr.name)) fail(`${element.tagName} 包含不支持的属性 ${attr.name}`);
    }
    const elements = Array.from(element.childNodes).filter(node => node.nodeType === 1);
    if (children !== null) {
      let last = -1;
      const seen = new Set();
      for (const child of elements) {
        const index = children.indexOf(child.tagName);
        if (index < 0 || index < last || (seen.has(child.tagName) && element.tagName !== 'hosts')) fail(`${element.tagName} 的子元素未知、重复或顺序错误`);
        last = index; seen.add(child.tagName);
      }
      if (Array.from(element.childNodes).some(node => [3, 4].includes(node.nodeType) && node.textContent.trim())) fail(`${element.tagName} 不允许直接填写文本`);
    } else if (elements.length) fail(`${element.tagName} 只能包含文本`);
    return elements;
  }
  const attrs = element => Object.fromEntries(Array.from(element.attributes).filter(a => !a.namespaceURI).map(a => [a.name, a.value]));
  if (root.tagName !== 'nodeExpansion') fail('根元素必须为 nodeExpansion');
  const children = inspect(root, ['version'], ['target', 'credentials', 'hosts', 'registry']);
  if (root.getAttribute('version') !== '1') fail('version 必须为 1');
  const data = {};
  for (const element of children) {
    if (element.tagName === 'target') { inspect(element, ['host', 'port', 'user', 'nodeName'], []); data.target = attrs(element); }
    if (element.tagName === 'credentials') {
      data.credentials = {};
      for (const child of inspect(element, [], ['sshPassword', 'sudoPassword'])) { inspect(child, [], null); data.credentials[child.tagName] = child.textContent; }
    }
    if (element.tagName === 'hosts') data.hosts = inspect(element, [], ['mapping']).map(child => { inspect(child, ['ip', 'names'], []); return attrs(child); });
    if (element.tagName === 'registry') {
      const children = inspect(element, ['ip', 'protocol', 'port'], ['token']);
      data.registry = attrs(element);
      if (children.length) { inspect(children[0], [], null); data.registry.token = children[0].textContent; }
    }
  }
  if (!data.target) fail('缺少 target 元素');
  return validateNodeImport(data);
}
