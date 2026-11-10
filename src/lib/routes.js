import { sections, kinds, scoped } from './resources.js';
import { deploymentModuleTitles } from './navigation.js';

const sectionNames = new Set(sections.map(([name]) => name));

export function parseRoute(hash) {
  const [pathname, query = ''] = hash.split('?');
  const [section, module = '', ...extra] = pathname.replace(/^#\/?/, '').split('/');
  if (!sectionNames.has(section) || extra.length) return { section: 'overview', deploymentModule: '' };
  const modal = parseModal(new URLSearchParams(query), section);
  return {
    ...(modal ? { modal } : {}),
    section,
    deploymentModule: section === 'deployments' && Object.hasOwn(deploymentModuleTitles, module) ? module : '',
  };
}

export function routeHash(section, deploymentModule = '', modal) {
  const route = parseRoute(`#/${section}${deploymentModule ? `/${deploymentModule}` : ''}`);
  const query = new URLSearchParams(modal || {});
  const valid = parseModal(query, route.section);
  return `#/${route.section}${route.deploymentModule ? `/${route.deploymentModule}` : ''}${valid ? `?${new URLSearchParams(valid)}` : ''}`;
}

function parseModal(params, section) {
  const dialog = params.get('dialog');
  if (['add-node', 'node-history'].includes(dialog)) return section === 'nodes' ? { dialog } : null;
  if (dialog === 'registry-progress') return { dialog };
  if (dialog !== 'resource') return null;
  const kind = params.get('kind'), name = params.get('name'), namespace = params.get('namespace');
  const validName = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value);
  if (!kinds.includes(kind) || !validName(name) || (scoped.has(kind) && !validName(namespace))) return null;
  const requestedTab = params.get('tab') || 'detail';
  const tabs = ['detail', ...(kind !== 'events' && kind !== 'customresourcedefinitions' ? ['edit'] : []), ...(kind === 'customresourcedefinitions' ? ['custom-resources'] : []), ...(kind === 'persistentvolumes' ? ['definition'] : []), ...(kind === 'nodes' ? ['labels', 'hosts'] : []), ...(kind === 'pods' ? ['logs'] : []), ...(kind === 'configmaps' ? ['config'] : []), ...(kind === 'deployments' ? ['config', ...Object.keys(deploymentModuleTitles).map(module => `config:${module}`)] : [])];
  return { dialog, kind, name, ...(scoped.has(kind) ? { namespace } : {}), tab: tabs.includes(requestedTab) ? requestedTab : 'detail' };
}
