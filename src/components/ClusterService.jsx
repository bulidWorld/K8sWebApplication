import RegistriesPage from '../pages/RegistriesPage.jsx';
import React, { useEffect, useRef, useState } from 'react';
import api from '../lib/api.js';

const stepCopy = {
  runtime: { label: '容器运行时', title: '安装容器运行时', description: '先检查 containerd，已有可用运行时直接复用；未安装时自动准备环境并安装。', action: '检查并安装 containerd' },
  registry: { label: '镜像仓库', title: '配置镜像仓库', description: '连接自建镜像仓库，或跳过此步使用默认镜像源。' },
  packages: { label: '集群工具', title: '安装集群工具', action: '安装集群工具' },
  images: { label: '解析镜像', title: '解析所需镜像', description: '生成 Kubernetes 与 Flannel 镜像清单，解析完成后确认并进入拉取步骤。', action: '解析镜像清单' },
  'pull-images': { label: '拉取镜像', title: '拉取集群镜像', description: '一键拉取全部镜像，或逐个拉取。已有完整镜像会自动复用，失败项可单独重试。', action: '一键拉取全部镜像' },
  init: { label: '控制平面', title: '初始化控制平面', action: '初始化控制平面' },
  network: { label: '集群网络', title: '配置集群网络', action: '安装 Flannel' },
  verify: { label: '验证集群', title: '验证集群状态', action: '验证集群' },
};

