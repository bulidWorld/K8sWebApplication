import { resourcePath, validateName } from '../core/kubernetes.js';

export async function listCustomResources(kubernetes, crdName, namespace = '', countOnly = false) {
  const crd = await kubernetes.request(resourcePath('customresourcedefinitions', '', crdName));
  const spec = crd.spec || {};
  const version = spec.versions?.find(v => v.served && v.storage) || spec.versions?.find(v => v.served);
  if (!version || !['Namespaced', 'Cluster'].includes(spec.scope)) {
    throw Object.assign(new Error('该 CRD 没有可用的 API 版本或作用域'), { status: 400 });
  }
  const group = validateName(spec.group, 'API 组');
  const plural = validateName(spec.names?.plural, '资源类型');
  const apiVersion = `${group}/${validateName(version.name, 'API 版本')}`;
  let target = `/apis/${apiVersion}`;
  if (spec.scope === 'Namespaced' && namespace) target += `/namespaces/${validateName(namespace, '命名空间')}`;
  if (countOnly) {
    let count = 0;
    let continuation = '';
    do {
      const query = new URLSearchParams({ limit: '200', ...(continuation ? { continue: continuation } : {}) });
      const page = await kubernetes.request(`${target}/${plural}?${query}`);
      if (!Array.isArray(page.items)) throw new Error('Kubernetes API 返回无效资源列表');
      count += page.items.length;
      continuation = page.metadata?.continue || '';
    } while (continuation);
    return { count };
  }
  const result = await kubernetes.request(`${target}/${plural}`);
  return { ...result, apiVersion, resourceKind: spec.names.kind, scope: spec.scope, schema: version.schema?.openAPIV3Schema || null, crdName };
}
