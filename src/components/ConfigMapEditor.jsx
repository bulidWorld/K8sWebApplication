import React, { useEffect, useState } from 'react';
import api from '../lib/api.js';

function rowsFrom(data = {}) {
  const rows = [];
  const visit = (value, path, root, nested) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
      Object.entries(value).forEach(([key, child]) => visit(child, [...path, key], root, nested));
    } else rows.push({ key: path.join('.'), value: nested ? String(value ?? '') : value, originalValue: value, root, nested });
  };
  Object.entries(data).forEach(([key, value]) => {
    let parsed;
    try { parsed = JSON.parse(value); } catch { /* plain text */ }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length) visit(parsed, [key], key, true);
    else rows.push({ key, value, root: key, nested: false });
  });
  return rows;
}

function buildData(rows) {
  const result = {};
  const seen = new Set();
  for (const row of rows) {
    const key = row.key.trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw new Error(`键名不合法：${key || '空键'}`);
    if (seen.has(key) || Object.hasOwn(result, key)) throw new Error(`键名重复：${key}`);
    seen.add(key);
    if (row.nested && key.startsWith(`${row.root}.`)) {
      const parts = key.slice(row.root.length + 1).split('.');
      if (parts.some(part => !part)) throw new Error(`路径不合法：${key}`);
      const tree = result[row.root] ||= {};
      if (typeof tree !== 'object') throw new Error(`键名冲突：${row.root}`);
      let node = tree;
      for (const part of parts.slice(0, -1)) node = node[part] ||= {};
      if (Object.hasOwn(node, parts.at(-1))) throw new Error(`键名冲突：${key}`);
      node[parts.at(-1)] = row.value === String(row.originalValue ?? '') ? row.originalValue : row.value;
    } else result[key] = row.value;
  }
  for (const [key, value] of Object.entries(result)) if (typeof value === 'object') result[key] = JSON.stringify(value, null, 2);
  return result;
}

export default function ConfigMapEditor({ item, token, onDirty, onResourceUpdated }) {
  const [base, setBase] = useState(item);
  const [rows, setRows] = useState(() => rowsFrom(item.data));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const dirty = JSON.stringify(rows) !== JSON.stringify(rowsFrom(base.data));
  useEffect(() => { onDirty(dirty || busy); return () => onDirty(false); }, [dirty, busy, onDirty]);
  function change(index, field, value) { setRows(current => current.map((row, i) => i === index ? { ...row, [field]: value } : row)); setMessage(''); }
  async function save() {
    setError(''); setMessage('');
    let data;
    try { data = buildData(rows); } catch (e) { setError(e.message); return; }
    setBusy(true);
    try {
      const { resource } = await api(`/api/configmaps/${encodeURIComponent(base.metadata.namespace)}/${encodeURIComponent(base.metadata.name)}/data`, token, undefined, { method: 'PATCH', body: JSON.stringify({ uid: base.metadata.uid, resourceVersion: base.metadata.resourceVersion, data }) });
      setBase(resource); setRows(rowsFrom(resource.data)); onResourceUpdated?.(resource); setMessage('配置已保存');
    } catch (e) { setError(e.status === 409 ? 'ConfigMap 已发生变化，请重新加载后核对修改。' : e.message); }
    finally { setBusy(false); }
  }
  return <section className="deployment-config configmap-editor">
    <p>每行编辑一个配置值。JSON 对象中的子节点以 parentkey.childkey.xxx 展示；新增键可使用点号。二进制配置保持原样。</p>
    {error && <div className="error" role="alert">{error}</div>}{message && <p className="config-success" role="status">{message}</p>}
    <div className="configmap-rows">{rows.map((row, index) => <div className="configmap-row" key={index}>
      <input aria-label={`键 ${index + 1}`} value={row.key} disabled={busy} onChange={e => change(index, 'key', e.target.value)} />
      <textarea aria-label={`值 ${index + 1}`} value={row.value} disabled={busy} onChange={e => change(index, 'value', e.target.value)} rows={2} />
      <button type="button" className="button" disabled={busy} onClick={() => setRows(current => current.filter((_, i) => i !== index))}>删除</button>
    </div>)}</div>
    <div className="config-actions"><button type="button" className="button" disabled={busy} onClick={() => setRows(current => [...current, { key: '', value: '', root: '', nested: false }])}>添加配置项</button><button type="button" className="button primary" disabled={busy || !dirty} onClick={save}>{busy ? '正在保存…' : '保存配置'}</button></div>
  </section>;
}
