export const sections = [
  ["overview", "◫", "集群概览"],
  ["nodes", "⬡", "节点"],
  ["namespaces", "▦", "命名空间"],
  ["pods", "◈", "Pods"],
  ["deployments", "▤", "Deployments"],
  ["services", "⇄", "Services"],
  ["persistentvolumeclaims", "▣", "存储声明 PVC"],
  ["persistentvolumes", "▥", "持久卷 PV"],
  ["storageclasses", "▧", "存储类"],
  ["events", "☷", "事件"],
];
export const kinds = [
  "nodes",
  "namespaces",
  "pods",
  "deployments",
  "services",
  "events",
  "persistentvolumeclaims",
  "persistentvolumes",
  "storageclasses",
];
export const scoped = new Set(["pods", "deployments", "services", "events", "persistentvolumeclaims"]);
export const labels = Object.fromEntries(
  sections.map(([key, , label]) => [key, label]),
);
