# 页面初始化和一键扩容

Web 服务在 master 上以 root 运行，扩容直接在 Web 后端执行，无需独立执行器。Web 应用更新并启动后，扩容配置初始化、新节点登记与入群全部在页面完成，不需要手动创建目录、复制 JSON、配置 SSH 密钥或运行节点初始化脚本。

## 首次使用

1. 进入“集群资源 → 节点 → 添加节点”。
2. 点击“自动识别当前集群”，核对 kubeconfig 路径、API Server 地址和 Kubernetes 完整版本。也可以直接在页面填写。
3. containerd 包版本默认填 `auto`，安装时从新节点 Ubuntu 源选择可用的 containerd 1.x / 2.x 候选版本；也可输入明确的完整包版本。
4. 点击“保存并继续”。后端自动创建配置目录和文件，不需要设置 K8S_EXPANSION_CONFIG。
5. 填写新节点 IPv4、SSH 端口、SSH 用户名和节点名称，点击“获取 SSH 主机指纹”。
6. 使用可信渠道核对页面显示的 SHA256 指纹后勾选确认。获取指纹时不会发送登录密码，确认有效期为 5 分钟，改变机器参数后需要重新获取。
7. 填写新节点 SSH 登录密码。sudo 密码相同时保持默认选项；不同时取消勾选，单独填写 sudo 密码；免密码 sudo 时取消勾选并留空 sudo 密码。SSH root 用户不需要 sudo 密码。
8. 点击“添加并开始扩容”。系统自动保存机器参数，进行预检、安装、入群与就绪检查。

已登记机器可以直接选择、填写密码并点击“开始扩容”，无需重复初始化或确认指纹。选择机器后点击“修改目标机器”，可修改 IP、SSH 端口、登录用户和节点名称，支持保存与取消。IP 或端口变化时必须重新获取并确认指纹；地址不变可保留原有信任记录，也可主动刷新指纹。保存只更新接入配置，不执行扩容或更改集群中已有的 Node，历史任务保留执行时的机器信息。目标 ID 不变，并通过版本校验防止覆盖其他页面的修改。任务执行期间禁止修改配置或机器。

## 环境边界

支持 kubeadm Worker、Ubuntu 22.04/24.04/26.04（含维护版本）、x86_64/aarch64、IPv4、cgroup v2、containerd 1.x/2.x、Kubernetes 1.31–1.35。新节点至少 2 CPU、约 2 GiB 内存、10 GiB 空闲空间。

master 需要已安装 Node.js >=22.12、`/usr/bin/kubectl`、`/usr/bin/kubeadm`，并有可用 kubeconfig；kubeadm 与 API Server 完整版本必须一致。旧版密钥目标仍依赖 `/usr/bin/ssh`。这些是向现有集群扩容的部署前提，扩容流程不会升级 master 或创建新集群。无 API Server 端口时可使用独立的“安装 K8s 集群服务”入口从零安装本机控制平面，详见 README。

新节点需要操作系统、SSH 服务、可登录的用户以及网络。页面新登记机器通过 SSH 密码登录，因此 SSH 服务须允许该用户的密码认证；普通用户需有 sudo 授权，无需预先配置 NOPASSWD。软件源、镜像仓库和节点间 CNI 网络应可达。当前不提供离线安装、控制平面扩容、多网卡选择或业务存储自动配置。

## 保存位置与权限

自动保存到应用目录：

```text
var/expansion/config.json     # 集群参数、机器参数和已确认的主机指纹，0600
var/expansion/tasks/          # 新初始化配置的任务状态，目录 0700
```

目录由后端按需创建，0700，仅 root 访问。systemd 已允许应用 var 目录写入。备份/更新时保留整个 var/expansion 目录。

旧版 K8S_EXPANSION_CONFIG 指向的配置若存在，首次访问时自动导入上述受管理位置；原有任务目录和密钥目标继续兼容。新的页面机器使用 SSH 密码认证，不依赖 known_hosts 文件或密钥部署。页面不会返回旧配置中的密钥路径或私钥正文。旧独立执行器服务不应与当前 Web 同时使用同一任务文件。

## 凭据处理

SSH 登录密码、sudo 密码仅存在当前请求和任务内存中，不写配置、任务文件、日志或浏览器持久化存储。提交后清空表单，关闭面板或切换机器也会清空；失败重试需重新输入。任务重新打开只能查看进度，不能恢复密码。

