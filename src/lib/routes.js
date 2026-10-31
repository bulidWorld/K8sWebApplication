import { sections } from './resources.js';
import { deploymentModuleTitles } from './navigation.js';

const sectionNames = new Set(sections.map(([name]) => name));

export function parseRoute(hash) {
  const [section, module = '', ...extra] = hash.replace(/^#\/?/, '').split('/');
  if (!sectionNames.has(section) || extra.length) return { section: 'overview', deploymentModule: '' };
  return {
    section,
    deploymentModule: section === 'deployments' && Object.hasOwn(deploymentModuleTitles, module) ? module : '',
  };
}

export function routeHash(section, deploymentModule = '') {
  const route = parseRoute(`#/${section}${deploymentModule ? `/${deploymentModule}` : ''}`);
  return `#/${route.section}${route.deploymentModule ? `/${route.deploymentModule}` : ''}`;
}
