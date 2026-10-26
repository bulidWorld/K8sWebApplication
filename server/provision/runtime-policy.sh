# Pure policy helpers, prepended to remote scripts by the task engine.
kubescope_supported_ubuntu() {
  [[ "$1" == ubuntu && "$2" =~ ^(22|24|26)\.04(\.[0-9]+)?$ ]]
}

kubescope_containerd_package_version() {
  local requested=$1 candidate=$2 selected
  if [[ "$requested" == auto ]]; then selected=$candidate; else selected=$requested; fi
  if [[ ! "$selected" =~ ^[12]\.[0-9][a-zA-Z0-9.+:~_-]*$ ]]; then
    printf '无法选择 containerd 1.x / 2.x 软件包（配置=%s，软件源候选=%s），请核对软件源或将包版本设为 auto。\n' "$requested" "$candidate" >&2
    return 1
  fi
  printf '%s\n' "$selected"
}

# APT's unprivileged verification process must be able to traverse these folders
# and read the public signing key/source, even when sudo inherits umask 077.
kubescope_prepare_apt_permissions() {
  local apt_root=${1:-/etc/apt}
  install -d -m 0755 "$apt_root/keyrings" "$apt_root/sources.list.d"
  local file
  for file in "$apt_root/keyrings/kubernetes-apt-keyring.gpg" "$apt_root/sources.list.d/kubernetes.list"; do
    if [[ -f "$file" ]]; then chmod 0644 "$file"; fi
  done
}

# Consume the full madison output: early awk exit can SIGPIPE apt-cache under pipefail.
# Compare the upstream version literally (1.34.1 must not match 1.34.10).
kubescope_select_kubernetes_package_version() {
  awk -v version="$1" 'index($3, version "-") == 1 && substr($3, length(version) + 2) ~ /^[0-9.]+$/ && !found { print $3; found = 1 }'
}
