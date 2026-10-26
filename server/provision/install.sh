set -Eeuo pipefail
STEP='准备初始化'
trap 'code=$?; printf "安装失败：%s（行 %s，退出码 %s）\n" "$STEP" "$LINENO" "$code" >&2' ERR
export DEBIAN_FRONTEND=noninteractive
mkdir -p /var/lib/kubescope-expansion
# Mark ownership before installing: a failed package operation can be retried.
touch /var/lib/kubescope-expansion/managed
STEP='关闭 swap 并备份系统配置'
printf '[安装] %s\n' "$STEP"
swapoff -a
# Preserve the original for operator recovery; disable fstab swap entries persistently.
[[ -f /etc/fstab.kubescope-backup ]] || cp -p /etc/fstab /etc/fstab.kubescope-backup
sed -i -E '/^[[:space:]]*#/! { /[[:space:]]swap[[:space:]]/s/^/# kubescope: /; }' /etc/fstab
# Dynamic zram/swap services require operator configuration; do not silently ignore them.
[[ -z $(swapon --noheadings --show) ]]
STEP='配置内核模块和网络参数'
printf '[安装] %s\n' "$STEP"
printf 'overlay\nbr_netfilter\n' > /etc/modules-load.d/kubescope.conf
modprobe overlay
modprobe br_netfilter
cat > /etc/sysctl.d/99-kubescope.conf <<'SYSCTL'
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward = 1
SYSCTL
sysctl --system >/dev/null
STEP='修复 APT 公钥与源文件读取权限'
printf '[安装] %s\n' "$STEP"
kubescope_prepare_apt_permissions
STEP='更新 Ubuntu 软件源'
printf '[安装] %s\n' "$STEP"
apt-get update -q
STEP='选择 containerd 安装版本'
printf '[安装] %s\n' "$STEP"
CONTAINERD_CANDIDATE=$(apt-cache policy containerd | awk '$1 == "Candidate:" {print $2}')
CONTAINERD_VERSION=$(kubescope_containerd_package_version "$CONTAINERD_VERSION" "$CONTAINERD_CANDIDATE")
printf '[安装] containerd 软件包版本：%s\n' "$CONTAINERD_VERSION"
STEP='安装 containerd 和基础依赖'
printf '[安装] %s\n' "$STEP"
apt-get install -y ca-certificates curl gpg "containerd=$CONTAINERD_VERSION"
STEP='配置和启动 containerd'
printf '[安装] %s\n' "$STEP"
CONTAINERD_INFO=$(containerd --version)
printf '[安装] 运行时：%s\n' "$CONTAINERD_INFO"
[[ "$CONTAINERD_INFO" =~ [[:space:]]v?([12])\.[0-9]+\. ]]
mkdir -p /etc/containerd
containerd config default > /etc/containerd/config.toml
# Generate the installed runtime's native format: v2 for containerd 1.x, v3 for 2.x.
sed -i -E 's/(SystemdCgroup[[:space:]]*=[[:space:]]*)false/\1true/' /etc/containerd/config.toml
# Fail explicitly if the expected runc option was absent from the runtime defaults.
grep -Eq 'SystemdCgroup[[:space:]]*=[[:space:]]*true' /etc/containerd/config.toml
containerd --config /etc/containerd/config.toml config dump >/dev/null
systemctl enable containerd
systemctl restart containerd
STEP='配置 Kubernetes 软件源'
printf '[安装] %s\n' "$STEP"
install -d -m 0755 /etc/apt/keyrings /etc/apt/sources.list.d
K8S_MINOR=${K8S_VERSION%.*}
curl --fail --silent --show-error --location --retry 3 "https://pkgs.k8s.io/core:/stable:/v${K8S_MINOR}/deb/Release.key" | gpg --dearmor --yes -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
printf 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v%s/deb/ /\n' "$K8S_MINOR" > /etc/apt/sources.list.d/kubernetes.list
kubescope_prepare_apt_permissions
apt-get update -q
# Select a complete Debian package version, not an unpinned latest version.
STEP='查找 Kubernetes 指定版本软件包'
printf '[安装] %s\n' "$STEP"
PACKAGE_VERSION=$(apt-cache madison kubeadm | kubescope_select_kubernetes_package_version "$K8S_VERSION")
if [[ -z "$PACKAGE_VERSION" ]]; then
  printf '软件源中找不到 Kubernetes %s 的完整软件包版本，请核对集群版本和软件源。\n' "$K8S_VERSION" >&2
  exit 1
fi
printf '[安装] Kubernetes 软件包版本：%s\n' "$PACKAGE_VERSION"
apt-mark unhold kubelet kubeadm 2>/dev/null || true
STEP='安装 kubeadm 和 kubelet'
printf '[安装] %s\n' "$STEP"
apt-get install -y "kubeadm=$PACKAGE_VERSION" "kubelet=$PACKAGE_VERSION"
apt-mark hold kubelet kubeadm containerd
systemctl enable kubelet
