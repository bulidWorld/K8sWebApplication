import { resourcePath } from '../core/kubernetes.js';

export const deletePod = (req, kubernetes, namespace, name) => deleteResource(req, kubernetes, 'pods', 'Pod', namespace, name);
export const deleteService = (req, kubernetes, namespace, name) => deleteResource(req, kubernetes, 'services', 'Service', namespace, name);
export const deletePersistentVolumeClaim = (req, kubernetes, namespace, name) => deleteResource(req, kubernetes, 'persistentvolumeclaims', 'PVC', namespace, name);

async function deleteResource(req, kubernetes, kind, label, namespace, name) {
  const target = resourcePath(kind, namespace, name);
  if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json')
    throw Object.assign(new Error('请使用 application/json'), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw Object.assign(new Error('删除请求不能超过 4 KiB'), { status: 413 });
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求不是有效 JSON'), { status: 400 }); }
  if (!body || typeof body.uid !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(body.uid) || Object.keys(body).some(key => key !== 'uid'))
    throw Object.assign(new Error(`删除请求必须且只能包含 ${label} UID`), { status: 400 });
  return kubernetes.request(target, true, {
    apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: body.uid },
  }, { method: 'DELETE', contentType: 'application/json', preserveStatus: true });
}
