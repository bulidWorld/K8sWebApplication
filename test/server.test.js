import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { KubeConfig } from "@kubernetes/client-node";
import { createApp } from "../server/index.js";
import { createKubernetes, resourcePath, logsPath } from "../server/kubernetes.js";
async function withServer(kubernetes, run, token = "", staticDirectory) {
  const app = createApp({ kubernetes, token, staticDirectory });
  await app.listen(0, "127.0.0.1");
  if (!app.listening) await new Promise(resolve => app.once("listening", resolve));
  try { await run(`http://127.0.0.1:${app.address().port}`); }
  finally { await new Promise(resolve => app.close(resolve)); }
}

test("所有资源映射到对应版本与作用域，详情需要命名空间", () => {
  for (const kind of ["nodes", "namespaces", "pods", "services", "events", "persistentvolumeclaims", "persistentvolumes", "deployments", "storageclasses"]) {
    const group = kind === "deployments" ? "/apis/apps/v1" : kind === "storageclasses" ? "/apis/storage.k8s.io/v1" : "/api/v1";
    const scoped = ["pods", "services", "events", "persistentvolumeclaims", "deployments"].includes(kind);
    assert.equal(resourcePath(kind, "default", "web"), `${group}${scoped ? "/namespaces/default" : ""}/${kind}/web`);
    assert.equal(resourcePath(kind), `${group}/${kind}`);
  }
  assert.throws(() => resourcePath("secrets"), { status: 404 });
  assert.throws(() => resourcePath("pods", "", "web"), { status: 400 });
  for (const value of ["--help", "../etc", "x y", "default;id"])
    assert.throws(() => resourcePath("pods", value), { status: 400 });
});
test("日志使用 Pod log 子资源并限制行数和字节数", () => {
  const url = new URL(logsPath(new URLSearchParams({ pod: "web", namespace: "apps", container: "app", previous: "true", tail: "500" })), "http://localhost");
  assert.equal(url.pathname, "/api/v1/namespaces/apps/pods/web/log");
  assert.deepEqual(Object.fromEntries(url.searchParams), { tailLines: "500", timestamps: "true", limitBytes: "1048576", container: "app", previous: "true" });
  for (const tail of ["0", "5001", "-1", "1e3", "10;id"])
    assert.throws(() => logsPath(new URLSearchParams({ pod: "web", namespace: "apps", tail })), { status: 400 });
  assert.throws(() => logsPath(new URLSearchParams({ pod: "web" })), { status: 400 });
});
test("网页 API 保持响应结构、令牌校验、只读限制与错误传播", async () => {
  const calls = [];
  const kubernetes = { context: () => "admin@cluster", request: async (path, json = true) => {
    calls.push([path, json]);
    if (path.includes("/log?")) return "service started\n";
    if (path === "/api/v1/nodes") throw Object.assign(new Error("RBAC Forbidden"), { status: 502 });
    return { items: [] };
  }};
  await withServer(kubernetes, async base => {
    assert.equal((await fetch(base + "/api/resources/pods")).status, 401);
    assert.equal(calls.length, 0);
    const headers = { Authorization: "Bearer test-token" };
    const get = url => fetch(base + url, { headers });
    assert.deepEqual(await (await get("/api/health")).json(), { connected: true, context: "admin@cluster" });
    assert.equal(calls[0][0], "/version");
    assert.deepEqual(await (await get("/api/resources/deployments?namespace=apps")).json(), { items: [] });
    assert.equal(calls.at(-1)[0], "/apis/apps/v1/namespaces/apps/deployments");
    assert.deepEqual(await (await get("/api/logs?pod=web&namespace=apps")).json(), { logs: "service started\n" });
    const count = calls.length;
    assert.equal((await get("/api/resources/pods?namespace=--help")).status, 400);
    assert.equal((await get("/api/resources/secrets")).status, 404);
    assert.equal((await fetch(base + "/api/resources/pods", { method: "DELETE", headers })).status, 405);
    assert.equal(calls.length, count);
    const denied = await get("/api/resources/nodes");
    assert.equal(denied.status, 502);
    assert.deepEqual(await denied.json(), { error: "RBAC Forbidden" });
  }, "test-token");
});
test("真实 HTTP 传输使用 kubeconfig 认证，保留原始 JSON、日志，处理错误与限额", async () => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ path: req.url, method: req.method, auth: req.headers.authorization });
    if (req.url === "/slow") return;
    if (req.url === "/denied") { res.writeHead(403); return res.end(JSON.stringify({ message: "pods is forbidden" })); }
    if (req.url === "/invalid") return res.end("bad json");
    if (req.url === "/large") return res.end("x".repeat(4096));
    if (req.url.includes("/log")) return res.end("2026 service started\n");
    res.end(JSON.stringify({ items: [{ metadata: { name: "web" }, arbitrary: { preserved: true } }] }));
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const config = new KubeConfig();
    config.loadFromOptions({ clusters: [{ name: "cluster", skipTLSVerify: true, server: `http://127.0.0.1:${upstream.address().port}` }], users: [{ name: "reader", token: "kube-token" }], contexts: [{ name: "test", cluster: "cluster", user: "reader" }], currentContext: "test" });
    const client = createKubernetes({ config, timeout: 1000, maxBytes: 1024 });
    assert.equal(client.context(), "test");
    const result = await client.request(resourcePath("pods", "apps"));
    assert.equal(result.items[0].arbitrary.preserved, true);
    assert.deepEqual(requests[0], { path: "/api/v1/namespaces/apps/pods", method: "GET", auth: "Bearer kube-token" });
    assert.match(await client.request("/log", false), /service started/);
    await assert.rejects(client.request("/denied"), { status: 502, message: /forbidden/ });
    await assert.rejects(client.request("/invalid"), { status: 502, message: /JSON/ });
    await assert.rejects(client.request("/large"), { status: 502, message: /大小/ });
    await assert.rejects(createKubernetes({ config, timeout: 30 }).request("/slow"), { status: 502, message: /超时/ });
    const hanging = { getCurrentCluster: () => ({ server: "http://localhost" }), applyToHTTPSOptions: () => new Promise(() => {}) };
    await assert.rejects(createKubernetes({ config: hanging, timeout: 30 }).request("/version"), { status: 502, message: /超时/ });
  } finally {
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("静态服务支持首页、嵌套资源及页面路由，并阻止目录穿越", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kubescope-static-"));
  try {
    await mkdir(path.join(directory, "assets"));
    await writeFile(path.join(directory, "index.html"), "<h1>KubeScope</h1>");
    await writeFile(
      path.join(directory, "assets/app.js"),
      'console.log("app");',
    );
    await withServer(
      { request: async () => ({}) },
      async (base) => {
        for (const url of ["/", "/pods"]) {
          const response = await fetch(base + url);
          assert.equal(response.status, 200);
          assert.match(response.headers.get("content-type"), /text\/html/);
          assert.equal(await response.text(), "<h1>KubeScope</h1>");
        }
        const asset = await fetch(base + "/assets/app.js");
        assert.equal(asset.status, 200);
        assert.match(asset.headers.get("content-type"), /javascript/);
        assert.equal(await asset.text(), 'console.log("app");');
        const traversal = await fetch(base + "/..%2fserver%2findex.js");
        assert.equal(traversal.status, 403);
      },
      "",
      directory + "/",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

