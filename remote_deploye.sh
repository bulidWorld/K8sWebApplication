#!/usr/bin/env bash
# Upload the latest package.sh artifact and install it with remote sudo.
set -euo pipefail
set +x # Never trace credential assignments, even if invoked with bash -x.
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_HOST="${DEPLOY_HOST:-192.168.100.132}"
DEPLOY_USER="${DEPLOY_USER:-zhiwenxia}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
RELEASES_DIR="${RELEASES_DIR:-$PROJECT_DIR/releases}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/kubescope-releases}"
REMOTE_NODE_BIN="${REMOTE_NODE_BIN:-}"
SSH_IDENTITY="${SSH_IDENTITY:-}"
# Default password requested for this deployment host; empty overrides restore prompts.
DEPLOY_PASSWORD="${DEPLOY_PASSWORD-123456}"
SUDO_PASSWORD="${SUDO_PASSWORD-$DEPLOY_PASSWORD}"
DRY_RUN=false
usage() {
  cat <<'HELP'
Usage: bash remote_deploye.sh [options]
  --user USER          SSH user (default: zhiwenxia)
  --host HOST          Server (default: 192.168.100.132)
  --port PORT          SSH port (default: 22)
  --identity FILE      Optional SSH private key
  --releases-dir DIR   Package directory (default: ./releases beside this script)
  --remote-dir DIR     Remote release root (default: /opt/kubescope-releases)
  --node-bin FILE      Remote Node.js path; otherwise reuse the old service executable
  --dry-run            Show selected package and destination without connecting
  -h, --help           Show help
SSH/sudo use the configured default password. Override DEPLOY_PASSWORD/SUDO_PASSWORD
or set both empty for interactive prompts. Passwords are never passed as arguments.
HELP
}
while (( $# )); do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    --user|--host|--port|--identity|--releases-dir|--remote-dir|--node-bin)
      (( $# >= 2 )) || { echo "Missing value for $1" >&2; exit 1; }
      case "$1" in
        --user) DEPLOY_USER=$2 ;; --host) DEPLOY_HOST=$2 ;; --port) DEPLOY_PORT=$2 ;;
        --identity) SSH_IDENTITY=$2 ;; --releases-dir) RELEASES_DIR=$2 ;;
        --remote-dir) REMOTE_ROOT=$2 ;; --node-bin) REMOTE_NODE_BIN=$2 ;;
      esac
      shift 2 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ && "$DEPLOY_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || { echo 'Invalid SSH user/host' >&2; exit 1; }
