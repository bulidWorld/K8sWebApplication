import React from "react";
import Badge from "./Badge.jsx";
import { nodeReady, podStatus, containers, age } from "../lib/formatters.js";

export default function ResourceTable({ kind, items, search, statusFilter, open }) {
  const status = (item) =>
    kind === "nodes"
      ? nodeReady(item)
        ? "Ready"
        : "NotReady"
      : kind === "pods"
        ? podStatus(item)
        : kind === "namespaces"
          ? item.status?.phase || "Unknown"
          : kind === "deployments"
            ? (item.status?.availableReplicas || 0) >=
              (item.spec?.replicas ?? 1)
              ? "Available"
              : "Unavailable"
            : ["persistentvolumeclaims", "persistentvolumes"].includes(kind)
              ? item.status?.phase || "Unknown"
              : item.type || "Unknown";
  const filtered = items.filter(
    (item) =>
      JSON.stringify([
        item.metadata.name,
        item.metadata.namespace,
        item.metadata.labels,
        item.spec?.nodeName,
        item.status?.addresses,
        item.spec?.storageClassName,
        item.spec?.volumeName,
        item.spec?.claimRef,
        item.provisioner,
      ])
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (!statusFilter || status(item) === statusFilter),
  );
  const storageHeaders = {
    persistentvolumeclaims: ["名称 / 命名空间", "状态", "申请 / 分配容量", "访问模式", "存储类", "绑定卷", "存续时间"],
    persistentvolumes: ["名称", "状态", "容量", "访问模式", "回收策略", "存储类", "绑定声明", "存续时间"],
    storageclasses: ["名称", "默认", "供应器", "回收策略", "绑定模式", "允许扩容", "存续时间"],
  };
  const headers = storageHeaders[kind] || (
    kind === "nodes"
      ? ["节点名称", "状态", "角色", "IP 地址", "版本", "存续时间"]
      : kind === "pods"
        ? [
            "Pod 名称 / 命名空间",
            "状态",
            "就绪",
            "重启",
            "所在节点",
            "存续时间",
          ]
        : kind === "deployments"
          ? [
              "名称 / 命名空间",
              "状态",
              "就绪副本",
              "最新副本",
              "可用副本",
              "存续时间",
            ]
          : kind === "services"
            ? ["名称 / 命名空间", "类型", "Cluster IP", "端口", "存续时间"]
            : kind === "events"
              ? ["事件 / 命名空间", "类型", "资源", "消息", "次数", "最近发生"]
              : ["命名空间", "状态", "存续时间"]);
  return (
    <>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {headers.map((h) => (
                <th key={h}>{h}</th>
              ))}
              <th className="align-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((item) => {
              const meta = item.metadata;
              return (
                <tr key={meta.uid || `${meta.namespace}/${meta.name}`}>
                  <td>
                    <button
                      className="name-button"
                      onClick={() => open(kind, item)}
                    >
                      {meta.name}
                    </button>
                    {meta.namespace && <small>{meta.namespace}</small>}
                  </td>
                  {kind === "nodes" && (
                    <>
                      <td>
                        <Badge status={status(item)} />
                      </td>
                      <td>
                        {Object.keys(meta.labels || {})
                          .filter((k) =>
                            k.startsWith("node-role.kubernetes.io/"),
                          )
                          .map((k) => k.split("/")[1])
                          .join(", ") || "worker"}
                      </td>
                      <td className="mono">
                        {item.status?.addresses?.find(
                          (a) => a.type === "InternalIP",
                        )?.address || "—"}
                      </td>
                      <td className="mono">
                        {item.status?.nodeInfo?.kubeletVersion || "—"}
                      </td>
                      <td>{age(meta.creationTimestamp)}</td>
                    </>
                  )}
                  {kind === "pods" && (
                    <>
                      <td>
                        <Badge status={status(item)} />
                      </td>
                      <td className="mono">
                        {item.status?.containerStatuses?.filter((c) => c.ready)
                          .length || 0}{" "}
                        / {item.spec?.containers?.length || 0}
                      </td>
                      <td
                        className={
                          containers(item).reduce(
                            (sum, c) => sum + (c.restartCount || 0),
                            0,
                          ) > 0
                            ? "amber"
                            : ""
                        }
                      >
                        {containers(item).reduce(
                          (sum, c) => sum + (c.restartCount || 0),
                          0,
                        )}
                      </td>
                      <td>{item.spec?.nodeName || "未调度"}</td>
                      <td>{age(meta.creationTimestamp)}</td>
                    </>
                  )}
                  {kind === "deployments" && (
                    <>
                      <td>
                        <Badge status={status(item)} />
                      </td>
                      <td className="mono">
                        {item.status?.readyReplicas || 0} /{" "}
                        {item.spec?.replicas ?? 1}
                      </td>
                      <td>{item.status?.updatedReplicas || 0}</td>
                      <td>{item.status?.availableReplicas || 0}</td>
                      <td>{age(meta.creationTimestamp)}</td>
                    </>
                  )}
                  {kind === "services" && (
                    <>
                      <td>
                        <span className="tag">{item.spec?.type}</span>
                      </td>
                      <td className="mono">{item.spec?.clusterIP || "—"}</td>
                      <td className="mono">
                        {item.spec?.ports
                          ?.map(
                            (p) =>
                              `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol}`,
                          )
                          .join(", ") || "—"}
                      </td>
                      <td>{age(meta.creationTimestamp)}</td>
                    </>
                  )}
                  {["persistentvolumeclaims", "persistentvolumes"].includes(kind) && (
                    <>
                      <td><Badge status={status(item)} /></td>
                      <td className="mono">{kind === "persistentvolumeclaims"
                        ? `${item.spec?.resources?.requests?.storage || "—"} / ${item.status?.capacity?.storage || "—"}`
                        : item.spec?.capacity?.storage || "—"}</td>
                      <td>{item.spec?.accessModes?.join(", ") || "—"}</td>
                      {kind === "persistentvolumes" && <td>{item.spec?.persistentVolumeReclaimPolicy || "—"}</td>}
                      <td>{item.spec?.storageClassName ?? "—"}</td>
                      <td>{kind === "persistentvolumeclaims"
                        ? item.spec?.volumeName || "未绑定"
                        : item.spec?.claimRef ? `${item.spec.claimRef.namespace}/${item.spec.claimRef.name}` : "未绑定"}</td>
                      <td>{age(meta.creationTimestamp)}</td>
                    </>
                  )}
                  {kind === "storageclasses" && (
                    <>
                      <td>{meta.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true" || meta.annotations?.["storageclass.beta.kubernetes.io/is-default-class"] === "true" ? "是" : "否"}</td>
                      <td className="mono">{item.provisioner || "—"}</td>
                      <td>{item.reclaimPolicy || "Delete"}</td>
                      <td>{item.volumeBindingMode || "Immediate"}</td>
                      <td>{item.allowVolumeExpansion ? "是" : "否"}</td>
                      <td>{age(meta.creationTimestamp)}</td>
                    </>
                  )}
                  {kind === "namespaces" && (
                    <>
                      <td>
                        <Badge status={status(item)} />
                      </td>
                      <td>{age(meta.creationTimestamp)}</td>
                    </>
                  )}
                  {kind === "events" && (
                    <>
                      <td>
                        <Badge status={item.type || "Unknown"} />
                      </td>
                      <td>
                        {item.involvedObject?.kind}/{item.involvedObject?.name}
                      </td>
                      <td className="event-message">{item.message}</td>
                      <td>{item.count || 1}</td>
                      <td>
                        {age(
                          item.lastTimestamp ||
                            item.eventTime ||
                            meta.creationTimestamp,
                        )}
                        前
                      </td>
                    </>
                  )}
                  <td className="align-right">
                    <div className="row-actions">
                      {kind === 'deployments' && <button className="text-button" onClick={() => open(kind, item, 'config')}>配置</button>}
                      {kind === "pods" && (
                        <button
                          className="text-button"
                          onClick={() => open(kind, item, "logs")}
                        >
                          日志
                        </button>
                      )}
                      <button
                        className="text-button"
                        onClick={() => open(kind, item)}
                      >
                        详情 ↗
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!filtered.length && (
        <div className="empty">
          <span>⌕</span>
          <h3>{search || statusFilter ? "没有匹配的资源" : "暂无资源"}</h3>
          <p>
            {search || statusFilter
              ? "调整搜索关键词或状态筛选后重试。"
              : "当前范围内没有此类资源。"}
          </p>
        </div>
      )}
      <div className="table-footer">
        共 {filtered.length} 项资源
        {filtered.length !== items.length &&
          `，已筛选 / 总计 ${items.length} 项`}
        <span>{kind === 'deployments' ? '支持模块配置 · Kubernetes API' : '只读访问 · Kubernetes API'}</span>
      </div>
    </>
  );
}
