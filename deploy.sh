#!/usr/bin/env bash
# Run as zhiwenxia from the extracted deployment package.
set -euo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
if [[ "$(id -un)" != zhiwenxia ]]; then
  echo "请以 zhiwenxia 用户运行 bash deploy.sh（不要 sudo 整个脚本）。" >&2
  exit 1
fi
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ ! -x "$NODE_BIN" ]]; then
  echo "找不到 Node.js，请安装或通过 NODE_BIN 指定绝对路径。" >&2
  exit 1
fi
# Keep generated systemd paths literal and unambiguous.
for value in "$APP_DIR" "$NODE_BIN" "$HOME"; do
  if [[ ! "$value" =~ ^/[a-zA-Z0-9_./+-]+$ ]]; then
    echo "部署目录、Node.js 和 HOME 需要使用不含空格或特殊字符的绝对路径。" >&2
    exit 1
  fi
done
for file in server/index.js server/kubernetes.js package.json node_modules/@kubernetes/client-node/package.json dist/index.html deploy/kubescope.service; do
  if [[ ! -r "$file" ]]; then
    echo "缺少或无法读取 $file，请使用完整部署包。" >&2
    exit 1
  fi
done
sudo -v
sudo test -f "$APP_DIR/.env"
sudo chown zhiwenxia "$APP_DIR/.env"
sudo chmod 600 "$APP_DIR/.env"

# Parse .env with Node.js, never execute it as shell code.
"$NODE_BIN" --env-file=.env --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) throw Error("需要 Node.js >= 22.12");
for (const key of ["PORT", "KUBECONFIG", "K8S_WEB_TOKEN"]) {
  if (!process.env[key]) throw Error(`.env 缺少 ${key}`);
}
if (!Number.isInteger(Number(process.env.PORT)) || Number(process.env.PORT) < 1 || Number(process.env.PORT) > 65535) throw Error("PORT 必须为 1–65535");
for (const file of process.env.KUBECONFIG.split(path.delimiter)) {
  if (!path.isAbsolute(file)) throw Error("KUBECONFIG 必须使用绝对路径");
  fs.accessSync(file, fs.constants.R_OK);
}
'

UNIT_FILE="$(mktemp)"
trap 'rm -f -- "$UNIT_FILE"' EXIT
sed \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=$APP_DIR|" \
  -e "s|^EnvironmentFile=.*|EnvironmentFile=$APP_DIR/.env|" \
  -e "s|^Environment=HOME=.*|Environment=HOME=$HOME|" \
  -e "s|^ExecStart=.*|ExecStart=$NODE_BIN $APP_DIR/server/index.js|" \
  deploy/kubescope.service > "$UNIT_FILE"
sudo install -o root -g root -m 644 "$UNIT_FILE" /etc/systemd/system/kubescope.service
sudo systemctl daemon-reload
sudo systemctl enable kubescope
# Restart also applies updated configuration on repeated deployment.
sudo systemctl restart kubescope
sudo systemctl status kubescope --no-pager
echo "部署完成。查看日志：sudo journalctl -u kubescope -f"
