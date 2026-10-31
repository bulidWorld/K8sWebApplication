import test from 'node:test';
import assert from 'node:assert/strict';
import { compareHosts, createHostsService, hostsWriteScript, selectedHosts } from '../server/expansion-hosts.js';
import { createHash } from 'node:crypto';

const master = '127.0.0.1 localhost\n10.0.0.1 master api # cluster\n';
const node = '127.0.0.1 localhost\n127.0.1.1 worker\n10.0.0.2 api other # keep alias\n10.0.0.3 local\n';
const target = { id: 'worker', host: '10.0.0.2' };
test('hosts 按解析映射比较，忽略顺序注释大小写与回环差异', () => {
  const result = compareHosts(master, '# header\n10.0.0.1 API master\n127.0.1.1 worker\n');
  assert.equal(result.different, false);
  assert.deepEqual(result.masterOnly, []);
  assert.deepEqual(result.nodeOnly, []);
});
test('hosts 合并替换同名映射并保留节点回环、独有映射及其他别名', () => {
  const result = compareHosts(master, node);
  assert.equal(result.different, true);
  assert.deepEqual(result.masterOnly, ['10.0.0.1\tapi', '10.0.0.1\tmaster']);
  assert.match(result.proposed, /127.0.1.1 worker/);
  assert.match(result.proposed, /10.0.0.2\tother # keep alias/);
  assert.match(result.proposed, /10.0.0.3\tlocal/);
  assert(!result.proposed.includes('10.0.0.2 api'));
  assert.match(result.proposed, /10.0.0.1 master api/);
  assert.deepEqual(compareHosts('10.0.0.1 worker\n', node).conflicts, ['worker']);
  assert.throws(() => compareHosts('bad entry\n', node), /无法识别/);
  assert.throws(() => compareHosts('x'.repeat(65537), node), /64 KiB/);
});
test('hosts 仅显式确认后写入，绑定目标、时效和 master 快照，拒绝重复提交', async () => {
  let currentMaster = master, time = 0;
  const calls = [];
  const ssh = async (...args) => { calls.push(args); return args[1].includes('cat /etc/hosts') ? node : '/etc/hosts.backup'; };
  const service = createHostsService({ ssh, readMaster: async () => currentMaster, now: () => time });
  const result = await service('/hosts/compare', target, {}, 'sudo-secret', 'ssh-secret');
  assert.equal(calls.length, 1);
  assert(!JSON.stringify(result).includes('secret'));
  const body = { comparisonId: result.comparisonId, confirm: true };
  await assert.rejects(service('/hosts/apply', target, { ...body, confirm: false }), /确认/);
  await assert.rejects(service('/hosts/apply', { ...target, host: '10.0.0.9' }, body), { status: 409 });
  currentMaster += '# changed\n';
  await assert.rejects(service('/hosts/apply', target, body), /master hosts 已变化/);
  currentMaster = master;
  const applied = await service('/hosts/apply', target, body, 'sudo-secret', 'ssh-secret');
  assert.equal(applied.backup, '/etc/hosts.backup');
  assert.equal(calls[1][2], 'sudo-secret');
  assert.equal(calls[1][3], 'ssh-secret');
  await assert.rejects(service('/hosts/apply', target, body), { status: 409 });
  const expired = await service('/hosts/compare', target, {});
  time = 300001;
  await assert.rejects(service('/hosts/apply', target, { comparisonId: expired.comparisonId, confirm: true }), { status: 409 });
});
test('hosts 写入脚本校验旧内容、备份、锁定并编码传输内容', () => {
  const proposed = "127.0.0.1 localhost\n# $(touch /tmp/never-execute)\n";
  const script = hostsWriteScript(node, proposed);
  assert(script.includes(createHash('sha256').update(node).digest('hex')));
  assert(script.includes(Buffer.from(proposed).toString('base64')));
  assert(!script.includes('$(touch'));
  assert.match(script, /cp -p \/etc\/hosts/);
  assert.match(script, /flock -x/);
  assert.match(script, /cat "\$backup" > \/etc\/hosts/);
});
test('hosts 禁止自动修改与节点回环主机名冲突的 master 映射', async () => {
  let writes = 0;
  const service = createHostsService({ readMaster: async () => '10.0.0.1 worker\n', ssh: async (t, script) => { if (script.includes('cp -p')) writes++; return node; } });
  const result = await service('/hosts/compare', target, {});
  await assert.rejects(service('/hosts/apply', target, { comparisonId: result.comparisonId, confirm: true }), /回环主机名冲突/);
  assert.equal(writes, 0);
});

test('hosts 写入真实临时文件：保留权限、备份原文，拒绝覆盖对比后变化', async () => {
  const { mkdtemp, writeFile, readFile, rm, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'hosts-write-'));
  const hostsFile = join(dir, 'hosts');
  const proposed = compareHosts(master, node).proposed;
  const script = hostsWriteScript(node, proposed)
    .replaceAll('/etc/hosts', hostsFile)
    .replaceAll('/etc/.kubescope-hosts.', `${dir}/.kubescope-hosts.`)
    .replaceAll('/run/kubescope-hosts.lock', `${dir}/hosts.lock`);
  try {
    await writeFile(hostsFile, `${node}# changed\n`, { mode: 0o640 });
    await assert.rejects(run('bash', ['-c', script]), { code: 73 });
    assert.equal(await readFile(hostsFile, 'utf8'), `${node}# changed\n`);
    await writeFile(hostsFile, node);
    const { stdout } = await run('bash', ['-c', script]);
    assert.equal(await readFile(stdout, 'utf8'), node);
    assert.equal(await readFile(hostsFile, 'utf8'), proposed);
    assert.equal((await stat(hostsFile)).mode & 0o777, 0o640);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('hosts 仅应用所选差异和自定义条目，保留未选映射', () => {
  const snapshot = compareHosts(master, node);
  const proposed = selectedHosts(snapshot, ['10.0.0.1\tmaster'], [{ ip: '2001:db8::1', names: 'custom alias' }]);
  assert.ok(proposed.includes('10.0.0.2 api other # keep alias'));
  assert.ok(proposed.includes('10.0.0.3 local'));
  assert.ok(proposed.includes('10.0.0.1\tmaster'));
  assert.ok(proposed.includes('2001:db8::1\tcustom alias'));
  const replaced = selectedHosts(snapshot, ['10.0.0.1\tapi']);
  assert.ok(replaced.includes('10.0.0.2\tother # keep alias'));
  assert.ok(!replaced.includes('10.0.0.1\tmaster'));
});

test('hosts 校验选择、自定义格式、重复 IP 和回环冲突', () => {
  const snapshot = compareHosts('10.0.0.1 worker\n10.0.0.4 safe\n', node);
  assert.ok(selectedHosts(snapshot, ['10.0.0.4\tsafe']).includes('10.0.0.4\tsafe'));
  assert.throws(() => selectedHosts(snapshot, ['10.0.0.1\tworker']), /回环/);
  assert.throws(() => selectedHosts(snapshot, ['10.0.0.9\tfake']), /不在/);
  assert.throws(() => selectedHosts(snapshot, []), /至少/);
  for (const entry of [{ ip: 'bad', names: 'a' }, { ip: '127.0.0.2', names: 'a' }, { ip: '10.0.0.4', names: 'a\n10.0.0.5 b' }, { ip: '10.0.0.4', names: '$(id)' }]) {
    assert.throws(() => selectedHosts(snapshot, [], [entry]), /自定义/);
  }
  assert.throws(() => selectedHosts(snapshot, ['10.0.0.4\tsafe'], [{ ip: '10.0.0.5', names: 'SAFE' }]), /多个不同 IP/);
});

test('hosts 服务把选择结果而非全部 master 映射写入节点', async () => {
  let written;
  const service = createHostsService({ readMaster: async () => master, ssh: async (target, script) => {
    if (!script.includes('cp -p')) return node;
    written = script;
    return '/etc/hosts.backup';
  } });
  const snapshot = await service('/hosts/compare', target, {});
  const selectedEntries = ['10.0.0.1\tmaster'];
  const customEntries = [{ ip: '10.0.0.8', names: 'custom' }];
  await service('/hosts/apply', target, { comparisonId: snapshot.comparisonId, confirm: true, selectedEntries, customEntries });
  assert.ok(written.includes(Buffer.from(selectedHosts(snapshot, selectedEntries, customEntries)).toString('base64')));
});
