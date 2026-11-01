import { useEffect, useState } from 'react';
import api from '../lib/api.js';

export default function useCustomResourceCounts(items, enabled, token) {
  const [counts, setCounts] = useState({});
  useEffect(() => {
    const controller = new AbortController();
    setCounts({});
    if (!enabled || !items?.length) return () => controller.abort();
    let next = 0;
    async function worker() {
      while (!controller.signal.aborted && next < items.length) {
        const name = items[next++].metadata.name;
        try {
          const result = await api(`/api/custom-resources/${encodeURIComponent(name)}/count`, token, controller.signal);
          if (!controller.signal.aborted) setCounts(current => ({ ...current, [name]: { count: result.count } }));
        } catch (error) {
          if (!controller.signal.aborted) setCounts(current => ({ ...current, [name]: { error: error.message } }));
        }
      }
    }
    // Bound concurrent requests when a cluster has many CRDs.
    for (let i = 0; i < Math.min(4, items.length); i++) void worker();
    return () => controller.abort();
  }, [items, enabled, token]);
  return counts;
}
