# KubeScope

部署在 Kubernetes master 节点上的网页运维控制台，支持资源查看和 Deployment 分模块配置更新。React 前端与 Node.js 后端在生产环境共用一个端口，后端通过 Kubernetes REST API 访问真实集群，使用官方 `@kubernetes/client-node` 加载 kubeconfig 和认证。

## 功能

- 集群概览：节点就绪率、可分配 CPU/内存、Pod 运行情况、异常 Pod 列表。
- 查看节点、命名空间、Pods、Deployments、Services、事件及资源 JSON 详情。
- 查看存储声明（PVC）、持久卷（PV）和存储类（StorageClass）：容量、状态、访问模式、绑定关系及 JSON 详情；PVC 支持命名空间筛选。
- 命名空间筛选，按名称、命名空间、标签和节点搜索，按状态筛选。
- Pod 日志：切换普通/初始化/临时容器、最近 100–5000 行、上次实例、每 5 秒刷新、下载；每次日志请求最大 1 MiB。
- 手动刷新或每 15 秒刷新资源。明确展示连接、RBAC、超时、空列表等状态。
- Deployment 第一期配置：镜像与版本、环境变量与 Secret/ConfigMap 引用、CPU/内存与副本数、HTTP/HTTPS 健康检查；模块独立预览和提交，支持多容器选择、并发版本检测、发布状态刷新。
- 资源白名单、请求超时、可选访问令牌。写入仅限 Deployment 四个配置模块，没有删除、exec 或任意命令接口。

CPU/内存展示的是节点 allocatable 容量，不是实时用量，不依赖 metrics-server。

## 环境要求

- Node.js >= 22.12（建议使用 Node.js 24）和 npm。
- 服务运行用户能够读取 kubeconfig 并访问集群 API Server，无需安装 kubectl。
- 默认继承该用户的 kubeconfig、当前 context，可用 `KUBECONFIG` 指定独立配置。

```bash
npm ci
npm run build
npm test
KUBECONFIG=/path/to/readonly-kubeconfig npm start
```

打开 `http://127.0.0.1:3000`。开发模式使用 `npm run dev`，浏览器打开 `http://127.0.0.1:5173`，Vite 将 `/api` 代理给本地后端。

本地调试可单独使用 `.env.local`：

```bash
cp .env.local.example .env.local
# 修改 KUBECONFIG 为本机实际路径
npm run dev
```

开发启动只加载 `.env.local`，不读取生产 `.env`；文件不存在时使用已有环境变量，默认后端监听 `127.0.0.1:3000`。终端中已有的环境变量优先。开发模式前后端同时启动，后端代码修改后自动重启；修改 `.env.local` 后需重新运行 `npm run dev`。`.env.local` 已被 Git 忽略，不进入部署包。`npm start` 仍读取生产 `.env`。

远程管理可以使用 SSH 转发（在自己的电脑上执行），然后访问本地 3000 端口：

```bash
ssh -L 3000:127.0.0.1:3000 user@master
```

需要监听网络地址时必须配置令牌：

```bash
HOST=0.0.0.0 PORT=3000 K8S_WEB_TOKEN='replace-with-a-long-random-token' npm start
```

打开控制台的「连接设置」，填入同一个令牌。令牌只保留在页面内存，刷新页面后需要重新输入。通过网络提供服务时，应在前面配置 HTTPS 反向代理并限制可访问来源；令牌通过 Authorization 请求头传输。前端静态文件可公开读取，全部 `/api/` 接口均要求令牌（若已配置），包括配置更新；本项目不提供多用户权限管理，共享访问令牌的用户具有相同操作权限，最终权限由后端 kubeconfig 的 RBAC 决定。

## 配置

