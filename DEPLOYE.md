# Ubuntu / master 部署指南

KubeScope 由 React 前端和 Node.js 后端组成，生产共用一个端口。Web 服务以 root 运行，节点扩容任务直接在后端执行，不再单独部署执行器。

## 1. 环境

- 本地构建机器：Node.js >=22.12、npm、Bash、tar。
- master：Node.js >=22.12，可读的 kubeconfig。
- 启用扩容时，master 还需 `/usr/bin/ssh`、`/usr/bin/kubeadm`、`/usr/bin/kubectl`，目标版本与 kubeadm 集群匹配。
- 新节点需要 Ubuntu、SSH、可用网络，Kubernetes 组件由扩容流程安装。

systemd 不加载交互 shell 配置，Node、kubeconfig 及认证插件须使用实际路径。Node 二进制、应用代码和父目录由 root 管理，普通用户不可写。

## 2. 本地打包

在本地准备 `.env`，然后：

```bash
bash package.sh
```

脚本安装依赖、测试、构建，将 dist、server、生产依赖、deploy 模板和脚本打入 releases 下的压缩包。服务器无需 npm install 或构建。部署包含 `.env` 中的令牌，应妥善保存；不含 Node、kubeconfig 或 SSH 密钥。

## 一键上传并远程部署

本地运行 `bash package.sh` 生成构建包后：

```bash
bash remote_deploye.sh --dry-run
bash remote_deploye.sh
```

默认选择脚本旁 `releases/` 中最后修改的 `kubescope-版本-构建时间.tar.gz`，上传到 `zhiwenxia@192.168.100.132:22`。先校验包结构和 SHA256，上传到远端私有临时目录，随后在终端通过 sudo 执行远端安装流程和解压后的 deploy.sh。按当前部署要求，脚本内预设了该主机的默认认证密码，自动完成 SSH 和 sudo 认证；可通过 DEPLOY_PASSWORD/SUDO_PASSWORD 覆盖。SSH 密码通过本地 0600 临时文件交给 ASKPASS，退出清理；sudo 密码仅经 SSH 标准输入传递，不进入命令参数或远端文件。脚本明确禁用 ControlMaster、ControlPersist 和 ControlPath 连接复用，避免远端拒绝复用会话。通过一次独立 SCP 连接上传整个私有目录，再通过一次独立 SSH 连接执行 sudo 部署，默认自动认证，无需输入密码；将 DEPLOY_PASSWORD 和 SUDO_PASSWORD 都设为空时恢复交互提示。每一步都有进度输出；连接超时 15 秒，建立连接后每 15 秒探测存活，连续 3 次无响应则断开。远端临时文件在部署连接退出时清理。脚本不会自动构建，也不会自动接受未知 SSH 主机密钥。

每次部署解压到 `/opt/kubescope-releases/构建包名.随机后缀/kubescope-版本/`，保留旧版本。脚本从旧 kubescope.service 获取运行目录和 Node 路径；没有旧服务时使用 root PATH 中的 Node。自定义示例：

```bash
bash remote_deploye.sh --user youruser --identity ~/.ssh/id_ed25519
bash remote_deploye.sh --node-bin /usr/bin/node --releases-dir ./releases
```

SSH 用户需要能以 sudo 运行 bash。交互认证模式请从交互终端执行。`--help` 展示完整参数，host、port、remote-dir 也可指定。

升级时会检查旧服务是否存在进行中的扩容任务，存在则拒绝切换。停止旧服务后复用旧 `.env` 并复制 var 数据，自动迁移扩容配置中指向旧 var 的路径和审计日志路径；外部 kubeconfig、SSH 文件及旧版本目录保留原位。新部署失败会尝试恢复原 systemd 配置和旧服务，失败目录保留供排查；不要同时从页面发起新的扩容任务。脚本只支持现有 systemd kubescope 服务的自动迁移，手工后台启动的服务需先另行处理端口占用。

## 3. 首次解压

压缩包的顶层目录带 package.json 中的版本号，例如 `kubescope-1.0.0/`；压缩包文件名仍包含构建时间。上传压缩包后，在 master 执行，替换实际文件名及目录版本号：

