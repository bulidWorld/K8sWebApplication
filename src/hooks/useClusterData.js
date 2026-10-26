import { useState, useEffect } from "react";
import api from "../lib/api.js";
import { kinds, scoped } from "../lib/resources.js";

export default function useClusterData({ namespace, token, auto }) {
  const [data, setData] = useState({});
  const [errors, setErrors] = useState({});
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [updated, setUpdated] = useState(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setErrors({});
    setData({});
    setHealth(null);
    setUpdated(null);
    const fetchAll = async () => {
      const outcomes = await Promise.allSettled([
        api("/api/health", token, controller.signal),
        ...kinds.map((kind) =>
          api(
            `/api/resources/${kind}${scoped.has(kind) && namespace ? `?namespace=${encodeURIComponent(namespace)}` : ""}`,
            token,
            controller.signal,
          ),
        ),
      ]);
      if (controller.signal.aborted) return;
      const next = {};
      const failures = {};
      outcomes.forEach((result, index) => {
        if (index === 0) {
          setHealth(
            result.status === "fulfilled"
              ? result.value
              : { connected: false, error: result.reason.message },
          );
          return;
        }
        const kind = kinds[index - 1];
        if (result.status === "fulfilled")
          next[kind] = result.value.items || [];
        else failures[kind] = result.reason.message;
      });
      setData(next);
      setErrors(failures);
      setLoading(false);
      setUpdated(new Date());
    };
    fetchAll();
    return () => controller.abort();
  }, [namespace, refresh, token]);
  useEffect(() => {
    if (!auto || loading) return;
    const id = setInterval(() => setRefresh((n) => n + 1), 15000);
    return () => clearInterval(id);
  }, [auto, loading]);
  return { data, errors, health, loading, updated, setRefresh };
}
