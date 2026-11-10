import React, { useEffect, useRef, useState } from "react";
import api from "../lib/api.js";

export default function OperationLogsPage({ token }) {
  const [items, setItems] = useState([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [method, setMethod] = useState(""),
    [pathQuery, setPathQuery] = useState("");
  const [selectedResponse, setSelectedResponse] = useState(null);
  const responseDialog = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      api("/api/operation-logs", token, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) {
            setItems(value.items || []);
            setError("");
          }
        })
        .catch((reason) => {
          if (!controller.signal.aborted) setError(reason.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [token]);
  useEffect(() => {
    const dialog = responseDialog.current;
    if (!dialog) return;
    if (selectedResponse && !dialog.open) dialog.showModal();
    else if (!selectedResponse && dialog.open) dialog.close();
  }, [selectedResponse]);
  const operations = items.filter((item) => item.event === "kubernetes_api");
  const filteredOperations = operations.filter((item) => {
    const [loggedMethod = "", ...pathParts] = (item.interface || "").split(" ");
    return (
      (!method || loggedMethod.toUpperCase() === method) &&
      pathParts.join(" ").toLowerCase().includes(pathQuery.trim().toLowerCase())
    );
  });
  return (
    <section className="panel resource-panel">
      <div className="resource-toolbar">
        <div className="resource-title">
          <h2>Kubernetes API 操作</h2>
          <span className="count-pill">{operations.length}</span>
        </div>
        <span className="panel-note">
          记录接口、请求参数和返回结果 · 自动刷新
        </span>
      </div>
      <div className="operation-log-filters" aria-label="操作日志筛选">
        <label>
          <span>Method</span>
          <select
            aria-label="按 Method 筛选"
            value={method}
            onChange={(event) => setMethod(event.target.value)}
          >
            <option value="">全部方法</option>
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>接口路径</span>
          <input
            type="search"
            aria-label="按接口路径筛选"
            placeholder="输入路径关键字"
            value={pathQuery}
            onChange={(event) => setPathQuery(event.target.value)}
          />
        </label>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {loading && !items.length ? (
        <div className="loading-state">正在读取操作日志…</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>接口</th>
                <th>请求参数</th>
                <th>HTTP 状态码</th>
                <th>响应结果</th>
              </tr>
            </thead>
            <tbody>
              {filteredOperations.map((entry, index) => {
                const response = entry.success
                  ? entry.response
                  : { error: entry.error };
                const formattedResponse =
                  JSON.stringify(response, null, 2) ?? String(response ?? "");
                return (
                  <tr key={`${entry.requestId || entry.time}-${index}`}>
                    <td>
                      {entry.time
                        ? new Date(entry.time).toLocaleString("zh-CN")
                        : "—"}
                    </td>
                    <td className="mono">{entry.interface}</td>
                    <td>
                      <pre className="operation-log-json">
                        {JSON.stringify(entry.params ?? {}, null, 2)}
                      </pre>
                    </td>
                    <td>{entry.statusCode ?? "—"}</td>
                    <td>
                      <button
                        type="button"
                        className="operation-log-response-button"
                        title="点击查看完整响应"
                        onClick={() =>
                          setSelectedResponse({
                            interface: entry.interface,
                            statusCode: entry.statusCode,
                            content: formattedResponse,
                          })
                        }
                      >
                        {formattedResponse || "（空响应）"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!filteredOperations.length && (
            <div className="empty">
              <h3>
                {operations.length
                  ? "没有匹配的操作记录"
                  : "暂无 Kubernetes 操作记录"}
              </h3>
            </div>
          )}
        </div>
      )}
      <dialog
        ref={responseDialog}
        className="resource-dialog operation-log-dialog"
        aria-label="完整响应结果"
        onClick={(event) => {
          if (event.target === responseDialog.current)
            setSelectedResponse(null);
        }}
        onClose={() => setSelectedResponse(null)}
      >
        {selectedResponse && (
          <>
            <div className="dialog-head">
              <div>
                <h2>响应结果</h2>
                <span className="panel-note">
                  {selectedResponse.interface} · HTTP{" "}
                  {selectedResponse.statusCode ?? "—"}
                </span>
              </div>
              <button
                type="button"
                className="button"
                onClick={() => setSelectedResponse(null)}
              >
                关闭
              </button>
            </div>
            <pre className="operation-log-full-response">
              {selectedResponse.content}
            </pre>
          </>
        )}
      </dialog>
      <div className="table-footer">
        显示最近 300 条 Kubernetes API 调用，日志文件按日期保存在服务端
        <span>敏感字段脱敏，过长内容截断</span>
      </div>
    </section>
  );
}
