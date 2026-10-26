# Ubuntu 部署指南

本文采用“本地构建打包 → 上传 → 服务器解压运行”的方式部署 KubeScope，使用 systemd 管理进程，支持开机自启和异常重启，**不需要 PM2**。

应用由 React 前端和 Node.js 后端组成，生产环境共用 3000 端口，无需单独运行 Vite，也无需数据库或 Docker。

## 1. 部署前提

- 有可访问的 Kubernetes 集群；本指南不包含创建集群。
- 本地构建机器安装 Node.js >= 22.12、npm、Bash 和 tar，能下载 npm 依赖。
- Ubuntu 服务器有 sudo 权限，已安装 Node.js >= 22.12，并能访问集群 API Server。
- 服务器无需安装 npm 依赖、拉取源码或执行前端构建。
- 使用现有 `zhiwenxia` 用户运行服务，复用该用户已经可用的集群配置。
- 服务可以部署在独立服务器上，不必安装到 Kubernetes master 节点。

除特别说明外，以下命令都在 Ubuntu 服务器执行。示例中的文件名、版本、服务器地址及用户名需要替换为实际值。

## 2. 安装基础依赖和 Node.js

```bash
sudo apt update
sudo apt install -y ca-certificates curl tar openssl
```

项目要求 Node.js >= 22.12，建议使用 Node.js 24 LTS。

## 3. 检查集群访问配置

应用通过 Kubernetes API 直接查询集群，无需安装 kubectl。准备服务用户可读的 kubeconfig，并确保能访问其中的 API Server 地址。客户端支持 CA、客户端证书和令牌；若 kubeconfig 使用 exec 认证插件，还需安装相应认证程序并配置环境变量。

systemd 不会加载 `.bashrc`，需要按第 5、6 节显式配置 `KUBECONFIG`、`PATH` 或云认证环境变量。

## 4. 本地打包、上传与解压

### 本地构建机器执行

在项目根目录确认 `.env` 中的服务器路径及端口正确，再运行：

```bash
bash package.sh
```

脚本依次执行 `npm ci --include=dev`、`npm test`、`npm run build`，任一步失败都会停止。成功后在 `releases/` 生成带版本号和 UTC 时间的压缩包，例如 `kubescope-1.0.0-20261023T120000Z.tar.gz`。也可执行 `bash package.sh /path/to/output` 指定输出目录。

部署包结构如下：

```text
kubescope/
├── dist/                # 已构建的前端
├── server/
│   ├── index.js         # 生产服务
│   └── kubernetes.js
├── deploy/              # systemd 配置和只读 RBAC
├── node_modules/        # 已安装的生产依赖
├── package-lock.json
├── package.json         # 包含 type: module，运行时需要保留
├── deploy.sh            # 安装或更新 systemd 服务并重启
├── start.sh             # 启动服务
├── stop.sh              # 停止服务
├── .env                 # 部署配置，包含访问令牌
└── DEPLOYE.md
```

生产后端使用官方 `@kubernetes/client-node` 加载配置及认证，直接通过 API 查询集群。打包脚本在暂存目录安装并包含生产依赖，服务器不需要执行 `npm install`。包内不包含 Node.js 或 kubeconfig，但包含本地 `.env` 及其中的访问令牌，请妥善保存部署包。`.env` 已被 Git 忽略。

上传生成的压缩包（文件名替换为实际值）：

```bash
scp releases/kubescope-1.0.0-20261023T120000Z.tar.gz zhiwenxia@k8s-master:/tmp/
```

### 首次部署时，在服务器执行

```bash
# 首次部署确认 /opt/kubescope 尚不存在；已有部署请使用第 10 节更新流程
set -e
sudo test ! -e /opt/kubescope
sudo tar -xzf /tmp/kubescope-1.0.0-20261023T120000Z.tar.gz \
  -C /opt --no-same-owner
sudo chown -R root:root /opt/kubescope
```

如果第一条检查失败，请停止，不要直接覆盖已有目录。压缩包自带 `kubescope/` 顶层目录，解压后入口为 `/opt/kubescope/server/index.js`。

## 5. 复用 zhiwenxia 的集群配置

不需要创建 `kubescope` 系统用户，也不需要复制 kubeconfig 或重新应用 RBAC。以 `zhiwenxia` 登录服务器后执行：

```bash
whoami
printf 'HOME=%s\n' "$HOME"
printf 'KUBECONFIG=%s\n' "${KUBECONFIG:-$HOME/.kube/config}"
command -v node
test -r "${KUBECONFIG:-$HOME/.kube/config}"
```

确认 `whoami` 为 `zhiwenxia`。后续配置使用上面查到的实际路径。如果终端未设置 `KUBECONFIG`，默认使用 `/home/zhiwenxia/.kube/config`；如果设置了自定义路径或多个配置文件，原样写入应用环境文件，建议使用绝对路径。

