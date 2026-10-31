set -Eeuo pipefail
umask 077
REGISTRY_STAGE='检查 curl、python3、openssl 依赖'
# Record only stage and line number; commands can contain credentials.
trap 'registry_rc=$?; printf "[镜像源] 失败：阶段=%s，脚本行=%s，退出码=%s\n" "$REGISTRY_STAGE" "$LINENO" "$registry_rc" >&2; exit "$registry_rc"' ERR
echo '[镜像源] 获取并验证仓库 TLS 证书'
command -v curl >/dev/null
command -v python3 >/dev/null
command -v openssl >/dev/null
REGISTRY_TEMP=$(mktemp -d)
trap 'rm -rf "$REGISTRY_TEMP"' EXIT
if [[ ${REGISTRY_MODE:-configure} == apply ]]; then
  echo '[镜像源] 使用第 4 步已拉取的证书'
  cp -- "$REGISTRY_CACHE/certificate.pem" "$REGISTRY_TEMP/certificate.pem"
  cp -- "$REGISTRY_CACHE/private-key.pem" "$REGISTRY_TEMP/private-key.pem"
else
# Keep the authorization header out of process arguments.
printf 'header = "Authorization: Bearer %s"\n' "$REGISTRY_TLS_EXPORT_TOKEN" > "$REGISTRY_TEMP/curl.conf"
unset REGISTRY_TLS_EXPORT_TOKEN
echo "[镜像源] 直连 ${REGISTRY_PROTOCOL:-https}://${REGISTRY_IP}:${REGISTRY_PORT:-443}/api/tls/bundle（不使用代理）"
echo '[registry-progress:20] 正在请求证书接口'
REGISTRY_STAGE='请求证书接口'
if curl -kfsS --noproxy '*' --retry 2 --retry-delay 2 --retry-max-time 180 --connect-timeout 10 --max-time 60 --max-filesize 1048576 --config "$REGISTRY_TEMP/curl.conf" "${REGISTRY_PROTOCOL:-https}://${REGISTRY_IP}:${REGISTRY_PORT:-443}/api/tls/bundle" --write-out '[镜像源] HTTP=%{http_code}，目标=%{remote_ip}:%{remote_port}，本地=%{local_ip}，连接=%{time_connect}s，TLS=%{time_appconnect}s，首字节=%{time_starttransfer}s，总耗时=%{time_total}s\n' -o "$REGISTRY_TEMP/tls.json"; then
  echo '[镜像源] 证书接口请求成功，开始校验响应'
else
  registry_curl_rc=$?
  echo "[镜像源] curl 退出码=$registry_curl_rc（6=解析失败，7=连接失败，22=HTTP 错误，28=超时，35=TLS 握手失败，63=响应过大）" >&2
  echo '[镜像源] 证书接口请求失败，尚未修改 hosts 或 containerd 配置。' >&2
  echo '[镜像源] HTTP 503 表示仓库证书接口或其反向代理暂不可用，请检查仓库服务、上游健康状态及 /api/tls/bundle 路由；401/403 请检查证书导出 Token。' >&2
  exit "$registry_curl_rc"
fi
REGISTRY_STAGE='解析证书接口 JSON 和证书字段'
python3 - "$REGISTRY_TEMP" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
bundle = json.loads((p / 'tls.json').read_text())
for field, name, marker in [('certificate', 'certificate.pem', 'CERTIFICATE'), ('privateKey', 'private-key.pem', 'PRIVATE KEY')]:
    value = bundle.get(field)
    if not isinstance(value, str) or len(value) > 131072 or marker not in value:
        raise SystemExit('仓库 TLS bundle 字段无效')
    (p / name).write_text(value)