export default function ClusterService({ health, token, onRefresh, onSettings, setupOnly = false, modal, onModalChange }) {
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const previous = useRef(null);
  const [install, setInstall] = useState(setupOnly);
  const [viewedStep, setViewedStep] = useState(null);
  const [registrySkipped, setRegistrySkipped] = useState(false);
  const [registryConfigured, setRegistryConfigured] = useState(false);
  const [version, setVersion] = useState('');
  const [address, setAddress] = useState('');
  const addressEdited = useRef(false);
  const [detectedAddress, setDetectedAddress] = useState('');
  const [steps, setSteps] = useState([]);
  const [task, setTask] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const registryDialogOpen = modal?.dialog === 'registry-progress';
  const setRegistryDialogOpen = opened => onModalChange(opened ? { dialog: 'registry-progress' } : null);
  const registryDialog = useRef(null);
  useEffect(() => {
    if (registryDialogOpen && !registryDialog.current.open) registryDialog.current.showModal();
  }, [registryDialogOpen]);
  useEffect(() => {
    if (!token || submitting) return;
    let cancelled = false;
    let timer;
    async function poll() {
      try {
        const result = await api('/api/cluster/service', token);
        if (cancelled) return;
        setTask(result.task);
        setRegistryConfigured(!!result.task?.registryConfigured || (result.task?.action === 'registry' && result.task.registryMode !== 'hosts' && result.task.status === 'succeeded'));
        if (result.task?.status === 'succeeded' && previous.current === 'running') setViewedStep(null);
        setSteps(result.steps || []);
        setDetectedAddress(result.localAddress || '');
        if (!addressEdited.current && !result.task?.deployment?.address) setAddress(current => current || result.localAddress || '');
        if (result.task?.deployment) {
          setInstall(true);
          if (result.task.deployment.version) setVersion(result.task.deployment.version);
          if (result.task.deployment.address) setAddress(result.task.deployment.address);
        }
        if (result.task?.version) setVersion(current => current || result.task.version);
        if (result.task?.status === 'succeeded' && previous.current === 'running' && (result.task.action !== 'step' || result.task.step === 'verify')) refresh.current();
        previous.current = result.task?.status;
        if (result.task?.status === 'running') timer = setTimeout(poll, 2000);
      } catch (e) { if (!cancelled) setError(e.message); }
    }
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [token, submitting]);
  async function submit(action, image, selectedImage, registryOptions) {
    if (action === 'registry') {
      if (!install) setRegistryDialogOpen(true);
    }
    if (action === 'registry' && registryOptions?.mode !== 'hosts') { setRegistryConfigured(false); setRegistrySkipped(false); }
    setSubmitting(true); setError('');
    try {
      const result = await api('/api/cluster/service', token, undefined, { method: 'POST', body: JSON.stringify({ action, ...(['images', 'pull', 'pull-all'].includes(action) ? { version, image } : {}), ...(action === 'step' ? { step: image, ...(selectedImage ? { image: selectedImage } : {}), ...(image === 'packages' ? { version } : {}), ...(image === 'init' ? { address } : {}) } : {}), ...((action === 'registry') ? registryOptions || {} : {}) }) });
      setTask(result.task);
      previous.current = result.task?.status;
      return result;
    } catch (e) { setError(e.message); if (registryOptions) throw e; }
    finally { setSubmitting(false); }
  }
  const busy = submitting || task?.status === 'running';
  const registryTask = task?.action === 'registry' ? task : null;
  const registryStatus = submitting ? '正在提交配置…' : error ? '配置状态异常' : ({ running: '正在配置镜像仓库…', succeeded: '镜像仓库配置完成', failed: '镜像仓库配置失败', interrupted: '镜像仓库配置已中断' }[registryTask?.status] || '等待任务状态…');
  const deployment = task?.deployment;
  const shownSteps = deployment?.steps || steps.map(step => ({ ...step, status: 'pending' }));
  const canExecuteStep = id => {
    const index = shownSteps.findIndex(step => step.id === id);
    return index >= 0 && shownSteps.slice(0, index).every(step => step.status === 'succeeded');
  };
  const registryDone = registryConfigured || (registryTask?.status === 'succeeded' && registryTask.registryMode !== 'hosts') || registrySkipped;
  const wizardSteps = shownSteps.flatMap(step => step.id === 'runtime' ? [step, {
    id: 'registry', title: '配置镜像仓库', description: '配置自建仓库的域名解析和 TLS 证书，也可跳过并使用默认镜像源。',
    status: registryDone ? 'succeeded' : registryTask?.registryMode === 'hosts' && registryTask.status === 'succeeded' ? 'pending' : registryTask?.status || 'pending',
  }] : [step]);
  const currentIndex = Math.max(0, wizardSteps.findIndex(step => step.status !== 'succeeded'));
  const allDone = wizardSteps.length > 0 && wizardSteps.every(step => step.status === 'succeeded');
  const activeIndex = viewedStep === null ? (allDone ? wizardSteps.length - 1 : currentIndex) : Math.min(viewedStep, Math.max(0, wizardSteps.length - 1));
  const activeStep = wizardSteps[activeIndex];
  const activeCopy = stepCopy[activeStep?.id];
  const completedCount = wizardSteps.filter(step => step.status === 'succeeded').length;
  const advance = () => setViewedStep(Math.min(activeIndex + 1, wizardSteps.length - 1));
  const statusLabel = { pending: '待执行', running: '执行中', succeeded: '已完成', failed: '失败，可重试', interrupted: '已中断，可重试' };
  const imageList = (allowPull, inWizard = true) => <div className="wizard-image-list">
    <div className="wizard-image-summary" aria-live="polite"><strong>{task?.images?.length || 0} 个镜像</strong><span>就绪 {task?.images?.filter(item => item.status === 'succeeded').length || 0} / {task?.images?.length || 0}</span>{task?.version && <span>Kubernetes {task.version}</span>}</div>
    {task?.images?.length > 0 ? <div className="table-scroll"><table><thead><tr><th>镜像</th><th>来源</th><th>状态</th>{allowPull && <th>操作</th>}</tr></thead><tbody>
      {task.images.map(item => <tr key={item.image}><td><code>{item.image}</code>{item.error && <p className="image-error">{item.error}</p>}</td><td>{item.source}</td><td><span className={`image-status image-status-${item.status}`}>{{ untested: '待拉取', pending: '待拉取', running: '拉取中', succeeded: '已就绪', failed: '拉取失败', interrupted: '已中断' }[item.status] || '待拉取'}</span></td>{allowPull && <td><button type="button" className="button wizard-secondary" aria-label={`${['failed', 'interrupted'].includes(item.status) ? '重试' : '拉取'} ${item.image}`} disabled={busy || task.version !== version || (inWizard && !canExecuteStep('pull-images'))} onClick={() => inWizard ? submit('step', 'pull-images', item.image) : submit('pull', item.image)}>{item.status === 'running' ? '拉取中…' : ['failed', 'interrupted'].includes(item.status) ? '重试' : item.status === 'succeeded' ? '重新检查' : '拉取'}</button></td>}</tr>)}
    </tbody></table></div> : <p className="wizard-image-empty">{busy ? '正在解析镜像清单…' : '尚无镜像清单，请先解析所需镜像。'}</p>}
  </div>;
  return <section className={`panel settings-panel cluster-service ${setupOnly ? 'cluster-service-setup' : ''}`}>
    <div className="cluster-service-intro">
      <div><h2>{setupOnly ? '部署向导' : 'K8s 集群服务'}</h2><p>{setupOnly ? '在当前服务器部署单控制平面集群，按步骤完成配置。' : '管理当前服务器的集群服务与镜像配置。'}</p></div>
      <span className={`cluster-state ${health?.needsCluster && !allDone ? 'cluster-state-pending' : ''}`}><i />{allDone ? '部署完成' : busy ? '执行中' : health?.needsCluster ? '待部署' : '集群服务'}</span>
    </div>
    {!token ? <button className="button" onClick={onSettings}>配置访问令牌</button> : <>
      {!setupOnly && <div className="cluster-actions">
        {!setupOnly && <button className="button" disabled={busy} onClick={() => submit('start')}>启动 K8s 集群</button>}
        {!install && <button className="button primary" disabled={busy} onClick={() => setInstall(true)}>部署集群</button>}
        {!setupOnly && <button className="button" onClick={onRefresh}>重新检测连接</button>}
      </div>}
      {install && <div className="cluster-wizard">
        <nav className="cluster-wizard-progress" aria-label="集群安装步骤">
          <div className="wizard-progress-summary"><span>安装流程</span><span>已完成 <strong>{completedCount}</strong> / {wizardSteps.length} 步</span></div>
          <ol style={{ '--wizard-step-count': wizardSteps.length || 8 }}>{wizardSteps.map((step, index) => <li key={step.id} className={`${index === activeIndex ? 'is-current' : ''} ${step.status === 'succeeded' ? 'is-complete' : ''}`} aria-current={index === activeIndex ? 'step' : undefined}>
            <button type="button" className="wizard-step-link" disabled={busy} onClick={() => setViewedStep(index)} aria-current={index === activeIndex ? 'step' : undefined}><span className="wizard-step-number" aria-hidden="true">{step.status === 'succeeded' ? '✓' : String(index + 1).padStart(2, '0')}</span><span className="wizard-step-title">{stepCopy[step.id]?.label || step.title}<span className="sr-only">，{statusLabel[step.status]}</span></span></button>
          </li>)}</ol>
        </nav>
        <div className="cluster-wizard-detail">
          <div className="cluster-step-heading"><div><span className="cluster-section-caption">第 {String(activeIndex + 1).padStart(2, '0')} 步</span><h3>{activeCopy?.title || activeStep?.title || '正在加载步骤…'}</h3></div><span className={`wizard-status wizard-status-${activeStep?.status || 'pending'}`} role="status">{allDone ? '部署完成' : statusLabel[activeStep?.status]}</span></div>
          <p className="wizard-step-description">{activeCopy?.description || activeStep?.description}</p>
      {activeStep?.id === 'registry' && <div className="cluster-section cluster-registry-section">
        <RegistriesPage token={token} embedded externalBusy={busy} onConfigure={options => submit('registry', undefined, undefined, options)} />
        <div className="cluster-form-actions"><button type="button" className="button wizard-secondary" disabled={busy} onClick={() => { setRegistrySkipped(true); setViewedStep(null); }}>使用默认镜像源</button>{registryTask && <button type="button" className="button wizard-secondary" onClick={() => setRegistryDialogOpen(true)}>查看日志</button>}</div>
      </div>}

          {activeStep && activeStep.id !== 'registry' && <form onSubmit={e => { e.preventDefault(); if (!busy && canExecuteStep(activeStep.id)) submit('step', activeStep.id); }}>
            {activeStep.id === 'runtime' && <div className="wizard-setup-grid">
              <div className="wizard-config"><h4>检查并安装 containerd</h4><p>自动检查已安装的运行时。已有可用组件将直接复用，无需选择 Kubernetes 版本或填写 IP。</p><p>版本在「集群工具」步骤选择，IP 在「控制平面」步骤确认。</p>
              </div>
              <aside className="wizard-requirements" aria-label="部署要求"><h4>环境要求</h4>
                <div className="wizard-resource-minimums"><span><strong>2</strong> CPU</span><span><strong>2 GiB</strong> 内存</span><span><strong>10 GiB</strong> 可用空间</span></div>
                <dl><div><dt>Pod 网段</dt><dd>10.244.0.0/16</dd></div><div><dt>Service 网段</dt><dd>10.96.0.0/12</dd></div></dl>
                <p>以上为最低资源要求，网段需与宿主网络无冲突。远程集群请在对应控制平面主机操作。</p>
              </aside>
            </div>}
            {activeStep.id === 'packages' && <div className="cluster-fields"><label>Kubernetes 版本<input required value={version} onChange={e => setVersion(e.target.value)} placeholder="例如 1.34.1" pattern="1\.(31|32|33|34|35)\.[0-9]{1,3}" disabled={busy || !!deployment?.version} /><small>{deployment?.version ? '版本已锁定，重复执行将检查并补齐组件' : '用于安装 kubeadm、kubelet 和 kubectl，开始后锁定'}</small></label></div>}
            {activeStep.id === 'init' && <div className="cluster-fields"><label>控制平面 IPv4<input required value={address} onChange={e => { addressEdited.current = true; setAddress(e.target.value); }} placeholder="自动检测，或手动输入" disabled={busy || !!deployment?.address} /><small>{deployment?.address ? '初始化已开始，地址已锁定' : detectedAddress ? address === detectedAddress ? '已自动检测本机地址，可按需修改' : `本机检测地址：${detectedAddress}` : '未检测到可用地址，请手动输入本机 IPv4'}</small></label></div>}
            {['images', 'pull-images'].includes(activeStep.id) && imageList(activeStep.id === 'pull-images')}
            {activeStep.error && <p className="error" role="alert">{activeStep.error}</p>}
            {activeStep.status === 'running' && <p role="status">{activeStep.id === 'pull-images' ? '正在拉取镜像，请在列表中查看各项进度…' : '正在执行，完成后自动进入下一步…'}</p>}
            {activeStep.logs?.length > 0 && <pre className="cluster-logs" aria-label="本步骤执行日志">{activeStep.logs.join('')}</pre>}
            <div className="cluster-form-actions"><button className="button primary" disabled={busy || !canExecuteStep(activeStep.id) || (activeStep.id === 'packages' && !version) || (activeStep.id === 'init' && !address) || (activeStep.id === 'pull-images' && !task?.images?.length)}>{busy ? '正在执行…' : activeStep.id === 'pull-images' ? '一键拉取全部镜像' : activeStep.id === 'images' ? activeStep.status === 'succeeded' ? '重新解析镜像' : '解析镜像清单' : activeStep.status === 'succeeded' ? '重新检查并执行' : ['failed', 'interrupted'].includes(activeStep.status) ? '重试此步骤' : activeCopy?.action || activeStep.title}<span aria-hidden="true"> →</span></button><span className="wizard-action-hint">{!canExecuteStep(activeStep.id) ? '请先完成前置步骤' : activeStep.id === 'images' ? '只生成清单，不会开始拉取' : activeStep.id === 'pull-images' ? '全部镜像就绪后，可继续初始化控制平面' : '先检查已有组件，再执行必要操作'}</span></div>
          </form>}
          {activeStep?.id === 'registry' && registryTask && <><p role="status">{registryStatus}</p>{registryTask.error && <p className="error" role="alert">{registryTask.error}</p>}<pre className="cluster-logs" aria-label="仓库配置日志">{registryTask.logs?.join('') || '等待执行日志…'}</pre></>}
          {error && <p className="error" role="alert">{error}</p>}
          {allDone && <p className="wizard-success" role="status">所有步骤已完成，集群部署成功。</p>}
          <div className="cluster-wizard-footer"><span className="wizard-footer-note">{allDone ? '集群已就绪' : '每步执行成功后，自动展示下一步'}</span><div className="wizard-navigation">{activeIndex > 0 && <button type="button" className="button wizard-secondary" disabled={busy} onClick={() => setViewedStep(activeIndex - 1)}>← 上一步</button>}
            {activeStep?.status === 'succeeded' && activeIndex < wizardSteps.length - 1 && <button type="button" className="button primary" disabled={busy} onClick={advance}>下一步 →</button>}
          </div></div>
        </div>
      </div>}
    </>}
    {token && !install && !setupOnly && <div className="cluster-section cluster-images">
      <h3>集群部署所需镜像</h3>
      <p>解析指定版本的 kubeadm 镜像清单和 Flannel v0.26.7 配置（含初始化容器），合并去重。需要本机已安装 kubeadm；Pull 需要 containerd 已启动，使用当前节点的仓库和证书配置，镜像保存在 k8s.io 命名空间。请先完成自建仓库配置再测试。</p>
      <div className="cluster-image-controls"><label>完整 Kubernetes 版本<input value={version} onChange={e => setVersion(e.target.value)} placeholder="例如 1.34.1" disabled={busy || !!deployment} /></label>
      <button type="button" className="button" disabled={busy || !version} onClick={() => submit('images')}>解析所需镜像</button></div>
      {task?.images?.length > 0 && <>{imageList(true, false)}<div className="cluster-form-actions"><button type="button" className="button primary" disabled={busy || task.version !== version} onClick={() => submit('pull-all')}>一键拉取全部镜像</button></div></>}

    </div>}
    {!install && error && <p className="error" role="alert">{error}</p>}
    {!install && task && <div className="cluster-section cluster-task" aria-live="polite"><h3>任务执行结果</h3><p>{task.action === 'step' ? `分步部署：${shownSteps.find(step => step.id === task.step)?.title || ''}` : task.action === 'images' ? '镜像解析' : ['pull', 'pull-all'].includes(task.action) ? '镜像拉取' : task.action === 'registry' ? '镜像仓库配置' : task.action === 'install' ? '安装' : '启动'}任务：{{ running: '执行中', succeeded: '已完成', failed: '失败', interrupted: '已中断' }[task.status]}{task.error ? `：${task.error}` : ''}</p><pre className="cluster-logs">{task.logs?.join('') || '等待执行日志…'}</pre></div>}
    {registryDialogOpen && <dialog ref={registryDialog} className="resource-dialog registry-progress-dialog" aria-labelledby="registry-progress-title" onCancel={event => { event.preventDefault(); setRegistryDialogOpen(false); }}>
      <div className="dialog-head">
        <h2 id="registry-progress-title">配置自建镜像仓库</h2>
        <button type="button" className="button" onClick={() => setRegistryDialogOpen(false)}>关闭</button>
      </div>
      <div className="registry-progress-body">
        <p role="status" aria-live="polite">{registryStatus}</p>
        {(submitting || registryTask?.status === 'running') && <progress aria-label="镜像仓库配置正在执行" />}
        <p>执行阶段与详细进度见下方日志。关闭弹窗后任务仍会继续执行。</p>
        {(error || registryTask?.error) && <p className="error" role="alert">{error || registryTask.error}</p>}
        <h3>执行日志</h3>
        <pre className="cluster-logs" tabIndex={0} aria-label="镜像仓库配置日志">{registryTask?.logs?.join('') || (submitting ? '正在提交请求，请稍候…' : error ? '请求未完成，请查看上方错误信息。' : '等待执行日志…')}</pre>
      </div>
    </dialog>}
  </section>;
}
