import { readFile } from 'node:fs/promises';
export const deploymentSteps = [
  { id: 'runtime', title: '安装 containerd', description: '检查已有运行时，复用可用组件；未安装时准备主机环境并安装 containerd。' },
  { id: 'packages', title: '安装 Kubernetes 工具', description: '选择 Kubernetes 版本，检查并补齐 kubeadm、kubelet 和 kubectl。' },
  { id: 'images', title: '解析所需镜像', description: '解析 Kubernetes 与 Flannel 镜像清单，确认所需镜像后再拉取。' },
  { id: 'pull-images', title: '拉取镜像', description: '一键拉取全部镜像，也可逐个拉取或重试。全部镜像就绪后可初始化控制平面。' },
  { id: 'init', title: '初始化控制平面', description: '确认本机 IPv4，初始化控制平面；已有集群只校验配置和状态。' },
  { id: 'network', title: '安装 Flannel 网络', description: '安装 Pod 网络插件。' },
  { id: 'verify', title: '验证集群', description: '等待 API Server、节点和系统 Pod 就绪，并加载集群连接。' },
];
export async function deploymentScript(step) {
  const policy = await readFile(new URL('./provision/runtime-policy.sh', import.meta.url), 'utf8');
  const install = await readFile(new URL('./provision/install.sh', import.meta.url), 'utf8');
  const bootstrap = await readFile(new URL('./provision/cluster.sh', import.meta.url), 'utf8');
  const header = 'set -Eeuo pipefail\numask 077\nexport DEBIAN_FRONTEND=noninteractive\nexec 9>/run/kubescope-cluster.lock\nflock -n 9 || { echo "已有集群操作正在执行" >&2; exit 1; }\n';
  if (step === 'runtime') {
    const check = `
kubescope_verify_runtime() {
  containerd --version
  containerd config dump | grep -E 'SystemdCgroup[[:space:]]*=[[:space:]]*true' >/dev/null || { echo '已有 containerd 未启用 SystemdCgroup，请检查运行时配置后重试' >&2; return 1; }
  systemctl enable containerd
  systemctl start containerd
  systemctl is-active --quiet containerd
  ctr --address /run/containerd/containerd.sock plugins ls | awk '
    ($1 == "io.containerd.grpc.v1" && $2 == "cri") || ($1 == "io.containerd.cri.v1" && $2 == "runtime") { found = 1; if ($NF != "ok") bad = 1 }
    END { exit (!found || bad) }
  ' || { echo 'containerd CRI 插件不可用，请检查运行时配置后重试' >&2; return 1; }
}
echo '[检查] containerd 安装状态'
if command -v containerd >/dev/null; then
  containerd --version | grep -Eq '[[:space:]]v?[12]\\.[0-9]+\\.' || { echo '已有 containerd 版本不受支持，请人工检查' >&2; exit 1; }
  kubescope_verify_runtime
  echo '[跳过] containerd 已安装且可用，保留现有配置'
  exit 0
fi
`;
    const preflight = bootstrap.slice(bootstrap.indexOf('if [[ "$CLUSTER_ACTION"'), bootstrap.indexOf('  # INSTALL_RUNTIME'));
    return header + policy + check + '\nexport CLUSTER_ACTION=install\nexport KUBESCOPE_INSTALL_PHASE=runtime\n' + preflight + '\nfi\n' + install + '\nkubescope_verify_runtime\n';
  }
  if (step === 'packages') return header + policy + `
export KUBESCOPE_INSTALL_PHASE=packages
echo '[检查] Kubernetes 工具安装状态'
all_installed=true
for component in kubeadm kubelet kubectl; do
  installed=$(dpkg-query -W -f='\${Status} \${Version}' "$component" 2>/dev/null || true)
  if [[ "$installed" == 'install ok installed '* ]]; then
    installed=\${installed##* }
    installed=\${installed#*:}
    if [[ "\${installed%%-*}" != "$K8S_VERSION" ]]; then
      echo "$component 已安装版本 $installed，与所选 $K8S_VERSION 不一致；请先处理版本差异后重试" >&2
      exit 1
    fi
    command -v "$component" >/dev/null || { echo "$component 软件包已安装但命令缺失，请修复软件包后重试" >&2; exit 1; }
    echo "[跳过] $component 已安装目标版本 $K8S_VERSION"
  else
    if command -v "$component" >/dev/null; then
      echo "检测到非 APT 管理的 $component，请确认版本及安装来源后重试；不会覆盖现有命令" >&2
      exit 1
    fi
    all_installed=false
    echo "[安装] 待补齐 $component"
  fi
done
if [[ "$all_installed" == true ]]; then
  systemctl enable kubelet
  echo '[完成] Kubernetes 工具已就绪，保留现有安装'
  exit 0
fi
source /etc/os-release
kubescope_supported_ubuntu "$ID" "$VERSION_ID"
if ! command -v curl >/dev/null || ! command -v gpg >/dev/null; then
  apt-get update -q
  apt-get install -y ca-certificates curl gpg
fi
` + install + '\napt-mark unhold kubectl 2>/dev/null || true\napt-get install -y "kubectl=$PACKAGE_VERSION"\napt-mark hold kubectl\nkubeadm version -o short\nkubectl version --client\n';
  if (step === 'init') return header + `
if [[ -s /etc/kubernetes/admin.conf ]]; then
  echo '检测到已初始化控制平面，验证配置后继续（不重复执行 kubeadm init）'
  export KUBECONFIG=/etc/kubernetes/admin.conf
  awk -v expected="--advertise-address=$TARGET_IP" '$2 == expected { found = 1 } END { exit !found }' /etc/kubernetes/manifests/kube-apiserver.yaml || { echo '已有控制平面 IP 与所选地址不一致' >&2; exit 1; }
  kubectl --request-timeout=10s -n kube-system get configmap kubeadm-config -o jsonpath='{.data.ClusterConfiguration}' | grep -Fx "kubernetesVersion: v$K8S_VERSION" || { echo '已有集群版本与所选版本不一致' >&2; exit 1; }
  kubectl --request-timeout=10s get --raw=/readyz
else
  [[ ! -e /etc/kubernetes/kubelet.conf && ! -e /var/lib/etcd/member && ! -s /etc/kubernetes/manifests/kube-apiserver.yaml ]] || { echo '检测到不完整的初始化，请人工检查后重试；不会自动 reset' >&2; exit 1; }
  kubeadm init --kubernetes-version "v$K8S_VERSION" --apiserver-advertise-address "$TARGET_IP" --pod-network-cidr 10.244.0.0/16 --cri-socket unix:///run/containerd/containerd.sock --skip-token-print
fi
`;
  if (step === 'network') return header + `
export KUBECONFIG=/etc/kubernetes/admin.conf
echo '[检查] Flannel 网络插件'
existing=$(kubectl --request-timeout=10s -n kube-flannel get daemonset kube-flannel-ds --ignore-not-found -o name)
if [[ -n "$existing" ]]; then
  echo '[跳过] Flannel 已安装，检查运行状态'
else
  kubectl apply -f "$FLANNEL_MANIFEST"
fi
kubectl --request-timeout=10s rollout status daemonset/kube-flannel-ds -n kube-flannel --timeout=300s
`;

  if (step === 'verify') return header + '\n' + bootstrap.slice(bootstrap.lastIndexOf('export KUBECONFIG=/etc/kubernetes/admin.conf')) + '\nkubectl --request-timeout=10s rollout status daemonset/kube-flannel-ds -n kube-flannel --timeout=300s\n';
  throw new Error('未知部署步骤');
}