| 环境变量        | 默认值           | 用途                              |
| --------------- | ---------------- | --------------------------------- |
| `HOST`          | `127.0.0.1`      | 监听地址；非本地地址强制要求令牌  |
| `PORT`          | `3000`           | HTTP 端口                         |
| `KUBECONFIG` | `~/.kube/config` 或集群内 ServiceAccount | 由官方客户端读取的集群配置 |
| `K8S_WEB_TOKEN` | 空               | 配置后所有 API 均需要 Bearer 令牌 |
| `K8S_AUDIT_FILE` | 项目下 `var/deployment-audit.jsonl` | Deployment 模块操作日志，包含时间、目标、模块、容器、来源地址、版本及结果，不包含变量值或令牌；运行用户需有目录写权限 |
| `K8S_PUBLIC_ORIGIN` | 由后端协议和 Host 推导 | HTTPS 反向代理部署时设置浏览器访问的来源，如 `https://kubescope.example.com`，不含路径及末尾斜线，用于写入来源检查 |

每次 API 请求具有 15 秒总超时（含认证），资源 JSON 响应上限 10 MiB。大规模集群可切换到具体命名空间缩小工作负载查询范围。概览独立读取各资源，单项无权限不会阻止其他资源展示。节点、命名空间、PV 和 StorageClass 属于集群级资源，不随命名空间选择变化。

## Ubuntu / master 节点部署

完整步骤见 [DEPLOYE.md](DEPLOYE.md)。在本地执行 `bash package.sh` 完成依赖安装、测试和构建，将 `releases/` 中的部署包上传服务器，解压到 `/opt/kubescope`，无需在服务器安装 npm 依赖或构建源码。

systemd 模板使用现有 `zhiwenxia` 用户运行，复用该用户可用的 kubeconfig。按实际环境配置 Node.js 的绝对路径，以及 `/opt/kubescope/.env` 中的 `KUBECONFIG`。systemd 不加载交互式 shell 配置，需显式设置相关环境变量。

## HTTP API

查询接口均为 GET，配置令牌后需 `Authorization: Bearer <token>`。模块更新接口见下节。

| 路径                                                                        | 说明                                                                                               |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/api/health`                                                               | 当前 context 与 API server 连通性检查                                                              |
| `/api/resources/:kind?namespace=default`                                    | kind 为 nodes/namespaces/pods/deployments/services/events/persistentvolumeclaims/persistentvolumes/storageclasses；省略 namespace 时工作负载跨命名空间查询 |
| `/api/resources/:kind/:name?namespace=default`                              | 单资源 JSON；命名空间资源应指定 namespace                                                          |
| `/api/logs?namespace=default&pod=web&container=app&tail=200&previous=false` | 带时间戳的日志快照                                                                                 |

日志自动刷新是定时重新获取快照，不是持续日志流连接。接口支持下述 Deployment 模块变更，不支持在浏览器切换 kubeconfig/context。

## Deployment 模块配置（第一期）

左侧导航最多三级，分组如下。分组可折叠，当前页面的父级会自动展开，资源叶子保留数量提示；移动端选择页面后收起侧栏。

```text
集群概览
集群资源
  节点
  命名空间
应用管理
  Deployments
    部署列表
    镜像与版本
    环境变量与外部连接
    计算资源与副本
    健康检查
  Pods
网络与存储
  网络访问
    Services
  存储资源
    存储声明 PVC
    持久卷 PV
    存储类
运维诊断
  集群事件