```bash
sudo test ! -e /opt/kubescope-1.0.0
sudo tar -xzf /tmp/kubescope-版本-时间.tar.gz -C /opt --no-same-owner
sudo chown -R root:root /opt/kubescope-1.0.0
```

若目录已存在，请先备份并按更新流程处理，不直接覆盖正在运行的服务。

## 4. 配置

编辑 `/opt/kubescope-1.0.0/.env`：

```dotenv
HOST=127.0.0.1
PORT=3000
KUBECONFIG=/etc/kubernetes/admin.conf
K8S_WEB_TOKEN=替换为强随机令牌
# 由 HTTPS 反向代理对外服务时设置实际页面来源
# K8S_PUBLIC_ORIGIN=https://kubescope.example.com
```

原有 kubeconfig 也可使用绝对路径继续配置，无需放到 root HOME 中；确认 root 可读取其中引用的证书和认证程序。Kubernetes 身份和权限由该 kubeconfig 决定。

首次扩容在页面点击“自动识别当前集群 → 保存并继续”，然后填写新机器参数、核对 SSH 指纹、输入登录密码和 sudo 密码，点击“添加并开始扩容”。目录和配置文件由后台自动创建，不需要 K8S_EXPANSION_CONFIG 或手动配置 SSH 密钥。详见 [页面扩容说明](deploy/EXPANSION.md)。

## 5. 启动 root Web 服务

```bash
cd /opt/kubescope-1.0.0
sudo bash deploy.sh
```

若 sudo PATH 中没有 Node：

```bash
sudo env NODE_BIN=/实际路径/node bash deploy.sh
```

脚本自动使用其所在目录作为运行目录，校验配置和 Node 版本，创建可写日志目录，安装 `kubescope.service`，以 root 身份启动，并设置开机自启。模板启用 ProtectSystem=strict，保留应用 var 目录和 `/var/lib/kubescope-expansion` 等状态目录可写。自定义审计或任务路径时，同步调整服务 ReadWritePaths。

```bash
sudo systemctl status kubescope --no-pager
sudo journalctl -u kubescope -f
```

此前已安装独立 kubescope-expansion 服务时，先停止并禁用旧服务，再启用内置扩容，避免多个进程写同一任务文件。删除旧的 K8S_EXPANSION_SOCKET 配置。

## 6. 访问

默认本地监听，可以在个人电脑转发访问：

```bash
ssh -L 3000:127.0.0.1:3000 user@master
```

打开 `http://127.0.0.1:3000`，在连接设置输入 Web 令牌。远程网络访问应配置 HTTPS 反向代理；如直接监听网络地址，必须设置 K8S_WEB_TOKEN。POST 扩容请求要求同源 Origin，代理需传递正确 Host，HTTPS 终止代理时设置 K8S_PUBLIC_ORIGIN。

进入“集群资源 → 节点 → 添加节点”，首次通过页面初始化并登记机器，之后只需选择机器并输入登录密码和 sudo 密码。点击开始后自动预检、安装、入群并显示进度。root SSH 不需要 sudo 密码，免密 sudo 可以单独留空 sudo 密码。

## 7. 更新和故障排查

更新前保存 `.env`、kubeconfig、SSH 配置和任务记录，等待扩容任务结束后停止 Web，替换应用代码及依赖，恢复配置后重新运行 `sudo bash deploy.sh`。新的页面配置和任务文件在应用 `var/expansion/` 下，备份/更新时保留该目录；旧版导入配置可能仍引用 `/var/lib/kubescope-expansion`。Web 重启不会自动续跑任务，应核对新节点状态后重试。

常见检查：

```bash
sudo systemctl cat kubescope
sudo journalctl -u kubescope -n 100 --no-pager
sudo /usr/bin/kubeadm version -o json
sudo /usr/bin/kubectl --kubeconfig /etc/kubernetes/admin.conf get nodes -o wide
```

Web 页面显示经过脱敏的远程 stdout/stderr、错误摘要和失败诊断，并在 master 的任务文件内保存最近 400 行 / 64 KiB；支持下载日志。目标节点也可查看 apt 日志以及 `journalctl -u kubelet -u containerd`。共享 Web 令牌的用户具备相同操作权限，暂无多用户角色管理。
