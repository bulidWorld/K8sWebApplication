import React from "react";
import { labels, scoped } from "../lib/resources.js";
import ResourceTable from "../components/ResourceTable.jsx";
import { deploymentModuleTitles } from '../lib/navigation.js';

export default function ResourcesPage({ section, deploymentModule, data, errors, loading, namespace, search, setSearch, statuses, statusFilter, setStatusFilter, setRefresh, open }) {
  const count = (kind) => data[kind] ? data[kind].length : "—";
  return (
            <section className="panel resource-panel">
              <div className="resource-toolbar">
                <div className="resource-title">
                  <h2>{labels[section]}</h2>
                  <span className="count-pill">{count(section)}</span>
                </div>
                <div className="filters">
                  <div className="search-input">
                    <span>⌕</span>
                    <input
                      aria-label="搜索资源"
                      placeholder="搜索名称、标签、节点…"
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
              {!scoped.has(section) && namespace && (
                <div className="panel-note">
                  {labels[section]}属于集群级资源，不受命名空间筛选影响。
                </div>
              )}
              {section === 'deployments' && deploymentModule && <div className="module-selection-note"><strong>{deploymentModuleTitles[deploymentModule]}</strong><span>选择下面的部署名称或点击“配置”，进入该应用的此项配置。每次保存仅更新所选模块。</span></div>}
              {loading ? (
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
                  kind={section}
                  items={data[section] || []}
                  search={search}
                  statusFilter={statusFilter}
                  open={(kind, item, tab) => open(kind, item, section === 'deployments' && deploymentModule ? `config:${deploymentModule}` : tab)}
                />
              )}
            </section>
  );
}
