import React, { useRef, useState } from 'react';
import api from '../lib/api.js';

export default function ManifestApply({ token, onUpdated }) {
  const dialog = useRef(null);
  const [manifest, setManifest] = useState('');
  const [serverSide, setServerSide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  async function upload(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(''); setResult(null);
    if (file.size > 10 * 1024 * 1024) { setError('YAML 配置不能超过 10 MiB'); return; }
    setReading(true);
    try { setManifest(await file.text()); }
    catch { setError('无法读取文件，请重新选择'); }
    finally { setReading(false); }
  }
  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError(''); setResult(null);
    try {
      const response = await api('/api/manifests/apply', token, undefined, {
        method: 'POST', body: JSON.stringify({ manifest, serverSide }),
      });
      setResult(response);
      onUpdated(); // A failed multi-document apply can still have changed some resources.
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  return <>
    <button className="button" onClick={() => dialog.current.showModal()}>上传 YAML / Apply</button>
    <dialog ref={dialog} className="resource-dialog" onCancel={e => { if (busy || reading) e.preventDefault(); }}>
      <div className="dialog-head"><h2>应用 YAML 配置</h2><button className="button" disabled={busy || reading} onClick={() => dialog.current.close()}>关闭</button></div>
      <form className="manifest-apply" onSubmit={submit}>
        <p>上传或粘贴 YAML，支持以 --- 分隔多个资源。命名空间使用 YAML 中的设置；未指定时使用当前 kubeconfig 的默认命名空间。</p>
        <label>上传配置（最大 10 MiB）<input type="file" accept=".yaml,.yml,.json" disabled={busy || reading} onChange={upload} /></label>
        <label htmlFor="apply-manifest">YAML 配置</label>
        <textarea id="apply-manifest" spellCheck={false} rows={16} required value={manifest} disabled={busy || reading} onChange={e => { setManifest(e.target.value); setResult(null); setError(''); }} />
        <label className="check"><input type="checkbox" checked={serverSide} disabled={busy || reading} onChange={e => { setServerSide(e.target.checked); setResult(null); }} />启用 --server-side（服务端应用）</label>
        <p>{serverSide ? '由 Kubernetes 服务端管理字段归属，字段冲突时返回错误。' : '客户端合并：保留未管理的对象字段，列表字段整体替换；需要按字段归属合并时请勾选服务端应用。'}</p>
        <p>执行将创建或更新当前集群资源；多个资源的应用不是事务，失败时可能已有部分资源生效。</p>
        {error && <p className="error" role="alert">{error}</p>}
        {result && <div role="status"><p className={result.success ? '' : 'error'}>{result.success ? '配置已应用' : result.timedOut ? '执行超时，请检查集群中资源的实际状态' : '应用失败，请查看输出；部分资源可能已生效'}</p><pre>{result.output}{result.diagnostics}</pre></div>}
        <button className="button primary" disabled={busy || reading || !manifest.trim()}>{busy ? '正在应用…' : '应用配置'}</button>
      </form>
    </dialog>
  </>;
}
