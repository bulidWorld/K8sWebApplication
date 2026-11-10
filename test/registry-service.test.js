import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { configureRegistryToml, registryHosts, configureRegistry, requestRegistryBundle } from '../server/registry/registry-service.js';

for (const version of [2, 3]) test(`containerd v${version} 补齐缺失的 registry 表和 config_path，保留其他配置`, () => {
  const plugin = version === 2 ? 'io.containerd.grpc.v1.cri' : 'io.containerd.cri.v1.images';
  for (const suffix of ['', `\n[plugins.'${plugin}'.registry]\n`, `\n[plugins."${plugin}".registry]\n  config_path = "old"\n[metrics]\naddress = "127.0.0.1"`]) {
    const source = `version = ${version}\nroot = "/var/lib/containerd"${suffix}`;
    const result = configureRegistryToml(source);
    assert.match(result, /root = "\/var\/lib\/containerd"/);
    assert.equal(result.match(/config_path\s*=/g).length, 1);
    assert.ok(result.includes('config_path = "/etc/containerd/certs.d"'));
    assert.equal(configureRegistryToml(result), result);
  }
  assert.throws(() => configureRegistryToml('version = 1'), /不受支持/);
});

test('hosts 替换镜像域名时保留别名与注释', () => {
  const result = registryHosts('127.0.0.1 localhost\n10.0.0.1 registry.k8s.io other.local # keep\n', '10.0.0.20');
  assert.match(result, /10.0.0.1 other.local # keep/);
  assert.equal(result.match(/registry.k8s.io/g).length, 1);
});

test('JavaScript 方法验证证书、备份并配置真实临时文件，失败时输出路径和堆栈', async () => {
  const root = await mkdtemp(`${tmpdir()}/registry-js-`);
  const logs = [], commands = [];
  try {
    await mkdir(`${root}/run`);
    await mkdir(`${root}/etc/containerd`, { recursive: true });
    await writeFile(`${root}/etc/hosts`, '127.0.0.1 localhost\n');
    await writeFile(`${root}/etc/containerd/config.toml`, 'version = 2\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Registry', '-addext', 'subjectAltName=DNS:docker.io,DNS:registry-1.docker.io,DNS:ghcr.io,DNS:registry.k8s.io', '-keyout', `${root}/key`, '-out', `${root}/cert`], { stdio: 'ignore', timeout: 10000 });
    const bundle = { certificate: await readFile(`${root}/cert`, 'utf8'), privateKey: await readFile(`${root}/key`, 'utf8') };
    const registry = { ip: '10.0.0.20', protocol: 'http', port: 10001, token: 'test-secret' };
    let invalid = false;
    const options = { root, log: line => logs.push(line), requestBundle: async () => bundle, run: async (file, args) => {
      commands.push([file, args]);
      if (file === 'containerd') {
        assert.match(await readFile(args[1], 'utf8'), /config_path/);
        if (invalid) throw new Error('invalid TOML');
      }
    } };
    await configureRegistry(registry, options);
    assert.equal(commands[0][0], 'containerd');
    assert.deepEqual(commands[1], ['systemctl', ['restart', 'containerd']]);
    assert.equal((await stat(`${root}/etc/kubescope/registry/private-key.pem`)).mode & 0o777, 0o600);
    const hosts = await readFile(`${root}/etc/hosts`, 'utf8');
    assert.match(hosts, /10.0.0.20/);
    assert.ok(logs.some(line => line.includes('备份：')));
    await assert.rejects(access(`${root}/run/kubescope-registry.lock`));
    invalid = true;
    await assert.rejects(configureRegistry({ ...registry, ip: '10.0.0.30' }, options), /补齐.*invalid TOML/);
    assert.equal(await readFile(`${root}/etc/hosts`, 'utf8'), hosts);
    invalid = false;
    const key = bundle.privateKey;
    bundle.privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    await assert.rejects(configureRegistry(registry, options), /公私钥.*不匹配/);
    bundle.privateKey = key;
    await rm(`${root}/etc/containerd/config.toml`);
    await assert.rejects(configureRegistry(registry, { ...options, requestBundle: async () => assert.fail('缺少运行时配置时不应请求证书') }), /检查 hosts.*先完成第一步“安装 containerd”/);
    assert.equal(await readFile(`${root}/etc/hosts`, 'utf8'), hosts);
    assert.ok(logs.some(line => line.includes('registry-service.js:')));
    assert.ok(!logs.join('\n').includes(registry.token));
    assert.ok(!logs.join('\n').includes(bundle.privateKey));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('原生 HTTP 直连证书接口，传递 Token，响应错误不泄漏正文', async () => {
  let status = 200;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/tls/bundle');
    assert.equal(req.headers.authorization, 'Bearer test-secret');
    res.writeHead(status);
    res.end(status === 200 ? JSON.stringify({ certificate: 'fixture', privateKey: 'fixture-key' }) : 'test-secret private body');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const registry = { ip: '127.0.0.1', protocol: 'http', port: server.address().port, token: 'test-secret' };
    assert.deepEqual(await requestRegistryBundle(registry), { certificate: 'fixture', privateKey: 'fixture-key' });
    status = 401;
    await assert.rejects(requestRegistryBundle(registry), error => /HTTP 401/.test(error.message) && !error.message.includes('test-secret'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