[[ "$DEPLOY_PORT" =~ ^[0-9]{1,5}$ ]] && (( 10#$DEPLOY_PORT >= 1 && 10#$DEPLOY_PORT <= 65535 )) || { echo 'Invalid SSH port' >&2; exit 1; }
for value in "$REMOTE_ROOT" "${REMOTE_NODE_BIN:-/auto}"; do
  [[ "$value" =~ ^/[a-zA-Z0-9_./+-]+$ && "/$value/" != *'/../'* ]] || { echo 'Remote paths must be absolute and contain no spaces or parent traversal' >&2; exit 1; }
done
[[ -z "$SSH_IDENTITY" || -r "$SSH_IDENTITY" ]] || { echo 'SSH key is not readable' >&2; exit 1; }
for tool in tar sha256sum timeout; do command -v "$tool" >/dev/null || { echo "Missing command: $tool" >&2; exit 1; }; done
ARCHIVE=''
shopt -s nullglob
for candidate in "$RELEASES_DIR"/kubescope-*.tar.gz; do
  [[ -f "$candidate" && ! -L "$candidate" ]] || continue
  [[ "${candidate##*/}" =~ ^kubescope-[0-9A-Za-z._+-]+-[0-9]{8}T[0-9]{6}Z\.tar\.gz$ ]] || continue
  if [[ -z "$ARCHIVE" || "$candidate" -nt "$ARCHIVE" ]]; then ARCHIVE=$candidate; fi
done
[[ -n "$ARCHIVE" ]] || { echo "No package.sh artifact found in $RELEASES_DIR. Run bash package.sh first." >&2; exit 1; }
ARCHIVE="$(cd -- "$(dirname -- "$ARCHIVE")" && pwd)/${ARCHIVE##*/}"
LOCAL_TMP="$(mktemp -d /tmp/kubescope-deploy.XXXXXXXXXXXX)"
REMOTE_UPLOAD=''
REMOTE="$DEPLOY_USER@$DEPLOY_HOST"
COMMON=(-o ControlMaster=no -o ControlPath=none -o ControlPersist=no -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
[[ -z "$SSH_IDENTITY" ]] || COMMON+=(-i "$SSH_IDENTITY")
SSH=(ssh -p "$DEPLOY_PORT" -o BatchMode=no "${COMMON[@]}")
SCP=(scp -P "$DEPLOY_PORT" -o BatchMode=no "${COMMON[@]}")
cleanup() {
  local result=$?
  trap - EXIT
  if [[ "$REMOTE_UPLOAD" =~ ^/tmp/kubescope-upload\.[a-zA-Z0-9]+$ ]]; then
    timeout 10 ssh -p "$DEPLOY_PORT" -o BatchMode=yes "${COMMON[@]}" "$REMOTE" "rm -rf -- '$REMOTE_UPLOAD'" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$LOCAL_TMP"
  exit "$result"
}
trap cleanup EXIT
if [[ -n "$DEPLOY_PASSWORD" ]]; then
  umask 077
  printf '%s\n' "$DEPLOY_PASSWORD" > "$LOCAL_TMP/password"
  cat > "$LOCAL_TMP/askpass" <<'ASKPASS'
#!/bin/sh
case "$1" in
  *assword*|*assphrase*) cat "$KUBESCOPE_DEPLOY_PASSWORD_FILE" ;;
  *) exit 1 ;;
esac
ASKPASS
  chmod 700 "$LOCAL_TMP/askpass"
  export KUBESCOPE_DEPLOY_PASSWORD_FILE="$LOCAL_TMP/password"
  export SSH_ASKPASS="$LOCAL_TMP/askpass" SSH_ASKPASS_REQUIRE=force
  export DISPLAY="${DISPLAY:-kubescope-deploy}"
  COMMON+=(-o StrictHostKeyChecking=yes -o NumberOfPasswordPrompts=1)
  SSH=(ssh -p "$DEPLOY_PORT" -o BatchMode=no "${COMMON[@]}")
  SCP=(scp -P "$DEPLOY_PORT" -o BatchMode=no "${COMMON[@]}")
fi
printf '[1/6] 检查构建包结构与校验值…\n'
tar -tzf "$ARCHIVE" > "$LOCAL_TMP/entries"
IFS= read -r first < "$LOCAL_TMP/entries"
PACKAGE_DIR=${first%%/*}
[[ "$PACKAGE_DIR" =~ ^kubescope-[0-9A-Za-z._+-]+$ ]] || { echo 'Package top-level directory must include its version' >&2; exit 1; }
while IFS= read -r entry; do
  [[ "$entry" == "$PACKAGE_DIR" || "$entry" == "$PACKAGE_DIR/"* ]] && [[ "/$entry/" != *'/../'* ]] || { echo 'Invalid package entry' >&2; exit 1; }
done < "$LOCAL_TMP/entries"
[[ -n "$(sed -n "\\|^$PACKAGE_DIR/deploy\.sh$|p" "$LOCAL_TMP/entries")" ]] || { echo 'Package is missing deploy.sh' >&2; exit 1; }
CHECKSUM=$(sha256sum < "$ARCHIVE"); CHECKSUM=${CHECKSUM%% *}
ARCHIVE_NAME=${ARCHIVE##*/}; ARCHIVE_NAME=${ARCHIVE_NAME%.tar.gz}
printf '构建包：%s\n目标：%s:%s\n部署根目录：%s\n包内目录：%s\n' "$ARCHIVE" "$REMOTE" "$DEPLOY_PORT" "$REMOTE_ROOT" "$PACKAGE_DIR"
printf '包 SHA256：%s\n' "$CHECKSUM"
if "$DRY_RUN"; then echo '预览完成，未连接远端。'; exit 0; fi
for tool in ssh scp; do command -v "$tool" >/dev/null || { echo "Missing command: $tool" >&2; exit 1; }; done

cat > "$LOCAL_TMP/install.sh" <<'REMOTE_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
umask 077
ARCHIVE=$1 ROOT=$2 TOP=$3 EXPECTED=$4 BUILD=$5 NODE_OVERRIDE=${6:-}
[[ $(id -u) == 0 ]] || { echo 'Remote installation requires sudo/root' >&2; exit 1; }
printf '[远端] 校验上传文件…\n'
ACTUAL=$(sha256sum "$ARCHIVE"); [[ ${ACTUAL%% *} == "$EXPECTED" ]] || { echo '上传文件校验失败，停止部署。' >&2; exit 1; }
# Serialize deployments, including different local callers.
exec 9>/run/lock/kubescope-remote-deploy.lock
flock -n 9 || { echo '已有远程部署正在进行。' >&2; exit 1; }
OLD_DIR=$(systemctl show kubescope --property=WorkingDirectory --value 2>/dev/null || true)
OLD_EXEC=$(systemctl show kubescope --property=ExecStart --value 2>/dev/null || true)
NODE_BIN=$NODE_OVERRIDE
if [[ -z "$NODE_BIN" ]]; then NODE_BIN=$(printf '%s\n' "$OLD_EXEC" | sed -n 's/.*path=\([^ ;]*\).*/\1/p'); fi
[[ -n "$NODE_BIN" ]] || NODE_BIN=$(command -v node || true)
[[ "$NODE_BIN" =~ ^/[a-zA-Z0-9_./+-]+$ && -x "$NODE_BIN" ]] || { echo '找不到远端 Node.js，请通过 --node-bin 指定。' >&2; exit 1; }
WAS_ACTIVE=false
if systemctl is-active --quiet kubescope; then WAS_ACTIVE=true; fi
install -d -m 755 "$ROOT"
RELEASE=$(mktemp -d "$ROOT/$BUILD.XXXXXXXX")
printf '[远端] 解压至：%s\n' "$RELEASE"
tar -xzf "$ARCHIVE" -C "$RELEASE" --no-same-owner --no-same-permissions
APP="$RELEASE/$TOP"
[[ -f "$APP/deploy.sh" ]] || { echo '解压后缺少 deploy.sh' >&2; exit 1; }
HAD_UNIT=false
if [[ -f /etc/systemd/system/kubescope.service ]]; then cp -p /etc/systemd/system/kubescope.service "$RELEASE/previous.service"; HAD_UNIT=true; fi
rollback() {
  local code=$?
  trap - EXIT
  echo "部署失败，保留新目录供排查：$RELEASE" >&2
  systemctl stop kubescope || true
  if "$HAD_UNIT"; then
    cp -p "$RELEASE/previous.service" /etc/systemd/system/kubescope.service
    systemctl daemon-reload
    if "$WAS_ACTIVE"; then systemctl restart kubescope || echo '旧服务恢复失败，请检查 journalctl -u kubescope' >&2; fi
  else
    rm -f /etc/systemd/system/kubescope.service
    systemctl daemon-reload
    if "$WAS_ACTIVE"; then systemctl restart kubescope || true; fi
  fi
  exit "$code"
}
printf '[远端] 检查旧服务和扩容任务…\n'
# Before stopping anything, reject upgrades while a node expansion is active.
if "$WAS_ACTIVE" && [[ -n "$OLD_DIR" && -f "$OLD_DIR/.env" ]]; then
  "$NODE_BIN" --input-type=module - "$OLD_DIR" <<'CHECK_TASKS'
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
process.loadEnvFile(path.join(root, '.env'));
const config = [path.join(root, 'var/expansion/config.json'), process.env.K8S_EXPANSION_CONFIG].filter(Boolean).find(f => fs.existsSync(f));
if (config) {
  const c = JSON.parse(fs.readFileSync(config, 'utf8'));
  const state = path.join(c.stateDirectory, 'tasks.json');
  const tasks = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')) : [];
  if (tasks.some(t => ['checking', 'running'].includes(t.status))) throw Error('存在未完成的节点扩容任务，停止部署；请等待任务完成。');
}
CHECK_TASKS
fi
trap 'exit 130' INT
trap 'exit 143' TERM HUP
trap rollback EXIT
if "$WAS_ACTIVE"; then echo '[远端] 停止旧服务，准备迁移配置…'; systemctl stop kubescope; fi
# Snapshot after stopping to avoid copying a partially updated tasks.json.
if [[ -n "$OLD_DIR" && -d "$OLD_DIR" ]]; then
  if [[ -f "$OLD_DIR/.env" ]]; then cp -p "$OLD_DIR/.env" "$APP/.env"; echo '已沿用旧服务 .env'; fi
  if [[ -d "$OLD_DIR/var" ]]; then install -d -m 700 "$APP/var"; cp -a "$OLD_DIR/var/." "$APP/var/"; chown -Rh root:root "$APP/var"; echo '已保留扩容配置、任务与日志'; fi
  "$NODE_BIN" --input-type=module - "$OLD_DIR" "$APP" <<'MIGRATE'
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
const [oldRoot, nextRoot] = process.argv.slice(2);
const rebase = value => typeof value === 'string' && value.startsWith(oldRoot + '/var/') ? nextRoot + value.slice(oldRoot.length) : value;
const file = path.join(nextRoot, 'var/expansion/config.json');
const copiedEnv = path.join(nextRoot, '.env');
const legacyEnv = fs.existsSync(copiedEnv) ? parseEnv(fs.readFileSync(copiedEnv, 'utf8')) : {};
const source = fs.existsSync(file) ? file : legacyEnv.K8S_EXPANSION_CONFIG;
if (source && fs.existsSync(source)) {
  const c = JSON.parse(fs.readFileSync(source, 'utf8'));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  c.stateDirectory = rebase(c.stateDirectory); c.knownHosts = rebase(c.knownHosts);
  for (const t of c.targets || []) if (t.identityFile) t.identityFile = rebase(t.identityFile);
  fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
}
const envFile = path.join(nextRoot, '.env');
if (fs.existsSync(envFile)) {
  let text = fs.readFileSync(envFile, 'utf8');
  const values = parseEnv(text);
  for (const key of ['K8S_AUDIT_FILE', 'K8S_EXPANSION_CONFIG']) {
    if (values[key] && rebase(values[key]) !== values[key]) {
      text = text.replace(new RegExp('^\\s*(?:export\\s+)?' + key + '\\s*=.*$', 'gm'), '');
      text += '\n' + key + '=' + JSON.stringify(rebase(values[key])) + '\n';
    }
  }
  fs.writeFileSync(envFile, text, { mode: 0o600 });
}
MIGRATE
fi
cd "$APP"
printf '[远端] 执行 deploy.sh（Node：%s）…\n' "$NODE_BIN"
NODE_BIN="$NODE_BIN" bash ./deploy.sh
echo '[远端] 检查新服务状态…'
sleep 2
systemctl is-active --quiet kubescope
trap - EXIT
printf '远程部署成功：%s\n' "$APP"
printf '运行用户：'; systemctl show kubescope --property=User --value
REMOTE_SCRIPT

# Use ordinary independent SSH sessions. Some hosts refuse additional multiplexed
# sessions; do not fall back to BatchMode or start a persistent background master.
printf '[2/6] 使用独立 SSH 连接，不启用连接复用。\n'
printf '[3/6] 准备上传文件…\n'
mkdir -m 700 "$LOCAL_TMP/upload"
ln -- "$ARCHIVE" "$LOCAL_TMP/upload/package.tar.gz" 2>/dev/null || cp -- "$ARCHIVE" "$LOCAL_TMP/upload/package.tar.gz"
cp -- "$LOCAL_TMP/install.sh" "$LOCAL_TMP/upload/install.sh"
REMOTE_UPLOAD="/tmp/kubescope-upload.${LOCAL_TMP##*.}"
printf '[4/6] 上传构建包和部署脚本…\n'
"${SCP[@]}" -r -- "$LOCAL_TMP/upload" "$REMOTE:$REMOTE_UPLOAD"
printf '[5/6] 文件上传完成。\n'

# Validate the upload ownership before executing scripts, and clean up using the
# same connection even when sudo/deploy fails. Credentials are never retained.
REMOTE_RUN=$(cat <<'REMOTE_LAUNCH'
set -eu
auto_sudo=$1; upload=$2; shift 2
[[ -d "$upload" && ! -L "$upload" && "$(stat -c %u -- "$upload")" == "$(id -u)" ]] || { echo '上传目录所有者校验失败' >&2; exit 1; }
for file in package.tar.gz install.sh; do
  [[ -f "$upload/$file" && ! -L "$upload/$file" && "$(stat -c %u -- "$upload/$file")" == "$(id -u)" ]] || { echo '上传文件所有者校验失败' >&2; exit 1; }
done
chmod 700 "$upload"
trap 'rm -rf -- "$upload"' EXIT
if [[ "$auto_sudo" == yes ]]; then
  sudo -S -k -p '' -- bash -c 'exec bash "$1" "${@:2}" </dev/null' _ "$upload/install.sh" "$upload/package.tar.gz" "$@"
else
  sudo -- bash "$upload/install.sh" "$upload/package.tar.gz" "$@"
fi
REMOTE_LAUNCH
)
quote_shell() { local value=${1//\'/\'\\\'\'}; printf "'%s'" "$value"; }
if [[ -n "$SUDO_PASSWORD" ]]; then
  printf '[6/6] 自动认证并执行远端部署…\n'
  printf '%s\n' "$SUDO_PASSWORD" | "${SSH[@]}" -T "$REMOTE" "bash -c $(quote_shell "$REMOTE_RUN") _ yes '$REMOTE_UPLOAD' '$REMOTE_ROOT' '$PACKAGE_DIR' '$CHECKSUM' '$ARCHIVE_NAME' '$REMOTE_NODE_BIN'"
else
  printf '[6/6] 执行远端部署（请按提示输入 sudo 密码）…\n'
  "${SSH[@]}" -tt "$REMOTE" "bash -c $(quote_shell "$REMOTE_RUN") _ no '$REMOTE_UPLOAD' '$REMOTE_ROOT' '$PACKAGE_DIR' '$CHECKSUM' '$ARCHIVE_NAME' '$REMOTE_NODE_BIN'"
fi
REMOTE_UPLOAD='' # The remote EXIT trap has removed it; do not open a cleanup session.
