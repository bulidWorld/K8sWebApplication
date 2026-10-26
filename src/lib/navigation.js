export const deploymentModuleTitles = {
  image: '镜像与版本',
  environment: '环境变量与外部连接',
  resources: '计算资源与副本',
  probes: '健康检查',
};

// A leaf selects an existing resource page, optionally focused on one config module.
export const navigation = [
  { id: 'overview', label: '集群概览', icon: '◫', section: 'overview' },
  { id: 'cluster', label: '集群资源', icon: '⎈', children: [
    { id: 'nodes', label: '节点', section: 'nodes' },
    { id: 'namespaces', label: '命名空间', section: 'namespaces' },
  ] },
  { id: 'applications', label: '应用管理', icon: '▦', children: [
    { id: 'deployment-group', label: 'Deployments', children: [
      { id: 'deployments', label: '部署列表', section: 'deployments' },
      ...Object.entries(deploymentModuleTitles).map(([module, label]) => ({ id: `deployment-${module}`, label, section: 'deployments', module })),
    ] },
    { id: 'pods', label: 'Pods', section: 'pods' },
  ] },
  { id: 'network-storage', label: '网络与存储', icon: '▧', children: [
    { id: 'network', label: '网络访问', children: [
      { id: 'services', label: 'Services', section: 'services' },
    ] },
    { id: 'storage', label: '存储资源', children: [
      { id: 'persistentvolumeclaims', label: '存储声明 PVC', section: 'persistentvolumeclaims' },
      { id: 'persistentvolumes', label: '持久卷 PV', section: 'persistentvolumes' },
      { id: 'storageclasses', label: '存储类', section: 'storageclasses' },
    ] },
  ] },
  { id: 'diagnostics', label: '运维诊断', icon: '◷', children: [
    { id: 'events', label: '集群事件', section: 'events' },
  ] },
];

export function isNavigationActive(entry, section, module = '') {
  return entry.children
    ? entry.children.some(child => isNavigationActive(child, section, module))
    : entry.section === section && (entry.module || '') === (section === 'deployments' ? module : '');
}

export function activeBranchIds(section, module = '') {
  const ids = [];
  function visit(entries) {
    for (const entry of entries) if (entry.children) {
      if (isNavigationActive(entry, section, module)) ids.push(entry.id);
      visit(entry.children);
    }
  }
  visit(navigation);
  return ids;
}
