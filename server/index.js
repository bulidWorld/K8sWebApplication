import http from "node:http";
import { createRequestLogger } from "./request-logger.js";
import { createClusterService } from "./cluster-service.js";
import {
  readFile,
  stat,
  appendFile,
  mkdir,
  copyFile,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import {
  createKubernetes,
  resourcePath,
  logsPath,
  managedKubeconfig,
} from "./kubernetes.js";
import { buildNodeLabelsPatch } from "./node-labels.js";
import { buildModulePatch } from "./deployment-config.js";
import { expansionClient } from "./expansion.js";
const root = fileURLToPath(new URL("../dist/", import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
function json(res, status, body) {
  if (status >= 400 && !res.requestError)
    res.requestError = new Error(body.error || `HTTP ${status}`);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}
function authorized(req, token) {
  if (!token) return true;
  const actual = Buffer.from(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function createApp({
  kubernetes = createKubernetes(),
  token = process.env.K8S_WEB_TOKEN,
  staticDirectory = root,
  auditFile = process.env.K8S_AUDIT_FILE ||
    fileURLToPath(new URL("../var/deployment-audit.jsonl", import.meta.url)),
  publicOrigin = process.env.K8S_PUBLIC_ORIGIN,
  expansion = expansionClient(),
  clusterService,
  logger = createRequestLogger({ secrets: [token] }),
} = {}) {
  const cluster =
    clusterService ||
    createClusterService({
      logger,
      reload: async (file) => {
        await mkdir(path.dirname(managedKubeconfig), {
          recursive: true,
          mode: 0o700,
        });
        await copyFile(file, managedKubeconfig);
        await chmod(managedKubeconfig, 0o600);
        kubernetes.reload(managedKubeconfig);
      },
    });
  const staticRoot = path.resolve(staticDirectory);
  return http.createServer((req, res) =>
    logger.request(req, res, async () => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "same-origin");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      );
      try {
        const url = new URL(req.url, "http://localhost");
        const update = url.pathname.match(
          /^\/api\/deployments\/([^/]+)\/([^/]+)\/modules\/(image|environment|resources|probes)$/,
        );
        const nodeLabels = url.pathname.match(
          /^\/api\/nodes\/([^/]+)\/labels$/,
        );
        const expansionRoute = url.pathname.match(
          /^\/api\/expansion\/(settings|discover|probe|registry\/prepare|hosts\/(?:compare|apply)|targets(?:\/[a-z0-9][a-z0-9-]{0,62})?|tasks(?:\/[a-f0-9-]{36}(?:\/start)?)?)$/,
        );
        const clusterRoute = url.pathname === "/api/cluster/service";
        if (
          req.method !== "GET" &&
          !(req.method === "POST" && (expansionRoute || clusterRoute)) &&
          !(req.method === "PATCH" && (update || nodeLabels))
        )
          return json(res, 405, { error: "不支持该接口的请求方法" });
        if (url.pathname.startsWith("/api/")) {
          if (!authorized(req, token))
            return json(res, 401, { error: "请输入有效的访问令牌" });
          if (clusterRoute) {
            if (!token)
              return json(res, 403, { error: "集群服务操作要求配置访问令牌" });
            if (req.method === "GET")
              return json(res, 200, await cluster("GET"));
            if (
              req.headers.origin !==
              (publicOrigin ||
                `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`)
            )
              return json(res, 403, { error: "集群服务请求必须来自当前页面" });
            if (
              (req.headers["content-type"] || "").split(";")[0] !==
              "application/json"
            )
              return json(res, 415, { error: "请使用 application/json" });
            let data = "";
            for await (const chunk of req) {
              data += chunk;
              if (Buffer.byteLength(data) > 4096)
                return json(res, 413, { error: "请求过大" });
            }
            let body;
            try {
              body = JSON.parse(data);
            } catch {
              return json(res, 400, { error: "无效 JSON" });
            }
            return json(res, 202, await cluster("POST", body));
          }
          if (expansionRoute) {
            if (!token)
              return json(res, 403, { error: "扩容功能要求配置访问令牌" });
            if (req.method === "POST") {
              if (
                req.headers.origin !==
                (publicOrigin ||
                  `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`)
              )
                return json(res, 403, { error: "扩容请求必须来自当前页面" });
              if (
                (req.headers["content-type"] || "").split(";")[0] !==
                "application/json"
              )
                return json(res, 415, { error: "请使用 application/json" });
              let data = "";
              for await (const chunk of req) {
                data += chunk;
                if (Buffer.byteLength(data) > 4096)
                  return json(res, 413, { error: "请求过大" });
              }
              let body;
              try {
                body = JSON.parse(data);
              } catch {
                return json(res, 400, { error: "无效 JSON" });
              }
              return json(
                res,
                200,
                await expansion("POST", `/${expansionRoute[1]}`, {
                  ...body,
                  source: req.socket.remoteAddress,
                }),
              );
            }
            return json(
              res,
              200,
              await expansion("GET", `/${expansionRoute[1]}`),
            );
          }
          if (req.method === "PATCH" && (update || nodeLabels)) {
            if (
              !(req.headers["content-type"] || "")
                .toLowerCase()
                .split(";")[0]
                .trim()
                .match(/^application\/json$/)
            )
              return json(res, 415, { error: "请使用 application/json" });
            if (
              req.headers.origin &&
              req.headers.origin !==
                (publicOrigin ||
                  `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`)
            )
              return json(res, 403, { error: "不允许跨来源更新" });
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > 128 * 1024)
                return json(res, 413, { error: "配置请求不能超过 128 KiB" });
              chunks.push(chunk);
            }
            let body;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              return json(res, 400, { error: "请求不是有效 JSON" });
            }
            const [, namespace, name, module] = update || [
              null,
              undefined,
              nodeLabels[1],
              "labels",
            ];
            const target = resourcePath(
              nodeLabels ? "nodes" : "deployments",
              namespace,
              name,
            );
            const current = await kubernetes.request(target);
            const patch = nodeLabels
              ? buildNodeLabelsPatch(current, body)
              : buildModulePatch(current, module, body);
            const record = {
              time: new Date().toISOString(),
              namespace,
              name,
              module,
              resource: nodeLabels ? "nodes" : "deployments",
              container: body.container,
              resourceVersion: body.resourceVersion,
              remoteAddress: req.socket.remoteAddress,
            };
            // Never record environment values or Secret contents.
            await mkdir(path.dirname(auditFile), { recursive: true });
            await appendFile(
              auditFile,
              JSON.stringify({ ...record, outcome: "requested" }) + "\n",
              { mode: 0o600 },
            );
            let result;
            try {
              result = await kubernetes.request(target, true, patch);
            } catch (error) {
              res.requestError = error;
              await appendFile(
                auditFile,
                JSON.stringify({
                  ...record,
                  outcome: "failed",
                  status: error.status || 500,
                }) + "\n",
              );
              if (
                [409, 422].includes(error.status) &&
                /test|conflict|modified/i.test(error.message)
              )
                return json(res, 409, {
                  error: "配置已发生变化，请重新加载后再编辑。",
                });
              throw error;
            }
            try {
              await appendFile(
                auditFile,
                JSON.stringify({
                  ...record,
                  outcome: "submitted",
                  newResourceVersion: result.metadata?.resourceVersion,
                }) + "\n",
              );
            } catch {
              return json(res, 200, {
                resource: result,
                warning: "配置已提交，但结果日志写入失败，请检查审计目录。",
              });
            }
            return json(res, 200, { resource: result });
          }
          if (url.pathname === "/api/health") {
            try {
              await kubernetes.request("/version");
            } catch (error) {
              logger.error(error, { operation: "cluster_health" });
              if (["ECONNREFUSED", "NO_CLUSTER"].includes(error.code))
                return json(res, 200, {
                  connected: false,
                  needsCluster: true,
                  error:
                    "未检测到 API Server 端口，请启动 K8s 集群，或安装 K8s 集群服务。",
                });
              throw error;
            }
            const context = kubernetes.context();
            return json(res, 200, { connected: true, context });
          }
          if (url.pathname === "/api/logs")
            return json(res, 200, {
              logs: await kubernetes.request(logsPath(url.searchParams), false),
            });
          const match = url.pathname.match(
            /^\/api\/resources\/([a-z]+)(?:\/([^/]+))?$/,
          );
          if (match)
            return json(
              res,
              200,
              await kubernetes.request(
                resourcePath(
                  match[1],
                  url.searchParams.get("namespace"),
                  match[2],
                ),
              ),
            );
          return json(res, 404, { error: "接口不存在" });
        }
        const pathname = decodeURIComponent(url.pathname);
        const target = path.resolve(staticRoot, `.${pathname}`);
        if (
          target !== staticRoot &&
          !target.startsWith(`${staticRoot}${path.sep}`)
        )
          return json(res, 403, { error: "无效路径" });
        let file = target;
        try {
          if (!(await stat(file)).isFile())
            file = path.join(staticRoot, "index.html");
        } catch {
          file = path.join(staticRoot, "index.html");
        }
        try {
          const data = await readFile(file);
          res.writeHead(200, {
            "Content-Type":
              mime[path.extname(file)] || "application/octet-stream",
            "Cache-Control": "no-cache",
          });
          res.end(data);
        } catch (error) {
          res.requestError = error;
          json(res, 503, { error: "前端尚未构建，请先执行 npm run build。" });
        }
      } catch (error) {
        res.requestError = error;
        json(res, error.status || 500, {
          error: error.message || "服务内部错误",
        });
      }
    }),
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.getuid?.() !== 0) {
    console.error(
      "Web 应用需要以 root 用户启动，请使用 sudo bash deploy.sh 部署。",
    );
    process.exit(1);
  }
  const host = process.env.HOST || "0.0.0.0";
  const port = Number(process.env.PORT || 3000);
  if (
    !["127.0.0.1", "localhost", "::1"].includes(host) &&
    !process.env.K8S_WEB_TOKEN
  ) {
    console.error("监听非本地地址必须设置 K8S_WEB_TOKEN。");
    process.exit(1);
  }
  createApp().listen(port, host, () =>
    console.log(`KubeScope listening on http://${host}:${port}`),
  );
}
