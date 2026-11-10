import React, { useEffect, useMemo, useRef, useState } from 'react';
import api from '../lib/api.js';
import ResourceDefinition from '../components/ResourceDefinition.jsx';

export default function CustomResourcesPage({ token, namespace, registerNavigationGuard, onUpdated }) {
  const [crds, setCrds] = useState([]), [crdsLoaded, setCrdsLoaded] = useState(false);
  const [crdName, setCrdName] = useState(''), [kindSearch, setKindSearch] = useState(''), [showKinds, setShowKinds] = useState(false), [query, setQuery] = useState('');
  const [result, setResult] = useState([]), [selected, setSelected] = useState(null), [loading, setLoading] = useState(false), [error, setError] = useState(''), [dirty, setDirty] = useState(false);
  const editorDialog = useRef(null);
  useEffect(() => { const controller = new AbortController(); api('/api/resources/customresourcedefinitions', token, controller.signal).then(items => { if (!controller.signal.aborted) { setCrds(items.items || []); setCrdsLoaded(true); } }).catch(e => { if (!controller.signal.aborted) { setError(e.message); setCrdsLoaded(true); } }); return () => controller.abort(); }, [token]);
  const availableCrds = crds.filter(crd => crd.status?.conditions?.some(c => c.type === 'Established' && c.status === 'True'));
  useEffect(() => {
    if (!crdsLoaded) return;
    const controller = new AbortController();
    const targets = availableCrds.filter(crd => !crdName || crd.metadata.name === crdName);
    setLoading(true); setError(''); setSelected(null); setResult([]);
    Promise.allSettled(targets.map(async crd => {
      const params = new URLSearchParams(namespace ? { namespace } : {});
      const value = await api(`/api/custom-resources/${encodeURIComponent(crd.metadata.name)}?${params}`, token, controller.signal);
      return { crd, value };
    })).then(outcomes => { if (!controller.signal.aborted) { setResult(outcomes.filter(outcome => outcome.status === 'fulfilled').map(outcome => outcome.value)); const failures = outcomes.filter(outcome => outcome.status === 'rejected'); if (failures.length) setError(`${failures.length} 个 CRD 读取失败：${failures.map(failure => failure.reason.message).join('；')}`); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [crdsLoaded, crds, crdName, namespace, token]);
  useEffect(() => registerNavigationGuard(() => !dirty || window.confirm('有未保存的 CR 修改，确定放弃并离开吗？')), [dirty, registerNavigationGuard]);
  useEffect(() => { const dialog = editorDialog.current; if (!dialog) return; if (selected && !dialog.open) dialog.showModal(); else if (!selected && dialog.open) dialog.close(); }, [!!selected]);
  const rows = useMemo(() => result.flatMap(({ crd, value }) => (value.items || []).map(item => ({ item, crd, schema: value.schema, apiVersion: value.apiVersion, scope: value.scope }))).filter(({ item, crd }) => `${crd.spec?.names?.kind || ''} ${item.metadata?.name} ${item.metadata?.namespace || ''} ${JSON.stringify(item.metadata?.labels || {})}`.toLowerCase().includes(query.toLowerCase())), [result, query]);
  const selectedCrd = crds.find(item => item.metadata.name === crdName);
  const matchingCrds = availableCrds.filter(crd => `${crd.spec?.names?.kind || ''} ${crd.spec?.group || ''} ${crd.metadata.name}`.toLowerCase().includes(kindSearch.trim().toLowerCase()));
  function choose(row) { if (dirty && !window.confirm('放弃未保存的 CR 修改？')) return; setSelected(row); setDirty(false); }
  function selectKind(crd) { if (dirty && !window.confirm('放弃未保存的 CR 修改？')) return; setCrdName(crd?.metadata.name || ''); setKindSearch(crd ? crd.spec?.names?.kind || '' : ''); setShowKinds(false); setDirty(false); }
  return <section className="panel resource-panel cr-instances-page">
    <div className="resource-toolbar"><div className="resource-title"><h2>CR 实例</h2><span className="count-pill">{loading ? '…' : rows.length}</span></div><div className="filters"><div className="kind-combobox"><input aria-label="Kind 搜索" placeholder="搜索 Kind（默认全部）" value={kindSearch} onFocus={() => setShowKinds(true)} onChange={e => { setKindSearch(e.target.value); setShowKinds(true); }} onKeyDown={e => { if (e.key === 'Escape') setShowKinds(false); if (e.key === 'Enter' && matchingCrds.length === 1) selectKind(matchingCrds[0]); }} /><button type="button" className="text-button" onClick={() => selectKind(null)}>全部</button>{showKinds && <div className="kind-options" role="listbox" aria-label="匹配的 Kind"><button type="button" role="option" aria-selected={!crdName} onClick={() => selectKind(null)}>ALL · 列出所有 CR</button>{matchingCrds.map(crd => <button type="button" role="option" aria-selected={crdName === crd.metadata.name} key={crd.metadata.name} onClick={() => selectKind(crd)}>{crd.spec?.names?.kind} · {crd.spec?.group}</button>)}{!matchingCrds.length && <span className="kind-no-match">没有匹配的 Kind</span>}</div>}</div><input aria-label="搜索 CR 实例" placeholder="搜索名称、命名空间、标签" value={query} onChange={e => setQuery(e.target.value)} /></div></div>
    {error && <div className="error" role="alert">{error}</div>}
    {selectedCrd && <div className="panel-note">{selectedCrd.spec?.names?.kind} · {selectedCrd.spec?.group} · {namespace || '全部命名空间'} · {rows.length} 个实例</div>}
    {loading ? <div className="loading-state">正在读取 CR 实例…</div> : <div className="table-scroll"><table><thead><tr><th>Kind</th><th>apiGroup</th><th>version</th><th>名称</th><th>命名空间</th><th>创建时间</th><th className="align-right">操作</th></tr></thead><tbody>{rows.map(({ item, crd, schema, apiVersion }) => <tr key={`${crd.metadata.name}/${item.metadata.uid || item.metadata.name}`}>
      <td>{crd.spec?.names?.kind || item.kind || '—'}</td><td>{crd.spec?.group || '—'}</td><td>{apiVersion?.split('/').at(-1) || item.apiVersion?.split('/').at(-1) || '—'}</td><td><button className="name-button" onClick={() => choose({ item, crd, schema })}>{item.metadata.name}</button></td><td>{item.metadata.namespace || '—'}</td><td>{item.metadata.creationTimestamp ? new Date(item.metadata.creationTimestamp).toLocaleString('zh-CN') : '—'}</td><td className="align-right"><button className="text-button" onClick={() => choose({ item, crd, schema })}>编辑</button></td></tr>)}</tbody></table>{!rows.length && <div className="empty"><h3>{query ? '没有匹配的实例' : '没有 CR 实例'}</h3></div>}</div>}
    <dialog ref={editorDialog} className="resource-dialog cr-editor-dialog" aria-label="编辑 CR 实例" onCancel={event => { event.preventDefault(); if (!dirty || window.confirm('放弃未保存的 CR 修改？')) { setSelected(null); setDirty(false); } }} onClose={() => setSelected(null)}>
      {selected && <><div className="dialog-head"><h2>{selected.crd.spec?.names?.kind} · {selected.item.metadata.namespace ? `${selected.item.metadata.namespace}/` : ''}{selected.item.metadata.name}</h2><button className="button" onClick={() => { if (!dirty || window.confirm('放弃未保存的 CR 修改？')) { setSelected(null); setDirty(false); } }}>关闭</button></div><div className="cr-editor-body"><ResourceDefinition key={selected.item.metadata.uid || selected.item.metadata.name} item={selected.item} schema={selected.schema} token={token} onDirty={setDirty} onResourceUpdated={value => { setSelected(current => ({ ...current, item: value })); setDirty(false); onUpdated?.(); }} /></div></>}
    </dialog>
  </section>;
}
