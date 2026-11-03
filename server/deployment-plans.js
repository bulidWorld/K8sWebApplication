import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { load } from 'js-yaml';

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
      if (!full || full.startsWith('/') || full.split('/').some(part => part === '..' || part === '.')) fail('tar 中包含不安全的文件路径');
      if (files.has(full)) fail('tar 中包含重复文件路径');
      files.set(full, buffer.subarray(offset + 512, offset + 512 + size));
    } else if (size && type !== 53) fail('tar 仅允许普通文件和目录');
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function xmlText(text) {
  if (text.length > 65536 || /<!DOCTYPE|<!ENTITY/i.test(text)) fail('XML 超过 64 KiB 或包含禁止的声明');
  const clean = text.replace(/^\uFEFF?\s*<\?xml[^?]*\?>\s*/i, '').trim();
  if (/<[^>]+\sxmlns(?::\w+)?\s*=/.test(clean) || /<!--|<!\[CDATA\[/.test(clean)) fail('计划 XML 不支持命名空间、注释或 CDATA');
  const tokens = clean.match(/<[^>]+>|[^<]+/g) || []; const stack = [];
  for (const t of tokens) {
    if (t.startsWith('</')) { if (stack.pop() !== t.slice(2, -1).trim()) fail('XML 标签不匹配'); }
    else if (t.startsWith('<?') || t.startsWith('<!')) fail('XML 声明无效');
    else if (t.startsWith('<')) { const tag = t.match(/^<([A-Za-z][\w]*)\b/); if (!tag) fail('XML 标签无效'); if (!t.endsWith('/>')) stack.push(tag[1]); }
  }
  if (stack.length || !/^<executionPlan>/.test(clean) || !clean.endsWith('</executionPlan>')) fail('XML 根节点必须是 executionPlan');
  const steps = []; const re = /<step(?:\s+name="([^"]*)")?\s*>([\s\S]*?)<\/step>/g; let m;
  while ((m = re.exec(clean))) {
    const body = m[2].trim(); const action = body.match(/^<(patch|apply|serverSideApply)([^>]*)>\s*<file>([^<]+)<\/file>\s*<\/\1>$/);
    if (!action) fail('step 必须包含 patch、apply 或 serverSideApply 和一个 file');
    const file = action[3].trim(); if (!file || file.includes('..') || file.startsWith('/') || file.includes('\\')) fail('计划文件路径必须是安全的相对路径');
    const attrs = Object.fromEntries([...action[2].matchAll(/(node|type)="([^"]*)"/g)].map(x => [x[1], x[2]]));
    if (action[1] === 'patch' && (!attrs.node || !['merge','strategic','json'].includes(attrs.type))) fail('patch 必须指定有效 node 和 type');
    steps.push({ name: m[1] || `${action[1]} ${file}`, action: action[1], file, ...attrs });
  }
  if (!steps.length || (clean.match(/<step\b/g) || []).length !== steps.length) fail('计划至少需要一个格式正确的 step');
  return steps;
}

export function createDeploymentPlans({ kubernetes, file = path.resolve('var/deployment-plans.json') }) {
  let tasks = [];
  const save = async () => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(tasks), { mode: 0o600 }); };
  const init = async () => { try { tasks = JSON.parse(await readFile(file, 'utf8')); for (const task of tasks) if (['queued', 'running'].includes(task.status)) { task.status = 'interrupted'; task.finishedAt = new Date().toISOString(); task.logs.push({ time: task.finishedAt, message: '服务重启，任务中断；请检查集群资源后重新导入执行' }); } await save(); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
  const get = id => tasks.find(t => t.id === id) || fail('任务不存在', 404);
  async function run(task, files) {
    const log = message => task.logs.push({ time: new Date().toISOString(), message });
    try {
      for (let i = 0; i < task.steps.length; i++) {
        const step = task.steps[i]; task.currentStep = i; task.status = 'running';
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
      task.status = 'succeeded'; task.finishedAt = new Date().toISOString(); log('计划执行完成');
    } catch (e) { task.status = 'failed'; task.error = e.message; task.finishedAt = new Date().toISOString(); log(`失败：${e.message}`); }
    await save();
  }
  return async (method, id, body) => {
    if (!tasks.length) await init();
    if (method === 'GET' && !id) return { tasks: tasks.slice().reverse().map(({ files, ...t }) => t) };
    if (method === 'GET' && id) { const { files, ...task } = get(id); return task; }
    if (method === 'POST') {
      if (tasks.some(task => ['queued', 'running'].includes(task.status))) fail('已有部署计划正在执行，请等待完成', 409);
      if (typeof body?.archive !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(body.archive)) fail('请上传 tar 文件');
      const files = unpackTar(Buffer.from(body.archive, 'base64'));
      const xmls = [...files].filter(([name]) => name.toLowerCase().endsWith('.xml'));
      if (xmls.length !== 1) fail('tar 中必须且只能包含一个 XML 计划文件');
      const steps = xmlText(xmls[0][1].toString('utf8'));
      for (const step of steps) if (!files.has(step.file)) fail(`计划引用的文件不存在：${step.file}`);
      const task = { id: randomUUID(), name: xmls[0][0], status: 'queued', createdAt: new Date().toISOString(), steps, completedSteps: 0, currentStep: -1, logs: [] };
      tasks.push(task); if (tasks.length > 500) tasks.shift(); await save();
      setImmediate(() => run(task, files));
      return { id: task.id, status: task.status };
    }
    fail('不支持的请求', 405);
  };
}
