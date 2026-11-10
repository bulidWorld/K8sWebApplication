import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateRegistry, registryEnvironment } from '../server/registry/registry-config.js';

test('证书接口端口默认 443，支持自定义端口并拒绝无效输入', () => {
  const registry = { ip: '10.0.0.20', token: 'test-secret' };
  assert.equal(validateRegistry(registry).port, 443);
  assert.equal(validateRegistry(registry).protocol, 'https');
  assert.equal(validateRegistry({ ...registry, protocol: 'http' }).port, 80);
  assert.equal(validateRegistry({ ...registry, protocol: 'http', port: 8080 }).port, 8080);
  assert.match(registryEnvironment(validateRegistry({ ...registry, protocol: 'http' })), /REGISTRY_PROTOCOL='http'/);
  for (const protocol of ['', null, 'ftp', 'https;id']) {
    assert.throws(() => validateRegistry({ ...registry, protocol }), /协议/);
  }
  const custom = validateRegistry({ ...registry, port: 8443 });
  assert.match(registryEnvironment(custom), /REGISTRY_PORT='8443'/);
  for (const port of [0, 65536, -1, 1.5, '', '443', null, '443;id']) {
    assert.throws(() => validateRegistry({ ...registry, port }), /端口/);
  }
});

test('仓库脚本验证真实证书后更新临时 hosts 和 containerd，保留别名并限制私钥权限', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'registry-script-'));
  try {
    await mkdir(`${root}/bin`);
    await mkdir(`${root}/etc/containerd`, { recursive: true });
    await writeFile(`${root}/etc/hosts`, '127.0.0.1 localhost\n10.0.0.1 registry.k8s.io other.local # keep\n');
    await writeFile(`${root}/etc/containerd/config.toml`, '[plugins.registry]\n config_path = ""\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Registry', '-addext', 'subjectAltName=DNS:docker.io,DNS:registry-1.docker.io,DNS:ghcr.io,DNS:registry.k8s.io', '-keyout', `${root}/key`, '-out', `${root}/cert`], { stdio: 'ignore', timeout: 10000 });
    await writeFile(`${root}/bundle.json`, JSON.stringify({ certificate: await readFile(`${root}/cert`, 'utf8'), privateKey: await readFile(`${root}/key`, 'utf8') }));
    await writeFile(`${root}/bin/curl`, '#!/bin/bash\nprintf \'%s\\n\' \"$@\" > \"$FIXTURE/curl-args\"\nwhile [[ $# -gt 0 ]]; do if [[ $1 == -o ]]; then cp "$FIXTURE/bundle.json" "$2"; exit; fi; shift; done\nexit 1\n', { mode: 0o700 });
    for (const name of ['containerd', 'systemctl']) await writeFile(`${root}/bin/${name}`, '#!/bin/bash\nexit 0\n', { mode: 0o700 });
    const script = (await readFile(new URL('../server/provision/registry.sh', import.meta.url), 'utf8')).replaceAll('/etc/', `${root}/etc/`);
    execFileSync('bash', ['-s'], { timeout: 10000, input: script, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE: root, REGISTRY_PROTOCOL: 'http', REGISTRY_PORT: '8443', REGISTRY_IP: '10.0.0.20', REGISTRY_TLS_EXPORT_TOKEN: 'test-secret' } });
    assert.match(await readFile(`${root}/curl-args`, 'utf8'), /http:\/\/10\.0\.0\.20:8443\/api\/tls\/bundle/);
    let hosts = await readFile(`${root}/etc/hosts`, 'utf8');
    assert.match(hosts, /10.0.0.1 other.local # keep/);
    assert.match(hosts, /10.0.0.20 docker.io ghcr.io registry-1.docker.io registry.k8s.io/);
    assert.equal(hosts.match(/registry.k8s.io/g).length, 1);
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(`${root}/etc/kubescope/registry/private-key.pem`)).mode & 0o777, 0o600);
    assert.ok((await readdir(`${root}/etc`)).some(name => name.startsWith('hosts.kubescope-registry-')));
    assert.match(await readFile(`${root}/etc/containerd/certs.d/docker.io/hosts.toml`, 'utf8'), /capabilities = \["pull", "resolve"\]/);
    assert.match(await readFile(`${root}/etc/containerd/config.toml`, 'utf8'), /certs.d/);
    // Preparation works before containerd is installed and does not change hosts.
    await rm(`${root}/etc/containerd/config.toml`);
    const cache = `${root}/prepared`;
    const environment = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE: root, REGISTRY_IP: '10.0.0.20', REGISTRY_TLS_EXPORT_TOKEN: 'test-secret', REGISTRY_CACHE: cache };
    const prepared = execFileSync('bash', ['-s'], { timeout: 10000, input: script, env: { ...environment, REGISTRY_MODE: 'prepare' } }).toString();
    assert.match(prepared, /registry-progress:100/);
    assert.equal(await readFile(`${root}/etc/hosts`, 'utf8'), hosts);
    assert.equal((await stat(`${cache}/private-key.pem`)).mode & 0o777, 0o600);
    await writeFile(`${root}/etc/containerd/config.toml`, '[plugins.registry]\n config_path = ""\n');
    await writeFile(`${root}/bin/curl`, '#!/bin/bash\nexit 99\n', { mode: 0o700 });
    execFileSync('bash', ['-s'], { timeout: 10000, input: script, env: { ...environment, REGISTRY_MODE: 'apply', REGISTRY_TLS_EXPORT_TOKEN: '' } });
    assert.match(await readFile(`${root}/etc/containerd/config.toml`, 'utf8'), /certs.d/);
    await writeFile(`${root}/bin/curl`, '#!/bin/bash\nwhile [[ $# -gt 0 ]]; do if [[ $1 == -o ]]; then cp "$FIXTURE/bundle.json" "$2"; exit; fi; shift; done\nexit 1\n', { mode: 0o700 });
    hosts = await readFile(`${root}/etc/hosts`, 'utf8');
    // Mismatched pairs must fail before changing the configured hosts.
    const bundle = JSON.parse(await readFile(`${root}/bundle.json`, 'utf8'));
    bundle.privateKey = 'invalid PRIVATE KEY';
    await writeFile(`${root}/bundle.json`, JSON.stringify(bundle));
    assert.throws(() => execFileSync('bash', ['-s'], { timeout: 10000, input: script, stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE: root, REGISTRY_IP: '10.0.0.30', REGISTRY_TLS_EXPORT_TOKEN: 'test-secret' } }));
    assert.equal(await readFile(`${root}/etc/hosts`, 'utf8'), hosts);
    // An unavailable certificate endpoint must stop before any host changes.
    await writeFile(`${root}/bin/curl`, '#!/bin/bash\necho "curl: (22) HTTP 503" >&2\nexit 22\n', { mode: 0o700 });
    assert.throws(() => execFileSync('bash', ['-s'], {
      timeout: 10000, input: script, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE: root, REGISTRY_IP: '10.0.0.30', REGISTRY_TLS_EXPORT_TOKEN: 'test-secret' },
    }), error => {
      assert.match(error.stderr.toString(), /HTTP 503/);
      assert.match(error.stderr.toString(), /尚未修改 hosts/);
      assert.ok(!error.stderr.toString().includes('test-secret'));
      return true;
    });
    assert.equal(await readFile(`${root}/etc/hosts`, 'utf8'), hosts);

  } finally { await rm(root, { recursive: true, force: true }); }
});
