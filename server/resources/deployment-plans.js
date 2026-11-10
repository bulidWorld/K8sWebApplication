import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { load } from 'js-yaml';
import { XmlDocument, XsdValidator } from 'libxml2-wasm';

const MAX_ARCHIVE = 50 * 1024 * 1024;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function unpackTar(buffer) {
  if (buffer.length > MAX_ARCHIVE) fail('tar 文件不能超过 50 MiB', 413);
  const files = new Map(); let offset = 0;
  while (offset + 512 <= buffer.length) {
    const h = buffer.subarray(offset, offset + 512); if (h.every(byte => byte === 0)) break;
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const full = (prefix ? `${prefix}/` : '') + name;
    const sizeText = h.toString('ascii', 124, 136).replace(/\0.*$/, '').trim();
    if (!/^[0-7]*$/.test(sizeText)) fail('tar 文件头无效');
    const size = parseInt(sizeText || '0', 8), type = h[156];
    if (size > MAX_ARCHIVE || offset + 512 + size > buffer.length) fail('tar 文件内容不完整或超限');
    if (type === 0 || type === 48) {
      const normalized = full.replace(/^(?:\.\/)+/, '');
      if (!normalized || normalized.startsWith('/') || normalized.includes('\\') || normalized.split('/').some(part => !part || part === '..' || part === '.')) fail('tar 中包含不安全的文件路径');
      if (files.has(normalized)) fail('tar 中包含重复文件路径');
      files.set(normalized, buffer.subarray(offset + 512, offset + 512 + size));
    } else if (size && type !== 53) fail('tar 仅允许普通文件和目录');
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const planSchema = readFile(new URL('./deployment-plan.xsd', import.meta.url), 'utf8');

async function xmlText(text) {
  if (text.length > 65536 || /<!DOCTYPE|<!ENTITY/i.test(text)) fail('XML 超过 64 KiB 或包含禁止的声明');
  const [schemaText] = await Promise.all([planSchema]);
  let xmlDoc, schemaDoc, validator;
  let isValid = false, validationError;
  try {
    xmlDoc = XmlDocument.fromString(text);
    schemaDoc = XmlDocument.fromString(schemaText);
    validator = XsdValidator.fromDoc(schemaDoc);
    validator.validate(xmlDoc.root);
    isValid = true;
  } catch (error) {
    validationError = error;
  } finally {
    validator?.dispose();
    schemaDoc?.dispose();
  }
  if (!isValid) { xmlDoc?.dispose(); fail(`计划 XML 不符合 deployment-plan.xsd：${validationError?.message || '格式无效'}`); }
  try {
    return xmlDoc.find('/executionPlan/step').map(step => {
      const action = step.find('./patch|./apply|./serverSideApply')[0];
      const file = action.find('./file')[0].content.trim();
      if (!file || file.includes('..') || file.startsWith('/') || file.includes('\\')) fail('计划文件路径必须是安全的相对路径');
      const actionName = action.name;
      const attrs = actionName === 'patch'
        ? { node: action.attr('node').value, type: action.attr('type').value }
        : {};
      return { name: step.attr('name')?.value || `${actionName} ${file}`, action: actionName, file, ...attrs };
    });
  } finally { xmlDoc.dispose(); }
}

export function createDeploymentPlans({ kubernetes, file = path.resolve('var/deployment-plans.json') }) {
  let tasks = [];
  const archiveDir = `${file}.archives`;
  const archivePath = id => path.join(archiveDir, `${id}.tar`);
  const save = async () => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(tasks), { mode: 0o600 }); };
  const init = async () => { try { tasks = JSON.parse(await readFile(file, 'utf8')); for (const task of tasks) if (['queued', 'running'].includes(task.status)) { task.status = 'interrupted'; task.finishedAt = new Date().toISOString(); task.failedAt = task.finishedAt; task.error = '服务重启导致任务中断'; task.logs.push({ time: task.finishedAt, message: '服务重启，任务中断；检查集群资源后可重试' }); } await save(); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
  const get = id => tasks.find(t => t.id === id) || fail('任务不存在', 404);
  async function run(task, files) {
    const log = message => task.logs.push({ time: new Date().toISOString(), message });
    try {
      for (let i = 0; i < task.steps.length; i++) {
        const step = task.steps[i]; task.currentStep = i; task.status = 'running'; task.startedAt ||= new Date().toISOString();
        log(`开始：${step.name}`); await save();
        const content = files.get(step.file); if (!content) throw new Error(`找不到 YAML 文件：${step.file}`);
        const yaml = content.toString('utf8');
        if (step.action === 'apply' || step.action === 'serverSideApply') {
          const result = await kubernetes.apply({ manifest: yaml, serverSide: step.action === 'serverSideApply' });
          if (!result.success) throw new Error(result.diagnostics || 'YAML 应用失败');
          if (result.output) result.output.trim().split('\n').forEach(line => log(line));
        } else {
          load(yaml);
          const patchType = { merge: 'application/merge-patch+json', strategic: 'application/strategic-merge-patch+json', json: 'application/json-patch+json' }[step.type];
          const payload = step.type === 'json' ? JSON.parse(yaml) : load(yaml);
          await kubernetes.request(`/api/v1/nodes/${encodeURIComponent(step.node)}?fieldValidation=Strict`, true, payload, { method: 'PATCH', contentType: patchType, preserveStatus: true });
          log(`已更新 Node/${step.node}`);
        }
        task.completedSteps = i + 1; log(`完成：${step.name}`); await save();
      }
      task.status = 'succeeded'; task.finishedAt = new Date().toISOString(); task.failedAt = null; task.error = ''; log('计划执行完成');
    } catch (e) { task.status = 'failed'; task.error = e.message; task.finishedAt = new Date().toISOString(); task.failedAt = task.finishedAt; log(`失败：${e.message}`); }
    await save();
    if (task.status === 'succeeded') await unlink(archivePath(task.id)).catch(() => {});
  }
  return async (method, id, body) => {
    if (!tasks.length) await init();
    if (method === 'GET' && !id) return { tasks: tasks.slice().reverse() };
    if (method === 'GET' && id) return get(id);
    if (method === 'POST') {
      if (tasks.some(task => ['queued', 'running'].includes(task.status))) fail('已有部署计划正在执行，请等待完成', 409);
      if (typeof body?.archive !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(body.archive)) fail('请上传 tar 文件');
      const files = unpackTar(Buffer.from(body.archive, 'base64'));
      const xmls = [...files].filter(([name]) => name.toLowerCase().endsWith('.xml'));
      if (xmls.length !== 1) fail('tar 中必须且只能包含一个 XML 计划文件');
      const steps = await xmlText(xmls[0][1].toString('utf8'));
      for (const step of steps) if (!files.has(step.file)) fail(`计划引用的文件不存在：${step.file}`);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 120) fail('请输入部署名称（最多 120 个字符）');
      const task = { id: randomUUID(), name, planFile: xmls[0][0], status: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, failedAt: null, error: '', steps, completedSteps: 0, currentStep: -1, logs: [] };
      await mkdir(archiveDir, { recursive: true });
      await writeFile(archivePath(task.id), Buffer.from(body.archive, 'base64'), { mode: 0o600 });
      tasks.push(task); if (tasks.length > 500) { const removed = tasks.shift(); await unlink(archivePath(removed.id)).catch(() => {}); } await save();
      setImmediate(() => run(task, files));
      return { id: task.id, status: task.status };
    }
    if (method === 'RETRY' && id) {
      const previous = get(id);
      if (!['failed', 'interrupted'].includes(previous.status)) fail('只有失败或中断的部署可以重试', 409);
      if (tasks.some(task => ['queued', 'running'].includes(task.status))) fail('已有部署计划正在执行，请等待完成', 409);
      let archive;
      try { archive = await readFile(archivePath(id)); } catch { fail('找不到该部署的归档文件，请重新上传部署包', 409); }
      const files = unpackTar(archive);
      const steps = await xmlText(files.get(previous.planFile)?.toString('utf8') || '');
      for (const step of steps) if (!files.has(step.file)) fail(`计划引用的文件不存在：${step.file}`);
      const task = { id: randomUUID(), name: previous.name, planFile: previous.planFile, status: 'queued', createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, failedAt: null, error: '', steps, completedSteps: 0, currentStep: -1, logs: [], retryOf: previous.id };
      await mkdir(archiveDir, { recursive: true }); await writeFile(archivePath(task.id), archive, { mode: 0o600 });
      tasks.push(task); if (tasks.length > 500) { const removed = tasks.shift(); await unlink(archivePath(removed.id)).catch(() => {}); } await save();
      setImmediate(() => run(task, files));
      return { id: task.id, status: task.status };
    }
    fail('不支持的请求', 405);
  };
}
