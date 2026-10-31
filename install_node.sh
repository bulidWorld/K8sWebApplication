#!/usr/bin/env bash
# Print only the selected Node.js absolute path to stdout for deploy.sh.
set -euo pipefail

if [[ "$(id -u)" != 0 ]]; then
  echo '请使用 sudo bash install_node.sh 安装 Node.js。' >&2
  exit 1
fi
NODE_CANDIDATE="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_CANDIDATE" && -x /usr/local/bin/node ]]; then
  NODE_CANDIDATE=/usr/local/bin/node
fi
if [[ -n "$NODE_CANDIDATE" ]]; then
  [[ "$NODE_CANDIDATE" == /* && -x "$NODE_CANDIDATE" ]] || { echo 'NODE_BIN 必须是可执行文件的绝对路径。' >&2; exit 1; }
  "$NODE_CANDIDATE" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' || {
    echo '已有 Node.js 无法运行或版本低于 22.12，请升级后重试；未覆盖现有安装。' >&2
    exit 1
  }
  echo "[Node.js] 使用已有安装：$NODE_CANDIDATE" >&2
  printf '%s\n' "$NODE_CANDIDATE"
  exit 0
fi

[[ "$(uname -s)" == Linux ]] || { echo '自动安装仅支持 Linux。' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) echo '自动安装仅支持 x86_64 / aarch64 架构。' >&2; exit 1 ;;
esac
for tool in curl tar xz sha256sum; do
  if ! command -v "$tool" >/dev/null; then
    command -v apt-get >/dev/null || { echo "缺少 $tool，请先安装 curl、ca-certificates、tar、xz-utils 和 coreutils。" >&2; exit 1; }
    echo '[Node.js] 安装下载及解压工具…' >&2
    apt-get update >&2
    DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl tar xz-utils coreutils >&2
    break
  fi
done
TEMP_DIR=$(mktemp -d)
trap 'rm -rf -- "$TEMP_DIR"' EXIT
CURL_ARGS=(--fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 600 --retry 3)
echo '[Node.js] 获取 Node.js 24 LTS 官方安装包校验信息…' >&2
curl "${CURL_ARGS[@]}" https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$TEMP_DIR/SHASUMS256.txt"
MANIFEST_LINE=$(awk -v arch="$NODE_ARCH" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") { print }' "$TEMP_DIR/SHASUMS256.txt")
read -r NODE_SHA NODE_ARCHIVE EXTRA <<< "$MANIFEST_LINE"
if [[ ! "$NODE_SHA" =~ ^[a-f0-9]{64}$ || ! "$NODE_ARCHIVE" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ || -n "${EXTRA:-}" || "$MANIFEST_LINE" == *$'\n'* ]]; then
  echo '无法解析 Node.js 官方安装包校验信息，停止安装。' >&2
  exit 1
fi
NODE_RELEASE=${NODE_ARCHIVE#node-}
NODE_RELEASE=${NODE_RELEASE%-linux-*}
echo "[Node.js] 下载 $NODE_ARCHIVE…" >&2
curl "${CURL_ARGS[@]}" "https://nodejs.org/dist/$NODE_RELEASE/$NODE_ARCHIVE" -o "$TEMP_DIR/$NODE_ARCHIVE"
printf '%s  %s\n' "$NODE_SHA" "$TEMP_DIR/$NODE_ARCHIVE" | sha256sum --check --status || { echo 'Node.js 安装包 SHA256 校验失败，停止安装。' >&2; exit 1; }
tar -xJf "$TEMP_DIR/$NODE_ARCHIVE" -C "$TEMP_DIR" --no-same-owner
NODE_DIRECTORY=${NODE_ARCHIVE%.tar.xz}
"$TEMP_DIR/$NODE_DIRECTORY/bin/node" --version >&2
[[ ! -e "/usr/local/lib/nodejs/$NODE_DIRECTORY" ]] || { echo 'Node.js 目标目录已存在，请检查后重试。' >&2; exit 1; }
install -d -m 755 /usr/local/lib/nodejs /usr/local/bin
mv -- "$TEMP_DIR/$NODE_DIRECTORY" "/usr/local/lib/nodejs/$NODE_DIRECTORY"
chown -R root:root "/usr/local/lib/nodejs/$NODE_DIRECTORY"
chmod -R a+rX "/usr/local/lib/nodejs/$NODE_DIRECTORY"
ln -sfn "/usr/local/lib/nodejs/$NODE_DIRECTORY/bin/node" /usr/local/bin/node
# Preserve any separately installed npm/npx commands.
for tool in npm npx; do
  if [[ ! -e "/usr/local/bin/$tool" && ! -L "/usr/local/bin/$tool" ]]; then
    ln -s "/usr/local/lib/nodejs/$NODE_DIRECTORY/bin/$tool" "/usr/local/bin/$tool"
  fi
done
/usr/local/bin/node --version >&2
echo '[Node.js] 安装完成。' >&2
printf '%s\n' /usr/local/bin/node