使用 ssh2 通过加密 SSH 通道认证，先验证保存的主机指纹，指纹变化时拒绝登录。sudo 密码经远程脚本标准输入验证，不拼接到脚本源码或命令参数。提供密码时通过单次 `sudo -S -k` 完成认证和执行，不依赖 sudo 时间戳缓存。脚本写入新节点 0600 的临时文件，退出删除；该文件不含登录或 sudo 密码，入群阶段可能包含临时 token。root 脚本标准输入设为 /dev/null，避免免密 sudo 时遗留密码进入安装命令。sudo 策略仍需允许该用户执行相应 root 操作；requiretty 策略可能需要管理员调整。

远程页面使用 HTTPS，或经 SSH 隧道转发到本地。扩容接口要求已配置 Web 访问令牌，所有 POST 请求强制同源 Origin。沿用共享令牌权限，持有令牌者都能配置与执行扩容，暂无独立用户权限。

## 后台任务流程

1. master 检查 kubeadm/API Server 版本、kubeadm 配置和重复 Node。
2. SSH 预检权限、Ubuntu 版本、CPU/内存/磁盘、cgroup、目标 IP、API TCP 连通性和安装源 DNS。
3. 关闭 swap、备份修改 fstab、配置内核模块/sysctl，安装 containerd、kubelet、kubeadm 并锁定版本。自动模式使用 apt-cache policy 的候选包，只接受 1.x/2.x；源中没有可用候选版本时明确报错。按安装版本生成原生配置并设置 SystemdCgroup=true，解析验证配置后重启服务。Ubuntu 26.04 和 containerd 2.x 已加入安装适配，但仍需在实际节点验收网络插件、镜像和存储。
4. master 创建有效期 30 分钟的 token，新节点执行 kubeadm join；临时配置文件受限权限，退出删除。
5. 每 5 秒检查 Node Ready、InternalIP 和目标节点上的 kube-system Pod，最多等待 10 分钟。完成后撤销 token，返回可分配资源。页面每 3 秒刷新状态。

页面展示 master 和新节点的执行日志（含 stdout/stderr），显示时间、来源、失败阶段和退出码。密码、入群 token 和私钥内容会过滤；日志在 master 的任务文件内持久化，每 250 毫秒批量更新，页面每 3 秒刷新。每个任务保留最近 400 行且不超过 64 KiB，较早内容截断并提示；支持跟随最新和下载当前保留的日志。超长单行（超过 8192 字符）会省略。安装或入群失败后，自动只读采集 kubelet/containerd 状态、最近 80 条 journal 和 apt term.log 的最后 60 行，最长 30 秒；SSH/授权失败时可能无法采集。单次正常 SSH 最长 20 分钟。Node Ready 不等于业务路径验收完成，跨节点通信、DNS、私有镜像、存储需按实际环境验收；不会增加应用副本或主动迁移现有 Pod。

## 恢复

任务文件最多保留 1000 条，页面显示最近 50 条。关闭浏览器不会停止任务。Web 重启将进行中的任务标记 interrupted，不自动重跑。安装失败且尚未入群可重新提交；部分入群后存在 kubelet.conf 或集群 Node 时拒绝重复初始化，需管理员诊断。不自动 reset、删除节点或回滚。

Web 意外中断时远程安装可能继续，恢复前需检查目标进程和 apt 锁；token 最多 30 分钟后过期。重试可能覆盖本引擎管理的 containerd 配置。动态 swap/zram 服务需单独处理并验证重启行为。

## API

- GET `/api/expansion/settings`：初始化状态和可编辑集群参数。
- POST `/api/expansion/discover`：自动识别当前 Web 连接的集群参数。
- POST `/api/expansion/settings`：保存集群参数，自动创建配置目录。
- POST `/api/expansion/probe`：获取机器指纹，返回绑定目标的 5 分钟确认标识。
- POST `/api/expansion/targets`：提交机器参数、probeId 和已核对指纹，登记机器。
- GET `/api/expansion/targets`：机器、指纹、配置版本与最近任务，不返回密码。
- POST `/api/expansion/targets/:id`：修改机器参数，必须提供当前 revision；地址变化或主动刷新指纹时还需提供新的 probeId 和已确认的 hostFingerprint。
- POST `/api/expansion/tasks`：提交 targetId、sshPassword、sudoPassword、start:true，启动完整任务。
- GET `/api/expansion/tasks/:id`：查看任务。
- POST `/api/expansion/tasks/:id/start`：保留旧版仅预检任务的兼容启动接口。

## 故障日志在哪里

页面打开节点扩容的历史任务，查看执行进度、错误摘要和日志，可下载当前保留的脱敏日志。master 默认保存在应用目录 `var/expansion/tasks/tasks.json`；导入的旧配置可能使用原 stateDirectory。该文件仅 root 可读写。

