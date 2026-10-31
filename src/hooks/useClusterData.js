import { useState, useEffect } from "react";
import api from "../lib/api.js";
import { kinds, scoped } from "../lib/resources.js";

export default function useClusterData({ namespace, token, auto }) {
  const [data, setData] = useState({});
  const [errors, setErrors] = useState({});
  const [health, setHealth] = useState(null);
  const [checkedToken, setCheckedToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setErrors({});
    setData({});
    setUpdated(null);
    if (!token) {
      setHealth(null);
      setLoading(false);
      return () => controller.abort();
    }
    const fetchAll = async () => {
      try {
        const result = await api("/api/health", token, controller.signal);
        if (controller.signal.aborted) return;
        setHealth(result);
        setCheckedToken(token);
        if (!result.connected) return;
        const outcomes = await Promise.allSettled(kinds.map(kind =>
          api(`/api/resources/${kind}${scoped.has(kind) && namespace ? `?namespace=${encodeURIComponent(namespace)}` : ""}`, token, controller.signal),
        ));
        if (controller.signal.aborted) return;
        const next = {};
        const failures = {};
        outcomes.forEach((result, index) => {
          if (result.status === "fulfilled") next[kinds[index]] = result.value.items || [];
          else failures[kinds[index]] = result.reason.message;
        });
        setData(next);
        setErrors(failures);
        setUpdated(new Date());
      } catch (error) {
        if (!controller.signal.aborted) {
          setHealth({ connected: false, error: error.message, status: error.status });
          setCheckedToken(token);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    fetchAll();
    return () => controller.abort();
  }, [namespace, refresh, token]);
  useEffect(() => {
    if (!token || !auto || loading) return;
    const id = setInterval(() => setRefresh((n) => n + 1), 15000);
    return () => clearInterval(id);
  }, [token, auto, loading]);
  return { data, errors, health, loading, updated, setRefresh, checking: !!token && (checkedToken !== token || !health) };
}
