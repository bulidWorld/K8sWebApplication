import { load, JSON_SCHEMA } from 'js-yaml';
import { validateName } from '../core/kubernetes.js';

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function buildResourceDefinitionPatch(current, body) {
  if (!object(body) || typeof body.manifest !== 'string' || body.manifest.length > 128 * 1024) fail('请提供不超过 128 KiB 的 YAML/JSON 定义');
  let desired;
  try { desired = load(body.manifest, { schema: JSON_SCHEMA, json: false }); }
  catch (error) { fail(`定义格式不正确：${error.message}`); }
  if (!object(desired) || desired.apiVersion !== current.apiVersion || desired.kind !== current.kind || !object(desired.metadata)) fail('API 版本、Kind 和 metadata 必须与当前资源一致');
  const meta = desired.metadata;
  if (meta.name !== current.metadata.name) fail('资源名称与当前实例不一致');
  if (meta.namespace !== undefined && meta.namespace !== current.metadata.namespace) fail('命名空间与当前实例不一致');
  if ((meta.uid !== undefined && meta.uid !== current.metadata.uid) || (meta.resourceVersion !== undefined && meta.resourceVersion !== current.metadata.resourceVersion)) fail('YAML 中的 UID 或资源版本与当前实例不一致；可以从原始清单中移除这两个自动生成字段');
  if (body.uid !== current.metadata.uid || typeof body.resourceVersion !== 'string' || body.resourceVersion !== current.metadata.resourceVersion) fail('实例已发生变化，请重新加载后再编辑。', 409);
  if (Object.keys(meta).some(key => !['name', 'namespace', 'uid', 'resourceVersion', 'labels', 'annotations'].includes(key))) fail('metadata 仅允许编辑标签和注解');
  if (desired.status !== undefined || Object.keys(desired).some(key => !['apiVersion', 'kind', 'metadata', 'spec'].includes(key))) fail('仅支持编辑 metadata 标签、注解及 spec，不支持修改 status');
  for (const key of ['labels', 'annotations']) if (meta[key] !== undefined && !object(meta[key])) fail(`metadata.${key} 必须是对象`);
  const patch = [
    { op: 'test', path: '/metadata/uid', value: current.metadata.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: current.metadata.resourceVersion },
  ];
  if (desired.spec !== undefined) patch.push({ op: current.spec === undefined ? 'add' : 'replace', path: '/spec', value: desired.spec });
  else if (current.spec !== undefined) patch.push({ op: 'remove', path: '/spec' });
  for (const key of ['labels', 'annotations']) {
    if (meta[key] !== undefined) patch.push({ op: 'add', path: `/metadata/${key}`, value: meta[key] });
    else if (current.metadata[key] !== undefined) patch.push({ op: 'remove', path: `/metadata/${key}` });
  }
  return patch;
}

export async function resourceDefinitionTarget(kubernetes, current, namespaceHint = '') {
  const version = current.apiVersion?.split('/');
  if (!version?.length || version.length > 2) fail('资源 apiVersion 无效');
  const prefix = version.length === 1 ? `/api/${encodeURIComponent(version[0])}` : `/apis/${encodeURIComponent(version[0])}/${encodeURIComponent(version[1])}`;
  const discovery = await kubernetes.request(prefix);
  const resource = discovery.resources?.find(item => item.kind === current.kind && !item.name.includes('/') && item.verbs?.includes('patch'));
  if (!resource) fail('集群未发现该资源的可写 API', 404);
  const namespace = current.metadata.namespace || namespaceHint;
  if (resource.namespaced && !namespace) fail('该资源需要命名空间');
  if (!resource.namespaced && namespace) fail('集群级资源不能设置命名空间');
  const collection = `${prefix}${resource.namespaced ? `/namespaces/${encodeURIComponent(validateName(namespace, '命名空间'))}` : ''}/${resource.name}`;
  return `${collection}/${encodeURIComponent(validateName(current.metadata.name))}`;
}