PY
fi
echo '[registry-progress:60] 验证证书有效期、公私钥及域名'
REGISTRY_STAGE='验证证书有效期及公私钥匹配'
openssl x509 -in "$REGISTRY_TEMP/certificate.pem" -checkend 0 -noout >/dev/null
openssl x509 -in "$REGISTRY_TEMP/certificate.pem" -pubkey -noout > "$REGISTRY_TEMP/cert.pub"
openssl pkey -in "$REGISTRY_TEMP/private-key.pem" -pubout > "$REGISTRY_TEMP/key.pub" 2>/dev/null
cmp -s "$REGISTRY_TEMP/cert.pub" "$REGISTRY_TEMP/key.pub" || { echo '仓库证书与私钥不匹配' >&2; exit 1; }
for domain in docker.io registry-1.docker.io ghcr.io registry.k8s.io; do
  REGISTRY_STAGE="验证证书域名 $domain"
  openssl x509 -in "$REGISTRY_TEMP/certificate.pem" -checkhost "$domain" -noout >/dev/null
done
if [[ ${REGISTRY_MODE:-configure} == prepare ]]; then
  REGISTRY_STAGE='保存已验证的证书'
  install -d -m 0700 "$REGISTRY_CACHE"
  install -m 0600 "$REGISTRY_TEMP/private-key.pem" "$REGISTRY_CACHE/private-key.pem"
  install -m 0600 "$REGISTRY_TEMP/certificate.pem" "$REGISTRY_CACHE/certificate.pem"
  echo '[registry-progress:100] 证书拉取和校验完成'
  exit 0
fi
REGISTRY_STAGE='检查 hosts 和 containerd 配置文件及 config_path'
[[ -f /etc/containerd/config.toml && ! -L /etc/containerd/config.toml && ! -L /etc/hosts ]]
# Check configuration before changing hosts or trust files.
grep -Eq '^[[:space:]]*config_path[[:space:]]*=' /etc/containerd/config.toml
REGISTRY_STAGE='备份并写入 hosts、证书和 containerd 配置'
backup="$(date +%Y%m%d%H%M%S)-$$"
cp -p /etc/hosts "/etc/hosts.kubescope-registry-${backup}.bak"
cp -p /etc/containerd/config.toml "/etc/containerd/config.toml.kubescope-registry-${backup}.bak"
install -d -m 0700 /etc/kubescope/registry
install -m 0600 "$REGISTRY_TEMP/private-key.pem" /etc/kubescope/registry/private-key.pem
install -m 0644 "$REGISTRY_TEMP/certificate.pem" /etc/kubescope/registry/certificate.pem
python3 - "$REGISTRY_IP" <<'PY'
import pathlib, sys
p = pathlib.Path('/etc/hosts')
domains = {'docker.io', 'registry-1.docker.io', 'ghcr.io', 'registry.k8s.io'}
lines = []
for line in p.read_text().splitlines():
    content, mark, comment = line.partition('#')
    fields = content.split()
    if len(fields) > 1 and any(host.lower() in domains for host in fields[1:]):
        aliases = [host for host in fields[1:] if host.lower() not in domains]
        if aliases: lines.append(' '.join([fields[0], *aliases]) + (' #' + comment if mark else ''))
        elif mark: lines.append('#' + comment)
    else: lines.append(line)
lines.append(sys.argv[1] + ' ' + ' '.join(sorted(domains)) + ' # kubescope registry')
p.write_text('\n'.join(lines) + '\n')
PY
for domain in docker.io registry-1.docker.io ghcr.io registry.k8s.io; do
  install -d -m 0755 "/etc/containerd/certs.d/$domain"
  install -m 0644 "$REGISTRY_TEMP/certificate.pem" "/etc/containerd/certs.d/$domain/ca.crt"
  cat > "/etc/containerd/certs.d/$domain/hosts.toml" <<HOSTS
server = "https://$domain"
[host."https://$domain"]
  capabilities = ["pull", "resolve"]
  ca = "/etc/containerd/certs.d/$domain/ca.crt"
HOSTS
done
sed -i -E 's|^([[:space:]]*config_path[[:space:]]*=).*|\1 "/etc/containerd/certs.d"|' /etc/containerd/config.toml
REGISTRY_STAGE='验证 containerd 配置'
containerd --config /etc/containerd/config.toml config dump >/dev/null
REGISTRY_STAGE='重启 containerd'
systemctl restart containerd
echo "[镜像源] 已配置；hosts 备份：/etc/hosts.kubescope-registry-${backup}.bak"
