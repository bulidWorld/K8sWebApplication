# KubeScope

部署在 Kubernetes master 节点上的网页运维控制台，支持资源查看和 Deployment 分模块配置更新。React 前端与 Node.js 后端在生产环境共用一个端口，后端通过 Kubernetes REST API 访问真实集群，使用官方 `@kubernetes/client-node` 加载 kubeconfig 和认证。

## 功能

- 集群概览：节点就绪率、可分配 CPU/内存、Pod 运行情况、异常 Pod 列表。
- 查看节点、命名空间、Pods、Deployments、Services、事件及资源 JSON 详情。
- 在“集群资源 → 自定义资源定义 CRD”查看 CustomResourceDefinition 的 API 组、Kind、作用域、提供的版本、存储版本、状态和 JSON 详情，支持搜索、状态筛选及 JSON 下载。CRD 属于集群级资源，不受命名空间筛选影响；专用只读身份需要 `deploy/rbac.yaml` 中的 CRD get/list 权限。
- Service 列表支持查看详情、下载 JSON 和删除。删除须确认，使用 UID 前置条件保护同名重建资源；要求访问令牌、同源请求及当前集群身份的 `services/delete` 权限。删除 Service 会中断经该服务的访问，不删除关联 Pod；只读角色 `deploy/rbac.yaml` 不包含删除权限。
- CRD 列表“实例数”列显示对应 CR 的集群总数（跨全部命名空间），点击数量可查看实例。数量异步加载并随列表刷新，统计分页结果；权限不足或查询失败显示“读取失败”，悬停可查看原因。
- CRD 列表操作列提供“查看 CR”，打开对应实例列表，支持命名空间查询、搜索、刷新、JSON 详情及下载。优先使用 served 的存储版本，否则使用第一个 served 版本。通过 API Server 查询；集群身份还需拥有对应 API 组和资源的 `list` 权限（仅 CRD get/list 权限不足）。
- 查看存储声明（PVC）、持久卷（PV）和存储类（StorageClass）：容量、状态、访问模式、绑定关系及 JSON 详情；PVC 支持命名空间筛选。
- PV 定义编辑：在持久卷列表点击“编辑定义”，支持 YAML/JSON 修改标签、注解及 spec，保存后刷新详情和列表；未保存离开提醒，UID/资源版本并发保护，失败保留编辑内容。
- 命名空间筛选，按名称、命名空间、标签和节点搜索，按状态筛选。
- Pod 删除：列表中点击“删除”后弹框确认，展示命名空间及名称，提交后刷新列表。使用 UID 前置条件防止误删同名重建 Pod，遵循默认终止宽限期；删除权限见 `deploy/pod-delete-rbac.yaml`，需绑定到 kubeconfig 使用的身份。
- Pod 日志：切换普通/初始化/临时容器、最近 100–5000 行、上次实例、每 5 秒刷新、下载；每次日志请求最大 1 MiB。
- 手动刷新或每 15 秒刷新资源。明确展示连接、RBAC、超时、空列表等状态。
- Deployment 第一期配置：镜像与版本、环境变量与 Secret/ConfigMap 引用、CPU/内存与副本数、HTTP/HTTPS 健康检查；模块独立预览和提交，支持多容器选择、并发版本检测、发布状态刷新。
- 资源白名单、请求超时、可选访问令牌。默认提供 Deployment 四个配置模块写入；页面初始化后可启用内置任务引擎，支持固定流程的 Worker 扩容，仅支持单个 Pod 删除，没有 exec 或任意命令接口。

CPU/内存展示的是节点 allocatable 容量，不是实时用量，不依赖 metrics-server。

## 环境要求

- Node.js >= 22.12（建议使用 Node.js 24）和 npm。
- 生产 Web 服务以 root 运行，能够读取 kubeconfig 并访问集群 API Server；启用扩容时 master 还需 kubeadm、kubectl 和 SSH。
- 默认继承该用户的 kubeconfig、当前 context，可用 `KUBECONFIG` 指定独立配置。

