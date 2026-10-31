import { loadAll } from 'js-yaml';

export const maxManifestBytes = 10240 * 1024;
export function validateApply(body) {
  if (!body || typeof body.manifest !== "string" || !body.manifest.trim())
    throw Object.assign(new Error("请上传或填写 YAML 配置"), { status: 400 });
  if (Buffer.byteLength(body.manifest) > maxManifestBytes)
    throw Object.assign(new Error("YAML 配置不能超过 10 MiB"), { status: 413 });
  if (body.serverSide !== undefined && typeof body.serverSide !== "boolean")
    throw Object.assign(new Error("serverSide 必须为布尔值"), { status: 400 });
}

const lastApplied = 'kubectl.kubernetes.io/last-applied-configuration';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const segment = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value) && value.length <= 253;

// Three-way JSON merge: remove fields previously declared but now omitted;
// retain live fields never declared here. JSON merge treats arrays atomically.
export function clientMergePatch(previous, desired, current) {
  const patch = Object.create(null);
  for (const key of Object.keys(previous || {})) {
    if (!Object.hasOwn(desired, key) && Object.hasOwn(current || {}, key)) patch[key] = null;
  }
  for (const [key, value] of Object.entries(desired)) {
    if (object(value) && object(current?.[key])) {
      const nested = clientMergePatch(object(previous?.[key]) ? previous[key] : {}, value, current[key]);
      if (Object.keys(nested).length) patch[key] = nested;
    } else if (JSON.stringify(value) !== JSON.stringify(current?.[key])) patch[key] = value;
  }
  return patch;
}

function parseManifest(text) {
  let documents;
  // Keep wire-format keys and unknown fields. SDK YAML helpers deserialize
  // known kinds into models (e.g. default -> _default), unsuitable for raw HTTP.
  try { documents = loadAll(text); }
  catch { fail('YAML 格式无效，请检查缩进、重复键及语法'); }
  const resources = [];
  function visit(item, depth = 0) {
    if (depth > 30 || resources.length >= 100) fail('单次最多应用 100 个资源，且嵌套不能超过 30 层');
    if (!object(item)) fail('YAML 文档必须是资源对象');
    if (item.kind === 'List' && item.apiVersion === 'v1') {
      if (!Array.isArray(item.items)) fail('List.items 必须是数组');
      item.items.forEach(child => visit(child, depth + 1));
      return;
    }
    if (typeof item.apiVersion !== 'string' || !item.apiVersion.split('/').every(segment) || item.apiVersion.split('/').length > 2 || !segment(item.kind) || !segment(item.metadata?.name))
      fail('每个资源必须包含有效的 apiVersion、kind 和 metadata.name');
    if (item.metadata.namespace !== undefined && !segment(item.metadata.namespace)) fail('命名空间格式不正确');
    // Reject cycles from YAML aliases and detach alias references.
    try { resources.push(JSON.parse(JSON.stringify(item))); }
    catch { fail('YAML 不能包含循环引用'); }
  }
  documents.filter(item => item !== null && item !== undefined).forEach(item => visit(item));
  if (!resources.length) fail('YAML 中没有资源');
  return resources;
}

export async function applyManifest(request, body, defaultNamespace = 'default') {
  validateApply(body);
  const resources = parseManifest(body.manifest);
  const output = [];
  const diagnostics = [];
  const discovery = new Map();
  for (const resource of resources) {
    const label = `${resource.kind}/${resource.metadata.name}`;
    try {
      const prefix = resource.apiVersion.includes('/') ? `/apis/${resource.apiVersion}` : `/api/${resource.apiVersion}`;
      if (!discovery.has(prefix)) discovery.set(prefix, await request(prefix));
      const info = discovery.get(prefix).resources?.find(item => item.kind === resource.kind && !item.name.includes('/'));
      if (!info || !segment(info.name)) throw new Error('集群未提供该资源 API，请检查 apiVersion、kind 或 CRD 是否就绪');
      let collection = prefix;
      if (info.namespaced) {
        const namespace = resource.metadata.namespace || defaultNamespace;
        if (!segment(namespace)) fail('默认命名空间格式不正确');
        resource.metadata.namespace = namespace;
        collection += `/namespaces/${namespace}`;
      } else if (resource.metadata.namespace) fail('集群级资源不能指定 namespace');
      collection += `/${info.name}`;
      const target = `${collection}/${resource.metadata.name}`;
      if (body.serverSide) {
        await request(`${target}?fieldManager=kubescope&fieldValidation=Strict`, resource, { method: 'PATCH', contentType: 'application/apply-patch+yaml' });
        output.push(`${label} serverside-applied`);
        continue;
      }
      let current;
      try { current = await request(target); }
      catch (error) { if (error.status !== 404) throw error; }
      resource.metadata.annotations ||= {};
      if (!object(resource.metadata.annotations)) fail('metadata.annotations 必须是对象');
      delete resource.metadata.annotations[lastApplied];
      const saved = JSON.stringify(resource);
      resource.metadata.annotations[lastApplied] = saved;
      if (!current) {
        await request(`${collection}?fieldManager=kubescope-client-side&fieldValidation=Strict`, resource, { method: 'POST', contentType: 'application/json' });
        output.push(`${label} created`);
      } else {
        let previous = {};
        const stored = current.metadata?.annotations?.[lastApplied];
        if (stored) {
          try { previous = JSON.parse(stored); if (!object(previous)) throw new Error(); }
          catch { fail('已有 last-applied-configuration 无效，无法计算客户端补丁'); }
        }
        const patch = clientMergePatch(previous, resource, current);
        patch.metadata ||= {};
        // Prevent overwriting concurrent changes, especially atomic list updates.
        patch.metadata.resourceVersion = current.metadata.resourceVersion;
        await request(`${target}?fieldManager=kubescope-client-side&fieldValidation=Strict`, patch, { method: 'PATCH', contentType: 'application/merge-patch+json' });
        output.push(`${label} configured`);
      }
    } catch (error) {
      // Diagnostics may contain Secret values: return to caller, never log them.
      diagnostics.push(`${label}: ${error.message}`);
    }
  }
  return { success: diagnostics.length === 0, output: output.join('\n') + (output.length ? '\n' : ''), diagnostics: diagnostics.join('\n'), timedOut: false };
}
