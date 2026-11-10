import React, { useEffect, useState } from 'react';
import { dump, load } from 'js-yaml';
import api from '../lib/api.js';

function definition(item) {
  const metadata = item.metadata || {};
  return dump({ apiVersion: item.apiVersion, kind: item.kind, metadata: {
    name: metadata.name, ...(metadata.namespace ? { namespace: metadata.namespace } : {}),
    uid: metadata.uid, resourceVersion: metadata.resourceVersion,
    ...(metadata.labels ? { labels: metadata.labels } : {}),
    ...(metadata.annotations ? { annotations: metadata.annotations } : {}),
  }, ...(item.spec !== undefined ? { spec: item.spec } : {}) }, { lineWidth: -1, noRefs: true });
}

export default function ResourceDefinition({ item, token, onDirty, onResourceUpdated, schema }) {
  const [base, setBase] = useState(item);
  const [text, setText] = useState(() => definition(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [tab, setTab] = useState('yaml');
  const [spec, setSpec] = useState(item.spec || {});
  const dirty = text !== definition(base) || JSON.stringify(spec) !== JSON.stringify(base.spec || {});
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try {
      let manifest = text;
      if (tab === 'form') {
        const parsed = load(text);
        parsed.spec = spec;
        manifest = dump(parsed, { lineWidth: -1, noRefs: true });
      }
      const result = await api('/api/resource-definition', token, undefined, { method: 'PATCH', body: JSON.stringify({ manifest, uid: base.metadata.uid, resourceVersion: base.metadata.resourceVersion, namespace: base.metadata.namespace || '' }) });
      setBase(result.resource); setText(definition(result.resource)); setSpec(result.resource.spec || {}); onResourceUpdated?.(result.resource); setMessage(result.warning || '资源定义已保存');
      window.alert(result.warning ? `保存成功\n${result.warning}` : '保存成功');
    } catch (e) {
      const errorMessage = e.status === 409 ? '资源已发生变化，请重新加载后再编辑；当前编辑内容已保留。' : e.message || '请稍后重试';
      setError(errorMessage);
      window.alert(`保存失败\n${errorMessage}`);
    }
    finally { setBusy(false); }
  }
  return <section className="deployment-config pv-definition">
    <p>编辑此资源的 spec、标签和注解（YAML/JSON）。名称、命名空间、UID、资源版本和 status 不可修改。集群 API 会校验资源字段及不可变规则。</p>
    <div className="tabs" role="tablist" aria-label="资源定义编辑方式"><button role="tab" aria-selected={tab === 'form'} className={tab === 'form' ? 'selected' : ''} onClick={() => { try { setSpec(load(text)?.spec || {}); } catch {} setTab('form'); }}>字段表单</button><button role="tab" aria-selected={tab === 'yaml'} className={tab === 'yaml' ? 'selected' : ''} onClick={() => { try { const parsed = load(text); parsed.spec = spec; setText(dump(parsed, { lineWidth: -1, noRefs: true })); } catch {} setTab('yaml'); }}>原始 YAML</button></div>
    {error && <div className="error" role="alert">{error}</div>}{message && <p className="config-success" role="status">{message}</p>}
    {tab === 'yaml' ? <label className="config-field"><span>资源定义 YAML</span><textarea aria-label="资源定义 YAML" spellCheck={false} value={text} disabled={busy} onChange={e => { setText(e.target.value); setError(''); setMessage(''); }} /></label> : schema?.properties?.spec ? <SchemaForm schema={schema.properties.spec} value={spec} onChange={setSpec} disabled={busy} /> : <p className="panel-note">该资源没有可用的 OpenAPI 字段描述，请切换到原始 YAML 编辑。</p>}
    <div className="config-actions"><button className="button primary" disabled={busy || !dirty} onClick={save}>{busy ? '正在保存…' : '保存定义'}</button><span>{dirty ? '有未保存的修改' : '已与加载的定义同步'}</span></div>
  </section>;
}

function schemaMatches(schema, query, path = []) {
  const text = query.trim().toLocaleLowerCase();
  if (!text) return true;
  const ownText = `${schema?.title || ''} ${path.join(' ')} ${schema?.description || ''}`.toLocaleLowerCase();
  if (ownText.includes(text)) return true;
  return Object.entries(schema?.properties || {}).some(([key, child]) => schemaMatches(child, text, [...path, key]));
}

function SchemaForm({ schema, value, onChange, disabled }) {
  const [query, setQuery] = useState('');
  return <div className="cr-schema-form">
    <label className="config-field cr-schema-search"><span>搜索字段</span><input type="search" aria-label="搜索字段" placeholder="输入字段名或说明进行模糊搜索" value={query} onChange={event => setQuery(event.target.value)} disabled={disabled} /></label>
    <section className="cr-schema-section"><h3>YAML 中已配置</h3><SchemaFields schema={schema} value={value} onChange={onChange} disabled={disabled} query={query} configured /></section>
    <section className="cr-schema-section"><h3>Schema 中未配置</h3><SchemaFields schema={schema} value={value} onChange={onChange} disabled={disabled} query={query} configured={false} /></section>
    {query.trim() && !schemaMatches(schema, query) && <p className="panel-note">没有匹配的字段</p>}
  </div>;
}

function SchemaFields({ schema, value, onChange, disabled, path = [], required = false, query = '', configured }) {
  const type = schema?.type || (schema?.properties ? 'object' : 'string');
  if (!schemaMatches(schema, query, path)) return null;
  if (type === 'object' && schema.properties) return <ul className="cr-schema-tree">{Object.entries(schema.properties).map(([key, child]) => {
    const childPath = [...path, key];
    const childType = child?.type || (child?.properties ? 'object' : 'string');
    const isGroup = childType === 'object' && child.properties;
    const present = value != null && Object.prototype.hasOwnProperty.call(value, key);
    if (!isGroup && present !== configured) return null;
    if (isGroup && !(configured && present && value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]) && Object.keys(value[key]).length === 0) && !hasCategory(child, value?.[key], configured)) return null;
    return <li key={key}>
      {isGroup ? <details open={query.trim() ? schemaMatches(child, query, childPath) : path.length === 0}>
        <summary title={child.description || undefined}>{child.title || key}</summary>
        <SchemaFields schema={child} value={value?.[key]} path={childPath} disabled={disabled} query={query} configured={configured} onChange={next => onChange({ ...(value || {}), [key]: next })} />
      </details> : <SchemaFields schema={child} required={schema.required?.includes(key)} value={value?.[key]} path={childPath} disabled={disabled} query={query} configured={configured} onChange={next => onChange({ ...(value || {}), [key]: next })} />}
    </li>;
  })}</ul>;
  const title = schema?.title || path[path.length - 1] || '字段';
  const description = schema?.description;
  const label = <span title={description || undefined}>{title}{required ? ' *' : ''}</span>;
  if (type === 'array' || type === 'object') return <label className="config-field cr-schema-field">{label}<textarea disabled={disabled} spellCheck={false} value={value === undefined ? '' : JSON.stringify(value, null, 2)} placeholder={type === 'array' ? '[]' : '{}'} onChange={event => { try { onChange(event.target.value ? JSON.parse(event.target.value) : (type === 'array' ? [] : {})); } catch {} }} /></label>;
  return <label className="config-field cr-schema-field">{label}{type === 'boolean' ? <select disabled={disabled} value={String(value ?? schema.default ?? false)} onChange={event => onChange(event.target.value === 'true')}><option value="true">true</option><option value="false">false</option></select> : schema.enum?.length ? <select disabled={disabled} value={value ?? schema.default ?? ''} onChange={event => onChange(event.target.value)}><option value="">—</option>{schema.enum.map(option => <option key={option} value={option}>{option}</option>)}</select> : <input disabled={disabled} type={type === 'integer' || type === 'number' ? 'number' : 'text'} step={type === 'integer' ? '1' : type === 'number' ? 'any' : undefined} value={value ?? schema.default ?? ''} onChange={event => onChange(type === 'integer' ? (event.target.value === '' ? undefined : Number.parseInt(event.target.value, 10)) : type === 'number' ? (event.target.value === '' ? undefined : Number(event.target.value)) : event.target.value)} />}</label>;
}

function hasCategory(schema, value, configured) {
  return Object.entries(schema?.properties || {}).some(([key, child]) => {
    const isGroup = (child?.type || (child?.properties ? 'object' : 'string')) === 'object' && child.properties;
    const present = value != null && Object.prototype.hasOwnProperty.call(value, key);
    return isGroup ? hasCategory(child, value?.[key], configured) : present === configured;
  });
}
