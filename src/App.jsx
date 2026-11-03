import React, { useState, useCallback, useEffect, useRef } from "react";
import api from "./lib/api.js";
import { labels } from "./lib/resources.js";
import { podStatus } from "./lib/formatters.js";
import useClusterData from "./hooks/useClusterData.js";
import ResourceDialog from "./components/ResourceDialog.jsx";
import OverviewPage from "./pages/OverviewPage.jsx";
import ResourcesPage from "./pages/ResourcesPage.jsx";

import ClusterService from "./components/ClusterService.jsx";
import ManifestApply from './components/ManifestApply.jsx';
import DeploymentPlan from './components/DeploymentPlan.jsx';
import NodeExpansion from "./components/NodeExpansion.jsx";
import SidebarNav from './components/SidebarNav.jsx';
import { deploymentModuleTitles } from './lib/navigation.js';
import { parseRoute, routeHash } from './lib/routes.js';

export default function App() {
  const [{ section, deploymentModule, modal }, setRoute] = useState(() => parseRoute(window.location.hash));
  const [namespace, setNamespace] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [auto, setAuto] = useState(false);
  const [selection, setSelection] = useState(null);
  const [token, setToken] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [settings, setSettings] = useState(false);
  const [mobile, setMobile] = useState(false);
  const navigationGuard = useRef(null);
  const acceptedHash = useRef(window.location.hash);
  const acceptedIndex = useRef(window.history.state?.kubeScopeIndex ?? 0);
  const restoringHistory = useRef(false);
  const [selectionError, setSelectionError] = useState('');
  const [selectionLoading, setSelectionLoading] = useState(false);
  const registerNavigationGuard = useCallback(guard => {
    navigationGuard.current = guard;
    return () => { if (navigationGuard.current === guard) navigationGuard.current = null; };
  }, []);
  const { data, errors, health, loading, updated, setRefresh, checking } = useClusterData({ namespace, token, auto });
  const setupOnly = health?.needsCluster === true;
  const resetNavigation = useCallback(() => {
    setSearch("");
    setStatusFilter("");
    setMobile(false);
    setSettings(false);
  }, []);
  useEffect(() => {
    const syncRoute = () => {
      const route = parseRoute(window.location.hash);
      const canonicalHash = routeHash(route.section, route.deploymentModule, route.modal);
      if (restoringHistory.current) {
        if (canonicalHash !== acceptedHash.current) return;
        restoringHistory.current = false;
      }
      const incomingIndex = window.history.state?.kubeScopeIndex;
      if (canonicalHash !== acceptedHash.current && navigationGuard.current && !navigationGuard.current()) {
        if (Number.isInteger(incomingIndex) && incomingIndex !== acceptedIndex.current) {
          restoringHistory.current = true;
          window.history.go(acceptedIndex.current - incomingIndex);
        } else {
          window.history.replaceState({ ...window.history.state, kubeScopeIndex: acceptedIndex.current }, '', acceptedHash.current);
        }
        return;
      }
      const previous = parseRoute(acceptedHash.current);
      acceptedHash.current = canonicalHash;
      acceptedIndex.current = Number.isInteger(incomingIndex) ? incomingIndex : acceptedIndex.current + 1;
      window.history.replaceState({ ...window.history.state, kubeScopeIndex: acceptedIndex.current }, '', canonicalHash);
      setRoute(route);
      if (previous.section !== route.section || previous.deploymentModule !== route.deploymentModule) resetNavigation();
    };
    syncRoute();
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('hashchange', syncRoute);
    return () => {
      window.removeEventListener('popstate', syncRoute);
      window.removeEventListener('hashchange', syncRoute);
    };
  }, [resetNavigation]);
  function commitRoute(hash) {
    if (hash === acceptedHash.current) return true;
    if (navigationGuard.current && !navigationGuard.current()) return false;
    acceptedIndex.current += 1;
    window.history.pushState({ kubeScopeIndex: acceptedIndex.current }, '', hash);
    acceptedHash.current = hash;
    setRoute(parseRoute(hash));
    return true;
  }
  function navigate(next, module = '') {
    if (commitRoute(routeHash(next, module))) resetNavigation();
  }
  function changeModal(next) { return commitRoute(routeHash(section, deploymentModule, next)); }
  function open(kind, item, initialTab = 'detail') {
    if (changeModal({ dialog: 'resource', kind, name: item.metadata.name, ...(item.metadata.namespace ? { namespace: item.metadata.namespace } : {}), tab: initialTab })) {
      setSelection({ kind, item }); setSelectionError('');
    }
  }
  const resourceKind = modal?.dialog === 'resource' ? modal.kind : '';
  const resourceName = resourceKind ? modal.name : '';
  const resourceNamespace = resourceKind ? modal.namespace || '' : '';
  useEffect(() => {
    setSelectionError('');
    if (!resourceKind || !token || checking || setupOnly) { setSelection(null); setSelectionLoading(false); return; }
    const controller = new AbortController();
    setSelectionLoading(true);
    const query = resourceNamespace ? `?namespace=${encodeURIComponent(resourceNamespace)}` : '';
    api(`/api/resources/${resourceKind}/${encodeURIComponent(resourceName)}${query}`, token, controller.signal)
      .then(item => { if (!controller.signal.aborted) setSelection({ kind: resourceKind, item }); })
      .catch(error => { if (!controller.signal.aborted) { setSelection(null); setSelectionError(error.message); } })
      .finally(() => { if (!controller.signal.aborted) setSelectionLoading(false); });
    return () => controller.abort();
  }, [resourceKind, resourceName, resourceNamespace, token, checking, setupOnly]);
  const selectedResourceMatches = selection?.kind === resourceKind && selection.item.metadata.name === resourceName && (selection.item.metadata.namespace || '') === resourceNamespace;
  const pods = data.pods || [];
  const statuses =
    section === "customresourcedefinitions"
      ? ["Established", "NotEstablished", "NameConflict", "Terminating", "Unknown"]
      : section === "nodes"
      ? ["Ready", "NotReady"]
      : section === "pods"
        ? [...new Set(pods.map(podStatus))].sort()
        : section === "namespaces"
          ? ["Active", "Terminating"]
          : section === "deployments"
            ? ["Available", "Unavailable"]
            : section === "events"
              ? ["Normal", "Warning"]
              : ["persistentvolumeclaims", "persistentvolumes"].includes(section)
                ? [...new Set((data[section] || []).map((item) => item.status?.phase || "Unknown"))].sort()
                : [];
  if (!token || checking || (health?.error && !health?.needsCluster)) {
    return <main className="token-entry">
      <section className="panel token-entry-card" aria-labelledby="token-entry-title">
        <div className="eyebrow">KUBESCOPE</div>
        <h1 id="token-entry-title">{checking ? '正在检测集群' : '配置访问 Token'}</h1>
        <p>{checking ? '正在验证 Token 并检查 K8s 集群连接，请稍候…' : '请输入 Web 服务配置的访问 Token，连接后查看集群状态或安装集群。'}</p>
        {checking ? <div className="token-checking" role="status"><span className="spin">↻</span> 正在连接…</div> : <form onSubmit={e => {
          e.preventDefault();
          const nextToken = tokenDraft.trim();
          if (!nextToken) return;
          setToken(nextToken);
          setRefresh(n => n + 1);
        }}>
          <label htmlFor="entry-token">访问 Token</label>
          <input id="entry-token" type="password" required autoFocus autoComplete="off" placeholder="请输入 K8S_WEB_TOKEN" value={tokenDraft} onChange={e => setTokenDraft(e.target.value)} />
          {health?.error && <p className="error" role="alert">{health.status === 401 || health.status === 403 ? 'Token 验证失败，请检查后重新输入。' : `连接检查失败：${health.error}`}</p>}
          <button className="button primary" disabled={!tokenDraft.trim() || loading}>{loading ? '正在检测…' : '连接并检测集群'}</button>
        </form>}
      </section>
    </main>;
  }
  return (
    <div className={`app ${setupOnly ? "cluster-setup-app" : ""}`}>
      {!setupOnly && <aside className={`sidebar ${mobile ? "is-open" : ""}`}>
        <a
          href="#/overview"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
        >
          <span className="brand-icon">⎈</span>
          <span>
            KubeScope<small>KUBERNETES CONSOLE</small>
          </span>
        </a>
        <div className="workspace">
          <span className="cluster-icon">▧</span>
          <div>
            集群工作空间
            <small>{health?.context || "当前集群 context"}</small>
          </div>
          <span
            className={`connection-dot ${health?.connected ? "online" : ""}`}
          />
        </div>
        <div className="nav-label">工作空间</div>
        <SidebarNav section={section} deploymentModule={deploymentModule} data={data} onNavigate={navigate} />
        <div className="sidebar-bottom">
          <div className="readonly">
            <span>◉</span> 集群运维控制台
            <small>通过 Kubernetes API 安全访问集群</small>
          </div>
          <button
            className="settings"
            onClick={() => {
              setSettings(!settings);
              setMobile(false);
            }}
          >
            ⚙ <span>连接设置</span>
            <span>↗</span>
          </button>
          <div className="version">
            KubeScope <span>v1.0.0</span>
          </div>
        </div>
      </aside>}
      {!setupOnly && mobile && (
        <button
          className="backdrop"
          aria-label="关闭导航"
          onClick={() => setMobile(false)}
        />
      )}
      <main>
        {!setupOnly && <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu icon-button"
              aria-label="展开导航"
              onClick={() => setMobile(!mobile)}
            >
              ☰
            </button>
            <span>工作空间</span>
            <b>/</b>
            <strong>{labels[section]}{section === 'deployments' && deploymentModule ? ` / ${deploymentModuleTitles[deploymentModule]}` : ''}</strong>
          </div>
          <div className="header-right">
            <ManifestApply token={token} onUpdated={() => setRefresh(n => n + 1)} />
            <DeploymentPlan token={token} onUpdated={() => setRefresh(n => n + 1)} />
            <span
              className={`connection ${health?.connected ? "connected" : ""}`}
            >
              <i />
              {loading
                ? "正在连接"
                : health?.connected
                  ? "集群已连接"
                  : "连接异常"}
            </span>
            <span className="avatar">K</span>
          </div>
        </header>}
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">{setupOnly ? 'KUBESCOPE / 集群部署' : 'CLUSTER WORKSPACE'}</div>
              <h1>{setupOnly ? '创建 Kubernetes 集群' : section === 'deployments' && deploymentModule ? deploymentModuleTitles[deploymentModule] : labels[section]}</h1>
              <p>
                {setupOnly ? "尚未连接集群。完成下方部署，或检测已有集群连接。" : section === "overview"
                  ? "掌握集群运行状态，让每一次运维都有据可循。"
                  : section === 'deployments' && deploymentModule
                    ? '先选择目标 Deployment，再编辑并单独保存此配置模块。'
                    : `查看和检索${labels[section]}，点击资源名称查看完整配置。`}
              </p>
            </div>
            <button
              className="button refresh"
              disabled={loading}
              onClick={() => setRefresh((n) => n + 1)}
            >
              <span className={loading ? "spin" : ""}>↻</span>
              {loading ? "检测中…" : setupOnly ? "检测连接" : "刷新数据"}
            </button>
          </div>
          {settings && (
            <section className="panel settings-panel">
              <h2>连接设置</h2>
              <p>
                后端使用运行用户的 kubeconfig 和当前
                context。若服务配置了访问令牌，请在此输入；令牌仅保存在本页面内存中。
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setToken(tokenDraft);
                  setSettings(false);
                }}
              >
                <input
                  type="password"
                  aria-label="访问令牌"
                  placeholder="K8S_WEB_TOKEN"
                  value={tokenDraft}
                  onChange={(e) => setTokenDraft(e.target.value)}
                  autoComplete="off"
                />
                <button className="button primary" type="submit">
                  应用令牌
                </button>
                <button
                  className="button"
                  type="button"
                  onClick={() => setSettings(false)}
                >
                  关闭
                </button>
              </form>
            </section>
          )}
          {setupOnly && <ClusterService modal={modal} onModalChange={changeModal} setupOnly={setupOnly} health={health} token={token} onRefresh={() => setRefresh(n => n + 1)} onSettings={() => setSettings(true)} />}
          {!loading && health?.error && !health?.needsCluster && (
            <div className="error" role="alert">
              <strong>集群连接检查失败</strong>
              <span>{health.error}</span>
              <button className="text-button" onClick={() => setSettings(true)}>
                连接设置 ↗
              </button>
            </div>
          )}
          {!setupOnly && <>
          {section !== "overview" && <div className="scope-bar">
            {section !== "nodes" && <div className="scope-select">
              <span>▦</span>
              <label htmlFor="namespace">命名空间</label>
              <select
                id="namespace"
                value={namespace}
                onChange={(e) => {
                  setNamespace(e.target.value);
                  setStatusFilter("");
                }}
              >
                <option value="">所有命名空间</option>
                {namespace &&
                  !data.namespaces?.some(
                    (n) => n.metadata.name === namespace,
                  ) && <option value={namespace}>{namespace}</option>}
                {(data.namespaces || []).map((n) => (
                  <option key={n.metadata.name}>{n.metadata.name}</option>
                ))}
              </select>
            </div>}
            <div className="update-meta">
              <label className="check">
                <input
                  type="checkbox"
                  checked={auto}
                  onChange={(e) => setAuto(e.target.checked)}
                />
                自动刷新 <span>15s</span>
              </label>
              <span className="updated">
                {updated
                  ? `更新于 ${updated.toLocaleTimeString("zh-CN", { hour12: false })}`
                  : "等待数据"}
              </span>
            </div>
          </div>}
          {section === "nodes" && <NodeExpansion modal={modal} onModalChange={changeModal} registerNavigationGuard={registerNavigationGuard} token={token} onUpdated={() => setRefresh(n => n + 1)} />}
          {section === "overview" ? (
            <OverviewPage data={data} errors={errors} loading={loading} namespace={namespace} navigate={navigate} open={open} />
          ) : (
            <ResourcesPage token={token} section={section} deploymentModule={deploymentModule} data={data} errors={errors} loading={loading} namespace={namespace} search={search} setSearch={setSearch} statuses={statuses} statusFilter={statusFilter} setStatusFilter={setStatusFilter} setRefresh={setRefresh} open={open} />
          )}
          <footer className="page-footer">
            <span>
              <i className="dot teal-bg" />
              基于 Kubernetes API · 实时集群数据
            </span>
            <span>KubeScope / Kubernetes 运维工作空间</span>
          </footer>
          </>}
        </div>
      </main>
      {!setupOnly && resourceKind && !selectedResourceMatches && (
        <ResourceLoadingDialog error={selectionError} loading={selectionLoading} close={() => changeModal(null)} />
      )}
      {!setupOnly && selectedResourceMatches && (
        <ResourceDialog
          key={`${selection.kind}/${selection.item.metadata.uid || selection.item.metadata.name}`}
          selection={{ ...selection, initialTab: modal.tab }}
          onTabChange={tab => changeModal({ ...modal, tab })}
          registerNavigationGuard={registerNavigationGuard}
          onUpdated={() => setRefresh(n => n + 1)}
          close={() => changeModal(null)}
          token={token}
        />
      )}
    </div>
  );
}

function ResourceLoadingDialog({ error, loading, close }) {
  const dialog = useRef(null);
  useEffect(() => { dialog.current.showModal(); }, []);
  return <dialog ref={dialog} className="resource-dialog" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="dialog-head"><h2>资源详情</h2><button className="button" onClick={close}>关闭</button></div>
    <div className="node-labels">{error ? <p className="error" role="alert">无法打开资源：{error}</p> : <p role="status">{loading ? '正在读取资源…' : '等待连接集群…'}</p>}</div>
  </dialog>;
}
