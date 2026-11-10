import React, { useEffect, useState } from 'react';
import api from '../lib/api.js';
export default function NodeHosts({ item, token, onDirty }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [ip, setIp] = useState(''), [name, setName] = useState(''), [pending, setPending] = useState(null), [syncNodes, setSyncNodes] = useState([]), [results, setResults] = useState([]);
  const url = `/api/nodes/${encodeURIComponent(item.metadata.name)}/hosts`;
  useEffect(() => { onDirty(busy || !!pending || !!ip || !!name); return () => onDirty(false); }, [busy, pending, ip, name, onDirty]);
  async function load() {
    setBusy(true); setError('');
    try { setData(await api(url, token)); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  useEffect(() => { load(); }, [url, token]);
  function propose(change) { setPending(change); setSyncNodes([]); setError(''); setResults([]); }
  async function apply() {
    setBusy(true); setError('');
    try {
      const result = await api(url, token, undefined, { method: 'POST', body: JSON.stringify({ before: data.content, change: pending, syncNodes, confirm: true }) });
      setResults(result.results); setPending(null);
      if (result.results[0]?.success) { setIp(''); setName(''); }
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="node-labels">
    <p>管理节点 /etc/hosts。新增或删除后，确认修改并选择要同步本次变更的节点。写入前自动备份，保留其他映射。</p>
    {error && <div className="error" role="alert">{error}</div>}
    {results.length > 0 && <div role="status">{results.map(result => <p key={result.node}>{result.node}：{result.success ? '修改成功' : `失败：${result.error}`}</p>)}</div>}
    <fieldset disabled={busy || !!pending}><legend className="sr-only">域名映射</legend>
      <button className="button" onClick={load}>{busy ? '处理中…' : '重新加载'}</button>
      {data && <><table><thead><tr><th>IP 地址</th><th>域名</th><th>操作</th></tr></thead><tbody>{data.mappings.map((row, index) => <tr key={`${row.ip}-${row.name}-${index}`}><td className="mono">{row.ip}</td><td>{row.name}</td><td><button className="text-button delete-button" onClick={() => propose({ action: 'delete', ...row })}>删除</button></td></tr>)}</tbody></table>
        {!data.mappings.length && <p>暂无域名映射</p>}
        <form className="node-label-row" onSubmit={event => { event.preventDefault(); propose({ action: 'add', ip: ip.trim(), name: name.trim() }); }}>
          <label className="config-field"><span>IP 地址</span><input required value={ip} onChange={e => setIp(e.target.value)} placeholder="例如 192.168.1.10" /></label>
          <label className="config-field"><span>域名</span><input required maxLength={253} value={name} onChange={e => setName(e.target.value)} placeholder="例如 registry.example.com" /></label>
          <button className="button primary" type="submit">新增映射</button>
        </form></>}
    </fieldset>
    {pending && <div className="hosts-confirm" role="alertdialog" aria-modal="true" aria-labelledby="hosts-confirm-title">
      <h3 id="hosts-confirm-title">确认{pending.action === 'add' ? '新增' : '删除'}域名映射？</h3>
      <p className="mono">{pending.ip} → {pending.name}</p><p>将修改节点 {item.metadata.name} 的 /etc/hosts。</p>
      <fieldset disabled={busy}><legend>是否同步到其他节点（可多选，默认不同步）</legend>
        {data.nodes.filter(node => node !== item.metadata.name).map(node => <label className="hosts-node-option" key={node}><input type="checkbox" checked={syncNodes.includes(node)} onChange={e => setSyncNodes(current => e.target.checked ? [...current, node] : current.filter(value => value !== node))} />{node}</label>)}
        {data.nodes.length === 1 && <p>没有其他节点</p>}
      </fieldset>
      <div className="row-actions"><button className="button" disabled={busy} onClick={() => setPending(null)}>取消</button><button className="button primary" disabled={busy} onClick={apply}>{busy ? '正在修改…' : '确认修改'}</button></div>
    </div>}
  </section>;
}