Web 服务自身日志在 master 的 `journalctl -u kubescope`。新节点的服务日志在 `journalctl -u kubelet -u containerd`，包管理日志在 `/var/log/apt/term.log`。旧版丢弃的远程输出不能追溯恢复；需要从新节点原始系统日志诊断，或更新后重新提交尚未入群的任务。不应对已部分入群的机器盲目重试。


### 扩容前对比 hosts

登录授权后，点击“读取并对比 hosts”。master 指运行 Web 服务的主机；通过已确认指纹的 SSH 读取新节点 `/etc/hosts`。页面展示两端原文及有效解析差异（忽略注释、空白、顺序、大小写和回环地址）。

有差异时可选择“确认修改新节点 hosts”或“保持原配置，继续扩容”。修改会合并 master 的非回环映射，同名映射以 master 为准，保留新节点回环配置、独有映射及未冲突别名。master 映射与新节点回环主机名冲突时，需手动处理后重新对比。master 文件不会修改。

确认修改前会展示最终文件内容，写入时在新节点创建 `/etc/hosts.kubescope-<ID>.bak` 备份并在页面返回路径。对比有效期为 5 分钟，绑定目标及主机指纹，写入前检查两端文件是否变化，变化后需重新对比。密码沿现有 SSH / sudo 通道传输，不写入配置或任务记录。

## 扩容时配置自建镜像仓库

在“节点扩容”的“工作节点镜像仓库”区域勾选“使用自建镜像仓库”，输入仓库 IPv4、证书接口协议（HTTPS/HTTP）和端口（默认分别为 443/80）和证书导出 Token 后点击“开始扩容”。原 hosts 对比步骤仍需完成；启用仓库配置后，会在新节点安装 containerd 后、入群前，将 docker.io、registry-1.docker.io、ghcr.io、registry.k8s.io 的映射替换为仓库 IP。

证书包由工作节点通过 `curl -kfsS` 携带 Bearer Token 请求 `<协议>://<仓库IP>:<证书接口端口>/api/tls/bundle` 获取，仓库必须从工作节点可达。校验证书有效期、域名及密钥匹配后配置 containerd 的 hosts.toml 和证书信任，并重启 containerd。hosts 和 containerd 主配置会在目标节点备份；证书与私钥保存于目标节点 `/etc/kubescope/registry/`，私钥权限 0600。拉取镜像时启用 TLS 验证。仓库配置失败会停止入群，并按现有流程保留失败阶段、采集诊断日志。

Token 仅随本次扩容请求通过 SSH 输入传递，不写入扩容配置、任务记录或命令参数；表单提交后清空。关闭或切换扩容面板也会清空 Token。未勾选时沿用原扩容流程。已经入群的节点不会因本次操作被修改。

## 使用 XML 导入节点

进入“节点扩容 → 添加节点 → 目标机器”，在“从 XML 导入”中选择文件。一次导入一个节点，文件最大 64 KiB；导入校验成功后填充向导，继续核对 SSH 指纹、登录授权、hosts 映射和镜像仓库，最后点击“开始扩容”。导入失败时保留原有配置。集群配置仍沿用当前集群的设置。

页面提供示例与 XSD 下载，源码分别位于 `public/templates/node-expansion.example.xml` 和 `public/templates/node-expansion.xsd`。XSD 包含各元素、字段、默认值、凭据用法及 hosts 合并行为的中文说明。文件以 `nodeExpansion` 为根元素，`version="1"`，按顺序包含 `target`、可选的 `credentials`、`hosts`、`registry`。不支持 DTD 或自定义实体。

`hosts` 只填写要新增的映射，例如 `<mapping ip="192.168.1.30" names="registry.internal registry"/>`，无需提供完整 `/etc/hosts` 或 master 内容。导入模式不会选择 master 的其他映射；确认写入时替换同名非回环映射，保留其余条目，并备份原文件。省略 `hosts` 或使用 `<hosts/>` 表示保持原配置。读取配置后仍需确认写入，回环主机名冲突及同名多 IP 会被拒绝。

密码和仓库 Token 可省略，在页面补填。省略 `sudoPassword` 时默认复用 SSH 密码，显式空元素 `<sudoPassword/>` 表示不复用（例如免密 sudo）。凭据使用元素文本，支持 CDATA，保留首尾空格，不允许换行；包含凭据的源文件应妥善保管。导入的凭据仅用于当前向导，不保存到目标配置或日志。
