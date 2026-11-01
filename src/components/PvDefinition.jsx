import React, { useEffect, useRef, useState } from 'react';
import { dump } from 'js-yaml';
import api from '../lib/api.js';

function definition(item) {
  const { name, uid, resourceVersion, labels, annotations } = item.metadata;
  return dump({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name, uid, resourceVersion, ...(labels ? { labels } : {}), ...(annotations ? { annotations } : {}) }, spec: item.spec }, { lineWidth: -1, noRefs: true });
}

export default function PvDefinition({ item, token, onDirty, onResourceUpdated }) {
  const [base, setBase] = useState(item);
  const [text, setText] = useState(() => definition(item));
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const dirty = text !== definition(base);
  useEffect(() => {
    onDirty(dirty || busy);
    return () => onDirty(false);
  }, [dirty, busy, onDirty]);
  function accept(resource) {
    setBase(resource);
    setText(definition(resource));
    onResourceUpdated(resource);
  }
  async function run(save) {
    if (pending.current) return;
    if (!save && dirty && !window.confirm('重新加载会放弃未保存的 PV 定义修改，是否继续？')) return;
    pending.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      const name = encodeURIComponent(base.metadata.name);
      if (save) {
        const result = await api(`/api/persistentvolumes/${name}/definition`, token, undefined, {
          method: 'PATCH', body: JSON.stringify({ manifest: text, uid: base.metadata.uid, resourceVersion: base.metadata.resourceVersion }),
        });
        accept(result.resource);
        setMessage(result.warning || 'PV 定义已保存');
      } else accept(await api(`/api/resources/persistentvolumes/${name}`, token));
    } catch (e) {
      setError(e.status === 409 ? 'PV 已发生变化，请重新加载后再编辑。当前编辑内容已保留。' : e.message);
    } finally { pending.current = false; setBusy(false); }
  }
  return <section className="deployment-config pv-definition">
    <p>编辑 PV 的标签、注解和 spec（YAML 或 JSON）。名称、UID 和资源版本不可修改；可修改字段由集群校验。</p>
    {error && <div className="error" role="alert">{error}</div>}
    {message && <p className="config-success" role="status">{message}</p>}
    <label className="config-field">
      <span>PV 定义</span>
      <textarea aria-label="PV 定义" spellCheck={false} value={text} disabled={busy} onChange={event => { setText(event.target.value); setError(''); setMessage(''); }} />
    </label>
    <div className="config-actions">
      <button className="button primary" disabled={busy || !dirty} onClick={() => run(true)}>{busy ? '处理中…' : '保存定义'}</button>
      <button className="button" disabled={busy} onClick={() => run(false)}>重新加载</button>
      <span>{dirty ? '有未保存的修改' : '已与加载的定义同步'}</span>
    </div>
  </section>;
}