```

点击四个配置模块中的任意一项，先展示可搜索、可按命名空间筛选的 Deployment 列表。选择目标部署后，仅打开选中的模块；「部署列表 → 配置」仍可同时查看四个模块。

进入 Deployments 列表，点击「配置」，或在详情中选择「模块配置」。配置页先读取最新资源，选择普通容器后分别编辑四个模块；每个模块先预览修改前后内容，再确认保存。其他模块的草稿会保留。关闭、切换容器或重新加载时，如有未保存修改会提示。

更新接口：`PATCH /api/deployments/:namespace/:name/modules/:module`，其中 module 只能为 `image`、`environment`、`resources`、`probes`。请求需要 `Content-Type: application/json`，最大 128 KiB，沿用访问令牌。示例请求体：

```json
{
  "uid": "从最新 Deployment metadata.uid 读取",
  "resourceVersion": "从最新 Deployment metadata.resourceVersion 读取",
  "container": "online-office",
  "values": {
    "image": "harbor.k8s.local/library/online-office:2026.10.24",
    "imagePullPolicy": "IfNotPresent"
  }
}
```

- 镜像模块：完整镜像地址与拉取策略。环境变量模块：`env` 数组，支持明文、Secret 和 ConfigMap Key 引用；不读取 Secret 正文，现有 Downward API 引用可保留或删除，`envFrom` 保持原样。
- 资源模块：`replicas`、`requests`、`limits`；后两者只编辑 CPU 和内存，空字符串移除此项，其他资源字段保持原样。副本数可为 0；副本数影响整个 Deployment，资源配置影响所选容器。
- 探针模块：`livenessProbe`、`readinessProbe`，关闭时为 `null`。第一期编辑 HTTP/HTTPS 探针的路径、端口、周期和阈值；现有主机、请求头等配置保留。非 HTTP 探针支持保留或关闭。

后端只生成白名单字段的 JSON Patch，并在同一原子请求中测试 UID 和 resourceVersion，防止覆盖并发修改或同名重建资源。版本变化返回 409，应重新加载并核对配置后编辑。保存结果表示 API Server 已接受配置，不表示 Pod 发布完成；页面每 5 秒刷新 observedGeneration、最新/可用副本和失败条件。模板变更按 Deployment 当前策略更新 Pod，暂停的 Deployment 会显示暂停状态；仅修改副本数属于扩缩容。网络超时可能发生在集群已经接受请求之后，应先重新加载确认实际状态。

写入前先记录操作意图；审计目录无法写入时不会提交集群更新。操作日志为 JSONL，请按部署需要持久化并轮转；日志中的来源地址可能是反向代理地址。本项目没有独立用户身份审计，也不在第一期提供一键回滚。

后端使用的 kubeconfig 需要目标命名空间下 Deployment 的 `get` 和 `patch` 权限；列表查询仍需原有读取权限。`deploy/deployment-editor-role.yaml` 提供 onlyoffice 命名空间的附加 Role 示例，需由管理员绑定给实际运行身份。程序不会自动授予权限。已有只读身份可继续查询，但保存会被 Kubernetes 拒绝。

反向代理应传递与浏览器一致的 Host；如由代理终止 HTTPS，请设置 `K8S_PUBLIC_ORIGIN` 为浏览器访问的完整来源，例如 `https://kubescope.example.com`。该配置仅用于来源校验，不信任任意转发请求头。

并发更新依据 [Kubernetes 官方 API 文档](https://kubernetes.io/docs/reference/using-api/api-concepts/#updates-to-existing-resources)实现。

## 验证

`npm test` 覆盖只读接口、令牌、请求参数校验、作用域、日志限制、超时和错误传播；测试使用本机模拟 Kubernetes HTTP 服务，不连接或修改集群。`npm run build` 验证生产前端构建。实际部署后还需使用目标 kubeconfig 验证真实集群、RBAC 和日志。

配置在首次请求时加载，修改 kubeconfig/context 后需重启服务。客户端支持 CA、客户端证书、Bearer Token 和 kubeconfig exec 认证插件；exec 插件仍需其外部认证程序。旧的 `KUBECTL_PATH` 配置已停用，可删除。部署包包含生产依赖。

API 实现依据 Context7 查询的 [Kubernetes 官方 JavaScript 客户端文档](https://github.com/kubernetes-client/javascript/blob/main/docs/docs/intro.md)及 [kubeconfig 认证实现](https://github.com/kubernetes-client/javascript/blob/main/src/config.ts)，当前依赖版本为 `2.0.1`。
