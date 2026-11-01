import React, { useEffect, useState } from 'react';
import api from '../lib/api.js';
import download from '../lib/download.js';
import { age } from '../lib/formatters.js';

export default function CustomResources({ crd, token }) {
  const [namespace, setNamespace] = useState('');
  const [namespaceInput, setNamespaceInput] = useState('');
  const [search, setSearch] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [selected, setSelected] = useState(null);
  const name = crd.metadata.name;
  const namespaced = crd.spec?.scope === 'Namespaced';
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    setResult(null);
    setSelected(null);
    const query = new URLSearchParams(namespaced && namespace ? { namespace } : {});
    api(`/api/custom-resources/${encodeURIComponent(name)}?${query}`, token, controller.signal)
      .then(body => { if (!controller.signal.aborted) setResult(body); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [name, namespaced, namespace, token, refresh]);
  const items = (result?.items || []).filter(item => JSON.stringify([item.metadata?.name, item.metadata?.namespace, item.metadata?.labels]).toLowerCase().includes(search.toLowerCase()));
  const cleaned = selected && { ...selected, metadata: { ...selected.metadata, managedFields: undefined } };
  return <>
    <form className="log-controls" onSubmit={event => { event.preventDefault(); setNamespace(namespaceInput.trim()); setRefresh(n => n + 1); }}>
      {namespaced && <label>命名空间<input aria-label="CR 命名空间" placeholder="留空查看全部命名空间" value={namespaceInput} onChange={e => setNamespaceInput(e.target.value)} /></label>}
      <label>搜索<input aria-label="搜索 CR" placeholder="名称、命名空间、标签" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <button className="button" type="submit" disabled={busy}>{busy ? '正在读取…' : '查询 / 刷新'}</button>
    </form>
    <div className="panel-note">{crd.spec?.names?.kind} · {result?.apiVersion || crd.spec?.group} · {namespaced ? namespace || '全部命名空间' : '集群级资源'}</div>
    {error ? <div className="resource-error" role="alert"><h3>CR 读取失败</h3><p>{error}</p><p>请确认当前集群身份拥有该自定义资源的 list 权限。</p><button className="button" onClick={() => setRefresh(n => n + 1)}>重试</button></div>
      : busy ? <div className="loading-state">正在读取对应 CR…</div>
      : <>
        <div className="table-scroll"><table>
          <thead><tr><th>名称</th>{namespaced && <th>命名空间</th>}<th>存续时间</th><th className="align-right">操作</th></tr></thead>
          <tbody>{items.map(item => <tr key={item.metadata.uid || `${item.metadata.namespace}/${item.metadata.name}`}>
            <td><button className="name-button" onClick={() => setSelected(item)}>{item.metadata.name}</button></td>
            {namespaced && <td>{item.metadata.namespace}</td>}
            <td>{age(item.metadata.creationTimestamp)}</td>
            <td className="align-right"><button className="text-button" onClick={() => setSelected(item)}>详情 ↗</button></td>
          </tr>)}</tbody>
        </table></div>
        {!items.length && <div className="empty"><h3>{search ? '没有匹配的 CR' : '暂无 CR'}</h3><p>{search ? '请调整搜索关键词。' : '当前范围内尚未创建该类型的资源实例。'}</p></div>}
        <div className="table-footer">共 {items.length} 项资源<span>只读访问 · Kubernetes API</span></div>
      </>}
    {cleaned && <>
      <div className="detail-summary"><strong>{selected.metadata.namespace ? `${selected.metadata.namespace}/` : ''}{selected.metadata.name}</strong><div className="row-actions"><button className="button" onClick={() => download(JSON.stringify(cleaned, null, 2), `${selected.metadata.name}.json`)}>下载 JSON ↓</button><button className="button" onClick={() => setSelected(null)}>收起详情</button></div></div>
      <pre className="code">{JSON.stringify(cleaned, null, 2)}</pre>
    </>}
  </>;
}
