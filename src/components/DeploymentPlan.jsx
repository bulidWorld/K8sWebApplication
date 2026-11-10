import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../lib/api.js';

const time = value => value ? new Date(value).toLocaleString('zh-CN') : '—';
const statusText = status => ({ queued: '等待中', running: '执行中', succeeded: '成功', failed: '失败', interrupted: '中断' })[status] || status;

export default function DeploymentPlan({ token, onUpdated }) {
  const dialog = useRef(null);
  const detailDialog = useRef(null);
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [tasks, setTasks] = useState([]);
  const [active, setActive] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api('/api/deployment-plans', token);
      setTasks(result.tasks);
      if (active) {
        const latest = result.tasks.find(task => task.id === active.id);
        if (latest) setActive(latest);
      }
    } catch (e) { setError(e.message); }
  }, [token, active]);

  useEffect(() => {
    if (!opened) return;
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [opened, refresh]);

  async function submit(e) {
    e.preventDefault();
    if (!file || !name.trim()) return;
    setBusy(true); setError('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const result = await api('/api/deployment-plans', token, undefined, { method: 'POST', body: JSON.stringify({ name: name.trim(), archive: btoa(binary) }) });
      setFile(null);
      setActive(await api(`/api/deployment-plans/${result.id}`, token));
      detailDialog.current?.showModal();
      await refresh(); onUpdated();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function retry(task) {
    setBusy(true); setError('');
    try {
      const result = await api(`/api/deployment-plans/${task.id}/retry`, token, undefined, { method: 'POST', body: '{}' });
      setActive(await api(`/api/deployment-plans/${result.id}`, token));
      detailDialog.current?.showModal();
      await refresh(); onUpdated();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function showTask(task) {
    try {
      setActive(await api(`/api/deployment-plans/${task.id}`, token));
      if (!detailDialog.current?.open) detailDialog.current?.showModal();
    } catch (e) { setError(e.message); }
  }

  return <>
    <button className="button" onClick={() => { dialog.current.showModal(); setOpened(true); }}>部署计划 / 历史</button>
    <dialog ref={dialog} className="resource-dialog" onClose={() => { setOpened(false); setActive(null); }}>
      <div className="dialog-head"><h2>部署计划</h2><button className="button" onClick={() => dialog.current.close()}>关闭</button></div>
      <div className="manifest-apply">
        <p>导入包含 YAML 文件和一个 executionPlan XML 的 .tar。步骤按 XML 中的顺序执行。</p>
        <form onSubmit={submit}>
          <label>部署名称<input value={name} maxLength={120} required onChange={e => setName(e.target.value)} placeholder="输入本次部署的名称" /></label>
          <label>选择 .tar 文件<input type="file" accept=".tar,application/x-tar" onChange={e => setFile(e.target.files?.[0] || null)} /></label>
          <button className="button primary" disabled={!file || !name.trim() || busy}>{busy ? '正在处理…' : '命名并执行部署'}</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        <h3>部署历史</h3>
        {tasks.length ? <div className="table-scroll"><table className="deployment-plan-history">
          <thead><tr><th>部署名称</th><th>开始时间</th><th>失败时间</th><th>失败原因</th><th>是否成功</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>{tasks.map(task => <tr key={task.id}>
            <td>{task.name}</td><td>{time(task.startedAt)}</td><td>{time(task.failedAt)}</td><td>{task.error || '—'}</td>
            <td>{task.status === 'succeeded' ? '是' : ['failed', 'interrupted'].includes(task.status) ? '否' : '—'}</td><td>{statusText(task.status)}</td>
            <td><div className="row-actions"><button type="button" className="icon-button" title="详情" aria-label={`查看 ${task.name} 的详情`} onClick={() => showTask(task)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button>{['failed', 'interrupted'].includes(task.status) && <button type="button" className="icon-button" title="重试" aria-label={`重试 ${task.name}`} disabled={busy || tasks.some(item => ['queued', 'running'].includes(item.status))} onClick={() => retry(task)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 1-2.4-5.7"/><path d="M20 4v6h-6"/></svg></button>}</div></td>
          </tr>)}</tbody>
        </table></div> : <p>暂无历史任务</p>}
      </div>
    </dialog>
    <dialog ref={detailDialog} className="resource-dialog deployment-plan-progress-dialog" onClose={() => setActive(null)}>
      <div className="dialog-head"><h2>{active ? `${active.name} · ${statusText(active.status)}` : '部署进度'}</h2><button type="button" className="button" onClick={() => detailDialog.current?.close()}>关闭</button></div>
      {active && <section className="deployment-plan-detail manifest-apply">
        <h3>{active.name} · {statusText(active.status)}{['queued', 'running'].includes(active.status) ? ` ${active.completedSteps}/${active.steps.length}` : ''}</h3>
        <progress max={active.steps.length || 1} value={active.completedSteps} />
        {active.error && <p className="error">{active.error}</p>}
        <pre>{active.logs.map(log => `[${time(log.time)}] ${log.message}`).join('\n')}</pre>
      </section>}
    </dialog>
  </>;
}
