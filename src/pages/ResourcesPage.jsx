import React, { useEffect, useRef, useState } from "react";
import api from '../lib/api.js';
import { labels, scoped } from "../lib/resources.js";
import ResourceTable from "../components/ResourceTable.jsx";
import { deploymentModuleTitles } from '../lib/navigation.js';
import useCustomResourceCounts from '../hooks/useCustomResourceCounts.js';

export default function ResourcesPage({ section, deploymentModule, data, errors, loading, namespace, search, setSearch, statuses, statusFilter, setStatusFilter, setRefresh, open, token }) {
  const crCounts = useCustomResourceCounts(data.customresourcedefinitions, section === 'customresourcedefinitions' && !loading && !errors[section], token);
  const deleting = useRef(false);
  const [deletingUid, setDeletingUid] = useState('');
  const [deleteResult, setDeleteResult] = useState(null);
  const [eventView, setEventView] = useState('live');
  const [historyEvents, setHistoryEvents] = useState([]);
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  useEffect(() => {
    if (section !== 'events' || eventView !== 'history') return;
    const controller = new AbortController();
    setHistoryLoading(true);
    api('/api/events/history', token, controller.signal)
      .then(result => { setHistoryEvents(result.items || []); setHistoryError(''); })
      .catch(error => { if (!controller.signal.aborted) setHistoryError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [section, eventView, token]);
  async function removeResource(item) {
    if (deleting.current || !item.metadata.uid || item.metadata.deletionTimestamp) return;
    const kind = section;
    if (!['pods', 'services'].includes(kind)) return;
    const label = kind === 'pods' ? 'Pod' : 'Service';
    const impact = kind === 'pods' ? '删除会终止该 Pod 中的容器。由 Deployment、StatefulSet 等控制器管理的 Pod 可能会自动重建。' : '删除后，通过该 Service 访问应用的流量将中断，关联的 Pod 不会被删除。';
    const { namespace, name, uid } = item.metadata;
    if (!window.confirm(`确定删除 ${label}「${namespace}/${name}」吗？\n\n${impact}`)) return;
    deleting.current = true;
    setDeletingUid(uid);
    setDeleteResult(null);
    try {
      await api(`/api/${kind}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`, token, undefined, { method: 'DELETE', body: JSON.stringify({ uid }) });
      setDeleteResult({ kind, message: `已提交删除 ${label} ${namespace}/${name}。` });
      setRefresh(n => n + 1);
    } catch (error) {
      setDeleteResult({ kind, error: true, message: `删除 ${namespace}/${name} 失败：${error.message}` });
    } finally {
      deleting.current = false;
      setDeletingUid('');
    }
  }
  const count = (kind) => data[kind] ? data[kind].length : "—";
  return (
            <section className="panel resource-panel">
              {deleteResult?.kind === section && <div className={deleteResult.error ? 'error' : 'panel-note'} role={deleteResult.error ? 'alert' : 'status'}>{deleteResult.message}</div>}
              <div className="resource-toolbar">
                <div className="resource-title">
                  <h2>{labels[section]}</h2>
                  <span className="count-pill">{section === 'events' && eventView === 'history' ? historyEvents.length : count(section)}</span>
                </div>
                <div className="filters">
                  <div className="search-input">
                    <span>⌕</span>
                    <input
                      aria-label="搜索资源"
                      placeholder={section === 'customresourcedefinitions' ? '搜索名称、API 组、Kind、版本…' : '搜索名称、标签、节点…'}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button
                        aria-label="清除搜索"
                        onClick={() => setSearch("")}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  {statuses.length > 0 && (
                    <select
                      aria-label="状态筛选"
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value)}
                    >
                      <option value="">全部状态</option>
                      {statuses.map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
              {section === 'events' && <div className="resource-toolbar event-view-tabs" role="tablist" aria-label="事件视图">
                <button className={`button ${eventView === 'live' ? 'primary' : ''}`} role="tab" aria-selected={eventView === 'live'} onClick={() => setEventView('live')}>事实事件</button>
                <button className={`button ${eventView === 'history' ? 'primary' : ''}`} role="tab" aria-selected={eventView === 'history'} onClick={() => setEventView('history')}>历史事件</button>
              </div>}
              {!scoped.has(section) && namespace && (
                <div className="panel-note">
                  {labels[section]}属于集群级资源，不受命名空间筛选影响。
                </div>
              )}
              {section === 'deployments' && deploymentModule && <div className="module-selection-note"><strong>{deploymentModuleTitles[deploymentModule]}</strong><span>选择下面的部署名称或点击“配置”，进入该应用的此项配置。每次保存仅更新所选模块。</span></div>}
              {section === 'events' && eventView === 'history' ? historyLoading ? (
                <div className="loading-state"><span className="spin">↻</span> 正在读取历史事件…</div>
              ) : historyError ? <div className="resource-error"><p>{historyError}</p><button className="button" onClick={() => setEventView('live')}>返回事实事件</button></div>
              : <ResourceTable crCounts={crCounts} kind="events" items={historyEvents} search={search} statusFilter={statusFilter} open={open} removeResource={removeResource} deletingUid={deletingUid} /> : loading ? (
                <div className="loading-state">
                  <span className="spin">↻</span> 正在读取{labels[section]}…
                </div>
              ) : errors[section] ? (
                <div className="resource-error">
                  <h3>资源读取失败</h3>
                  <p>{errors[section]}</p>
                  <button
                    className="button"
                    onClick={() => setRefresh((n) => n + 1)}
                  >
                    重试
                  </button>
                </div>
              ) : (
                <ResourceTable
                  crCounts={crCounts}
                  kind={section}
                  removeResource={removeResource}
                  deletingUid={deletingUid}
                  items={data[section] || []}
                  search={search}
                  statusFilter={statusFilter}
                  open={(kind, item, tab) => open(kind, item, section === 'deployments' && deploymentModule ? `config:${deploymentModule}` : tab)}
                />
              )}
            </section>
  );
}
