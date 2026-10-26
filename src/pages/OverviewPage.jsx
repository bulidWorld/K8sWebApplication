import React from "react";
import { labels } from "../lib/resources.js";
import { nodeReady, readyPods, podStatus, cpu, memory } from "../lib/formatters.js";
import ResourceTable from "../components/ResourceTable.jsx";

export default function OverviewPage({ data, errors, loading, namespace, navigate, open }) {
  const nodes = data.nodes || [];
  const pods = data.pods || [];
  const ready = nodes.filter(nodeReady).length;
  const scopeLabel = namespace || "所有命名空间";
  const count = (kind) => data[kind] ? data[kind].length : "—";
  const badPods = pods.filter((p) => !["Running", "Succeeded"].includes(podStatus(p)));
  return (
            <>
              <div className="stats-grid">
                {[
                  [
                    "nodes",
                    "⬡",
                    "集群节点",
                    count("nodes"),
                    data.nodes
                      ? `${ready} 个就绪 / ${nodes.length} 个节点`
                      : "等待集群数据",
                    "teal",
                  ],
                  [
                    "pods",
                    "◈",
                    "Pods",
                    count("pods"),
                    data.pods
                      ? `${readyPods(pods)} 个运行就绪 · ${scopeLabel}`
                      : "等待集群数据",
                    "blue",
                  ],
                  [
                    "deployments",
                    "▤",
                    "Deployments",
                    count("deployments"),
                    data.deployments
                      ? `${data.deployments.filter((d) => (d.status?.availableReplicas || 0) >= (d.spec?.replicas ?? 1)).length} 个可用工作负载`
                      : "等待集群数据",
                    "purple",
                  ],
                  [
                    "namespaces",
                    "▦",
                    "命名空间",
                    count("namespaces"),
                    "集群资源隔离与分组",
                    "amber",
                  ],
                ].map(([key, icon, title, value, subtitle, color]) => (
                  <button
                    className="stat-card"
                    key={key}
                    onClick={() => navigate(key)}
                  >
                    <div className="stat-label">
                      {title}
                      <span className={`stat-icon ${color}`}>{icon}</span>
                    </div>
                    <div className="stat-value">
                      {loading ? <span className="skeleton" /> : value}
                      <span>↗</span>
                    </div>
                    <div className="stat-note">
                      {errors[key] ? "资源读取失败，点击查看" : subtitle}
                    </div>
                  </button>
                ))}
              </div>
              {Object.keys(errors).length > 0 && (
                <div className="error" role="alert">
                  <strong>部分资源读取失败</strong>
                  {Object.entries(errors).map(([kind, message]) => (
                    <span key={kind}>
                      {labels[kind]}：{message}
                    </span>
                  ))}
                </div>
              )}
              <div className="overview-grid">
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        节点健康状态{" "}
                        <span className="subtle-label">CLUSTER HEALTH</span>
                      </h2>
                      <p>集群级别 · 以节点 Ready 条件为准</p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() => navigate("nodes")}
                    >
                      查看节点 ↗
                    </button>
                  </div>
                  <div className="health-content">
                    <div
                      className="health-ring"
                      style={{
                        "--progress": `${nodes.length ? (ready / nodes.length) * 100 : 0}%`,
                      }}
                    >
                      <div>
                        <strong>
                          {data.nodes && nodes.length
                            ? `${Math.round((ready / nodes.length) * 100)}%`
                            : "—"}
                        </strong>
                        <span>节点就绪率</span>
                      </div>
                    </div>
                    <div className="health-details">
                      <div>
                        <span>
                          <i className="dot teal-bg" />
                          就绪节点
                        </span>
                        <strong>
                          {data.nodes ? ready : "—"} <small>个</small>
                        </strong>
                      </div>
                      <div>
                        <span>
                          <i className="dot amber-bg" />
                          未就绪节点
                        </span>
                        <strong>
                          {data.nodes ? nodes.length - ready : "—"}{" "}
                          <small>个</small>
                        </strong>
                      </div>
                      <div>
                        <span>可分配 CPU</span>
                        <strong>
                          {data.nodes
                            ? nodes
                                .reduce(
                                  (sum, n) =>
                                    sum + cpu(n.status?.allocatable?.cpu),
                                  0,
                                )
                                .toLocaleString("zh-CN", {
                                  maximumFractionDigits: 1,
                                })
                            : "—"}{" "}
                          <small>核</small>
                        </strong>
                      </div>
                      <div>
                        <span>可分配内存</span>
                        <strong>
                          {data.nodes
                            ? nodes
                                .reduce(
                                  (sum, n) =>
                                    sum + memory(n.status?.allocatable?.memory),
                                  0,
                                )
                                .toFixed(1)
                            : "—"}{" "}
                          <small>GiB</small>
                        </strong>
                      </div>
                    </div>
                  </div>
                  <div className="panel-note">
                    可分配容量来自节点配置，不代表实时使用量。
                  </div>
                </section>
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        工作负载状态{" "}
                        <span className="subtle-label">WORKLOADS</span>
                      </h2>
                      <p>{scopeLabel} · Pod 运行情况</p>
                    </div>
                    <span className="tag">{count("pods")} Pods</span>
                  </div>
                  <div className="workload-summary">
                    <strong>{data.pods ? readyPods(pods) : "—"}</strong>
                    <span>运行就绪</span>
                    <span className="badge good">Running</span>
                  </div>
                  <div className="pod-bar">
                    {data.pods &&
                      ["Running", "Succeeded", "Other"].map((state, i) => {
                        const amount = pods.filter((p) =>
                          state === "Other"
                            ? !["Running", "Succeeded"].includes(podStatus(p))
                            : podStatus(p) === state,
                        ).length;
                        return (
                          amount > 0 && (
                            <div
                              key={state}
                              className={`bar-${i}`}
                              style={{
                                width: `${(amount / pods.length) * 100}%`,
                              }}
                              title={`${state}: ${amount}`}
                            />
                          )
                        );
                      })}
                  </div>
                  <div className="pod-legend">
                    <span>
                      <i className="dot teal-bg" />
                      运行 {data.pods ? readyPods(pods) : "—"}
                    </span>
                    <span>
                      <i className="dot blue-bg" />
                      已完成{" "}
                      {data.pods
                        ? pods.filter((p) => podStatus(p) === "Succeeded")
                            .length
                        : "—"}
                    </span>
                    <span>
                      <i className="dot amber-bg" />
                      待关注 {data.pods ? badPods.length : "—"}
                    </span>
                  </div>
                  <button
                    className="workload-link"
                    onClick={() => navigate("pods")}
                  >
                    检查工作负载与容器日志 <span>→</span>
                  </button>
                </section>
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>
                      需要关注的 Pods{" "}
                      <span className="count-pill">
                        {data.pods ? badPods.length : "—"}
                      </span>
                    </h2>
                    <p>包含未就绪、等待调度、重启异常等状态</p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => navigate("pods")}
                  >
                    查看全部 Pods →
                  </button>
                </div>
                {loading ? (
                  <div className="loading-state">正在获取集群资源…</div>
                ) : errors.pods ? (
                  <div className="error">{errors.pods}</div>
                ) : badPods.length ? (
                  <ResourceTable
                    kind="pods"
                    items={badPods}
                    search=""
                    statusFilter=""
                    open={open}
                  />
                ) : (
                  <div className="healthy-empty">
                    <span>✓</span>
                    <div>
                      <h3>
                        {pods.length
                          ? "当前没有需要关注的 Pods"
                          : "当前范围内暂无 Pods"}
                      </h3>
                      <p>
                        {pods.length
                          ? "所有 Pod 均运行就绪或已成功完成。"
                          : "可切换命名空间查看其他工作负载。"}
                      </p>
                    </div>
                  </div>
                )}
              </section>
            </>
  );
}
