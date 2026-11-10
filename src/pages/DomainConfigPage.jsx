import React, { useEffect, useState } from 'react';
import api from '../lib/api.js';

const domainsFor = item => [...new Set([...(item?.subjectAltName || '').split(',').filter(value => value.startsWith('DNS:')).map(value => value.slice(4).toLowerCase()), ...(item?.urls || [item?.url]).flatMap(value => {
  try { const host = new URL(value).hostname.toLowerCase(); return host !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(host) ? [host] : []; }
  catch { return []; }
})].filter(value => value && value !== 'localhost' && !value.includes('*')))].join('\n');

export default function DomainConfigPage({ token, nodeName, onClose }) {
  const [registries, setRegistries] = useState([]), [nodes, setNodes] = useState([]), [registryId, setRegistryId] = useState('');
  const [domains, setDomains] = useState(''), [ip, setIp] = useState(''), [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [task, setTask] = useState(null);
  const registry = registries.find(item => item.id === registryId);
  const running = busy || task?.status === 'running';
  useEffect(() => {
    let active = true;
    Promise.all([api('/api/registries', token), api('/api/resources/nodes', token)]).then(([saved, found]) => {
      if (!active) return;
      setRegistries(saved.items || []); setNodes(found.items || []);
      setSelected([]);
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [token]);
  useEffect(() => {
    if (!task || task.status !== 'running') return;
    let active = true;
    const poll = async () => { try { const result = await api(`/api/registries/${task.registryId}/distribute?task=${encodeURIComponent(task.id)}`, token); if (active) setTask(result.task); } catch (e) { if (active) setError(e.message); } };
    poll(); const timer = setInterval(poll, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [task?.id, task?.status, token]);
  async function apply(event) {
    event.preventDefault(); setBusy(true); setError(''); setTask(null);
    const body = { confirm: true, mode: 'hosts', domains: [...new Set(domains.split(/[,\n]+/).map(value => value.trim()).filter(Boolean))], hostsIp: ip, registryId, registryVersion: registry.version };
    try {
      const result = await api(`/api/registries/${registryId}/distribute`, token, undefined, { method: 'POST', body: JSON.stringify({ ...body, version: registry.version, nodes: [nodeName, ...selected] }) });
      setTask(result.task);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="hosts-confirm domain-config-page" role="dialog" aria-modal="true" aria-labelledby="domain-config-title">
    <div className="resource-title"><h2 id="domain-config-title">域名配置 · {nodeName}</h2></div>
    <p>将域名映射到仓库 IP，应用到当前节点。可选择同步到其他节点。已有正确映射保持不变。</p>
    {error && <div className="error" role="alert">{error}</div>}
    <form onSubmit={apply}><fieldset disabled={running}>
      <div className="registry-fields">
        <label className="config-field"><span>镜像仓库</span><select required value={registryId} onChange={e => { const item = registries.find(value => value.id === e.target.value); setRegistryId(e.target.value); setDomains(domainsFor(item)); setIp(item?.hostsIp || ''); }}><option value="">选择仓库</option>{registries.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label className="config-field"><span>仓库 IP</span><input required value={ip} onChange={e => setIp(e.target.value)} placeholder="192.168.100.133" /></label>
      </div>
      <label className="config-field"><span>域名（每行一个）</span><textarea required rows={5} value={domains} onChange={e => setDomains(e.target.value)} /></label>
      <div className="domain-node-picker"><strong>同步到其他节点（可多选，默认不同步）</strong><div className="domain-node-list">{nodes.filter(node => node.metadata.name !== nodeName).map(node => <label className="hosts-node-option" key={node.metadata.name}><input type="checkbox" checked={selected.includes(node.metadata.name)} onChange={e => setSelected(current => e.target.checked ? [...current, node.metadata.name] : current.filter(name => name !== node.metadata.name))} />{node.metadata.name}</label>)}</div>{nodes.length <= 1 && <p>没有其他节点。</p>}</div>
      <div className="row-actions"><button type="button" className="button" onClick={onClose}>关闭</button><button className="button primary" disabled={!registry || !domains.trim() || !ip.trim()}>{running ? '正在配置…' : `应用到 ${selected.length + 1} 个节点`}</button></div>
    </fieldset></form>
    {task && <div className="domain-task-result" role="status"><h3>节点执行结果</h3><p>{task.status === 'running' ? '正在下发…' : task.status === 'failed' ? `失败：${task.error}` : '下发完成'}</p>{task.results?.map(result => <p key={result.node}>{result.node}：{result.success ? '成功' : `失败：${result.error}`}</p>)}</div>}
  </section>;
}
