import { loadAllYaml } from '@kubernetes/client-node';

export const flannelManifest = 'https://github.com/flannel-io/flannel/releases/download/v0.26.7/kube-flannel.yml';
export function validateVersion(version) {
  if (!/^1\.(3[1-5])\.\d{1,3}$/.test(version || '')) throw Object.assign(new Error('请输入 Kubernetes 1.31–1.35 的完整补丁版本'), { status: 400 });
}
export function manifestImages(yaml) {
  const images = new Set();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (['containers', 'initContainers', 'ephemeralContainers'].includes(key) && Array.isArray(item)) {
        for (const container of item) if (typeof container.image === 'string') images.add(container.image);
      } else visit(item);
    }
  };
  for (const document of loadAllYaml(yaml)) visit(document);
  return [...images];
}
export async function discoverImages(version, run, fetchManifest = fetch) {
  validateVersion(version);
  const output = await run('/usr/bin/kubeadm', ['config', 'images', 'list', '--kubernetes-version', `v${version}`]);
  const response = await fetchManifest(flannelManifest, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`获取 Flannel 配置失败（HTTP ${response.status}）`);
  const images = new Map();
  for (const image of output.trim().split(/\r?\n/).filter(Boolean)) images.set(image.trim(), { image: image.trim(), source: 'kubeadm', status: 'untested' });
  for (const image of manifestImages(await response.text())) images.set(image, { image, source: 'Flannel YAML', status: 'untested' });
  if (!images.size) throw new Error('配置中没有解析到容器镜像');
  for (const image of images.keys()) if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,511}$/.test(image)) throw new Error('配置中存在无效镜像地址');
  return [...images.values()];
}
