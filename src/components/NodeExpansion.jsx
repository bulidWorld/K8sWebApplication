import React, { useEffect, useRef, useState } from 'react';
import api from '../lib/api.js';
import download from '../lib/download.js';
const active = task => ['checking', 'running'].includes(task?.status);
const states = { checking: '预检中', checked: '预检通过', running: '扩容中', succeeded: '扩容完成', failed: '失败', interrupted: '已中断' };
const emptyTarget = { host: '', port: 22, user: '', nodeName: '' };
export default function NodeExpansion({ token, onUpdated }) {
  const logRef = useRef(null);
  const [followLogs, setFollowLogs] = useState(true);
  const [opened, setOpened] = useState(false);
  const [info, setInfo] = useState(null);
  const [settings, setSettings] = useState(null);
  const [editing, setEditing] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingTarget, setEditingTarget] = useState(false);
  const [target, setTarget] = useState(emptyTarget);
  const [probe, setProbe] = useState(null);
  const [trusted, setTrusted] = useState(false);
  const [task, setTask] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sshPassword, setSshPassword] = useState('');
  const [sudoPassword, setSudoPassword] = useState('');
  const [samePassword, setSamePassword] = useState(true);
  const clearPasswords = () => { setSshPassword(''); setSudoPassword(''); };
  const post = (route, body) => api(`/api/expansion/${route}`, token, undefined, { method: 'POST', body: JSON.stringify(body) });
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    clearPasswords(); setEditingTarget(false); setInfo(null); setError(''); setTask(null); setProbe(null); setTrusted(false);
    Promise.all([
      api('/api/expansion/settings', token, controller.signal),
      api('/api/expansion/targets', token, controller.signal),
    ]).then(([config, result]) => {
      setSettings(config.settings); setEditing(!config.initialized);
      setInfo(result); setTargetId(result.targets[0]?.id || ''); setAdding(!result.targets.length);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [opened, token]);
  useEffect(() => {
    if (!opened || !active(task)) return;
    let cancelled = false; const controller = new AbortController();
    const timer = setInterval(async () => {
      try {
        const result = await api(`/api/expansion/tasks/${task.id}`, token, controller.signal);
        if (cancelled) return;
        setTask(result); setError(''); if (!active(result)) onUpdated();
      } catch (e) { if (!cancelled) setError(e.message); }
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); controller.abort(); };
  }, [opened, task?.id, task?.status, token, onUpdated]);
  useEffect(() => {
    if (followLogs && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [task?.id, task?.logs?.length, task?.logs?.at(-1), followLogs]);
  async function action(work) {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function saveSettings(e) {
    e.preventDefault();
    await action(async () => {
      const result = await post('settings', settings);
      setSettings(result.settings); setEditing(false);
      const next = await api('/api/expansion/targets', token); setInfo(next); setAdding(!next.targets.length);
    });
  }
  async function start() {
    await action(async () => {
      try {
        let id = targetId;
        if (adding) {
          const saved = await post('targets', { ...target, ...probe });
          id = saved.target.id; setTargetId(id); setAdding(false); setProbe(null); setTrusted(false);
          setInfo(current => ({ ...current, targets: [...current.targets, saved.target] }));
        }
        setTask(await post('tasks', { targetId: id, start: true, sshPassword, sudoPassword: usesPassword && samePassword ? sshPassword : sudoPassword }));
      } finally { clearPasswords(); }
    });
  }
  function editSelected() {
    clearPasswords(); setProbe(null); setTrusted(false); setEditingTarget(true);
    setTarget({ host: selected.host, port: selected.port, user: selected.user, nodeName: selected.nodeName });
  }
  function cancelTargetEdit() { clearPasswords(); setEditingTarget(false); setProbe(null); setTrusted(false); }
  async function saveTarget() {
    await action(async () => {
      const saved = await post(`targets/${selected.id}`, { ...target, ...(probe || {}), revision: selected.revision });
      setInfo(current => ({ ...current, targets: current.targets.map(t => t.id === saved.target.id ? saved.target : t) }));
      setTask(null); cancelTargetEdit();
    });
  }
  const selected = info?.targets.find(t => t.id === targetId);
  const usesPassword = adding || selected?.auth === 'password';
  const locked = busy || active(task);
  const addressChanged = editingTarget && (target.host !== selected?.host || target.port !== selected?.port);
  const requiresProof = adding || addressChanged;
  return <section className="panel expansion-panel">
    <div className="expansion-heading">
      <div><h2>节点扩容</h2><p>将新机器加入当前集群，自动完成环境检查、安装与入群。</p></div>
      <button className={`button ${opened ? '' : 'primary'}`} aria-expanded={opened} aria-controls="node-expansion-content" onClick={() => { clearPasswords(); setOpened(v => !v); }}>{opened ? '收起' : '＋ 添加节点'}</button>
    </div>
    {opened && <div id="node-expansion-content" className="expansion-content">
      {error && <div className="error" role="alert">{error}</div>}
      {!info && !error && <p className="expansion-muted" role="status">正在加载扩容配置…</p>}
      {settings && editing && <form className="expansion-section" onSubmit={saveSettings}>
        <div className="expansion-section-heading">
          <div><h3>{info?.enabled ? '集群扩容配置' : '初始化集群配置'}</h3><p>识别当前集群信息，核对后保存即可继续。</p></div>
          <button className="button" type="button" disabled={locked} onClick={() => action(async () => setSettings((await post('discover', {})).settings))}>自动识别集群</button>
        </div>
        <div className="expansion-grid">
          {[
            ['kubeconfig', 'Kubeconfig 路径', '/etc/kubernetes/admin.conf'], ['apiServer', 'API Server 地址', 'https://192.168.1.10:6443'],
            ['kubernetesVersion', 'Kubernetes 版本', '例如 1.34.1'], ['containerdPackageVersion', 'containerd 包版本', 'auto'],
          ].map(([key, label, placeholder]) => <label className="expansion-field" key={key}><span>{label}</span><input required disabled={locked} placeholder={placeholder} value={settings[key] || ''} onChange={e => setSettings({ ...settings, [key]: e.target.value })} /></label>)}
        </div>
        <p className="expansion-help">containerd 填写 auto 时，将从新节点的软件源选择可用的 1.x / 2.x 版本。配置会自动保存。</p>
        <div className="expansion-actions"><button className="button primary" disabled={locked} type="submit">保存并继续</button>
          {info?.enabled && <button className="button" type="button" disabled={locked} onClick={() => setEditing(false)}>返回</button>}
        </div>
      </form>}
      {info?.enabled && !editing && <>
        <div className="expansion-cluster-bar">
          <span className="expansion-cluster-version"><span className="expansion-status-dot" /> Kubernetes {info.version}</span>
          <span className="expansion-supported">Ubuntu 22.04 / 24.04 / 26.04 · containerd 1.x / 2.x · cgroup v2</span>
          <button className="text-button" disabled={locked || editingTarget} onClick={() => setEditing(true)}>修改集群配置</button>
        </div>
        <div className="expansion-section">
          <div className="expansion-section-heading"><div><h3><span className="expansion-step">01</span>目标机器</h3><p>{editingTarget ? "修改扩容接入配置，不会更改集群中已有的 Node。" : "填写新节点的连接信息，或选择已登记的机器。"}</p></div>{!adding && selected && <button className="button" disabled={locked} onClick={editingTarget ? cancelTargetEdit : editSelected}>{editingTarget ? "取消修改" : "修改目标机器"}</button>}</div>
          {!!info.targets.length && <label className="expansion-field expansion-target-select"><span>选择机器</span><select value={adding ? '__new' : targetId} disabled={locked || editingTarget} onChange={e => { clearPasswords(); setTask(null); setProbe(null); setTrusted(false); setAdding(e.target.value === '__new'); if (e.target.value !== '__new') setTargetId(e.target.value); }}>
            {info.targets.map(t => <option key={t.id} value={t.id}>{t.nodeName} — {t.host}（{t.user || '配置账号'}）</option>)}
            <option value="__new">＋ 添加新机器</option>
          </select></label>}
          {(adding || editingTarget) && <div className="expansion-grid expansion-machine-grid">
            {[
              ['host', '新节点 IP 地址', '例如 192.168.100.141'], ['port', 'SSH 端口', '22'], ['user', 'SSH 登录用户', '例如 ubuntu'], ['nodeName', '节点名称', '例如 worker-02'],
            ].map(([key, label, placeholder]) => <label className="expansion-field" key={key}><span>{label}</span><input disabled={locked} placeholder={placeholder} type={key === 'port' ? 'number' : 'text'} min={key === 'port' ? 1 : undefined} max={key === 'port' ? 65535 : undefined} value={target[key]} onChange={e => { setTarget({ ...target, [key]: key === 'port' ? Number(e.target.value) : e.target.value }); setProbe(null); setTrusted(false); }} /></label>)}
          </div>}
        </div>
        {(adding || editingTarget) && <div className="expansion-section">
          <div className="expansion-section-heading"><div><h3><span className="expansion-step">02</span>主机身份确认</h3><p>{editingTarget && !addressChanged ? "地址未改变，可保留原有信任记录；也可重新获取指纹。" : "获取 SSH 指纹并核对，确认连接的是目标机器。"}</p></div>
            <button className="button" disabled={locked || !target.host || !target.user || !target.nodeName} onClick={() => action(async () => { setTrusted(false); setProbe(await post('probe', target)); })}>{probe ? '重新获取指纹' : '获取主机指纹'}</button>
          </div>
          {probe ? <div className={`expansion-fingerprint ${trusted ? 'is-trusted' : ''}`}>
            <div className="expansion-fingerprint-heading"><span>SSH · SHA256</span><span>{trusted ? '已确认' : '待核对'}</span></div>
            <code>{probe.hostFingerprint}</code>
            <label className="expansion-check"><input type="checkbox" disabled={locked} checked={trusted} onChange={e => setTrusted(e.target.checked)} /><span>已通过可信渠道核对该机器指纹</span></label>
            <p className="expansion-help">确认有效期为 5 分钟，确认前不会发送登录密码。</p>
          </div> : <p className="expansion-help">填写机器信息后获取指纹，无需提前配置 SSH 密钥。</p>}
        </div>}
        {editingTarget && <div className="expansion-actions">
          <button className="button primary" disabled={locked || (requiresProof && (!probe || !trusted)) || (!!probe && !trusted)} onClick={saveTarget}>{busy ? '正在保存…' : '保存目标配置'}</button>
          <button className="button" disabled={locked} onClick={cancelTargetEdit}>取消</button>
        </div>}
        {!editingTarget && <>
        <div className="expansion-section">
          <div className="expansion-section-heading"><div><h3><span className="expansion-step">{adding ? '03' : '02'}</span>登录与授权</h3><p>密码仅用于本次任务，提交后清空，不保存到配置或日志。</p></div></div>
          <div className="expansion-grid expansion-credentials-grid">
            {usesPassword && <label className="expansion-field" htmlFor="expansion-ssh-password"><span>SSH 登录密码</span><input id="expansion-ssh-password" type="password" autoComplete="off" placeholder="输入新节点的登录密码" value={sshPassword} disabled={locked} onChange={e => setSshPassword(e.target.value)} /></label>}
            {(adding ? target.user : selected?.user) !== 'root' && (!usesPassword || !samePassword) && <label className="expansion-field" htmlFor="expansion-sudo-password"><span>sudo 密码 <small>免密 sudo 可留空</small></span><input id="expansion-sudo-password" type="password" autoComplete="off" placeholder="输入 sudo 密码" value={sudoPassword} disabled={locked} onChange={e => setSudoPassword(e.target.value)} /></label>}
          </div>
          {usesPassword && (adding ? target.user : selected?.user) !== 'root' && <label className="expansion-check expansion-password-option"><input type="checkbox" disabled={locked} checked={samePassword} onChange={e => setSamePassword(e.target.checked)} /><span>sudo 密码与 SSH 登录密码相同</span></label>}
          {!usesPassword && selected?.user === 'root' && <p className="expansion-help">使用已配置的 root SSH 密钥登录，无需输入 sudo 密码。</p>}
        </div>
        <div className="expansion-submit-bar">
          <div><strong>准备好后，一次完成扩容</strong><p>将关闭 swap、调整内核参数并安装组件。现有应用副本数不变。</p></div>
          <button className="button primary" disabled={locked || (adding ? !probe || !trusted : !targetId) || (usesPassword && !sshPassword)} onClick={start}>{busy ? '正在提交…' : active(task) ? '扩容进行中…' : adding ? '添加并开始扩容' : '开始扩容'}</button>
        </div>
        <p className="expansion-help expansion-footer-note">远程访问请使用 HTTPS 或 SSH 本地转发。任务开始后，关闭页面仍会继续执行。</p>
        </>}
        {task && <div className="expansion-section expansion-task">
          <div className="expansion-section-heading"><h3>执行进度 · {task.target.nodeName}</h3><span className="expansion-task-status" data-status={task.status} role="status">{states[task.status] || task.status}</span></div>
          <p className="expansion-task-stage">{task.stage}</p><small className="expansion-task-id">任务 ID：{task.id}</small>
          {task.error && <div className="expansion-log-error" role="alert"><strong>{task.failedStage || '扩容失败'}</strong><p>{task.error}</p></div>}
          <div className="expansion-log-toolbar"><label className="expansion-check"><input type="checkbox" checked={followLogs} onChange={e => setFollowLogs(e.target.checked)} /><span>跟随最新日志</span></label><button className="button" onClick={() => download([`任务：${task.id}`, `节点：${task.target.nodeName}`, `状态：${states[task.status] || task.status}`, task.logsTruncated ? '较早日志已截断，仅包含近期日志' : '', ...task.logs].join('\n'), `expansion-${task.id}.log`)}>下载日志</button></div>
          {task.logsTruncated && <p className="expansion-help">日志较多，已保留最近 400 行 / 64 KiB 内的内容。</p>}
          <pre ref={logRef} aria-live="polite">{task.logs.join('\n')}</pre>
          <p className="expansion-help">日志已脱敏并保存到 master 的扩容任务记录，每 3 秒刷新。安装失败时会自动尝试回传节点诊断日志。</p>
          {task.capacity && <p className="expansion-task-capacity">可分配 CPU：{task.capacity.cpu} · 内存：{task.capacity.memory}</p>}
        </div>}
        {!!info.tasks.length && <details className="expansion-history"><summary>历史任务 <span>{info.tasks.length}</span></summary><div className="expansion-history-list">{info.tasks.map(t => <button className="expansion-history-item" key={t.id} disabled={locked || editingTarget} onClick={() => { clearPasswords(); setTask(t); setTargetId(t.targetId); setAdding(false); }}><span>{t.target.nodeName}<small>{new Date(t.createdAt).toLocaleString()}</small></span><span className="expansion-task-status" data-status={t.status}>{states[t.status]}</span></button>)}</div></details>}
      </>}
    </div>}
  </section>;
}
