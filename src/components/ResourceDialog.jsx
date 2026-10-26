import React, { useState, useEffect, useRef } from "react";
import { labels } from "../lib/resources.js";
import api from "../lib/api.js";
import download from "../lib/download.js";
import DeploymentConfig from './DeploymentConfig.jsx';

export default function ResourceDialog({ selection, close, token, onUpdated }) {
  const { kind, item: initialItem, initialTab } = selection;
  const [item, setItem] = useState(initialItem);
  const [tab, setTab] = useState(initialTab?.startsWith('config:') ? 'config' : initialTab || "detail");
  const [configDirty, setConfigDirty] = useState(false);
  const safeClose = () => { if (!configDirty || window.confirm('有未保存的配置修改，确定放弃并关闭吗？')) close(); };
  const switchTab = next => { if (!configDirty || window.confirm('有未保存的配置修改，确定放弃并切换吗？')) setTab(next); };
  const [container, setContainer] = useState(
    item.spec?.containers?.[0]?.name || "",
  );
  const [tail, setTail] = useState("200");
  const [previous, setPrevious] = useState(false);
  const [auto, setAuto] = useState(false);
  const [logs, setLogs] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const dialog = useRef(null);
  useEffect(() => {
    dialog.current.showModal();
  }, []);
  useEffect(() => {
    if (!auto || tab !== "logs" || busy) return;
    const id = setInterval(() => setRefresh((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, [auto, tab, busy]);
  useEffect(() => {
    if (tab !== "logs") return;
    const controller = new AbortController();
    setBusy(true);
    setError("");
    setLogs("");
    const query = new URLSearchParams({
      pod: item.metadata.name,
      namespace: item.metadata.namespace,
      container,
      tail,
      previous: String(previous),
    });
    api(`/api/logs?${query}`, token, controller.signal)
      .then((body) => setLogs(body.logs))
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [tab, container, tail, previous, refresh, item, token]);
  const cleaned = {
    ...item,
    metadata: { ...item.metadata, managedFields: undefined },
  };
  return (
    <dialog
      ref={dialog}
      onCancel={e => { e.preventDefault(); safeClose(); }}
      onClick={(e) => {
        if (e.target === dialog.current) safeClose();
      }}
      className="resource-dialog"
    >
      <div className="dialog-head">
        <div>
          <span className="eyebrow">
            {labels[kind]} / {item.metadata.namespace || "集群资源"}
          </span>
          <h2>{item.metadata.name}</h2>
        </div>
        <button className="icon-button" onClick={safeClose} aria-label="关闭详情">
          ×
        </button>
      </div>
      <div className="tabs">
        <button
          className={tab === "detail" ? "selected" : ""}
          onClick={() => switchTab("detail")}
        >
          资源详情
        </button>
        {kind === 'deployments' && <button className={tab === 'config' ? 'selected' : ''} onClick={() => switchTab('config')}>模块配置</button>}
        {kind === "pods" && (
          <button
            className={tab === "logs" ? "selected" : ""}
            onClick={() => setTab("logs")}
          >
            容器日志
          </button>
        )}
      </div>
      {tab === 'config' && kind === 'deployments' ? <DeploymentConfig item={item} token={token} initialModule={initialTab?.startsWith('config:') ? initialTab.slice(7) : ''} onDirty={setConfigDirty} onResourceUpdated={value => { setItem(value); onUpdated?.(); }} /> : tab === "detail" ? (
        <>
          <div className="detail-summary">
            <span>
              创建于{" "}
              {new Date(item.metadata.creationTimestamp).toLocaleString(
                "zh-CN",
              )}
            </span>
            <button
              className="button"
              onClick={() =>
                download(
                  JSON.stringify(cleaned, null, 2),
                  `${item.metadata.name}.json`,
                )
              }
            >
              下载 JSON ↓
            </button>
          </div>
          <pre className="code">{JSON.stringify(cleaned, null, 2)}</pre>
        </>
      ) : (
        <>
          <div className="log-controls">
            <label>
              容器
              <select
                value={container}
                onChange={(e) => setContainer(e.target.value)}
              >
                {[
                  ...(item.spec?.initContainers || []),
                  ...(item.spec?.containers || []),
                  ...(item.spec?.ephemeralContainers || []),
                ].map((c) => (
                  <option key={c.name}>{c.name}</option>
                ))}
              </select>
            </label>
            <label>
              最近行数
              <select value={tail} onChange={(e) => setTail(e.target.value)}>
                {["100", "200", "500", "1000", "5000"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={previous}
                onChange={(e) => setPrevious(e.target.checked)}
              />
              上次实例
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => setAuto(e.target.checked)}
              />
              每 5 秒刷新
            </label>
            <button
              className="button"
              disabled={busy}
              onClick={() => setRefresh((n) => n + 1)}
            >
              刷新
            </button>
            <button
              className="button"
              disabled={!logs}
              onClick={() =>
                download(logs, `${item.metadata.name}-${container}.log`)
              }
            >
              下载 ↓
            </button>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="terminal-heading">
            <i /> {container || "container"}
            <span>{busy ? "正在读取…" : "带时间戳 · 最大 1 MiB"}</span>
          </div>
          <pre className="code logs" aria-live="polite">
            {busy
              ? "正在读取容器日志…"
              : error
                ? "无法读取日志。请检查上方错误信息。"
                : logs || "当前容器暂无日志。"}
          </pre>
        </>
      )}
    </dialog>
  );
}
