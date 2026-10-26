import React, { useEffect, useState } from 'react';
import api from '../lib/api.js';

const modules = [['image', '镜像与版本'], ['environment', '环境变量与外部连接'], ['resources', '计算资源与副本'], ['probes', '健康检查']];
const clone = value => JSON.parse(JSON.stringify(value));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function valuesFor(resource, name, module) {
  const c = resource.spec.template.spec.containers.find(c => c.name === name);
  if (module === 'image') return { image: c.image, imagePullPolicy: c.imagePullPolicy || 'IfNotPresent' };
  if (module === 'environment') return { env: clone(c.env || []) };
  if (module === 'resources') return { replicas: resource.spec.replicas ?? 1, ...Object.fromEntries(['requests', 'limits'].map(k => [k, { cpu: c.resources?.[k]?.cpu || '', memory: c.resources?.[k]?.memory || '' }])) };
  return { livenessProbe: clone(c.livenessProbe || null), readinessProbe: clone(c.readinessProbe || null) };
}
function Field({ label, value, onChange, type = 'text', min, placeholder }) {
  return <label className="config-field"><span>{label}</span><input type={type} min={min} step={type === 'number' ? 1 : undefined} value={value} placeholder={placeholder} onChange={e => onChange(type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)} /></label>;
}
function Environment({ values, change }) {
  const set = (index, env) => change({ env: values.env.map((v, i) => i === index ? env : v) });
  return <>
    <p>Secret 只填写名称和 Key，不读取密钥正文。现有 envFrom 保持原样。</p>
    {values.env.map((env, index) => {
      const mode = env.valueFrom ? Object.keys(env.valueFrom)[0] : 'value';
      const reference = env.valueFrom?.[mode];
      const supported = ['value', 'secretKeyRef', 'configMapKeyRef'].includes(mode);
      return <div className="env-row" key={index}>
        <Field label="变量名" value={env.name} onChange={name => set(index, { ...env, name })} />
        <label className="config-field"><span>值来源</span><select value={mode} disabled={!supported} onChange={e => set(index, e.target.value === 'value' ? { name: env.name, value: '' } : { name: env.name, valueFrom: { [e.target.value]: { name: '', key: '' } } })}>
          <option value="value">明文</option><option value="secretKeyRef">Secret 引用</option><option value="configMapKeyRef">ConfigMap 引用</option>{!supported && <option value={mode}>现有 {mode} 引用（保留）</option>}
        </select></label>
        {mode === 'value' ? <Field label="值" value={env.value ?? ''} onChange={value => set(index, { ...env, value })} /> : supported ? <>
          <Field label="引用名称" value={reference.name || ''} onChange={name => set(index, { ...env, valueFrom: { [mode]: { ...reference, name } } })} />
          <Field label="Key" value={reference.key || ''} onChange={key => set(index, { ...env, valueFrom: { [mode]: { ...reference, key } } })} />
          <label className="check"><input type="checkbox" checked={reference.optional || false} onChange={e => set(index, { ...env, valueFrom: { [mode]: { ...reference, optional: e.target.checked } } })} />允许缺失</label>
        </> : <span>此引用仅支持保留或删除</span>}
        <button type="button" className="text-button" onClick={() => change({ env: values.env.filter((_, i) => i !== index) })} aria-label={`删除变量 ${env.name || index + 1}`}>删除</button>
      </div>;
    })}
    <button type="button" className="button" onClick={() => change({ env: [...values.env, { name: '', value: '' }] })}>＋ 添加变量</button>
  </>;
}
function Probe({ label, value, change, liveness }) {
  const supported = !value || Boolean(value.httpGet);
  return <section className="probe-fields"><h4>{label}</h4>
    <label className="check"><input type="checkbox" checked={Boolean(value)} onChange={e => change(e.target.checked ? { httpGet: { path: '/healthz', port: 'http', scheme: 'HTTP' }, initialDelaySeconds: 5, timeoutSeconds: 1, periodSeconds: 10, successThreshold: 1, failureThreshold: 3 } : null)} />启用检查</label>
    {value && !supported && <p>现有非 HTTP 探针保持原样。第一期支持编辑 HTTP/HTTPS 探针；可关闭后重新启用以改成 HTTP。</p>}
    {value && supported && <div className="config-grid">
      <Field label="路径" value={value.httpGet.path || '/'} onChange={path => change({ ...value, httpGet: { ...value.httpGet, path } })} />
      <Field label="端口名称或端口号" value={value.httpGet.port} onChange={port => change({ ...value, httpGet: { ...value.httpGet, port: /^\d+$/.test(port) ? Number(port) : port } })} />
      <label className="config-field"><span>协议</span><select value={value.httpGet.scheme || 'HTTP'} onChange={e => change({ ...value, httpGet: { ...value.httpGet, scheme: e.target.value } })}><option>HTTP</option><option>HTTPS</option></select></label>
      {[['initialDelaySeconds', '启动延迟（秒）', 0, 0], ['timeoutSeconds', '超时（秒）', 1, 1], ['periodSeconds', '检查周期（秒）', 1, 10], ['failureThreshold', '失败阈值', 1, 3], ...(!liveness ? [['successThreshold', '成功阈值', 1, 1]] : [])].map(([key, title, min, fallback]) => <Field key={key} label={title} type="number" min={min} value={value[key] ?? fallback} onChange={n => change({ ...value, [key]: n })} />)}
    </div>}
  </section>;
}
function Module({ module, title, resource, container, token, onSaved, onDirty }) {
  const [base, setBase] = useState(resource);
  const [values, setValues] = useState(() => valuesFor(resource, container, module));
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const before = valuesFor(base, container, module);
  const dirty = !equal(before, values);
  useEffect(() => {
    if (!dirty && !busy) { setBase(resource); setValues(valuesFor(resource, container, module)); }
  }, [resource, container, module]);
  useEffect(() => { onDirty(module, dirty); }, [module, dirty, onDirty]);
  function change(next) { setValues(next); setPreview(false); setMessage(''); setError(''); }
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api(`/api/deployments/${encodeURIComponent(base.metadata.namespace)}/${encodeURIComponent(base.metadata.name)}/modules/${module}`, token, undefined, { method: 'PATCH', body: JSON.stringify({ resourceVersion: base.metadata.resourceVersion, uid: base.metadata.uid, container, values }) });
      setBase(result.resource); setValues(valuesFor(result.resource, container, module)); setPreview(false);
      setMessage(result.warning || '配置已提交，下面的发布状态将持续刷新。'); onSaved(result.resource);
    } catch (e) { setError(e.status === 409 ? `${e.message} 请使用顶部“重新加载配置”。` : `${e.message}。若请求超时，请先重新加载确认实际配置，再决定是否提交。`); }
    finally { setBusy(false); }
  }
  const onlyScale = module === 'resources' && equal(before.requests, values.requests) && equal(before.limits, values.limits);
  return <section className="config-module">
    <div className="config-module-head"><h3>{title}</h3><span>{dirty ? '有未保存修改' : '当前配置'}</span></div>
    <form onSubmit={e => { e.preventDefault(); setPreview(true); }}>
      <fieldset disabled={busy}>
        {module === 'image' && <div className="config-grid"><Field label="完整镜像地址（含版本或 digest）" value={values.image} onChange={image => change({ ...values, image })} /><label className="config-field"><span>拉取策略</span><select value={values.imagePullPolicy} onChange={e => change({ ...values, imagePullPolicy: e.target.value })}>{['Always', 'IfNotPresent', 'Never'].map(v => <option key={v}>{v}</option>)}</select></label></div>}
        {module === 'environment' && <Environment values={values} change={change} />}
        {module === 'resources' && <><p>副本数作用于整个 Deployment；CPU 和内存作用于当前容器。留空表示移除此项，其他资源保持原样。</p><div className="config-grid"><Field label="副本数（0 表示停止运行）" type="number" min={0} value={values.replicas} onChange={replicas => change({ ...values, replicas })} />{['requests', 'limits'].flatMap(kind => ['cpu', 'memory'].map(type => <Field key={`${kind}-${type}`} label={`${kind === 'requests' ? '申请' : '上限'} ${type}`} value={values[kind][type]} placeholder={type === 'cpu' ? '如 100m、0.5' : '如 128Mi、1Gi'} onChange={value => change({ ...values, [kind]: { ...values[kind], [type]: value } })} />))}</div></>}
        {module === 'probes' && <>{[['livenessProbe', '存活检查'], ['readinessProbe', '就绪检查']].map(([key, label]) => <Probe key={key} label={label} value={values[key]} liveness={key === 'livenessProbe'} change={value => change({ ...values, [key]: value })} />)}</>}
        <div className="config-actions"><button className="button" type="submit" disabled={!dirty || busy}>预览变更</button><button className="text-button" type="button" disabled={!dirty || busy} onClick={() => change(clone(before))}>撤销本模块修改</button></div>
      </fieldset>
    </form>
    {preview && dirty && <div className="config-preview"><p>{onlyScale ? '本次仅调整副本数，不改变 Pod 模板。' : '本次修改 Pod 模板，将按 Deployment 发布策略更新 Pod。'}{base.spec.paused ? ' 当前 Deployment 已暂停，Pod 模板修改将在恢复发布后生效。' : ''}</p><div className="config-diff"><div><h4>修改前</h4><pre>{JSON.stringify(before, null, 2)}</pre></div><div><h4>修改后</h4><pre>{JSON.stringify(values, null, 2)}</pre></div></div><button type="button" className="button primary" disabled={busy} onClick={save}>{busy ? '正在提交…' : '确认保存本模块'}</button></div>}
    {error && <div className="error" role="alert">{error}</div>}{message && <p className="config-success" role="status">{message}</p>}
  </section>;
}
export default function DeploymentConfig({ item, token, initialModule = '', onDirty, onResourceUpdated }) {
  const [resource, setResource] = useState(null);
  const [container, setContainer] = useState('');
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const endpoint = `/api/resources/deployments/${encodeURIComponent(item.metadata.name)}?namespace=${encodeURIComponent(item.metadata.namespace)}`;
  const hasChanges = Object.values(dirty).some(Boolean);
  const reportDirty = React.useCallback((module, value) => setDirty(previous => previous[module] === value ? previous : { ...previous, [module]: value }), []);
  useEffect(() => { onDirty(hasChanges); return () => onDirty(false); }, [hasChanges, onDirty]);
  useEffect(() => {
    if (!hasChanges) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [hasChanges]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(''); setResource(null);
    api(endpoint, token, controller.signal).then(value => { setResource(value); setContainer(previous => value.spec.template.spec.containers.some(c => c.name === previous) ? previous : value.spec.template.spec.containers[0].name); }).catch(e => { if (e.name !== 'AbortError') setError(e.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [endpoint, token, revision]);
  useEffect(() => {
    if (!resource) return;
    const controller = new AbortController(); let active = false;
    const timer = setInterval(async () => {
      if (active) return; active = true;
      try { const latest = await api(endpoint, token, controller.signal); setResource(latest); setError(''); }
      catch (e) { if (e.name !== 'AbortError') setError(`状态刷新失败：${e.message}`); }
      finally { active = false; }
    }, 5000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [endpoint, token, Boolean(resource)]);
  const discard = () => !hasChanges || window.confirm('有未保存的配置修改，确定放弃这些修改吗？');
  const status = resource?.status || {}, desired = resource?.spec.replicas ?? 1;
  const failed = status.conditions?.find(c => (c.type === 'Progressing' && c.status === 'False') || (c.type === 'ReplicaFailure' && c.status === 'True'));
  const complete = resource && (status.observedGeneration ?? 0) >= resource.metadata.generation && (status.updatedReplicas || 0) === desired && (status.availableReplicas || 0) === desired && (status.replicas || 0) === desired;
  return <div className="deployment-config">
    <div className="config-toolbar"><p>每个模块独立提交。状态每 5 秒刷新；其他模块的未保存内容会保留。保存遇到版本冲突时请重新加载。</p><button className="button" disabled={busy} onClick={() => { if (discard()) { setDirty({}); setRevision(n => n + 1); } }}>重新加载配置</button></div>
    {error && <div className="error" role="alert">{error}</div>}
    {busy ? <p role="status">正在读取最新配置…</p> : resource && <>
      <div className="config-status" role="status"><strong>{failed ? '发布异常' : resource.spec.paused ? '发布已暂停' : complete ? '发布完成' : '发布进行中'}</strong><span>就绪 {status.readyReplicas || 0}/{desired} · 最新 {status.updatedReplicas || 0} · 可用 {status.availableReplicas || 0} · generation {resource.metadata.generation}</span>{failed && <p>{failed.reason}：{failed.message}</p>}</div>
      <label className="config-field"><span>配置容器</span><select value={container} onChange={e => { if (discard()) { setDirty({}); setContainer(e.target.value); } }}>{resource.spec.template.spec.containers.map(c => <option key={c.name}>{c.name}</option>)}</select></label>
      {resource.metadata.uid !== item.metadata.uid && <div className="error" role="alert">此 Deployment 已被同名重建，请关闭详情并刷新列表后重新打开配置。</div>}
      {resource.metadata.uid === item.metadata.uid && resource.spec.template.spec.containers.find(c => c.name === container) && modules.filter(([module]) => !initialModule || module === initialModule).map(([module, title]) => <Module key={`${revision}/${container}/${module}`} module={module} title={title} resource={resource} container={container} token={token} onSaved={value => { setResource(value); onResourceUpdated(value); }} onDirty={reportDirty} />)}
    </>}
  </div>;
}
