import http from "node:http";
import { createRegistryDistributor } from "./registry/registry-distribution.js";
import { createRegistryMaintenance } from "./registry/registry-maintenance.js";
import { createNodeHosts } from "./nodes/node-hosts.js";
import { syncRegistryHosts } from './registry/registry-hosts-sync.js';
import { createRegistryNodeAccess } from './registry/registry-node-access.js';
import { createRequestLogger } from "./core/request-logger.js";
import { createClusterService } from "./cluster/cluster-service.js";
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
} from "./core/kubernetes.js";
import { buildNodeLabelsPatch } from "./nodes/node-labels.js";
import { buildPvDefinitionPatch } from './resources/pv-definition.js';
import { buildResourceDefinitionPatch, resourceDefinitionTarget } from './resources/resource-definition.js';
import { deletePod, deleteService, deletePersistentVolumeClaim } from './resources/pod-delete.js';
import { listCustomResources } from './resources/custom-resources.js';
import { buildModulePatch } from "./resources/deployment-config.js";
import { expansionClient } from "./expansion/expansion.js";
import { validateApply, maxManifestBytes } from './core/apply.js';
import { createEventHistory } from './core/event-history.js';
import { createDeploymentPlans } from './resources/deployment-plans.js';
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
  token = process.env.K8S_WEB_TOKEN,
  logger = createRequestLogger({ secrets: [token] }),
  kubernetes = createKubernetes({ logger }),
  staticDirectory = root,
  auditFile = process.env.K8S_AUDIT_FILE ||
    fileURLToPath(new URL("../var/deployment-audit.jsonl", import.meta.url)),
  publicOrigin = process.env.K8S_PUBLIC_ORIGIN,
  expansion = expansionClient(),
  clusterService,
  eventHistory,
} = {}) {
  const registryNodeAccess = createRegistryNodeAccess({ kubernetes, expansion });
  const registryDistributor = createRegistryDistributor({ kubernetes, logger, access: registryNodeAccess });
  const registryMaintenance = createRegistryMaintenance({ distribute: registryDistributor, syncHosts: (record, onProgress) => syncRegistryHosts(record, { kubernetes, distribute: registryDistributor, onProgress }) });
  const nodeHostsService = createNodeHosts({ kubernetes });
  const plans = createDeploymentPlans({ kubernetes });
  const history = eventHistory || createEventHistory({ kubernetes, logger });
  const cluster =
    clusterService ||
    createClusterService({
      logger,
      resolveRegistry: (id, version) => registryMaintenance('RESOLVE', id, { version }),
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
  const server = http.createServer((req, res) =>
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
        const registryRoute = url.pathname.match(/^\/api\/registries(?:\/(parse-certificate|save-status|[a-f0-9-]{36})(\/(?:distribute|certificates))?)?$/);
        const registryNodeAccessRoute = url.pathname.match(/^\/api\/registry-node-access(?:\/(probe|[a-z0-9][a-z0-9-]{0,62}))?$/);
        const nodeHosts = url.pathname.match(/^\/api\/nodes\/([^/]+)\/hosts$/);
        const nodeLabels = url.pathname.match(
          /^\/api\/nodes\/([^/]+)\/labels$/,
        );
        const podDelete = url.pathname.match(/^\/api\/pods\/([^/]+)\/([^/]+)$/);
        const serviceDelete = url.pathname.match(/^\/api\/services\/([^/]+)\/([^/]+)$/);
        const pvcDelete = url.pathname.match(/^\/api\/persistentvolumeclaims\/([^/]+)\/([^/]+)$/);
        const pvDefinition = url.pathname.match(/^\/api\/persistentvolumes\/([^/]+)\/definition$/);
        const resourceDefinition = url.pathname === '/api/resource-definition';
        const configMapUpdate = url.pathname.match(/^\/api\/configmaps\/([^/]+)\/([^/]+)\/data$/);
        const expansionRoute = url.pathname.match(
          /^\/api\/expansion\/(settings|discover|probe|registry\/prepare|hosts\/(?:compare|apply)|targets(?:\/[a-z0-9][a-z0-9-]{0,62})?|tasks(?:\/[a-f0-9-]{36}(?:\/start)?)?)$/,
        );
        const clusterRoute = url.pathname === "/api/cluster/service";
        const applyRoute = url.pathname === "/api/manifests/apply";
        const plansRoute = url.pathname === '/api/deployment-plans' || /^\/api\/deployment-plans\/[a-f0-9-]{36}(?:\/retry)?$/.test(url.pathname);
        if (
          req.method !== "GET" &&
          !(req.method === "DELETE" && (podDelete || serviceDelete || pvcDelete || registryRoute || registryNodeAccessRoute)) &&
          !(req.method === "POST" && (expansionRoute || clusterRoute || applyRoute || plansRoute || nodeHosts || registryRoute || registryNodeAccessRoute)) &&
          !(req.method === "PATCH" && (update || nodeLabels || pvDefinition || resourceDefinition || configMapUpdate || registryRoute))
        )
          return json(res, 405, { error: "不支持该接口的请求方法" });
        if (url.pathname.startsWith("/api/")) {
          if (!authorized(req, token))
            return json(res, 401, { error: "请输入有效的访问令牌" });
          if (registryNodeAccessRoute) {
            if (!token) return json(res, 403, { error: '节点登录配置要求访问令牌' });
            const suffix = registryNodeAccessRoute[1];
            if (!(req.method === 'GET' && !suffix || req.method === 'POST' && (!suffix || suffix === 'probe' || suffix === 'from-expansion') || req.method === 'DELETE' && suffix && !['probe', 'from-expansion'].includes(suffix))) return json(res, 405, { error: '不支持该操作' });
            let body;
            if (req.method !== 'GET') {
              if (req.headers.origin !== (publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`)) return json(res, 403, { error: '节点登录配置请求必须来自当前页面' });
              let source = '';
              for await (const chunk of req) { source += chunk; if (Buffer.byteLength(source) > 16384) return json(res, 413, { error: '请求过大' }); }
              if (req.method === 'POST') try { body = JSON.parse(source); } catch { return json(res, 400, { error: '无效 JSON' }); }
            }
            const result = req.method === 'GET' ? await registryNodeAccess.list() : req.method === 'DELETE' ? await registryNodeAccess.remove(suffix) : suffix === 'probe' ? await registryNodeAccess.probe(body) : suffix === 'from-expansion' ? await registryNodeAccess.importExpansion(body) : await registryNodeAccess.save(body);
            logger.write('registry_node_access', { method: req.method, node: body?.nodeName || suffix || '' });
            return json(res, 200, result);
          }
          if (registryRoute) {
            const parsing = registryRoute[1] === 'parse-certificate';
            const savingStatus = registryRoute[1] === 'save-status';
            const id = parsing || savingStatus ? undefined : registryRoute[1];
            const distributing = registryRoute[2] === '/distribute';
            const importing = registryRoute[2] === '/certificates';
            if (!(savingStatus ? ['GET'] : parsing || importing ? ['POST'] : distributing ? ['GET', 'POST'] : ['GET', ...(id ? ['PATCH', 'DELETE'] : ['POST'])]).includes(req.method)) return json(res, 405, { error: '不支持该操作' });
            if (!token) return json(res, 403, { error: '仓库维护要求配置访问令牌' });
            let body;
            if (req.method !== 'GET') {
              if (req.headers.origin !== (publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`)) return json(res, 403, { error: '仓库修改请求必须来自当前页面' });
              let text = '';
              for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 300000) return json(res, 413, { error: '请求过大' }); }
              try { body = JSON.parse(text); } catch { return json(res, 400, { error: '无效 JSON' }); }
            }
            const result = await registryMaintenance(savingStatus ? 'SAVE_STATUS' : parsing ? 'PARSE_CERTIFICATE' : importing ? 'IMPORT_CERTIFICATES' : distributing ? (req.method === 'GET' ? 'DISTRIBUTION_STATUS' : 'DISTRIBUTE') : req.method, id, req.method === 'GET' && (distributing || savingStatus) ? { taskId: url.searchParams.get('task') } : body);
            logger.write('registry_maintenance', { method: req.method, id: id || result.item?.id });
            return json(res, 200, result);
          }
          if (nodeHosts) {
            if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: '请使用 GET 或 POST' });
            if (!token) return json(res, 403, { error: '管理节点 hosts 要求配置访问令牌' });
            let body;
            if (req.method === 'POST') {
              if (req.headers.origin !== (publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`)) return json(res, 403, { error: 'hosts 修改请求必须来自当前页面' });
              let text = '';
              for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 100000) return json(res, 413, { error: '请求过大' }); }
              try { body = JSON.parse(text); } catch { return json(res, 400, { error: '无效 JSON' }); }
              if (!body || typeof body !== 'object') return json(res, 400, { error: '无效请求' });
            }
            const result = await nodeHostsService(decodeURIComponent(nodeHosts[1]), body);
            logger.write('node_hosts', { node: decodeURIComponent(nodeHosts[1]), operation: body?.change, results: result.results });
            return json(res, 200, result);
          }
          if (pvDefinition) {
            if (req.method !== 'PATCH') return json(res, 405, { error: '请使用 PATCH' });
            if (!token) return json(res, 403, { error: '编辑 PV 定义要求配置访问令牌' });
            if (req.headers.origin !== (publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`))
              return json(res, 403, { error: '编辑 PV 定义请求必须来自当前页面' });
          }
          if (podDelete || serviceDelete || pvcDelete) {
            const match = podDelete || serviceDelete || pvcDelete;
            const label = podDelete ? 'Pod' : serviceDelete ? 'Service' : 'PVC';
            if (req.method !== 'DELETE') return json(res, 405, { error: '请使用 DELETE' });
            if (!token) return json(res, 403, { error: `删除 ${label} 要求配置访问令牌` });
            if (req.headers.origin !== (publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`))
              return json(res, 403, { error: `删除 ${label} 请求必须来自当前页面` });
            const remove = podDelete ? deletePod : serviceDelete ? deleteService : deletePersistentVolumeClaim;
            const resource = await remove(req, kubernetes, match[1], match[2]);
            return json(res, 200, { resource });
          }
          if (applyRoute) {
            if (req.method !== 'POST') return json(res, 405, { error: '请使用 POST' });
            if (!token) return json(res, 403, { error: '应用 YAML 要求配置访问令牌' });
            if (req.headers.origin !== (publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`))
              return json(res, 403, { error: '应用 YAML 请求必须来自当前页面' });
            if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json')
              return json(res, 415, { error: '请使用 application/json' });
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
              size += chunk.length;
              if (size > maxManifestBytes * 6 + 4096) return json(res, 413, { error: '请求过大' });
              chunks.push(chunk);
            }
            let body;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { return json(res, 400, { error: '请求不是有效 JSON' }); }
            validateApply(body);
            const result = await kubernetes.apply(body);
            logger.write('manifest_apply', { serverSide: body.serverSide === true, success: result.success });
            return json(res, 200, result);
          }
          if (plansRoute) {
            if (!token) return json(res, 403, { error: '部署计划执行要求配置访问令牌' });
            if (req.method === 'POST') {
              if (req.headers.origin !== (publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`)) return json(res, 403, { error: '部署计划请求必须来自当前页面' });
              const retryMatch = url.pathname.match(/^\/api\/deployment-plans\/([a-f0-9-]{36})\/retry$/);
              if (retryMatch) return json(res, 202, await plans('RETRY', retryMatch[1]));
              if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json(res, 415, { error: '请使用 application/json' });
              const chunks = []; let size = 0;
              for await (const chunk of req) { size += chunk.length; if (size > 70 * 1024 * 1024) return json(res, 413, { error: 'tar 文件不能超过 50 MiB' }); chunks.push(chunk); }
              let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: '请求不是有效 JSON' }); }
              return json(res, 202, await plans('POST', null, body));
            }
            if (req.method === 'GET') return json(res, 200, await plans('GET', url.pathname.endsWith('/deployment-plans') ? null : url.pathname.split('/').pop()));
          }
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
          if (configMapUpdate) {
            if (req.method !== 'PATCH') return json(res, 405, { error: '请使用 PATCH' });
            if (!token) return json(res, 403, { error: '编辑 ConfigMap 要求配置访问令牌' });
            if (req.headers.origin !== (publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`)) return json(res, 403, { error: 'ConfigMap 修改请求必须来自当前页面' });
            if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json(res, 415, { error: '请使用 application/json' });
            let source = '';
            for await (const chunk of req) { source += chunk; if (Buffer.byteLength(source) > 1024 * 1024) return json(res, 413, { error: '配置请求不能超过 1 MiB' }); }
            let body; try { body = JSON.parse(source); } catch { return json(res, 400, { error: '无效 JSON' }); }
            if (!body || typeof body.uid !== 'string' || typeof body.resourceVersion !== 'string' || !body.data || typeof body.data !== 'object' || Array.isArray(body.data) || Object.entries(body.data).some(([key, value]) => !/^[a-zA-Z0-9._-]+$/.test(key) || typeof value !== 'string')) return json(res, 400, { error: '配置项格式不正确' });
            const target = resourcePath('configmaps', configMapUpdate[1], configMapUpdate[2]);
            const current = await kubernetes.request(target);
            if (current.metadata.uid !== body.uid || current.metadata.resourceVersion !== body.resourceVersion) return json(res, 409, { error: 'ConfigMap 已发生变化，请重新加载后编辑' });
            const patch = [{ op: 'test', path: '/metadata/uid', value: body.uid }, { op: 'test', path: '/metadata/resourceVersion', value: body.resourceVersion }, { op: current.data === undefined ? 'add' : 'replace', path: '/data', value: body.data }];
            const resource = await kubernetes.request(target, true, patch);
            logger.write('configmap_update', { namespace: configMapUpdate[1], name: configMapUpdate[2], resourceVersion: body.resourceVersion });
            return json(res, 200, { resource });
          }
          if (req.method === "PATCH" && resourceDefinition) {
            if (!token) return json(res, 403, { error: '编辑资源定义要求配置访问令牌' });
            if (req.headers.origin !== (publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`)) return json(res, 403, { error: '编辑资源定义请求必须来自当前页面' });
            if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return json(res, 415, { error: '请使用 application/json' });
            const chunks = []; let size = 0;
            for await (const chunk of req) { size += chunk.length; if (size > 132 * 1024) return json(res, 413, { error: '定义请求不能超过 128 KiB' }); chunks.push(chunk); }
            let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: '请求不是有效 JSON' }); }
            const { load, JSON_SCHEMA } = await import('js-yaml');
            let manifest; try { manifest = load(body.manifest, { schema: JSON_SCHEMA }); } catch (error) { return json(res, 400, { error: `定义格式不正确：${error.message}` }); }
            if (!manifest?.kind || !manifest.apiVersion || !manifest.metadata?.name) return json(res, 400, { error: '定义必须包含 apiVersion、kind 和 metadata.name' });
            if (typeof body.uid !== 'string' || typeof body.resourceVersion !== 'string') return json(res, 400, { error: '请基于重新加载的实例编辑；请求缺少 UID 或资源版本校验信息' });
            const target = await resourceDefinitionTarget(kubernetes, manifest, body.namespace || '');
            const current = await kubernetes.request(target);
            const patch = buildResourceDefinitionPatch(current, body);
            const result = await kubernetes.request(target, true, patch);
            return json(res, 200, { resource: result });
          }
          if (req.method === "PATCH" && (update || nodeLabels || pvDefinition)) {
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
              (nodeLabels || pvDefinition)[1],
              nodeLabels ? "labels" : "definition",
            ];
            const resourceKind = pvDefinition ? 'persistentvolumes' : nodeLabels ? 'nodes' : 'deployments';
            const target = resourcePath(
              resourceKind,
              namespace,
              name,
            );
            const current = await kubernetes.request(target);
            const patch = pvDefinition ? buildPvDefinitionPatch(current, body) : nodeLabels
              ? buildNodeLabelsPatch(current, body)
              : buildModulePatch(current, module, body);
            const record = {
              time: new Date().toISOString(),
              namespace,
              name,
              module,
              resource: resourceKind,
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
          if (url.pathname === '/api/operation-logs')
            return json(res, 200, { items: await logger.list?.(300, 'kubernetes_api') || [] });
          if (url.pathname === '/api/events/history')
            return json(res, 200, { items: history.list() });
          const customResources = url.pathname.match(/^\/api\/custom-resources\/([^/]+)(\/count)?$/);
          if (customResources) return json(res, 200, await listCustomResources(kubernetes, customResources[1], customResources[2] ? '' : url.searchParams.get('namespace') || '', !!customResources[2]));
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
  server.once('listening', () => history.start());
  return server;
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
