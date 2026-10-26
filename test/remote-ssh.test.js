import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { once } from 'node:events';
import ssh2 from 'ssh2';
import { probeHost, remoteSsh } from '../server/remote-ssh.js';
import { sudoInput } from '../server/expansion-executor.js';

test('SSH 协议验证：探测不发送密码，固定指纹认证，密码和脚本经加密通道传输', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const key = ssh2.utils.parseKey(pem);
  const expected = `SHA256:${createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  let authAttempts = 0, received = '', executed = '';
  const server = new ssh2.Server({ hostKeys: [pem] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => {
      authAttempts++;
      if (ctx.method === 'password' && ctx.username === 'ubuntu' && ctx.password === 'ssh-secret') ctx.accept();
      else if (ctx.method === 'publickey' && ctx.key.data.equals(key.getPublicSSH())) ctx.accept();
      else ctx.reject(['password', 'publickey']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (acceptExec, rejectExec, info) => {
        executed = info.command;
        const stream = acceptExec();
        stream.on('data', chunk => received += chunk);
        stream.on('end', () => {
          if (info.command.includes('FAIL_TEST')) { stream.stderr.write('APT_REPOSITORY_ERROR\n'); stream.exit(100); stream.end(); }
          else { stream.exit(0); stream.end('REMOTE_OK\n'); }
        });
      });
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const target = { host: '127.0.0.1', port: server.address().port, user: 'ubuntu', hostFingerprint: expected };
  try {
    assert.equal(await probeHost(target), expected);
    assert.equal(authAttempts, 0);
    const remote = sudoInput('printf READY', 'sudo-secret');
    assert.equal(await remoteSsh(target, remote, 'ssh-secret'), 'REMOTE_OK\n');
    assert.equal(await remoteSsh(target, remote, undefined, undefined, { privateKey: pem }), 'REMOTE_OK\n');
    assert(received.startsWith('sudo-secret\n')); assert(received.includes('printf READY'));
    assert(!executed.includes('sudo-secret')); assert(!executed.includes('ssh-secret'));
    const streamed = [];
    await assert.rejects(remoteSsh(target, { args: ['FAIL_TEST'], input: '' }, 'ssh-secret', undefined, { onOutput: (stream, chunk) => streamed.push([stream, String(chunk)]) }), /退出码 100/);
    assert(streamed.some(([stream, text]) => stream === 'stderr' && text.includes('APT_REPOSITORY_ERROR')));
    await assert.rejects(remoteSsh(target, remote, 'incorrect'), /认证失败/);
    const previous = authAttempts;
    await assert.rejects(remoteSsh({ ...target, hostFingerprint: `SHA256:${'a'.repeat(43)}` }, remote, 'ssh-secret'), /指纹发生变化/);
    assert.equal(authAttempts, previous);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
