#!/usr/bin/env bash
# Run as root from the extracted deployment package.
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
if [[ "$(id -u)" != 0 ]]; then
  echo "请使用 sudo bash deploy.sh，以 root 用户部署 Web 应用。" >&2
  exit 1
fi
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ ! -x "$NODE_BIN" ]]; then
  if [[ -n "$NODE_BIN" ]]; then
    echo "NODE_BIN 指向的文件不可执行，请检查指定路径。" >&2
    exit 1
  fi
  echo "未检测到 Node.js，开始自动安装…" >&2
  NODE_BIN="$(bash "$APP_DIR/install_node.sh")"
fi
# Keep generated systemd paths literal and unambiguous.
for value in "$APP_DIR" "$NODE_BIN"; do
  if [[ ! "$value" =~ ^/[a-zA-Z0-9_./+-]+$ ]]; then
    echo "部署目录、Node.js 和 HOME 需要使用不含空格或特殊字符的绝对路径。" >&2
    exit 1
  fi
done
for file in server/index.js server/expansion.js server/expansion-executor.js server/kubernetes.js server/deployment-env.js package.json node_modules/@kubernetes/client-node/package.json dist/index.html deploy/kubescope.service; do
  if [[ ! -r "$file" ]]; then
    echo "缺少或无法读取 $file，请使用完整部署包。" >&2
    exit 1
  fi
done
test -f "$APP_DIR/.env"
chown root:root "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"

# Parse .env with Node.js, never execute it as shell code.
"$NODE_BIN" --env-file=.env --input-type=module -e '
import { validateDeploymentEnvironment } from "./server/deployment-env.js";
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) throw Error("需要 Node.js >= 22.12");
const { missing } = validateDeploymentEnvironment();
if (missing.length) console.warn(`KUBECONFIG 尚不存在：${missing.join(", ")}；继续部署 Web，请在页面连接或分步安装 K8s 集群。`);
'

install -d -m 700 "$APP_DIR/var" /var/lib/kubescope-expansion /var/service/kubescope/log
UNIT_FILE="$(mktemp)"
trap 'rm -f -- "$UNIT_FILE"' EXIT
sed \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
  -e "s|^EnvironmentFile=.*|EnvironmentFile=$APP_DIR/.env|" \
  -e "s|^Environment=HOME=.*|Environment=HOME=/root|" \
  -e "s|^ReadWritePaths=.*|ReadWritePaths=$APP_DIR/var|" \
  -e "s|^ExecStart=.*|ExecStart=$NODE_BIN $APP_DIR/server/index.js|" \
  deploy/kubescope.service > "$UNIT_FILE"
install -o root -g root -m 644 "$UNIT_FILE" /etc/systemd/system/kubescope.service
systemctl daemon-reload
systemctl enable kubescope
# Restart also applies updated configuration on repeated deployment.
systemctl restart kubescope
systemctl status kubescope --no-pager
echo "部署完成。查看日志：journalctl -u kubescope -f"
