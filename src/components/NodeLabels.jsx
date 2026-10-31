import React, { useEffect, useState } from "react";
import api from "../lib/api.js";

export default function NodeLabels({
  item,
  token,
  onDirty,
  onResourceUpdated,
}) {
  const [base, setBase] = useState(item);
  const [changes, setChanges] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const dirty = Object.keys(changes).length > 0;
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
      onResourceUpdated(resource);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
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
            changes,
          }),
        },
      );
      setBase(result.resource);
      setChanges({});
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
      <p>查看和修改节点标签。删除标记和修改将在保存后生效；标签值可以为空。</p>
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
                    value={removed ? value : (changes[key] ?? value)}
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
        <div className="node-label-actions">
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
              ? `有 ${Object.keys(changes).length} 项未保存的变更`
              : `${entries.length} 个标签`}
          </span>
        </div>
      </fieldset>
    </section>
  );
}
