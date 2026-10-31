set -Eeuo pipefail
umask 077
exec 9>/run/kubescope-cluster.lock
flock -n 9 || { echo '已有集群操作正在执行' >&2; exit 1; }
if [[ "$CLUSTER_ACTION" == install ]]; then
  [[ ! -e /etc/kubernetes/admin.conf && ! -e /etc/kubernetes/kubelet.conf && ! -e /var/lib/etcd/member ]]
  [[ ! -s /etc/kubernetes/manifests/kube-apiserver.yaml ]]
  if ss -ltnH | awk '{print $4}' | grep -Eq ':6443$'; then
    echo '6443 端口已占用，停止安装' >&2; exit 1
  fi
  source /etc/os-release
  kubescope_supported_ubuntu "$ID" "$VERSION_ID"
  [[ $(nproc) -ge 2 ]]
  awk '/MemTotal/ { exit ($2 < 1900000) }' /proc/meminfo
  [[ $(df -Pk / | awk 'NR==2 {print $4}') -ge 10485760 ]]
  [[ $(stat -fc %T /sys/fs/cgroup) == cgroup2fs ]]
  for service in docker k3s rke2-server rke2-agent; do
    if systemctl is-active --quiet "$service"; then echo "检测到冲突服务：$service" >&2; exit 1; fi
  done
  if command -v containerd >/dev/null && [[ ! -f /var/lib/kubescope-expansion/managed ]]; then
    echo '检测到已有 containerd，拒绝覆盖配置' >&2; exit 1
  fi
  # INSTALL_RUNTIME
  echo '[安装] 安装 kubectl'
  apt-get install -y "kubectl=$PACKAGE_VERSION"
  apt-mark hold kubectl
  echo '[安装] 初始化控制平面'
  kubeadm init --kubernetes-version "v$K8S_VERSION" --apiserver-advertise-address "$TARGET_IP" --pod-network-cidr 10.244.0.0/16 --cri-socket unix:///run/containerd/containerd.sock --skip-token-print
  export KUBECONFIG=/etc/kubernetes/admin.conf
  echo '[安装] 安装 Flannel 网络插件'
  kubectl apply -f "$FLANNEL_MANIFEST"
else
  [[ -s /etc/kubernetes/manifests/kube-apiserver.yaml ]]
  echo '[启动] 启动 containerd 和 kubelet，恢复静态控制平面 Pod'
  systemctl start containerd
  systemctl start kubelet
fi
export KUBECONFIG=/etc/kubernetes/admin.conf
echo '[验证] 等待 API Server 和节点就绪'
for attempt in $(seq 1 60); do
  if kubectl --request-timeout=5s get --raw=/readyz >/dev/null 2>&1; then break; fi
  sleep 5
done
kubectl --request-timeout=10s get --raw=/readyz
kubectl --request-timeout=10s wait --for=condition=Ready nodes --all --timeout=300s
kubectl --request-timeout=10s wait --for=condition=Ready pods --all -n kube-system --timeout=300s
echo '[完成] 集群已就绪'
