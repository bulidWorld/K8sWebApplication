import React, { useEffect, useRef, useState } from "react";
import api from "../lib/api.js";

export default function NodeLabels({
  item,
  token,
  onDirty,
  onResourceUpdated,
}) {
  const [base, setBase] = useState(item);
  const [changes, setChanges] = useState({});
  const [additions, setAdditions] = useState([]);
  const nextId = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const changeCount = Object.keys(changes).length + additions.length;
  const dirty = changeCount > 0;
  useEffect(() => {
    onDirty(dirty || busy);
    return () => onDirty(false);
  }, [dirty, busy, onDirty]);
  function change(key, value) {
    setChanges((previous) => {
      const next = { ...previous, [key]: value };
      if (value === base.metadata.labels[key]) delete next[key];
      return next;
    });
    setMessage("");
  }
  function updateAddition(id, field, value) {
    setAdditions(previous => previous.map(row => row.id === id ? { ...row, [field]: value } : row));
    setMessage("");
    setError("");
  }
  async function reload() {
    if (dirty && !window.confirm("重新加载会放弃未保存的标签修改，是否继续？"))
      return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const resource = await api(
        `/api/resources/nodes/${encodeURIComponent(base.metadata.name)}`,
        token,
      );
      setBase(resource);
      setChanges({});
      setAdditions([]);
      onResourceUpdated(resource);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const keys = new Set(Object.keys(base.metadata.labels || {}));
    for (const row of additions) {
      if (!row.key.trim()) {
        setError("请填写新增标签的名称。");
        return;
      }
      if (keys.has(row.key)) {
        setError(`标签名称重复：${row.key}。已有标签请直接修改原行。`);
        return;
      }
      keys.add(row.key);
    }
    const submittedChanges = { ...changes, ...Object.fromEntries(additions.map(row => [row.key, row.value])) };
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api(
        `/api/nodes/${encodeURIComponent(base.metadata.name)}/labels`,
        token,
        undefined,
        {
          method: "PATCH",
          body: JSON.stringify({
            uid: base.metadata.uid,
            resourceVersion: base.metadata.resourceVersion,
            changes: submittedChanges,
          }),
        },
      );
      setBase(result.resource);
      setChanges({});
      setAdditions([]);
      onResourceUpdated(result.resource);
      setMessage(result.warning || "标签已保存");
    } catch (e) {
      setError(
        e.status === 409 ? "节点已发生变化，请重新加载后再编辑。" : e.message,
      );
    } finally {
      setBusy(false);
    }
  }
  const entries = Object.entries(base.metadata.labels || {}).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return (
    <section className="node-labels">
      <p>查看、新增和修改节点标签。所有变更将在保存后生效；标签值可以为空。</p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {message && <p role="status">{message}</p>}
      <fieldset disabled={busy}>
        <legend className="sr-only">节点标签</legend>
        {entries.length ? (
          entries.map(([key, value]) => {
            const removed =
              Object.hasOwn(changes, key) && changes[key] === null;
            return (
              <div
                className={`node-label-row${removed ? " pending-delete" : ""}`}
                key={key}
              >
                <label className="config-field">
                  <span className="mono">{key}</span>
                  <input
                    aria-label={`标签 ${key} 的值`}
                    disabled={removed}
                    value={removed || !Object.hasOwn(changes, key) ? value : changes[key]}
                    maxLength={63}
                    onChange={(e) => change(key, e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="text-button"
                  aria-label={`${removed ? "撤销删除" : "删除标签"} ${key}`}
                  onClick={() => change(key, removed ? value : null)}
                >
                  {removed ? "撤销删除" : "删除"}
                </button>
                {removed && <span>待删除</span>}
              </div>
            );
          })
        ) : (
          <p>该节点暂无标签。</p>
        )}
        {additions.map((row, index) => (
          <div className="node-label-row" key={row.id}>
            <label className="config-field">
              <span>新增标签名称</span>
              <input
                autoFocus
                aria-label={`新增标签 ${index + 1} 的名称`}
                placeholder="例如 example.com/zone"
                maxLength={317}
                value={row.key}
                onChange={e => updateAddition(row.id, "key", e.target.value)}
              />
            </label>
            <label className="config-field">
              <span>标签值（可为空）</span>
              <input
                aria-label={`新增标签 ${index + 1} 的值`}
                maxLength={63}
                value={row.value}
                onChange={e => updateAddition(row.id, "value", e.target.value)}
              />
            </label>
            <button type="button" className="text-button" aria-label={`移除新增标签 ${index + 1}`} onClick={() => {
              setAdditions(previous => previous.filter(entry => entry.id !== row.id));
              setError("");
            }}>移除</button>
            <span>待新增</span>
          </div>
        ))}
        <div className="node-label-actions">
          <button type="button" className="button" onClick={() => {
            const id = nextId.current++;
            setAdditions(previous => [...previous, { id, key: "", value: "" }]);
            setMessage("");
            setError("");
          }}>＋ 新增标签</button>
          <button
            className="button primary"
            disabled={!dirty || busy}
            onClick={save}
          >
            {busy ? "处理中…" : "保存标签"}
          </button>
          <button className="button" onClick={reload}>
            重新加载
          </button>
          <span>
            {dirty
              ? `有 ${changeCount} 项未保存的变更`
              : `${entries.length} 个标签`}
          </span>
        </div>
      </fieldset>
    </section>
  );
}
