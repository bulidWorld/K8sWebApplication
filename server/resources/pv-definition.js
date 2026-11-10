import { load, JSON_SCHEMA } from 'js-yaml';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

export function buildPvDefinitionPatch(current, body) {
  if (!object(body) || typeof body.manifest !== 'string' || !body.manifest.trim() ||
      typeof body.uid !== 'string' || !body.uid || typeof body.resourceVersion !== 'string' || !body.resourceVersion ||
      Object.keys(body).some(key => !['manifest', 'uid', 'resourceVersion'].includes(key))) fail('请提供 PV 定义、UID 和资源版本');
  if (body.uid !== current.metadata.uid || body.resourceVersion !== current.metadata.resourceVersion)
    fail('PV 已发生变化，请重新加载后再编辑。', 409);
  let definition;
  try { definition = load(body.manifest, { schema: JSON_SCHEMA }); }
  catch (error) { fail(`YAML 格式不正确：${error.message}`); }
  if (!object(definition) || definition.apiVersion !== 'v1' || definition.kind !== 'PersistentVolume' ||
      !object(definition.metadata) || !object(definition.spec)) fail('定义必须为 v1 PersistentVolume，且包含 metadata 和 spec');
  if (Object.keys(definition).some(key => !['apiVersion', 'kind', 'metadata', 'spec'].includes(key))) fail('仅支持编辑 metadata 标签、注解及 spec，不支持修改 status');
  const meta = definition.metadata;
  if (meta.name !== current.metadata.name || meta.uid !== body.uid || meta.resourceVersion !== body.resourceVersion)
    fail('不能修改 PV 名称、UID 或资源版本');
  if (Object.keys(meta).some(key => !['name', 'uid', 'resourceVersion', 'labels', 'annotations'].includes(key))) fail('metadata 仅允许包含名称、UID、资源版本、标签和注解');
  const patch = [
    { op: 'test', path: '/metadata/uid', value: body.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: body.resourceVersion },
    { op: 'replace', path: '/spec', value: definition.spec },
  ];
  for (const key of ['labels', 'annotations']) {
    if (Object.hasOwn(meta, key)) {
      if (!object(meta[key]) || Object.values(meta[key]).some(value => typeof value !== 'string')) fail(`${key} 必须是字符串键值对象`);
      patch.push({ op: 'add', path: `/metadata/${key}`, value: meta[key] });
    } else if (Object.hasOwn(current.metadata, key)) patch.push({ op: 'remove', path: `/metadata/${key}` });
  }
  return patch;
}
