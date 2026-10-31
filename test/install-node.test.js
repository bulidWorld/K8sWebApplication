import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
const deploy = new URL('../deploy.sh', import.meta.url);
const installer = new URL('../install_node.sh', import.meta.url).pathname;

// Mock root identity only; the tested branches never change system files.
function bash(script, args = [], env = {}) {
  return spawnSync('/bin/bash', ['-c', 'id() { echo 0; }; export -f id; ' + script, '_', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
}
test('Node 安装脚本复用已有可执行文件，路径只输出到 stdout；无效显式路径失败', () => {
  const existing = bash('bash "$1"', [installer], { NODE_BIN: '/bin/true' });
  assert.equal(existing.status, 0, existing.stderr);
  assert.equal(existing.stdout, '/bin/true\n');
  assert.match(existing.stderr, /使用已有安装/);
  const invalid = bash('bash "$1"', [installer], { NODE_BIN: '/missing-node' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /可执行文件的绝对路径/);
});
test('deploy 缺少 Node 时调用同目录安装脚本；已有 Node 或显式错误路径不触发安装', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'deploy-node-'));
  try {
    await copyFile(deploy, path.join(directory, 'deploy.sh'));
    await writeFile(path.join(directory, 'install_node.sh'), '#!/bin/bash\nprintf installed > "$TEST_MARKER"\nprintf "/bin/true\\n"\n');
    const marker = path.join(directory, 'called');
    const missing = bash('command() { if [[ "$*" == "-v node" ]]; then return 1; fi; builtin command "$@"; }; export -f command; bash "$1"', [path.join(directory, 'deploy.sh')], { NODE_BIN: '', TEST_MARKER: marker });
    assert.match(missing.stderr, /开始自动安装/);
    assert.equal(await readFile(marker, 'utf8'), 'installed');
    assert.match(missing.stderr, /完整部署包/); // Reached package validation after installation.
    await rm(marker);
    for (const node of ['/bin/true', '/missing-node']) {
      const result = bash('bash "$1"', [path.join(directory, 'deploy.sh')], { NODE_BIN: node, TEST_MARKER: marker });
      assert.notEqual(result.status, 0);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