应用会使用该用户已有的 Kubernetes 身份和权限，但应用接口仍只提供读取操作。`deploy/rbac.yaml` 保留在包内，当前流程无需应用。

## 6. 创建应用环境配置

配置保存在应用目录的 `.env` 中，systemd 从 `/opt/kubescope/.env` 读取。本地项目已生成该文件和随机访问令牌，打包脚本会将其放入部署包，无需另外创建 `/etc` 环境文件。

在本地打包前编辑 `.env`，按服务器实际路径填写：

```dotenv
HOST=0.0.0.0
PORT=3000
KUBECONFIG=/home/zhiwenxia/.kube/config
K8S_WEB_TOKEN=填写实际的随机令牌
```

令牌必须是实际值，`.env` 不会执行 `$(openssl rand -hex 32)`。需要更换时，先执行 `openssl rand -hex 32`，再将输出填入文件。不要提交或公开此文件。

解压后设置文件所有者及权限，以便 zhiwenxia 也可直接启动：

```bash
sudo chown zhiwenxia /opt/kubescope/.env
sudo chmod 600 /opt/kubescope/.env
```

如果使用认证插件，还需显式配置它依赖的 PATH 或云认证环境变量；请使用完整值，不要写 `$HOME`、`$PATH` 或 `~`。

不使用 systemd 时，以 zhiwenxia 用户直接运行并加载相同配置：

```bash
cd /opt/kubescope
node --env-file=.env server/index.js
```

直接执行 `node server/index.js` 不会自动读取 `.env`。使用 systemd 时由 `EnvironmentFile` 负责加载，不需要添加 Node.js 参数。

| 配置 | 说明 |
| --- | --- |
| `HOST` | 可省略，默认监听 `0.0.0.0`；监听非本地地址时，应用强制要求设置令牌 |
| `PORT` | HTTP 端口，示例为 3000 |
| `KUBECONFIG` | zhiwenxia 当前使用的 kubeconfig 路径 |
| `K8S_WEB_TOKEN` | 网页 API 的访问令牌，与 Kubernetes 凭证是不同配置 |

## 7. 首次部署和重复部署

以 `zhiwenxia` 用户登录，在解压后的应用目录执行：

```bash
cd /opt/kubescope
bash deploy.sh
```

不要对整个脚本使用 sudo。脚本会在需要管理系统服务或调整 `.env` 权限时调用 sudo，届时可能需要输入密码。

`deploy.sh` 会检查部署文件、Node.js 版本、`.env` 必填项，以及生产依赖和 kubeconfig 的文件访问权限；自动检测当前终端的 Node.js 绝对路径，生成并安装 systemd 服务，设置开机自启，然后重启服务。不会在服务器安装 npm 依赖、构建源码或改动集群资源。

脚本可重复执行：保留现有 `.env` 内容，更新服务配置并重启。修改 `.env` 或升级 Node.js 后也可重新执行。若需要指定其他 Node.js 路径：

```bash
NODE_BIN=/usr/local/bin/node bash deploy.sh
```

服务使用 `zhiwenxia` 用户和部署时的 HOME，支持使用该用户 nvm 下的 Node.js。systemd 不会加载 `.bashrc`，集群认证依赖的环境变量仍需写入 `.env`。

模板的 `ProtectHome=read-only` 允许读取主目录；如果认证插件需要写入主目录中的凭证缓存，需要按插件要求调整 `deploy/kubescope.service` 后重新部署。

部署目录、Node.js 路径和 HOME 使用不含空格或特殊字符的绝对路径。默认目录为 `/opt/kubescope`，脚本也支持其他满足条件的解压目录。

检查本地页面：

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

返回 `200` 表示页面正常；还需在网页中验证集群连接。脚本不主动执行集群查询。

## 8. 通过 SSH 隧道访问

**在自己的电脑上执行**，将用户名和 IP 替换为实际值：

```bash
ssh -N -L 3000:127.0.0.1:3000 zhiwenxia@服务器IP
```

保持 SSH 连接，在浏览器打开 `http://127.0.0.1:3000`。

在服务器查看访问令牌：

```bash
sudo cat /opt/kubescope/.env
```

将 `K8S_WEB_TOKEN` 的值填入网页的「连接设置」。令牌只保存在页面内存中，刷新页面后需要重新输入。

这种访问方式无需对外开放服务器的 3000 端口，只需要电脑能够通过 SSH 登录服务器。

## 9. 通过域名访问（可选）

多人通过浏览器长期访问时，可配置 Nginx 或其他 HTTPS 反向代理：

1. 将域名解析到服务器，并配置有效 TLS 证书。
2. 让代理将请求转发到 `http://127.0.0.1:3000`，保留 `Authorization` 请求头。
3. 按需开放 HTTPS 端口并限制访问来源；后端继续监听本机。
4. 访问 HTTPS 域名，在页面填入同一个访问令牌。

