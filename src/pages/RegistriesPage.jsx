import React, { useEffect, useState } from 'react';
import api from '../lib/api.js';
const empty = { hostsIp: '', subjectAltName: '', serverCert: '', serverKey: '', clearServerKey: false, name: '', url: 'https://', urls: [], username: '', password: '', ca: '', clientCert: '', clientKey: '', clearPassword: false, clearClientKey: false };
const splitDomains = text => text.split(/[,\n]+/).map(value => value.trim()).filter(Boolean);
function defaultDomains(item) {
  const sanNames = (item.subjectAltName || '').split(',').filter(value => value.startsWith('DNS:')).map(value => value.slice(4).toLowerCase());
  const addressNames = (item.urls || [item.url]).flatMap(value => { try { return [new URL(value).hostname.toLowerCase()]; } catch { return []; } });
  const names = [...new Set([...sanNames, ...addressNames].filter(value => value && value !== 'localhost' && !value.includes('*') && !/^\d+\.\d+\.\d+\.\d+$/.test(value) && !value.includes(':')))];
  return (names.length ? names : ['docker.io', 'registry-1.docker.io', 'ghcr.io', 'registry.k8s.io']).join('\n');
}
function inferredIp(item) {
  if (item.hostsIp) return item.hostsIp;
  try { const host = new URL(item.url).hostname; return /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : ''; } catch { return ''; }
}
const nodeIp = node => node.status?.addresses?.find(address => address.type === 'InternalIP')?.address || node.status?.addresses?.find(address => address.type === 'ExternalIP')?.address || '—';
const nodeState = node => node.status?.conditions?.find(condition => condition.type === 'Ready')?.status === 'True' ? 'Ready' : 'NotReady';
export default function RegistriesPage({ token, registerNavigationGuard, embedded = false, onConfigure, externalBusy = false }) {
  const [items, setItems] = useState([]), [query, setQuery] = useState(''), [editor, setEditor] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [dirty, setDirty] = useState(false);
  const [distribution, setDistribution] = useState(null), [nodes, setNodes] = useState([]), [selectedNodes, setSelectedNodes] = useState([]), [domains, setDomains] = useState(''), [task, setTask] = useState(null), [showTaskLog, setShowTaskLog] = useState(false);
  const [mapHosts, setMapHosts] = useState(true), [hostsIp, setHostsIp] = useState(''), [localTask, setLocalTask] = useState(null), [certificateRequest, setCertificateRequest] = useState(null), [saveTask, setSaveTask] = useState(null);
  const blocked = busy || externalBusy || task?.status === 'running' || localTask?.status === 'running' || saveTask?.status === 'running';
  useEffect(() => {
    if (embedded) return;
    const saved = sessionStorage.getItem('registry-distribution');
    if (saved) try { setTask(JSON.parse(saved)); } catch { sessionStorage.removeItem('registry-distribution'); }
    const saving = sessionStorage.getItem('registry-save');
    if (saving) try { setSaveTask(JSON.parse(saving)); } catch { sessionStorage.removeItem('registry-save'); }
  }, [embedded]);
  useEffect(() => {
    if (!saveTask?.id || saveTask.status !== 'running') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await api(`/api/registries/save-status?task=${encodeURIComponent(saveTask.id)}`, token);
        if (!cancelled) { setSaveTask(result.task); if (result.task.status !== 'running') sessionStorage.removeItem('registry-save'); }
      } catch (e) { if (!cancelled && e.status === 404) { setSaveTask(current => ({ ...current, status: 'failed', error: e.message, logs: [...(current.logs || []), `读取进度失败：${e.message}`] })); sessionStorage.removeItem('registry-save'); } }
    };
    poll(); const timer = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [saveTask?.id, saveTask?.status, token]);
  useEffect(() => {
    if (!task || task.status !== 'running') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await api(`/api/registries/${task.registryId}/distribute?task=${encodeURIComponent(task.id)}`, token);
        if (!cancelled) { setTask(result.task); sessionStorage.setItem('registry-distribution', JSON.stringify(result.task)); }
      } catch (e) { if (!cancelled) { setError(e.message); setTask(current => ({ ...current, status: 'failed' })); sessionStorage.removeItem('registry-distribution'); } }
    };
    poll(); const timer = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [task?.id, task?.status, token]);
  useEffect(() => {
    if (!localTask || localTask.status !== 'running') return;
    let cancelled = false;
    const poll = async () => {
      try { const result = await api('/api/cluster/service', token); if (!cancelled) setLocalTask(result.task); }
      catch (e) { if (!cancelled) { setError(e.message); setLocalTask(current => ({ ...current, status: 'failed' })); } }
    };
    const timer = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [localTask?.createdAt, localTask?.status, token]);
  useEffect(() => registerNavigationGuard?.(() => !(dirty || blocked || distribution || certificateRequest) || window.confirm('有未保存的仓库配置或正在处理的操作，确定离开吗？')), [dirty, blocked, distribution, certificateRequest, registerNavigationGuard]);
  async function load() { setBusy(true); setError(''); try { setItems((await api('/api/registries', token)).items); } catch (e) { setError(e.message); } finally { setBusy(false); } }
  useEffect(() => { load(); }, [token]);
  async function prepareDistribution(item) {
    if (dirty && !window.confirm('将使用已保存的仓库配置，是否继续？')) return;
    setError(''); setMessage(''); setDistribution({ ...item, mode: 'configure', target: embedded ? 'local' : 'nodes' }); setSelectedNodes([]);
    setDomains(defaultDomains(item)); setHostsIp(inferredIp(item)); setMapHosts(embedded);
    if (!embedded) {
      setBusy(true);
      try { const result = await api('/api/resources/nodes', token); setNodes(result.items || []); setSelectedNodes((result.items || []).map(node => node.metadata.name)); }
      catch (e) { setNodes([]); setError(`无法读取节点：${e.message}`); }
      finally { setBusy(false); }
    }
  }
  async function apply() {
    setBusy(true); setError('');
    const options = { domains: splitDomains(domains), confirm: true, mode: 'configure', mapHosts: distribution.target === 'local' && mapHosts, hostsIp };
    try {
      if (distribution.target === 'local') {
        const body = { ...options, registryId: distribution.id, registryVersion: distribution.version };
        if (onConfigure) await onConfigure(body);
        else { const result = await api('/api/cluster/service', token, undefined, { method: 'POST', body: JSON.stringify({ action: 'registry', ...body }) }); setLocalTask(result.task); }
      } else {
        const result = await api(`/api/registries/${distribution.id}/distribute`, token, undefined, { method: 'POST', body: JSON.stringify({ ...options, version: distribution.version, nodes: selectedNodes }) });
        setTask(result.task); setShowTaskLog(true); sessionStorage.setItem('registry-distribution', JSON.stringify(result.task));
      }
      setDistribution(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function edit(item) {
    if (dirty && !window.confirm('放弃未保存的配置？')) return;
    setEditor(item ? { ...empty, ...item, urls: item.urls || [item.url], password: '', clientKey: '', serverKey: '' } : { ...empty }); setDirty(false); setMessage(''); setError('');
  }
  function change(key, value) { setEditor(current => ({ ...current, [key]: value })); setDirty(true); }
  async function upload(key, file) { if (!file) return; if (file.size > 65536) { setError('证书文件不能超过 64 KiB'); return; } try { change(key, await file.text()); } catch { setError('读取文件失败'); } }
  async function parseAddresses() {
    if (!editor.ca.trim()) { setError('请先上传或粘贴 certificates 证书'); return; }
    setBusy(true); setError('');
    try {
      const result = await api('/api/registries/parse-certificate', token, undefined, { method: 'POST', body: JSON.stringify({ certificate: editor.ca }) });
      if (!result.urls.length) throw new Error('证书 SAN 中没有可用的 DNS 域名');
      setEditor(current => ({ ...current, urls: result.urls, url: result.urls.includes(current.url) ? current.url : result.urls[0] })); setDirty(true);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function save(event) {
    event.preventDefault(); setBusy(true); setError(''); setSaveTask({ status: 'running', logs: ['正在保存仓库配置…'] });
    const body = Object.fromEntries(Object.keys(empty).map(key => [key, editor[key]]));
    body.urls = [...new Set((editor.urls.length ? editor.urls : [editor.url]).map(value => value.trim()).filter(Boolean))];
    body.url = body.urls[0] || editor.url;
    if (editor.id) body.version = editor.version;
    try {
      const result = await api(`/api/registries${editor.id ? `/${editor.id}` : ''}`, token, undefined, { method: editor.id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      setEditor(null); setDirty(false); setSaveTask(result.task || { status: 'succeeded', logs: ['仓库配置已保存'] });
      if (result.task) sessionStorage.setItem('registry-save', JSON.stringify(result.task));
      await load();
    } catch (e) { setSaveTask(null); setError(e.message); } finally { setBusy(false); }
  }
  async function remove(item) {
    if (!window.confirm(`确认删除镜像仓库“${item.name}”及其保存的证书配置？已应用到主机的配置不会随之删除。`)) return;
    setBusy(true); setError('');
    try { await api(`/api/registries/${item.id}`, token, undefined, { method: 'DELETE', body: JSON.stringify({ version: item.version }) }); if (editor?.id === item.id) { setEditor(null); setDirty(false); } setMessage('仓库已删除'); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function prepareCertificates(item) {
    const url = new URL(item.url);
    setCertificateRequest({ item, protocol: url.protocol.slice(0, -1), port: url.port || (url.protocol === 'https:' ? '443' : '80'), token: '' }); setError('');
  }
  async function importCertificates(event) {
    event.preventDefault(); setBusy(true); setError('');
    const request = certificateRequest;
    setCertificateRequest(current => ({ ...current, token: '' }));
    try {
      await api(`/api/registries/${request.item.id}/certificates`, token, undefined, { method: 'POST', body: JSON.stringify({ version: request.item.version, protocol: request.protocol, port: Number(request.port), token: request.token }) });
      setCertificateRequest(null); setMessage('公共证书已拉取并保存，可应用到本机或下发节点。'); await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function closeEditor() { if (!dirty || window.confirm('放弃未保存的配置？')) { setEditor(null); setDirty(false); setError(''); } }
  const shown = items.filter(item => `${item.name} ${(item.urls || [item.url]).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <section className={`${embedded ? '' : 'panel '}registry-maintenance`}>
    <div className="resource-toolbar"><div className="resource-title"><h2>镜像仓库列表</h2><span className="count-pill">{shown.length}</span></div><div className="filters"><input aria-label="搜索镜像仓库" placeholder="搜索名称、地址" value={query} onChange={e => setQuery(e.target.value)} /><button className="button" disabled={blocked} onClick={load}>刷新</button><button className="button primary" disabled={blocked} onClick={() => edit(null)}>新增仓库</button></div></div>
    <p>{embedded ? '选择或新增仓库，保存证书后应用到当前服务器，再继续安装集群。' : '维护仓库备用入口和证书，并将镜像拉取配置下发到 K8s 节点。域名与 IP 映射请使用“系统维护 → 域名配置”。'}</p>
    {error && !editor && !distribution && !certificateRequest && <div className="error" role="alert">{error}</div>}{message && <p role="status">{message}</p>}
    <div className="table-wrap"><table><thead><tr><th>仓库</th><th>备用入口</th><th>仓库 IP</th><th>证书</th><th>状态</th><th>操作</th></tr></thead><tbody>{shown.map(item => <tr key={item.id}><td><strong>{item.name}</strong></td><td><span className="mono">{item.url}</span>{(item.urls || []).length > 1 && <span className="count-pill">+{item.urls.length - 1}</span>}</td><td>{inferredIp(item) || '未配置'}</td><td>{item.ca ? '已配置' : '未配置'}</td><td>{task?.registryId === item.id ? <button className={`registry-task-status ${task.status}`} onClick={() => setShowTaskLog(true)}>{task.status === 'running' ? '配置中 · 查看日志' : task.status === 'failed' ? '下发失败 · 查看日志' : '已完成 · 查看日志'}</button> : <span className="registry-task-empty">暂无下发任务</span>}</td><td><div className="row-actions registry-row-actions"><button className="text-button" disabled={blocked} onClick={() => edit(item)}>查看 / 编辑</button><button className="text-button" disabled={blocked} onClick={() => prepareCertificates(item)}>拉取证书</button><button className="text-button" disabled={blocked} onClick={() => prepareDistribution(item)}>{embedded ? '配置当前服务器' : '下发到节点'}</button><button className="text-button delete-button" disabled={blocked} onClick={() => remove(item)}>删除</button></div></td></tr>)}</tbody></table></div>
    {certificateRequest && <div className="registry-modal-backdrop"><form className="registry-editor registry-modal" role="dialog" aria-modal="true" aria-labelledby="registry-certificate-title" onSubmit={importCertificates}><h3 id="registry-certificate-title">拉取公共证书 · {certificateRequest.item.name}</h3><p>从仓库主机获取公共证书，导出 Token 仅用于本次请求。</p>{error && <div className="error" role="alert">{error}</div>}<fieldset disabled={blocked}><div className="registry-fields"><label className="config-field"><span>证书接口协议</span><select value={certificateRequest.protocol} onChange={e => setCertificateRequest(current => ({ ...current, protocol: e.target.value, port: e.target.value === 'https' ? '443' : '80' }))}><option value="https">HTTPS</option><option value="http">HTTP</option></select></label><label className="config-field"><span>证书接口端口</span><input required type="number" min="1" max="65535" value={certificateRequest.port} onChange={e => setCertificateRequest(current => ({ ...current, port: e.target.value }))} /></label><label className="config-field"><span>证书导出 Token</span><input required type="password" autoComplete="off" value={certificateRequest.token} onChange={e => setCertificateRequest(current => ({ ...current, token: e.target.value }))} /></label></div><div className="row-actions"><button className="button primary" type="submit">拉取并保存公共证书</button><button className="button" type="button" onClick={() => setCertificateRequest(null)}>取消</button></div></fieldset></form></div>}
    {localTask && <section className="registry-editor" role="status"><h3>本机配置结果</h3><p>{{ running: '正在配置…', succeeded: '配置成功', failed: '配置失败', interrupted: '配置中断' }[localTask.status]}{localTask.error ? `：${localTask.error}` : ''}</p><pre className="cluster-logs">{localTask.logs?.join('')}</pre></section>}
    {task && showTaskLog && <div className="registry-modal-backdrop"><section className="registry-modal registry-task-modal" role="dialog" aria-modal="true" aria-labelledby="registry-task-title"><h3 id="registry-task-title">节点下发日志 · {items.find(item => item.id === task.registryId)?.name || '镜像仓库'}</h3><p>{task.status === 'running' ? '正在下发' : task.status === 'failed' ? '下发未全部成功' : '下发完成'}{task.error ? `：${task.error}` : ''}</p><pre className="registry-save-logs" aria-live="polite">{(task.logs || []).join('\n')}</pre>{task.results?.length > 0 && <div className="registry-task-results">{task.results.map(result => <p key={result.node}>{result.node}：{result.success ? `成功 · ${result.restarted ? '已重启 containerd' : '无需重启 containerd'} · 备份 ${result.backupId}` : `失败 · ${result.error}`}</p>)}</div>}<div className="row-actions"><button className="button" onClick={() => setShowTaskLog(false)}>关闭</button></div></section></div>}
    {distribution && <div className="registry-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !blocked) setDistribution(null); }}><section className="registry-modal registry-distribution-modal" role="dialog" aria-modal="true" aria-labelledby="registry-distribution-title" onKeyDown={e => { if (e.key === 'Escape' && !blocked) setDistribution(null); }}>
      <h3 id="registry-distribution-title">{embedded ? '配置当前服务器' : '下发到节点'} · {distribution.name}</h3>
      <p>每个镜像源将按仓库备用入口顺序拉取，并校验证书。</p>
      {error && <div className="error" role="alert">{error}</div>}
      <fieldset disabled={blocked}>
        <label className="config-field"><span>镜像源域名（每行一个）</span><textarea rows={4} value={domains} onChange={e => setDomains(e.target.value)} /></label>
        {embedded && <><label className="check"><input type="checkbox" checked={mapHosts} onChange={e => setMapHosts(e.target.checked)} />同时配置 /etc/hosts</label>{mapHosts && <label className="config-field"><span>镜像仓库 IP</span><input value={hostsIp} onChange={e => setHostsIp(e.target.value)} /></label>}</>}
        {!embedded && <div className="domain-node-picker"><div className="domain-node-head"><strong>目标节点（{selectedNodes.length}/{nodes.length}）</strong><div className="row-actions"><button type="button" className="button" onClick={() => setSelectedNodes(nodes.map(node => node.metadata.name))}>全选</button><button type="button" className="button" onClick={() => setSelectedNodes([])}>清空</button></div></div><div className="registry-node-table-wrap"><table className="registry-node-table"><thead><tr><th><span className="sr-only">选择</span></th><th>节点名称</th><th>节点 IP</th><th>节点状态</th></tr></thead><tbody>{nodes.map(node => <tr key={node.metadata.name}><td><input type="checkbox" aria-label={`选择节点 ${node.metadata.name}`} checked={selectedNodes.includes(node.metadata.name)} onChange={e => setSelectedNodes(current => e.target.checked ? [...current, node.metadata.name] : current.filter(name => name !== node.metadata.name))} /></td><td>{node.metadata.name}</td><td className="mono">{nodeIp(node)}</td><td><span className={`registry-node-status ${nodeState(node) === 'Ready' ? 'is-ready' : 'is-not-ready'}`}>{nodeState(node)}</span></td></tr>)}</tbody></table></div>{!nodes.length && <p>没有可用节点。</p>}</div>}
        <div className="row-actions"><button className="button primary" disabled={!domains.trim() || (embedded && mapHosts && !hostsIp.trim()) || (!embedded && !selectedNodes.length)} onClick={apply}>确认{embedded ? '配置当前服务器' : `下发到 ${selectedNodes.length} 个节点`}</button><button className="button" onClick={() => setDistribution(null)}>取消</button></div>
      </fieldset>
    </section></div>}
    {!shown.length && <p>{busy ? '正在加载…' : '暂无匹配的镜像仓库，请先新增仓库。'}</p>}
    {editor && <div className="registry-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !blocked) closeEditor(); }}><form className="registry-editor registry-modal" role="dialog" aria-modal="true" aria-labelledby="registry-editor-title" onSubmit={save} onKeyDown={e => { if (e.key === 'Escape' && !blocked) { e.preventDefault(); closeEditor(); } }}><h3 id="registry-editor-title">{editor.id ? '查看 / 编辑仓库' : '新增仓库'}</h3>{error && <div className="error" role="alert">{error}</div>}<fieldset disabled={blocked}><legend className="sr-only">仓库配置</legend><div className="registry-fields">
      <label className="config-field"><span>仓库名称</span><input required maxLength={512} value={editor.name} onChange={e => change('name', e.target.value)} autoFocus /></label>
      <label className="config-field"><span>仓库 IP（保存后同步 hosts）</span><input required maxLength={512} value={editor.hostsIp} onChange={e => change('hostsIp', e.target.value)} placeholder="192.168.100.133" /></label>
    </div>
    <h3>仓库 HTTPS 证书</h3><p>上传或粘贴 certificates 文件中的 PEM 公共证书；也可保存仓库后通过列表的“拉取证书”获取。</p>
    <label className="config-field"><span>certificates（PEM）</span><input type="file" accept=".pem,.crt,.cer,text/plain" onChange={e => upload('ca', e.target.files?.[0])} /><textarea rows={8} maxLength={65536} value={editor.ca} onChange={e => change('ca', e.target.value)} placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'} /></label>
    <div className="row-actions"><button type="button" className="button" onClick={parseAddresses}>解析仓库地址</button></div>
    <label className="config-field"><span>仓库备用入口（每行一个；按顺序尝试并校验证书）</span><textarea required rows={4} value={editor.urls.join('\n')} onChange={e => change('urls', e.target.value.split('\n'))} placeholder="https://lingxi.image.io" /></label>
    <div className="row-actions"><button className="button primary" type="submit">{busy ? '保存中…' : '保存配置'}</button><button className="button" type="button" onClick={closeEditor}>取消</button></div>
    </fieldset></form></div>}
    {saveTask && <div className="registry-modal-backdrop"><section className="registry-modal registry-save-progress" role="dialog" aria-modal="true" aria-labelledby="registry-save-title"><h3 id="registry-save-title">{saveTask.status === 'running' ? '正在保存仓库配置' : saveTask.status === 'succeeded' ? '仓库配置已保存' : '仓库保存或节点同步未完成'}</h3><div className="registry-progress-track" role="progressbar" aria-label="仓库保存与节点同步进度" aria-valuetext={saveTask.status === 'running' ? '正在处理' : '已结束'}><span className={saveTask.status === 'running' ? 'is-running' : saveTask.status === 'succeeded' ? 'is-complete' : 'is-failed'} /></div><pre className="registry-save-logs" aria-live="polite">{(saveTask.logs || []).join('\n')}</pre>{saveTask.error && <p className="error" role="alert">{saveTask.error}</p>}{saveTask.hosts?.nodes?.length > 0 && <p>工作节点：{saveTask.hosts.nodes.filter(node => node.success).length}/{saveTask.hosts.nodes.length} 个成功</p>}<div className="row-actions"><button className="button primary" type="button" disabled={saveTask.status === 'running'} onClick={() => setSaveTask(null)}>关闭</button></div></section></div>}
  </section>;
}
