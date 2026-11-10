import React, { useEffect, useState } from 'react';
import api from '../lib/api.js';
import DomainConfigPage from './DomainConfigPage.jsx';

const initial = { nodeName: '', user: 'root', port: '22', auth: 'key', loginPassword: '', identityFile: '', sudoPassword: '' };
const ipOf = node => node?.status?.addresses?.find(item => item.type === 'InternalIP')?.address || '—';

export default function NodeConfigPage({ token, registerNavigationGuard }) {
  const [nodes, setNodes] = useState([]), [saved, setSaved] = useState([]), [form, setForm] = useState(initial), [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [dirty, setDirty] = useState(false), [domainNode, setDomainNode] = useState('');
  useEffect(() => registerNavigationGuard?.(() => !dirty || window.confirm('放弃未保存的节点登录配置？')), [dirty, registerNavigationGuard]);
  async function load() {
    try {
      const [nodeResult, accessResult] = await Promise.all([api('/api/resources/nodes', token), api('/api/registry-node-access', token)]);
      setNodes(nodeResult.items || []); setSaved(accessResult.items || []);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, [token]);
  function change(key, value) { setForm(current => ({ ...current, [key]: value })); if (['nodeName', 'user', 'port'].includes(key)) setProbe(null); setDirty(true); }
  async function inspect() {
    setBusy(true); setError(''); setMessage('');
    try { setProbe(await api('/api/registry-node-access/probe', token, undefined, { method: 'POST', body: JSON.stringify({ nodeName: form.nodeName, user: form.user, port: Number(form.port) }) })); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function save(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await api('/api/registry-node-access', token, undefined, { method: 'POST', body: JSON.stringify({ ...form, port: Number(form.port), probeId: probe.probeId, fingerprint: probe.fingerprint }) });
      setMessage(`${form.nodeName} 的 SSH 登录方式已保存`); setForm(initial); setProbe(null); setDirty(false); await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function remove(item) {
    if (!window.confirm(`删除节点 ${item.nodeName} 的 SSH 登录配置？`)) return;
    setBusy(true); setError('');
    try { await api(`/api/registry-node-access/${item.nodeName}`, token, undefined, { method: 'DELETE' }); setMessage('节点登录配置已删除'); await load(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="panel node-config-page">
    <div className="resource-title"><h2>节点配置</h2></div>
    <p>仓库下发通过 SSH 直接修改节点宿主机。先核对主机指纹，再保存登录方式；密码仅保存在服务器的受限配置文件中，不会回显。</p>
    {error && <div className="error" role="alert">{error}</div>}{message && <p role="status">{message}</p>}
    <div className="table-wrap"><table><thead><tr><th>节点</th><th>节点 IP</th><th>SSH 用户</th><th>登录方式</th><th>状态</th><th>操作</th></tr></thead><tbody>{nodes.map(node => {
      const item = saved.find(value => value.nodeName === node.metadata.name);
      return <tr key={node.metadata.name}><td>{node.metadata.name}</td><td className="mono">{ipOf(node)}</td><td>{item?.user || '—'}</td><td>{item ? item.auth === 'key' ? '密钥' : '密码' : '—'}</td><td>{item ? item.host === ipOf(node) ? '已配置' : 'IP 已变化，需重新配置' : '未配置'}</td><td><div className="row-actions"><button className="text-button" disabled={busy} onClick={() => { setForm({ ...initial, nodeName: node.metadata.name, user: item?.user || 'root', port: String(item?.port || 22), auth: item?.auth || 'key' }); setProbe(null); setDirty(false); }}>配置</button><button className="text-button" onClick={() => setDomainNode(node.metadata.name)}>域名配置</button>{item && <button className="text-button delete-button" disabled={busy} onClick={() => remove(item)}>删除</button>}</div></td></tr>;
    })}</tbody></table></div>
    {form.nodeName && <form className="node-access-form" onSubmit={save}><h3>配置节点 · {form.nodeName}（{ipOf(nodes.find(node => node.metadata.name === form.nodeName))}）</h3><fieldset disabled={busy}><div className="registry-fields">
      <label className="config-field"><span>SSH 用户</span><input required value={form.user} onChange={e => change('user', e.target.value)} /></label>
      <label className="config-field"><span>SSH 端口</span><input required type="number" min="1" max="65535" value={form.port} onChange={e => change('port', e.target.value)} /></label>
      <label className="config-field"><span>登录方式</span><select value={form.auth} onChange={e => change('auth', e.target.value)}><option value="key">服务器上的 SSH 私钥</option><option value="password">SSH 登录密码</option></select></label>
      {form.auth === 'key' ? <label className="config-field"><span>SSH 私钥绝对路径</span><input required value={form.identityFile} onChange={e => change('identityFile', e.target.value)} placeholder="/root/.ssh/id_ed25519" /></label> : <label className="config-field"><span>SSH 登录密码</span><input required type="password" autoComplete="new-password" value={form.loginPassword} onChange={e => change('loginPassword', e.target.value)} /></label>}
      {form.user !== 'root' && <label className="config-field"><span>sudo 密码（免密 sudo 可留空）</span><input type="password" autoComplete="new-password" value={form.sudoPassword} onChange={e => change('sudoPassword', e.target.value)} /></label>}
    </div><div className="row-actions"><button type="button" className="button" onClick={inspect}>获取 SSH 主机指纹</button></div>
    {probe && <div className="node-access-fingerprint"><p>确认节点 {probe.host} 的 SSH 主机指纹：</p><code>{probe.fingerprint}</code><p>核对无误后保存。修改登录参数需要重新获取指纹。</p></div>}
    <div className="row-actions"><button className="button primary" disabled={!probe}>确认指纹并保存</button><button type="button" className="button" onClick={() => { setForm(initial); setProbe(null); setDirty(false); }}>取消</button></div></fieldset></form>}
    {domainNode && <DomainConfigPage token={token} nodeName={domainNode} onClose={() => setDomainNode('')} />}
  </section>;
}
