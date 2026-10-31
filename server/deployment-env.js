import fs from 'node:fs';
import path from 'node:path';

// A fresh node can serve the deployment UI before Kubernetes is installed.
export function validateDeploymentEnvironment(env = process.env, checkReadable = file => fs.accessSync(file, fs.constants.R_OK)) {
  for (const key of ['PORT', 'K8S_WEB_TOKEN']) {
    if (!env[key]) throw new Error(`.env 缺少 ${key}`);
  }
  if (!Number.isInteger(Number(env.PORT)) || Number(env.PORT) < 1 || Number(env.PORT) > 65535) throw new Error('PORT 必须为 1–65535');
  const missing = [];
  for (const file of (env.KUBECONFIG || '').split(path.delimiter).filter(Boolean)) {
    if (!path.isAbsolute(file)) throw new Error('KUBECONFIG 必须使用绝对路径');
    try { checkReadable(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.push(file);
    }
  }
  return { missing };
}
