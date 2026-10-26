import React, { useState, useCallback } from "react";
import { sections, labels } from "./lib/resources.js";
import { podStatus } from "./lib/formatters.js";
import useClusterData from "./hooks/useClusterData.js";
import ResourceDialog from "./components/ResourceDialog.jsx";
import OverviewPage from "./pages/OverviewPage.jsx";
import ResourcesPage from "./pages/ResourcesPage.jsx";

import NodeExpansion from "./components/NodeExpansion.jsx";
import SidebarNav from './components/SidebarNav.jsx';
import { deploymentModuleTitles } from './lib/navigation.js';

export default function App() {
  const [deploymentModule, setDeploymentModule] = useState('');
  const [section, setSection] = useState("overview");
  const [namespace, setNamespace] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [auto, setAuto] = useState(false);
  const [selection, setSelection] = useState(null);
  const [token, setToken] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [settings, setSettings] = useState(false);
  const [mobile, setMobile] = useState(false);
  const open = useCallback(
    (kind, item, initialTab) => setSelection({ kind, item, initialTab }),
    [],
  );
  const { data, errors, health, loading, updated, setRefresh } = useClusterData({ namespace, token, auto });
  function navigate(next) {
    setSection(next);
    setSearch("");
    setStatusFilter("");
    setMobile(false);
  }
  const pods = data.pods || [];
  const statuses =
    section === "nodes"
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
  return (
    <div className="app">
      <aside className={`sidebar ${mobile ? "is-open" : ""}`}>
        <a
          href="#"
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
        <SidebarNav section={section} deploymentModule={deploymentModule} data={data} onNavigate={(key, module) => { setDeploymentModule(module); navigate(key); }} />
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
      </aside>
      {mobile && (
        <button
          className="backdrop"
          aria-label="关闭导航"
          onClick={() => setMobile(false)}
        />
      )}
      <main>
        <header className="topbar">
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
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">CLUSTER WORKSPACE</div>
              <h1>{section === 'deployments' && deploymentModule ? deploymentModuleTitles[deploymentModule] : labels[section]}</h1>
              <p>
                {section === "overview"
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
              {loading ? "刷新中" : "刷新数据"}
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
          {!loading && health?.error && (
            <div className="error" role="alert">
              <strong>集群连接检查失败</strong>
              <span>{health.error}</span>
              <button className="text-button" onClick={() => setSettings(true)}>
                连接设置 ↗
              </button>
            </div>
          )}
          <div className="scope-bar">
            <div className="scope-select">
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
            </div>
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
          </div>
          {section === "nodes" && <NodeExpansion token={token} onUpdated={() => setRefresh(n => n + 1)} />}
          {section === "overview" ? (
            <OverviewPage data={data} errors={errors} loading={loading} namespace={namespace} navigate={navigate} open={open} />
          ) : (
            <ResourcesPage section={section} deploymentModule={deploymentModule} data={data} errors={errors} loading={loading} namespace={namespace} search={search} setSearch={setSearch} statuses={statuses} statusFilter={statusFilter} setStatusFilter={setStatusFilter} setRefresh={setRefresh} open={open} />
          )}
          <footer className="page-footer">
            <span>
              <i className="dot teal-bg" />
              基于 Kubernetes API · 实时集群数据
            </span>
            <span>KubeScope / Kubernetes 运维工作空间</span>
          </footer>
        </div>
      </main>
      {selection && (
        <ResourceDialog
          key={`${selection.kind}/${selection.item.metadata.uid || selection.item.metadata.name}`}
          selection={selection}
          onUpdated={() => setRefresh(n => n + 1)}
          close={() => setSelection(null)}
          token={token}
        />
      )}
    </div>
  );
}