```bash
npm ci
npm run build
npm test
sudo env KUBECONFIG=/path/to/kubeconfig "$(command -v node)" --env-file=.env server/index.js
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
sudo env HOST=0.0.0.0 PORT=3000 K8S_WEB_TOKEN='replace-with-a-long-random-token' "$(command -v node)" --env-file=.env server/index.js
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

完整步骤见 [DEPLOYE.md](DEPLOYE.md)。在本地执行 `bash package.sh` 完成依赖安装、测试和构建，将 `releases/` 中的部署包上传服务器，解压后目录自带版本号，例如 `/opt/kubescope-1.0.0`，无需在服务器安装 npm 依赖或构建源码。服务器缺少 Node.js 时，`deploy.sh` 会调用随包提供的 `install_node.sh` 安装 Node.js 24 LTS（官方安装包并校验 SHA256）。

打包后可运行 `bash remote_deploye.sh`，自动将最新构建包上传到 `192.168.100.132`，解压并通过 sudo 执行 deploy.sh。默认 SSH 用户为 `zhiwenxia`，可用 `--user` 修改；`--dry-run` 可先预览而不连接远端。升级时保留旧配置和扩容数据，完整参数见 `bash remote_deploye.sh --help`。

systemd 模板以 `root` 用户运行，扩容任务直接在 Web 后端执行，无需独立执行器服务。按实际环境配置 Node.js 的绝对路径，以及 解压目录中的 `.env` 中的 `KUBECONFIG`。systemd 不加载交互式 shell 配置，需显式设置相关环境变量。

## 节点扩容

节点页面提供“添加节点”：首次在页面自动识别并保存集群参数，填写新机器 IP、SSH 用户并核对指纹，输入登录密码和 sudo 密码后，先对比 master 与新节点的 hosts 配置；页面显示原文、解析映射差异和修改预览，可确认合并或保持原配置，再开始预检、安装并入群。Web 以 root 运行，后台自动创建配置目录与文件，无需手动复制 JSON 或部署独立执行器。密码仅用于当前任务，不落盘。详见 [节点扩容说明](deploy/EXPANSION.md)。

## HTTP API

查询接口均为 GET，配置令牌后需 `Authorization: Bearer <token>`。模块更新接口见下节。

| 路径                                                                        | 说明                                                                                               |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/api/health`                                                               | 当前 context 与 API server 连通性检查                                                              |
| `/api/resources/:kind?namespace=default`                                    | kind 为 nodes/namespaces/pods/deployments/services/events/persistentvolumeclaims/persistentvolumes/storageclasses/customresourcedefinitions；省略 namespace 时工作负载跨命名空间查询 |
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

### API Server 未启动与全新集群安装

未配置当前集群或 API Server 连接被拒绝时，页面提示启动 K8s 集群或安装 K8s 集群服务。证书、权限等错误仍显示连接错误。

集群服务操作需要 root 后端、有效的 `K8S_WEB_TOKEN` 和同源请求。操作仅作用于 Web 后端所在主机，远程集群须在远端控制平面操作。启动选项恢复本机 kubeadm 控制平面的 containerd 和 kubelet；未发现控制平面时提示安装。

安装选项需填写本机非回环 IPv4 与完整 Kubernetes 版本（1.31–1.35）。安装沿用项目的 Ubuntu / containerd 版本策略，要求至少 2 CPU、约 2 GiB 内存、10 GiB 可用磁盘及 cgroup v2，并需要访问 Ubuntu、pkgs.k8s.io、GitHub 与容器镜像仓库。它关闭 swap、配置内核网络、安装 containerd、kubelet、kubeadm、kubectl，执行 kubeadm init，再安装固定版本 Flannel v0.26.7，等待 API、节点和系统 Pod 就绪。Pod CIDR 为 `10.244.0.0/16`，Service CIDR 为 `10.96.0.0/12`，安装前请确认宿主网络无冲突。控制平面保持默认调度污点，业务工作负载可通过现有节点扩容功能添加工作节点后部署。