Nginx 的代理 location 示例（放入已配置 HTTPS 的 server 块内）：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;
    proxy_read_timeout 120s;
}
```

该片段不包含证书和完整 server 配置。配置后执行 `sudo nginx -t`，通过后再重新加载 Nginx。

前端静态页面可公开读取，配置令牌后全部 `/api/` 接口要求认证。项目不提供多用户权限管理；有访问权限的用户可以读取授权范围内的 Pod 配置和日志。

## 10. 日常管理与更新

```bash
# 查看状态
sudo systemctl status kubescope --no-pager

# 启动 / 停止（先进入应用目录）
cd /opt/kubescope
bash start.sh
bash stop.sh

# 重启并重新应用部署配置
bash deploy.sh

# 实时日志 / 最近 100 条日志
sudo journalctl -u kubescope -f
sudo journalctl -u kubescope -n 100 --no-pager
```

更新时，先在本地重新执行 `bash package.sh`，测试和构建成功后上传新的部署包。服务器只进行解压和切换，不执行 npm 命令。

在服务器执行以下示例，替换实际包名。先解压到临时目录并检查，再停止服务：

```bash
set -e
UPDATE_DIR="$(mktemp -d /tmp/kubescope-update.XXXXXX)"
tar -xzf /tmp/kubescope-1.0.0-20261023T120000Z.tar.gz -C "$UPDATE_DIR"
test -f "$UPDATE_DIR/kubescope/dist/index.html"
test -f "$UPDATE_DIR/kubescope/server/index.js"
sudo chown -R root:root "$UPDATE_DIR/kubescope"
# 保留服务器当前配置和令牌，避免被新包覆盖
sudo cp -p /opt/kubescope/.env "$UPDATE_DIR/kubescope/.env"
BACKUP_DIR="/opt/kubescope-backup-$(date +%Y%m%dT%H%M%S)"
sudo test ! -e "$BACKUP_DIR"
sudo systemctl stop kubescope
sudo mv /opt/kubescope "$BACKUP_DIR"
sudo mv "$UPDATE_DIR/kubescope" /opt/kubescope
rmdir "$UPDATE_DIR"
sudo systemctl start kubescope
sudo systemctl status kubescope --no-pager
printf '旧版本备份目录：%s\n' "$BACKUP_DIR"
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

页面正常后，还需确认网页能连接集群和读取资源。环境文件位于 `/opt/kubescope/.env`，kubeconfig 继续使用 zhiwenxia 的现有路径，更新步骤会将现有 `.env` 复制到新版本中，保留服务器配置和令牌。

如果切换后启动或验证失败，用实际备份路径回退：

```bash
sudo systemctl stop kubescope
sudo mv /opt/kubescope "/opt/kubescope-failed-$(date +%Y%m%dT%H%M%S)"
sudo mv /opt/kubescope-backup-实际时间 /opt/kubescope
sudo systemctl start kubescope
```

如果新版本调整了服务模板或 Node.js 路径，在新应用目录执行 `bash deploy.sh`，即可重新安装配置并重启。`start.sh` 仅负责启动；已经运行的服务需要重启才能加载配置修改。

## 11. 常见问题

| 现象 | 排查方式 |
| --- | --- |
| 服务无法启动 | 查看 journalctl；确认 Node.js 路径、版本、项目权限、环境文件和端口占用 |
| 页面 404 或找不到前端 | 确认上传的是 package.sh 生成的部署包，且 `/opt/kubescope/dist/index.html` 存在；缺失时在本地重新打包 |
| API 返回 401 | 在页面输入 `/opt/kubescope/.env` 中的访问令牌；刷新页面后重新输入 |
| 集群连接超时 | 检查 kubeconfig 中的 API 地址、DNS、路由、防火墙及 API Server 状态 |
| Kubernetes 返回 Unauthorized | 检查 kubeconfig 的认证信息、凭证有效期和认证插件 |
| Kubernetes 返回 Forbidden | 检查服务与终端是否使用相同 kubeconfig 和 context，以及现有身份的资源或日志权限 |
| 终端集群访问正常，但服务连接失败 | 检查服务的 HOME、KUBECONFIG、PATH 和云认证变量；systemd 不加载 shell 配置 |
| SSH 隧道无法建立 | 检查 SSH 登录和本地 3000 端口占用；必要时改用 `-L 3001:127.0.0.1:3000` 并访问本地 3001 |
| 服务器启动正常，但电脑无法直连 IP:3000 | 默认监听 `0.0.0.0`，检查服务器防火墙、安全组和 `HOST` 配置 |

systemd 已负责进程托管，不需要再用 PM2 启动同一个应用。

旧配置中的 `KUBECTL_PATH` 已停用，可删除。修改 kubeconfig 或当前 context 后需重启服务。
