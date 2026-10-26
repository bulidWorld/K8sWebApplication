import http from "node:http";
import https from "node:https";
import { KubeConfig } from "@kubernetes/client-node";

const groups = {
  nodes: "/api/v1", namespaces: "/api/v1", pods: "/api/v1",
  services: "/api/v1", events: "/api/v1",
  persistentvolumeclaims: "/api/v1", persistentvolumes: "/api/v1",
  deployments: "/apis/apps/v1", storageclasses: "/apis/storage.k8s.io/v1",
};
export const namespaced = new Set(["pods", "services", "events", "persistentvolumeclaims", "deployments"]);
export function validateName(value, label = "资源名称") {
  if (!value || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value))
    throw Object.assign(new Error(`${label}格式不正确`), { status: 400 });
  return value;
}
export function resourcePath(resource, namespace, name) {
  if (!Object.hasOwn(groups, resource))
    throw Object.assign(new Error("不支持的资源类型"), { status: 404 });
  let prefix = groups[resource];
  if (namespaced.has(resource)) {
    if (namespace) prefix += `/namespaces/${validateName(namespace, "命名空间")}`;
    else if (name) throw Object.assign(new Error("查询单个资源必须指定命名空间"), { status: 400 });
  }
  return `${prefix}/${resource}${name ? `/${validateName(name)}` : ""}`;
}
export function logsPath(query) {
  const pod = validateName(query.get("pod"), "Pod 名称");
  const namespace = validateName(query.get("namespace"), "命名空间");
  const tail = query.get("tail") || "200";
  if (!/^\d+$/.test(tail) || +tail < 1 || +tail > 5000)
    throw Object.assign(new Error("日志行数必须在 1 到 5000 之间"), { status: 400 });
  const params = new URLSearchParams({ tailLines: tail, timestamps: "true", limitBytes: "1048576" });
  if (query.get("container")) params.set("container", validateName(query.get("container"), "容器名称"));
  if (query.get("previous") === "true") params.set("previous", "true");
  return `/api/v1/namespaces/${namespace}/pods/${pod}/log?${params}`;
}

// Preserve the API server's JSON fields without generated-model conversion.
export function createKubernetes({ config, timeout = 15000, maxBytes = 10 * 1024 * 1024 } = {}) {
  let kc = config;
  function configuration() {
    if (!kc) {
      const loaded = new KubeConfig();
      loaded.loadFromDefault();
      kc = loaded;
    }
    if (!kc.getCurrentCluster()) throw new Error("kubeconfig 未配置当前集群");
    return kc;
  }
  async function request(apiPath, json = true, mutation) {
    try {
      // Includes credential refresh in the total deadline; abort destroys the socket.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const operation = async () => {
          const config = configuration();
          const cluster = config.getCurrentCluster();
          const target = new URL(cluster.server.replace(/\/$/, "") + apiPath);
          if (!["https:", "http:"].includes(target.protocol)) throw new Error("不支持的 API server 协议");
          const options = { headers: { Accept: json ? "application/json" : "text/plain" } };
          if (mutation) options.headers['Content-Type'] = 'application/json-patch+json';
          await config.applyToHTTPSOptions(options);
          if (controller.signal.aborted) throw new Error("访问 Kubernetes 超时，请检查集群连接。");
          return new Promise((resolve, reject) => {
            const transport = target.protocol === "https:" ? https : http;
            const req = transport.request(target, { ...options, method: mutation ? "PATCH" : "GET", signal: controller.signal }, (res) => {
              const chunks = [];
              let size = 0;
              res.on("data", (chunk) => {
                size += chunk.length;
                if (size > maxBytes) {
                  res.destroy(new Error("Kubernetes 响应超过大小限制"));
                  return;
                }
                chunks.push(chunk);
              });
              res.on("error", reject);
              res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                if (res.statusCode < 200 || res.statusCode >= 300) {
                  let message = `Kubernetes API 请求失败 (${res.statusCode})`;
                  try { message = JSON.parse(text).message || message; } catch {}
                  return reject(Object.assign(new Error(message), { status: res.statusCode }));
                }
                try { resolve(json ? JSON.parse(text) : text); } catch { reject(new Error("Kubernetes API 返回无效 JSON")); }
              });
            });
            req.on("error", reject);
            req.end(mutation ? JSON.stringify(mutation) : undefined);
          });
        };
        const aborted = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("访问 Kubernetes 超时，请检查集群连接。")), { once: true }));
        return await Promise.race([operation(), aborted]);
      } finally { clearTimeout(timer); }
    } catch (error) {
      throw Object.assign(new Error(error.message || "Kubernetes API 请求失败"), { status: mutation ? error.status || 502 : 502 });
    }
  }
  return { request, context: () => configuration().getCurrentContext() };
}