已有 admin.conf、kubelet.conf、etcd 数据或占用的 6443 端口会阻止全新初始化；不会自动 reset 或覆盖已有集群。部分初始化失败后需先检查日志和主机状态。后台任务状态保存在 `var/cluster/task.json`；服务重启后未完成任务显示中断。成功后将管理员 kubeconfig 以 0600 权限保存到 `var/cluster/kubeconfig`，控制台及后续重启优先使用它；如需切回原 kubeconfig，请由管理员移除此文件并重启 Web 服务。

安装步骤参考 [kubeadm 创建集群文档](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/create-cluster-kubeadm/) 和 [Flannel 安装文档](https://github.com/flannel-io/flannel)。

### 自建镜像仓库

集群服务区域提供“自建镜像仓库”，填写仓库 IPv4、证书接口协议、端口和证书导出 Token 后点击配置。操作目标是运行 Web 后端的本机，需要 root 和已有 containerd 配置。后端直接调用 `server/registry-service.js` 的 `configureRegistry()`，在当前 Node.js 进程内完成请求、证书校验和文件操作，不启动独立 Node.js 进程，也不执行 registry.sh。仅 containerd 配置验证及 systemctl 服务重启调用系统命令。

本机后端通过 Node.js 原生 HTTP/HTTPS 直连仓库 IP（绕过环境代理，临时服务错误最多重试两次），携带 Bearer Token 请求 `<协议>://<仓库IP>:<证书接口端口>/api/tls/bundle`，读取 `certificate` 和 `privateKey`。校验证书有效期、证书与私钥匹配及四个镜像域名后，备份并修改 `/etc/hosts`，将 `docker.io`、`registry-1.docker.io`、`ghcr.io`、`registry.k8s.io` 指向填写的 IP，保留其他域名和注释。证书接口协议可选择 HTTPS 或 HTTP，默认 HTTPS；端口可配置，HTTPS 默认 443、HTTP 默认 80；镜像仓库需监听 HTTPS 443，并预先存有所需镜像。

证书和私钥存入 `/etc/kubescope/registry/`，目录权限 0700、私钥 0600。containerd 使用 `/etc/containerd/certs.d/<域名>/ca.crt` 和 `hosts.toml` 验证仓库 TLS，按配置版本 2/3 补齐对应 registry 表中的 `config_path`，先用 containerd 验证候选配置，再备份并写入正式配置、重启服务；拉取时不关闭 TLS 校验，也不使用仓库服务端私钥作为客户端身份。Token 仅用于本次请求，不保存到任务记录；表单在任务提交后清空 Token。

本机 hosts 和 containerd 主配置备份分别为 `/etc/hosts.kubescope-registry-<时间>-<UUID>.bak`、`/etc/containerd/config.toml.kubescope-registry-<时间>-<UUID>.bak`。失败日志包含阶段、文件路径及 JavaScript 堆栈，并过滤 Token 和私钥。本机配置入口仅操作 Web 后端主机；工作节点可在“节点扩容”中勾选“使用自建镜像仓库”，填写仓库 IP 和 Token。扩容流程在安装 containerd 后、执行 kubeadm join 前，通过 SSH 执行 `server/provision/registry.sh` 在目标节点获取 bundle（远程节点无需 Node.js）、修改 hosts 并配置证书；仓库配置失败会停止入群。每次扩容需重新填写 Token，Token 不保存到扩容配置或任务记录。配置失败时检查任务日志及备份，完成实际镜像拉取验证后再部署业务。

### 集群部署镜像检查

在“K8s 集群服务”中填写完整 Kubernetes 版本，点击“解析所需镜像”。后端使用 `kubeadm config images list --kubernetes-version` 获取控制平面、etcd、CoreDNS、pause 等清单，并解析安装流程共用的 Flannel v0.26.7 YAML，合并普通容器及初始化容器镜像。需要本机预先安装 kubeadm，且能够访问 Flannel 配置下载地址。

解析只生成清单，不会自动拉取。列表支持“一键拉取全部镜像”和逐项“拉取 / 重试”，通过本机 containerd 的 `ctr` 拉取至 `k8s.io` 命名空间，使用 `/etc/containerd/certs.d` 的仓库及证书配置。批量拉取中单项失败不影响其余镜像；页面显示每项状态与错误，结果随任务持久化。内容完整且已解包的镜像直接复用，其余补齐。需先启动 containerd；自建仓库请先完成仓库配置。操作目标为 Web 后端所在节点。

### 分步骤部署 K8s 集群

进入部署向导，按页面顺序手动执行，在需要时填写对应配置：

1. 安装 containerd：无需填写版本或 IP。先检查已有运行时及 CRI；可用时保留配置并复用，未安装时准备主机环境并安装。
2. 配置镜像仓库：可选，也可使用默认镜像源。
3. 安装 Kubernetes 工具：在此选择完整版本，已安装目标版本的 kubeadm、kubelet、kubectl 会复用，缺失组件会补齐；版本不一致时停止并提示。
4. 解析所需镜像：读取 kubeadm 与 Flannel 镜像清单，展示镜像地址、来源和状态；此步不下载镜像。
5. 拉取镜像：一键拉取全部镜像，或逐项拉取、重试。全部镜像就绪后才能继续初始化；重新解析新增的镜像也需完成拉取。
6. 初始化控制平面：在此确认自动检测的本机 IPv4，可手动修改。已有控制平面只核对版本、IP 和就绪状态，不重复初始化。
7. 安装 Flannel 网络插件：已有 DaemonSet 时检查就绪状态，否则安装。
8. 验证集群：检查 API Server、节点、系统 Pod 和 Flannel 就绪，加载集群连接。

每次点击只执行选中步骤，前置步骤成功后才可继续。已完成步骤也可点击“重新检查并执行”；失败或服务重启中断后可重试。版本在首次执行工具安装时锁定，IP 在首次执行初始化时锁定，刷新页面会恢复配置、进度及各步日志。旧部署记录中已锁定的配置继续沿用。初始化失败时不会自动 reset；若留下不完整配置，需要人工检查处理后再重试。

## 节点标签管理

进入「节点」，点击行内「标签（数量）」或详情中的「标签」页签，查看完整标签键和值。修改值或点击「删除」后，点击「保存标签」统一提交；删除可撤销，空字符串是有效标签值。重新加载可读取最新节点数据，存在未保存修改时会提示确认。

接口：`PATCH /api/nodes/{name}/labels`，请求示例：

```json
{"uid":"节点 UID","resourceVersion":"节点版本","changes":{"example.com/zone":"zone-a","obsolete-label":null}}
```

仅修改 `changes` 中的标签，`null` 表示删除。后端校验标签格式，并通过 JSON Patch 原子检查 UID 与 resourceVersion；并发变化返回 409，需重新加载后编辑。请求与结果写入现有 `K8S_AUDIT_FILE` 审计文件。保存时的连接失败可能发生在 API Server 已接受请求之后，应重新加载核实结果。

运行身份需要集群级 Nodes 的 `get`、`list`、`patch` 权限。`deploy/node-labels-rbac.yaml` 提供可选 ClusterRole，需绑定至实际 kubeconfig 身份；应用不会自动授予权限。Kubernetes RBAC 的 `patch` 权限针对整个 Node，网页接口将变更限定为标签。

## 弹窗地址

弹窗状态保存在地址栏 Hash 的查询参数中，可复制链接；打开、切换资源页签和关闭弹窗都会同步地址栏，并支持浏览器前进/后退。

- 节点标签：`#/nodes?dialog=resource&kind=nodes&name=worker-1&tab=labels`
- Pod 删除：列表中点击“删除”后弹框确认，展示命名空间及名称，提交后刷新列表。使用 UID 前置条件防止误删同名重建 Pod，遵循默认终止宽限期；删除权限见 `deploy/pod-delete-rbac.yaml`，需绑定到 kubeconfig 使用的身份。
- Pod 日志：`#/pods?dialog=resource&kind=pods&name=web-1&namespace=apps&tab=logs`
- Deployment 环境变量：`#/deployments/environment?dialog=resource&kind=deployments&name=web&namespace=apps&tab=config%3Aenvironment`
- 添加节点：`#/nodes?dialog=add-node`
- 历史任务：`#/nodes?dialog=node-history`
- 镜像仓库进度（集群安装界面）：`#/overview?dialog=registry-progress`

刷新或直接访问链接后，输入访问 Token 即可恢复可用的弹窗。资源弹窗会按名称和命名空间重新读取数据；资源不存在或无权访问时显示错误。URL 不保存 Token、密码、未提交草稿或执行操作，恢复流程弹窗不会自动提交安装/扩容任务。存在未保存配置时，离开弹窗会提示确认。

### 上传 YAML 并应用资源

顶部“上传 YAML / Apply”支持上传或粘贴最大 10 MiB 的 YAML/JSON、多个 YAML 文档及 `kind: List`，每次最多 100 个资源。接口为 `POST /api/manifests/apply`，JSON 请求体包含 `manifest` 字符串和 `serverSide` 布尔值；要求访问令牌和同源 Origin。

此功能直接使用当前 kubeconfig 调用 Kubernetes API，不需要 kubectl，也不写出临时 kubeconfig。通过 API discovery 解析资源路径与作用域，支持已注册的 CRD。命名空间优先使用资源声明，否则使用当前 context 的 namespace（缺省为 default）。

- 勾选 `--server-side`：发送 `application/apply-patch+yaml` PATCH，使用 `fieldManager=kubescope`；不强制覆盖字段冲突。
- 未勾选：GET 当前资源，不存在时 POST 创建；存在时根据 `kubectl.kubernetes.io/last-applied-configuration` 计算 JSON Merge Patch，记录新配置，并用 resourceVersion 防止并发覆盖。保留未管理的对象字段，删除上次声明但此次移除的字段。**列表整体替换，不等同于 kubectl 对内置资源的 Strategic Merge Patch 列表合并**；需要字段归属及 schema 驱动的列表合并时使用服务端模式。

运行身份需要 discovery 读取权限及目标资源的相应 get/create/patch 权限。多个资源逐个提交，不具备事务回滚；响应 `success` 表示全部是否成功，`output` 和 `diagnostics` 展示成功和失败结果。新建 CRD 后立即提交实例可能因 API 尚未就绪失败，需要待 CRD 就绪后重试。请求日志不会记录 YAML 或 API 错误详情，以避免泄露 Secret 内容。

Pod 删除接口：`DELETE /api/pods/:namespace/:name`，JSON 请求体为 `{"uid":"Pod UID"}`，要求访问令牌和同源 Origin。保留 Kubernetes 403/404/409 等错误，禁止批量删除和强制删除参数。删除行为参见 [Kubernetes Pod API](https://kubernetes.io/docs/reference/kubernetes-api/core/pod-v1/)。

PV 定义接口：`PATCH /api/persistentvolumes/:name/definition`，JSON 请求体包含 `manifest`（YAML/JSON 字符串）、`uid`、`resourceVersion`，最大 128 KiB，要求访问令牌和同源 Origin。可选权限见 `deploy/pv-editor-rbac.yaml`；更新写入现有审计日志。不可变字段等限制由 Kubernetes 校验并返回错误，不执行删除重建。参见 [Kubernetes PV API](https://kubernetes.io/docs/reference/kubernetes-api/core/persistent-volume-v1/)。
