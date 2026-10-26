export default async function api(url, token, signal, options = {}) {
  const response = await fetch(url, {
    signal,
    ...options,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const body = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(body.error || `请求失败 (${response.status})`), { status: response.status });
  return body;
}
