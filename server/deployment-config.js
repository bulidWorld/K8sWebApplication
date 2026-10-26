import { validateName } from './kubernetes.js';
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail(`${label}包含不支持的字段`);
}
function integer(value, min, label) {
  if (!Number.isSafeInteger(value) || value < min || value > 2147483647) fail(`${label}必须是 ${min} 到 2147483647 的整数`);
}
function string(value, label, max = 4096) {
  if (typeof value !== 'string' || !value.length || value.length > max) fail(`${label}不能为空且不能超过 ${max} 个字符`);
}
export function quantity(value, type) {
  if (typeof value !== 'string') fail('资源数量必须是字符串');
  const match = value.match(/^(\d+(?:\.\d+)?)(m|Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/);
  if (!match || (type === 'cpu' && match[2] && match[2] !== 'm')) fail('CPU 使用核数或 m；内存使用数字或 Ki/Mi/Gi/Ti/Pi/Ei/k/M/G/T/P/E');
  const factor = { m: .001, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6, k: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };
  const number = Number(match[1]) * (factor[match[2]] || 1);
  if (!Number.isFinite(number) || (type === 'cpu' && Math.abs(number * 1000 - Math.round(number * 1000)) > 1e-7)) fail('CPU 精度不能小于 1m');
  return number;
}
function probe(value, label, previous) {
  if (value === null) return;
  // Phase one preserves existing non-HTTP probes without editing their handlers.
  if (value && !value.httpGet && JSON.stringify(value) === JSON.stringify(previous)) return;
  object(value, ['httpGet', 'initialDelaySeconds', 'timeoutSeconds', 'periodSeconds', 'successThreshold', 'failureThreshold', 'terminationGracePeriodSeconds'], label);
  object(value.httpGet, ['path', 'port', 'scheme', 'host', 'httpHeaders'], `${label} HTTP`);
  const http = value.httpGet;
  if (typeof http.port === 'number') { integer(http.port, 1, '探针端口'); if (http.port > 65535) fail('探针端口不能超过 65535'); }
  else if (typeof http.port !== 'string' || !/^[a-z0-9]([a-z0-9-]{0,13}[a-z0-9])?$/.test(http.port) || !/[a-z]/.test(http.port)) fail('探针端口名称无效');
  if (http.path !== undefined && (typeof http.path !== 'string' || !http.path.startsWith('/') || http.path.length > 4096)) fail('探针路径必须以 / 开头');
  if (http.scheme !== undefined && !['HTTP', 'HTTPS'].includes(http.scheme)) fail('探针协议无效');
  if (http.host !== undefined && typeof http.host !== 'string') fail('探针主机必须是字符串');
  if (http.httpHeaders !== undefined) {
    if (!Array.isArray(http.httpHeaders) || http.httpHeaders.length > 100) fail('探针请求头格式无效');
    for (const header of http.httpHeaders) { object(header, ['name', 'value'], '请求头'); string(header.name, '请求头名称'); if (typeof header.value !== 'string') fail('请求头值必须是字符串'); }
  }
  for (const key of ['initialDelaySeconds', 'timeoutSeconds', 'periodSeconds', 'successThreshold', 'failureThreshold', 'terminationGracePeriodSeconds']) {
    if (value[key] !== undefined) integer(value[key], key === 'initialDelaySeconds' ? 0 : 1, key);
  }
  if (label === '存活检查' && (value.successThreshold ?? 1) !== 1) fail('存活检查成功阈值必须为 1');
  if (label === '就绪检查' && value.terminationGracePeriodSeconds !== undefined) fail('就绪检查不支持终止宽限期');
}
export function buildModulePatch(current, module, body) {
  object(body, ['resourceVersion', 'uid', 'container', 'values'], '请求');
  string(body.resourceVersion, '资源版本'); string(body.uid, '资源 UID');
  if (body.resourceVersion !== current.metadata.resourceVersion || body.uid !== current.metadata.uid) fail('配置已发生变化，请重新加载后再编辑。', 409);
  const containers = current.spec?.template?.spec?.containers || [];
  const index = containers.findIndex(c => c.name === body.container);
  if (index < 0) fail('容器不存在');
  const container = containers[index], values = body.values;
  const prefix = `/spec/template/spec/containers/${index}`;
  const patch = [
    { op: 'test', path: '/metadata/uid', value: body.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: body.resourceVersion },
  ];
  const set = (path, value, old) => {
    if (value === null) { if (old !== undefined) patch.push({ op: 'remove', path }); }
    else patch.push({ op: 'add', path, value });
  };
  if (module === 'image') {
    object(values, ['image', 'imagePullPolicy'], '镜像配置'); string(values.image, '镜像地址');
    if (/\s/.test(values.image)) fail('镜像地址不能包含空白字符');
    if (!['Always', 'IfNotPresent', 'Never'].includes(values.imagePullPolicy)) fail('镜像拉取策略无效');
    set(`${prefix}/image`, values.image); set(`${prefix}/imagePullPolicy`, values.imagePullPolicy);
  } else if (module === 'environment') {
    object(values, ['env'], '环境变量');
    if (!Array.isArray(values.env) || values.env.length > 500) fail('环境变量必须是数组且最多 500 项');
    const names = new Set();
    for (const env of values.env) {
      object(env, ['name', 'value', 'valueFrom'], '环境变量');
      if (typeof env.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env.name) || names.has(env.name)) fail('环境变量名称无效或重复');
      names.add(env.name);
      if (Object.hasOwn(env, 'value') === Object.hasOwn(env, 'valueFrom')) fail('变量必须选择明文或引用其中一种');
      if (Object.hasOwn(env, 'value')) { if (typeof env.value !== 'string' || env.value.length > 32768) fail('变量值必须为字符串且不超过 32768 字符'); }
      else {
        object(env.valueFrom, ['secretKeyRef', 'configMapKeyRef', 'fieldRef', 'resourceFieldRef'], '变量引用');
        const keys = Object.keys(env.valueFrom);
        if (keys.length !== 1) fail('每个变量只允许一个引用');
        const key = keys[0], ref = env.valueFrom[key];
        if (['secretKeyRef', 'configMapKeyRef'].includes(key)) {
          object(ref, ['name', 'key', 'optional'], '配置引用'); validateName(ref.name, '引用名称');
          if (typeof ref.key !== 'string' || !/^[A-Za-z0-9._-]+$/.test(ref.key)) fail('引用 Key 无效');
          if (ref.optional !== undefined && typeof ref.optional !== 'boolean') fail('optional 必须是布尔值');
        } else if (JSON.stringify(env) !== JSON.stringify(container.env?.find(e => e.name === env.name))) fail('Downward API 引用仅支持保留或删除');
      }
    }
    set(`${prefix}/env`, values.env);
  } else if (module === 'resources') {
    object(values, ['replicas', 'requests', 'limits'], '资源配置'); integer(values.replicas, 0, '副本数');
    const resources = structuredClone(container.resources || {});
    for (const kind of ['requests', 'limits']) {
      object(values[kind], ['cpu', 'memory'], kind); resources[kind] = { ...resources[kind] };
      for (const type of ['cpu', 'memory']) {
        const value = values[kind][type];
        if (value === '' || value === undefined) delete resources[kind][type];
        else { quantity(value, type); resources[kind][type] = value; }
      }
    }
    for (const type of ['cpu', 'memory']) if (resources.requests[type] !== undefined && resources.limits[type] !== undefined && quantity(resources.requests[type], type) > quantity(resources.limits[type], type)) fail(`${type} 申请量不能超过上限`);
    set('/spec/replicas', values.replicas); set(`${prefix}/resources`, resources);
  } else if (module === 'probes') {
    object(values, ['livenessProbe', 'readinessProbe'], '健康检查');
    for (const key of ['livenessProbe', 'readinessProbe']) {
      if (!Object.hasOwn(values, key)) fail('请同时提交两种健康检查，未启用时使用 null');
      probe(values[key], key === 'livenessProbe' ? '存活检查' : '就绪检查', container[key]);
      set(`${prefix}/${key}`, values[key], container[key]);
    }
  } else fail('不支持的配置模块', 404);
  return patch;
}
