export const sections = [
  ["registries", "⚙", "镜像仓库维护"],
  ["nodeconfig", "⌘", "节点配置"],
  ["overview", "◫", "集群概览"],
  ["nodes", "⬡", "节点"],
  ["namespaces", "▦", "命名空间"],
  ["customresourcedefinitions", "▤", "自定义资源定义 CRD"],
  ["customresources", "▧", "CR 实例"],
  ["pods", "◈", "Pods"],
  ["deployments", "▤", "Deployments"],
  ["configmaps", "▤", "ConfigMap"],
  ["services", "⇄", "Services"],
  ["persistentvolumeclaims", "▣", "存储声明 PVC"],
  ["persistentvolumes", "▥", "持久卷 PV"],
  ["storageclasses", "▧", "存储类"],
  ["events", "☷", "事件"],
  ["operationlogs", "≋", "操作日志"],
];
export const kinds = [
  "nodes",
  "namespaces",
  "pods",
  "deployments",
  "configmaps",
  "services",
  "events",
  "persistentvolumeclaims",
  "persistentvolumes",
  "storageclasses",
  "customresourcedefinitions",
];
export const scoped = new Set(["pods", "deployments", "configmaps", "services", "events", "persistentvolumeclaims"]);
export const labels = Object.fromEntries(
  sections.map(([key, , label]) => [key, label]),
);
