import React, { useEffect, useRef, useState } from 'react';
import api from '../lib/api.js';
import download from '../lib/download.js';
import { NODE_XML_MAX_BYTES, parseNodeImportXml } from '../lib/node-import.js';
const active = task => ['checking', 'running'].includes(task?.status);
const states = { checking: '预检中', checked: '预检通过', running: '扩容中', succeeded: '扩容完成', failed: '失败', interrupted: '已中断' };
const wizardSteps = ['目标机器', '登录授权', 'hosts 对比', '镜像仓库', '执行扩容'];
const emptyTarget = { host: '', port: 22, user: '', nodeName: '' };
export default function NodeExpansion({ token, onUpdated, modal, onModalChange, registerNavigationGuard }) {
  const logRef = useRef(null);
  const dialogRef = useRef(null);
  const [step, setStep] = useState(0);
  const [followLogs, setFollowLogs] = useState(true);
  const opened = ['add-node', 'node-history'].includes(modal?.dialog);
  const historyOpen = modal?.dialog === 'node-history';
  const [historyBusy, setHistoryBusy] = useState(false);
  const [history, setHistory] = useState([]);
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
  const [preparedRegistry, setPreparedRegistry] = useState(null);
  const [registryEnabled, setRegistryEnabled] = useState(false);
  const [registryIp, setRegistryIp] = useState('');
  const [registryProtocol, setRegistryProtocol] = useState('https');
  const [registryPort, setRegistryPort] = useState('443');
  const [registryToken, setRegistryToken] = useState('');
  const [sshPassword, setSshPassword] = useState('');
  const [sudoPassword, setSudoPassword] = useState('');
  const [samePassword, setSamePassword] = useState(true);
  const [hostsComparison, setHostsComparison] = useState(null);
  const [hostsDecision, setHostsDecision] = useState('');
  const [selectedHosts, setSelectedHosts] = useState([]);
  const [customHosts, setCustomHosts] = useState([]);
  const [importedHosts, setImportedHosts] = useState(null);
  const [importNotice, setImportNotice] = useState('');
  useEffect(() => { setPreparedRegistry(null); }, [opened, targetId, settings, registryEnabled, registryIp, registryProtocol, registryPort, registryToken]);
  useEffect(() => { setHostsComparison(null); setHostsDecision(''); }, [opened, targetId, target, editingTarget, settings, token]);
  useEffect(() => {
    if (!opened) return;
    dialogRef.current.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [opened]);
  useEffect(() => {
    if (!opened) { setSshPassword(''); setSudoPassword(''); setRegistryToken(''); return; }
    return registerNavigationGuard(() => !busy);
  }, [opened, busy, registerNavigationGuard]);
  const clearPasswords = () => { setSshPassword(''); setSudoPassword(''); setRegistryToken(''); };
  const post = (route, body) => api(`/api/expansion/${route}`, token, undefined, { method: 'POST', body: JSON.stringify(body) });
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    clearPasswords(); setImportedHosts(null); setImportNotice(''); setStep(0); setEditingTarget(false); setInfo(null); setError(''); setTask(null); setProbe(null); setTrusted(false);
    if (historyOpen) return () => controller.abort();
    Promise.all([
      api('/api/expansion/settings', token, controller.signal),
      api('/api/expansion/targets', token, controller.signal),
    ]).then(([config, result]) => {
      setSettings(config.settings); setEditing(!config.initialized);
      setInfo(result); setTask(result.tasks.find(active) || null); if (result.tasks.some(active)) setStep(result.tasks.find(active)?.kind === 'registry' ? 3 : 4); setTargetId(result.targets[0]?.id || ''); setAdding(!result.targets.length);
    }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [opened, historyOpen, token]);
  useEffect(() => {
    if (!opened || !active(task)) return;
    let cancelled = false; const controller = new AbortController();
    const timer = setInterval(async () => {
      try {
        const result = await api(`/api/expansion/tasks/${task.id}`, token, controller.signal);
        if (cancelled) return;
        if (result.kind === 'registry' && result.status === 'succeeded') { setPreparedRegistry(result); setStep(4); }
        setTask(result); setInfo(current => ({ ...current, busy: active(result) })); setError(''); if (!active(result)) onUpdated();
      } catch (e) { if (!cancelled) setError(e.message); }
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); controller.abort(); };
  }, [opened, task?.id, task?.status, token, onUpdated]);
  useEffect(() => {
    if (followLogs && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [task?.id, task?.logs?.length, task?.logs?.at(-1), followLogs, step]);
  async function action(work) {
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function refreshHistory() {
    setHistoryBusy(true);
    try {
      const result = await api('/api/expansion/tasks', token);
      setHistory(result.tasks);
      setInfo(current => ({ ...current, busy: result.tasks.some(active) }));
    }
    catch (e) { setError(e.message); }
    finally { setHistoryBusy(false); }
  }
  useEffect(() => {
    if (!opened || !historyOpen) return;
    refreshHistory();
    const timer = setInterval(refreshHistory, 3000);
    return () => clearInterval(timer);
  }, [opened, historyOpen, token]);
  async function viewTask(id) {
    await action(async () => {
      const result = await api(`/api/expansion/tasks/${id}`, token);
      clearPasswords(); setTask(result); setEditing(false); setStep(4);
    });
  }
  async function saveSettings(e) {
    e.preventDefault();
    await action(async () => {
      const result = await post('settings', settings);
      setSettings(result.settings); setEditing(false);
      const next = await api('/api/expansion/targets', token); setInfo(next); setAdding(!next.targets.length);
    });
  }
  const credentials = () => ({ sshPassword, sudoPassword: usesPassword && samePassword ? sshPassword : sudoPassword });
  async function ensureTarget() {
    if (!adding) return targetId;
    const saved = await post('targets', { ...target, ...probe });
    setTargetId(saved.target.id); setAdding(false); setProbe(null); setTrusted(false);
    setInfo(current => ({ ...current, targets: [...current.targets, saved.target] }));
    return saved.target.id;
  }
  async function importNodeXml(file) {
    if (!file) return;
    await action(async () => {
      if (file.size > NODE_XML_MAX_BYTES) throw new Error('XML 文件不能超过 64 KiB');
      const imported = parseNodeImportXml(await file.text());
      clearPasswords(); setTask(null); setProbe(null); setTrusted(false); setEditingTarget(false);
      setTarget(imported.target); setTargetId(''); setAdding(true);
      setSshPassword(imported.credentials.sshPassword); setSudoPassword(imported.credentials.sudoPassword); setSamePassword(imported.credentials.samePassword);
      setImportedHosts(imported.hosts); setSelectedHosts([]); setCustomHosts([]); setHostsComparison(null); setHostsDecision('');
      setRegistryEnabled(Boolean(imported.registry)); setRegistryIp(imported.registry?.ip || '');
      setRegistryProtocol(imported.registry?.protocol || 'https'); setRegistryPort(String(imported.registry?.port || 443)); setRegistryToken(imported.registry?.token || '');
      setPreparedRegistry(null);
      setImportNotice(`已导入节点 ${imported.target.nodeName} 和 ${imported.hosts.length} 条 hosts 映射，请核对机器信息并确认主机指纹。`);
    });
  }
  async function compareNodeHosts() {
    await action(async () => {
      setHostsComparison(null); setHostsDecision(''); setSelectedHosts([]); setCustomHosts([]);
      const id = await ensureTarget();
      const result = await post('hosts/compare', { targetId: id, ...credentials() });
      setHostsComparison({ ...result, targetId: id });
      if (importedHosts !== null) {
        setCustomHosts(importedHosts.map(entry => ({ ...entry, id: crypto.randomUUID(), selected: true })));
        if (!importedHosts.length) setHostsDecision('keep');
      } else {
        setSelectedHosts(result.masterOnly.filter(line => !result.conflicts.includes(line.split('\t')[1])));
        if (!result.different) setHostsDecision('unchanged');
      }
    });
  }
  async function applyNodeHosts() {
    await action(async () => {
      const result = await post('hosts/apply', { targetId, comparisonId: hostsComparison.comparisonId, selectedEntries: selectedHosts, customEntries: customHosts.filter(entry => entry.selected).map(({ ip, names }) => ({ ip, names })), confirm: true, ...credentials() });
      setHostsComparison(current => ({ ...current, backup: result.backup }));
      setHostsDecision('applied');
    });
  }
  async function nextStep() {
    if (step !== 3 || !registryEnabled || preparedRegistry) { setStep(current => current + 1); return; }
    await action(async () => {
      setTask(await post('registry/prepare', { targetId, ...credentials(), registry: { ip: registryIp, protocol: registryProtocol, port: Number(registryPort), token: registryToken } }));
    });
  }
  async function start() {
    await action(async () => {
      if (!hostsComparison || hostsComparison.targetId !== targetId || !hostsDecision) throw new Error('请先对比 hosts 并确认处理方式');
      if (registryEnabled && !preparedRegistry) throw new Error('请返回镜像仓库步骤拉取证书');
      try {
        setTask(await post('tasks', { targetId, start: true, ...credentials(), ...(registryEnabled ? { registryTaskId: preparedRegistry?.id } : {}) }));
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
  const selected = info?.targets?.find(t => t.id === targetId);
  const usesPassword = adding || selected?.auth === 'password';
  const locked = busy || active(task) || info?.busy;
  const addressChanged = editingTarget && (target.host !== selected?.host || target.port !== selected?.port);
  const requiresProof = adding || addressChanged;
  const registryReady = !registryEnabled || (registryIp && registryToken && Number.isInteger(Number(registryPort)) && Number(registryPort) >= 1 && Number(registryPort) <= 65535);
  const canContinue = !locked && !editing && !editingTarget && info?.enabled && [
    adding ? Boolean(probe && trusted) : Boolean(selected),
    !usesPassword || Boolean(sshPassword),
    Boolean(hostsDecision && hostsComparison?.targetId === targetId),
    registryReady,
  ][step];
  const closeDialog = () => { clearPasswords(); onModalChange(null); };
  return <section className="panel expansion-panel">
    <div className="expansion-heading">
      <div><h2>节点扩容</h2><p>将新机器加入当前集群，自动完成环境检查、安装与入群。</p></div>
      <div className="expansion-actions"><button className="button" onClick={() => { clearPasswords(); onModalChange({ dialog: 'node-history' }); }}>历史任务</button>
      <button className="button primary" aria-haspopup="dialog" onClick={() => { onModalChange({ dialog: 'add-node' }); }}>＋ 添加节点</button></div>
    </div>
    {opened && <dialog ref={dialogRef} className="resource-dialog expansion-dialog cluster-service" aria-labelledby="node-expansion-title" onCancel={e => { e.preventDefault(); if (!busy) closeDialog(); }}>
      <div className="dialog-head"><div><h2 id="node-expansion-title">{historyOpen ? '历史任务' : '添加节点'}</h2><p className="expansion-help">{historyOpen ? '查看历史任务的执行状态和日志。' : '按步骤配置新机器并加入当前集群。'}</p></div><button className="button" disabled={busy} onClick={closeDialog} aria-label={historyOpen ? '关闭历史任务' : '关闭添加节点'}>关闭</button></div>
      <div className={historyOpen ? undefined : "cluster-wizard"}>
        {!historyOpen && <nav className="cluster-wizard-progress" aria-label="添加节点步骤">
          <div className="wizard-progress-summary"><span>节点扩容流程</span><span>第 <strong>{step + 1}</strong> / {wizardSteps.length} 步</span></div>
          <ol style={{ '--wizard-step-count': wizardSteps.length }}>{wizardSteps.map((title, index) => <li key={title} className={index === step ? 'is-current' : ''} aria-current={index === step ? 'step' : undefined}>
            <button className="wizard-step-link" disabled={locked || index > step} onClick={() => setStep(index)}><span className="wizard-step-number">{String(index + 1).padStart(2, '0')}</span><span className="wizard-step-title">{title}</span></button>
          </li>)}</ol>
        </nav>}
        <div id="node-expansion-content" className="cluster-wizard-detail">
          {!historyOpen && <div className="cluster-step-heading"><div><span className="cluster-section-caption">操作台 · 第 {String(step + 1).padStart(2, '0')} 步</span><h3>{wizardSteps[step]}</h3></div></div>}
      {error && <div className="error" role="alert">{error}</div>}
      {!historyOpen && !info && !error && <p className="expansion-muted" role="status">正在加载扩容配置…</p>}
      {!historyOpen && step === 0 && settings && editing && <form className="expansion-section" onSubmit={saveSettings}>
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
      {!historyOpen && info?.enabled && !editing && <>
        {step === 0 && <>
        <div className="expansion-section">
          <div className="expansion-section-heading"><div><h3>从 XML 导入</h3><p>导入单个节点配置后继续确认并执行。hosts 只需填写要新增的 IP 与主机名映射。</p></div></div>
          <div className="expansion-actions">
            <label className="expansion-field"><span>选择 XML 文件（最大 64 KiB）</span><input type="file" accept=".xml,application/xml,text/xml" disabled={locked || editingTarget} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; importNodeXml(file); }} /></label>
            <a className="button" href="/templates/node-expansion.example.xml" download>下载 XML 示例</a>
            <a className="button" href="/templates/node-expansion.xsd" download>下载 XSD</a>
          </div>
          {importNotice && <p className="expansion-help" role="status">{importNotice}</p>}
        </div>
        <div className="expansion-cluster-bar">
          <span className="expansion-cluster-version"><span className="expansion-status-dot" /> Kubernetes {info.version}</span>
          <span className="expansion-supported">Ubuntu 22.04 / 24.04 / 26.04 · containerd 1.x / 2.x · cgroup v2</span>
          <button className="text-button" disabled={locked || editingTarget} onClick={() => setEditing(true)}>修改集群配置</button>
        </div>
        <div className="expansion-section">
          <div className="expansion-section-heading"><div><h3>目标机器</h3><p>{editingTarget ? "修改扩容接入配置，不会更改集群中已有的 Node。" : "填写新节点的连接信息，或选择已登记的机器。"}</p></div>{!adding && selected && <button className="button" disabled={locked} onClick={editingTarget ? cancelTargetEdit : editSelected}>{editingTarget ? "取消修改" : "修改目标机器"}</button>}</div>
          {!!info.targets.length && <label className="expansion-field expansion-target-select"><span>选择机器</span><select value={adding ? '__new' : targetId} disabled={locked || editingTarget} onChange={e => { clearPasswords(); setImportedHosts(null); setImportNotice(''); setTask(null); setProbe(null); setTrusted(false); setAdding(e.target.value === '__new'); if (e.target.value !== '__new') setTargetId(e.target.value); }}>
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
          <div className="expansion-section-heading"><div><h3>主机身份确认</h3><p>{editingTarget && !addressChanged ? "地址未改变，可保留原有信任记录；也可重新获取指纹。" : "获取 SSH 指纹并核对，确认连接的是目标机器。"}</p></div>
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
        </>}
        {!editingTarget && <>
        {step === 1 && <div className="expansion-section">
          <div className="expansion-section-heading"><div><h3>登录与授权</h3><p>密码仅用于本次任务，提交后清空，不保存到配置或日志。</p></div></div>
          <div className="expansion-grid expansion-credentials-grid">
            {usesPassword && <label className="expansion-field" htmlFor="expansion-ssh-password"><span>SSH 登录密码</span><input id="expansion-ssh-password" type="password" autoComplete="off" placeholder="输入新节点的登录密码" value={sshPassword} disabled={locked} onChange={e => setSshPassword(e.target.value)} /></label>}
            {(adding ? target.user : selected?.user) !== 'root' && (!usesPassword || !samePassword) && <label className="expansion-field" htmlFor="expansion-sudo-password"><span>sudo 密码 <small>免密 sudo 可留空</small></span><input id="expansion-sudo-password" type="password" autoComplete="off" placeholder="输入 sudo 密码" value={sudoPassword} disabled={locked} onChange={e => setSudoPassword(e.target.value)} /></label>}
          </div>
          {usesPassword && (adding ? target.user : selected?.user) !== 'root' && <label className="expansion-check expansion-password-option"><input type="checkbox" disabled={locked} checked={samePassword} onChange={e => setSamePassword(e.target.checked)} /><span>sudo 密码与 SSH 登录密码相同</span></label>}
          {!usesPassword && selected?.user === 'root' && <p className="expansion-help">使用已配置的 root SSH 密钥登录，无需输入 sudo 密码。</p>}
        </div>}
        {step === 2 && <div className="expansion-section">
          <div className="expansion-section-heading"><div><h3>{importedHosts !== null ? '导入的 hosts 映射' : '对比 hosts 配置'}</h3><p>{importedHosts !== null ? '仅添加 XML 中定义的映射，不选择 master 的其他条目。读取新节点配置后确认写入；同名非回环映射将替换，其他映射保留。' : '对比 master（运行本服务的主机）与新节点的 /etc/hosts。忽略注释、空白、顺序及回环地址差异。'}</p></div>
            <button className="button" disabled={locked || (adding ? !probe || !trusted : !targetId) || (usesPassword && !sshPassword)} onClick={compareNodeHosts}>{busy ? '正在处理…' : hostsComparison ? '重新读取 hosts' : importedHosts !== null ? '读取 hosts 并预览映射' : '读取并对比 hosts'}</button>
          </div>
          {hostsComparison && <>
            {importedHosts === null && <>
            <p className="expansion-help" role="status">{hostsComparison.different ? '发现解析配置差异，请选择是否修改新节点 hosts。' : '有效解析配置一致，可以开始扩容。'}</p>
            <div className="expansion-grid expansion-hosts-grid"><div><h4>master /etc/hosts</h4><pre>{hostsComparison.master}</pre></div><div><h4>新节点 /etc/hosts</h4><pre>{hostsComparison.node}</pre></div></div>
            </>}
            <div className="expansion-section-heading"><div><h4>差异条目与自定义配置</h4><p>勾选要写入新节点的条目。同名映射会替换，未选中的映射保持原配置。</p></div>
              <button className="button" disabled={locked || hostsDecision === 'applied'} onClick={() => { setCustomHosts(current => [...current, { id: crypto.randomUUID(), ip: '', names: '', selected: true }]); setHostsDecision(''); }}>添加自定义条目</button>
            </div>
            <div className="expansion-hosts-list">
              <table><thead><tr><th>添加</th><th>主机名</th><th>新节点 IP</th><th>待添加 IP</th><th>差异 / 操作</th></tr></thead><tbody>
                {importedHosts === null && hostsComparison.masterOnly.map(line => {
                  const [ip, name] = line.split('\t');
                  const previous = hostsComparison.nodeOnly.filter(item => item.split('\t')[1] === name).map(item => item.split('\t')[0]);
                  const conflict = hostsComparison.conflicts.includes(name);
                  return <tr key={line}><td><input type="checkbox" aria-label={`添加 ${name} ${ip}`} disabled={locked || conflict || hostsDecision === 'applied'} checked={selectedHosts.includes(line)} onChange={e => { setSelectedHosts(current => e.target.checked ? [...current, line] : current.filter(item => item !== line)); setHostsDecision(''); }} /></td><td>{name}</td><td>{previous.join('、') || '—'}</td><td>{ip}</td><td>{conflict ? '回环冲突，无法添加' : previous.length ? '同名 IP 不同，将替换' : '仅 master 存在'}</td></tr>;
                })}
                {importedHosts === null && hostsComparison.nodeOnly.filter(line => !hostsComparison.masterOnly.some(item => item.split('\t')[1] === line.split('\t')[1])).map(line => {
                  const [ip, name] = line.split('\t');
                  return <tr key={`node-${line}`}><td>—</td><td>{name}</td><td>{ip}</td><td>—</td><td>仅新节点存在，保留</td></tr>;
                })}
                {customHosts.map(entry => {
                  const update = patch => { setCustomHosts(current => current.map(item => item.id === entry.id ? { ...item, ...patch } : item)); setHostsDecision(''); };
                  return <tr key={entry.id}><td><input type="checkbox" aria-label="添加此自定义条目" disabled={locked || hostsDecision === 'applied'} checked={entry.selected} onChange={e => update({ selected: e.target.checked })} /></td><td><input aria-label="自定义主机名" placeholder="主机名，多个以空格分隔" disabled={locked || hostsDecision === 'applied'} value={entry.names} onChange={e => update({ names: e.target.value })} /></td><td>自定义</td><td><input aria-label="自定义 IP 地址" placeholder="IPv4 或 IPv6" disabled={locked || hostsDecision === 'applied'} value={entry.ip} onChange={e => update({ ip: e.target.value })} /></td><td><button className="button" disabled={locked || hostsDecision === 'applied'} onClick={() => { setCustomHosts(current => current.filter(item => item.id !== entry.id)); setHostsDecision(''); }}>删除</button></td></tr>;
                })}
                {(importedHosts !== null || !hostsComparison.different) && !customHosts.length && <tr><td colSpan={5}>暂无差异，可添加自定义条目。</td></tr>}
              </tbody></table>
            </div>
            <p className="expansion-help">已选择 {selectedHosts.length + customHosts.filter(entry => entry.selected).length} 个条目。写入前自动备份，对比有效期为 5 分钟。</p>
            {hostsDecision !== 'applied' && <div className="expansion-actions"><button className="button primary" disabled={locked || !(selectedHosts.length + customHosts.filter(entry => entry.selected).length)} onClick={applyNodeHosts}>确认添加所选条目</button><button className="button" disabled={locked} onClick={() => setHostsDecision('keep')}>保持原配置，继续扩容</button></div>}
            {hostsDecision === 'applied' && <p className="expansion-help" role="status">新节点 hosts 已修改。原文件备份：{hostsComparison.backup}</p>}
            {hostsDecision === 'keep' && <p className="expansion-help" role="status">已选择保持原配置。</p>}
          </>}
        </div>}
        {step === 3 && <div className="expansion-section">
          <div className="expansion-section-heading"><div><h3>工作节点镜像仓库</h3><p>点击下一步后，自动在新节点拉取并校验 TLS 证书，显示日志和进度。扩容时再配置 hosts 和 containerd。</p></div></div>
          <label className="expansion-check"><input type="checkbox" disabled={locked} checked={registryEnabled} onChange={e => { setRegistryEnabled(e.target.checked); setRegistryToken(''); }} /><span>使用自建镜像仓库</span></label>
          {registryEnabled && <div className="expansion-grid">
            <label className="expansion-field"><span>仓库 IPv4 地址</span><input disabled={locked} value={registryIp} placeholder="例如 192.168.1.20" onChange={e => setRegistryIp(e.target.value)} /></label>
            <label className="expansion-field"><span>证书接口协议</span><select value={registryProtocol} onChange={e => { const protocol = e.target.value; setRegistryProtocol(protocol); setRegistryPort(current => current === (protocol === 'http' ? '443' : '80') ? (protocol === 'http' ? '80' : '443') : current); }} disabled={locked}><option value="https">HTTPS</option><option value="http">HTTP</option></select></label>
            <label className="expansion-field"><span>证书接口端口</span><input type="number" min="1" max="65535" step="1" disabled={locked} value={registryPort} onChange={e => setRegistryPort(e.target.value)} /></label>
            <label className="expansion-field"><span>证书导出 Token</span><input type="password" autoComplete="off" maxLength={3072} disabled={locked} value={registryToken} onChange={e => setRegistryToken(e.target.value)} /></label>
          </div>}
          {registryEnabled && <p className="expansion-help">将 docker.io、registry-1.docker.io、ghcr.io、registry.k8s.io 指向仓库 IP；从新节点请求 /api/tls/bundle，校验证书后配置 containerd。证书拉取成功后才能开始扩容；拉取失败可修改配置后重试。Token 不会写入日志或保存到配置。</p>}
        </div>}
        {step === 4 && <>
        <div className="expansion-submit-bar">
          <div><strong>准备好后，一次完成扩容</strong><p>将关闭 swap、调整内核参数并安装组件。现有应用副本数不变。</p></div>
          <button className="button primary" disabled={locked || (registryEnabled && !preparedRegistry) || !hostsDecision || hostsComparison?.targetId !== targetId || (usesPassword && !sshPassword)} onClick={start}>{busy ? '正在提交…' : active(task) ? '扩容进行中…' : adding ? '添加并开始扩容' : '开始扩容'}</button>
        </div>
        <p className="expansion-help expansion-footer-note">远程访问请使用 HTTPS 或 SSH 本地转发。任务开始后，关闭页面仍会继续执行。</p>
        </>}
        </>}
      </>}
        {(historyOpen || step === 4 || (step === 3 && task?.kind === 'registry')) && task && <div className="expansion-section expansion-task">
          <div className="expansion-section-heading"><h3>{task.kind === 'registry' ? '证书拉取进度' : '执行进度'} · {task.target.nodeName}</h3><span className="expansion-task-status" data-status={task.status} role="status">{task.kind === 'registry' && task.status === 'running' ? '拉取中' : task.kind === 'registry' && task.status === 'succeeded' ? '证书已就绪' : states[task.status] || task.status}</span></div>
          {task.kind === 'registry' && <div role="status"><progress max="100" value={task.progress || 0} aria-label="证书拉取进度" /> <span>{task.progress || 0}% · {task.status === 'failed' ? '拉取失败，请重试' : '按拉取和校验阶段显示进度'}</span></div>}
          <p className="expansion-task-stage">{task.stage}</p><small className="expansion-task-id">任务 ID：{task.id}</small>
          {task.error && <div className="expansion-log-error" role="alert"><strong>{task.failedStage || '扩容失败'}</strong><p>{task.error}</p></div>}
          <div className="expansion-log-toolbar"><label className="expansion-check"><input type="checkbox" checked={followLogs} onChange={e => setFollowLogs(e.target.checked)} /><span>跟随最新日志</span></label><button className="button" onClick={() => download([`任务：${task.id}`, `节点：${task.target.nodeName}`, `状态：${states[task.status] || task.status}`, task.logsTruncated ? '较早日志已截断，仅包含近期日志' : '', ...task.logs].join('\n'), `expansion-${task.id}.log`)}>下载日志</button></div>
          {task.logsTruncated && <p className="expansion-help">日志较多，已保留最近 400 行 / 64 KiB 内的内容。</p>}
          <pre ref={logRef} aria-live="polite">{task.logs.join('\n')}</pre>
          <p className="expansion-help">日志已脱敏并保存到 master 的扩容任务记录，每 3 秒刷新。安装失败时会自动尝试回传节点诊断日志。</p>
          {task.capacity && <p className="expansion-task-capacity">可分配 CPU：{task.capacity.cpu} · 内存：{task.capacity.memory}</p>}
        </div>}
          {!historyOpen && <div className="cluster-wizard-footer"><button className="button wizard-secondary" disabled={step === 0 || locked} onClick={() => { setEditingTarget(false); setStep(current => current - 1); }}>← 上一步</button><span className="expansion-help">返回上一步可修改配置</span>{step < 4 && <button className="button primary" disabled={!canContinue} onClick={nextStep}>{step === 3 && active(task) && task.kind === 'registry' ? '正在拉取证书…' : step === 3 && task?.kind === 'registry' && task.status === 'failed' ? '重试拉取证书 →' : '下一步 →'}</button>}</div>}
        </div>
      </div>
      {historyOpen && <section className="expansion-history">
          <h3>历史任务 <span>{history.length}</span></h3>
          <div className="expansion-actions"><button className="button" disabled={historyBusy} onClick={refreshHistory}>{historyBusy ? '正在刷新…' : '刷新历史任务'}</button></div>
          {!historyBusy && !history.length && <p className="expansion-help">暂无扩容历史任务。</p>}
          <div className="expansion-history-list">{history.map(t => <button className="expansion-history-item" key={t.id} disabled={busy} aria-pressed={task?.id === t.id} onClick={() => viewTask(t.id)}><span>{t.target.nodeName} · {t.target.host}<small>{new Date(t.createdAt).toLocaleString()} · {t.stage}</small><small>任务 ID：{t.id}</small></span><span className="expansion-task-status" data-status={t.status}>{states[t.status] || t.status}</span></button>)}</div>
        </section>}
    </dialog>}
  </section>;
}
