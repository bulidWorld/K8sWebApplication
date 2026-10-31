import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('远程部署首次连接使用 accept-new，严格模式可选，ssh/scp 使用同一主机校验策略', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remote-deploy-test-'));
  const script = path.resolve('remote_deploye.sh');
  try {
    const bin = path.join(directory, 'bin');
    const releases = path.join(directory, 'releases');
    const top = 'kubescope-1.0.0';
    await mkdir(bin);
    await mkdir(releases);
    await mkdir(path.join(directory, top));
    await writeFile(path.join(directory, top, 'deploy.sh'), '#!/bin/bash\n');
    const archived = spawnSync('tar', ['-czf', path.join(releases, 'kubescope-1.0.0-20261026T000000Z.tar.gz'), '-C', directory, top]);
    assert.equal(archived.status, 0);
    for (const tool of ['ssh', 'scp']) await writeFile(path.join(bin, tool), `#!/bin/bash\nprintf '%s\\n' "$@" > "$DEPLOY_TEST_LOG/${tool}.args"\nexit ${tool === 'scp' ? 42 : 0}\n`, { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEPLOY_TEST_LOG: directory, DEPLOY_PASSWORD: 'test-password', SUDO_PASSWORD: '', SSH_HOST_KEY_POLICY: 'accept-new' };
    for (const [extra, expected] of [[[], 'accept-new'], [['--host-key-policy', 'strict'], 'yes']]) {
      const result = spawnSync('bash', [script, '--releases-dir', releases, ...extra], { env, encoding: 'utf8' });
      assert.equal(result.status, 42, result.stderr);
      for (const tool of ['ssh', 'scp']) {
        const args = await readFile(path.join(directory, `${tool}.args`), 'utf8');
        assert.match(args, new RegExp(`StrictHostKeyChecking=${expected}\\n`));
        assert.equal((args.match(/StrictHostKeyChecking=/g) || []).length, 1);
        assert.ok(!args.includes('test-password'));
      }
    }
    const invalid = spawnSync('bash', [script, '--host-key-policy', 'no'], { env, encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /accept-new or strict/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
