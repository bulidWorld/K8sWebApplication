set -Eeuo pipefail
CHECK='检查 root 权限'
trap 'code=$?; printf "预检失败：%s（退出码 %s）\n" "$CHECK" "$code" >&2' ERR
[[ $(id -u) == 0 ]]
CHECK='检查操作系统信息'
source /etc/os-release
printf '[预检] 系统：%s（ID=%s VERSION_ID=%s）\n' "${PRETTY_NAME:-未知}" "$ID" "$VERSION_ID"
CHECK='仅支持 Ubuntu 22.04 / 24.04 / 26.04 及其维护版本'
kubescope_supported_ubuntu "$ID" "$VERSION_ID"
CHECK='仅支持 x86_64 / aarch64'
[[ $(uname -m) == x86_64 || $(uname -m) == aarch64 ]]
CHECK='至少需要 2 个 CPU'
[[ $(nproc) -ge 2 ]]
CHECK='内存至少需要约 2 GiB'
awk '/MemTotal/ { exit ($2 < 1900000) }' /proc/meminfo
CHECK='根目录至少需要 10 GiB 可用空间'
[[ $(df -Pk / | awk 'NR==2 {print $4}') -ge 10485760 ]]
CHECK='需要启用 cgroup v2'
[[ $(stat -fc %T /sys/fs/cgroup) == cgroup2fs ]]
CHECK='机器存在入群配置，请先核对节点状态'
[[ ! -e /etc/kubernetes/kubelet.conf && ! -e /etc/kubernetes/admin.conf ]]
for service in docker k3s rke2-server rke2-agent; do
  if systemctl is-active --quiet "$service"; then
    printf "Conflicting service: %s\n" "$service" >&2
    exit 1
  fi
done
CHECK='目标 IP 必须属于本机网卡'
ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -Fx "$TARGET_IP" > /dev/null
CHECK='需要可用的 apt-get'
command -v apt-get >/dev/null
command -v curl >/dev/null || command -v wget >/dev/null || command -v apt-get >/dev/null
API_HOST=${API_SERVER#https://}
API_PORT=${API_HOST##*:}
if [[ "$API_HOST" == *:* ]]; then API_HOST=${API_HOST%:*}; else API_PORT=443; fi
CHECK='新节点无法连接 API Server 的 TCP 端口'
timeout 10 bash -c 'exec 3<>/dev/tcp/"$1"/"$2"' _ "$API_HOST" "$API_PORT"
# Ensure the required Ubuntu and Kubernetes package sources are reachable.
CHECK='无法解析 pkgs.k8s.io 安装源'
getent hosts pkgs.k8s.io >/dev/null
# Reject an existing runtime unless it was installed by this executor (failed job retry).
if command -v containerd >/dev/null; then
CHECK='检测到非本系统管理的 containerd，禁止覆盖'
  [[ -f /var/lib/kubescope-expansion/managed ]]
fi
printf 'Precheck passed\n'
