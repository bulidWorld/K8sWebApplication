import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNodeImport, parseNodeImportXml, NODE_XML_MAX_BYTES } from '../src/lib/node-import.js';
import { selectedHosts } from '../server/expansion-hosts.js';
const target = { host: '192.168.1.21', user: 'ubuntu', nodeName: 'worker-02' };

test('XML import defaults and optional credentials preserve password whitespace', () => {
  const result = validateNodeImport({ target });
  assert.equal(result.target.port, 22);
  assert.equal(result.credentials.samePassword, true);
  assert.deepEqual(result.hosts, []);
  assert.equal(result.registry, null);
  const explicit = validateNodeImport({ target, credentials: { sshPassword: ' a&<b ', sudoPassword: '' }, registry: { ip: '192.168.1.30', protocol: 'http' } });
  assert.equal(explicit.credentials.sshPassword, ' a&<b ');
  assert.equal(explicit.credentials.samePassword, false);
  assert.equal(explicit.registry.port, 80);
});

test('XML import rejects invalid target, ports, secrets and registry', () => {
  for (const patch of [{ host: '999.1.1.1' }, { host: '01.2.3.4' }, { user: 'root;id' }, { nodeName: 'UPPER' }, { port: '0' }, { port: '65536' }, { port: '1.5' }]) {
    assert.throws(() => validateNodeImport({ target: { ...target, ...patch } }), /XML 导入失败/);
  }
  assert.throws(() => validateNodeImport({ target, credentials: { sshPassword: 'a\nb' } }));
  assert.throws(() => validateNodeImport({ target, registry: { ip: '192.168.1.2', protocol: 'ftp' } }));
  assert.throws(() => parseNodeImportXml('x'.repeat(NODE_XML_MAX_BYTES + 1)), /64 KiB/);
  assert.throws(() => parseNodeImportXml('<!DOCTYPE a><a/>'), /DOCTYPE/);
});

test('imported hosts only applies requested mappings while preserving unrelated aliases', () => {
  const imported = validateNodeImport({ target, hosts: [{ ip: '192.168.1.30', names: 'registry.internal registry' }, { ip: '2001:db8::30', names: 'service.internal' }] });
  const snapshot = { node: '127.0.0.1 localhost\n192.168.1.2 registry.internal old-alias\n192.168.1.3 keep-me\n', masterOnly: ['192.168.1.9\tmaster-only'] };
  const result = selectedHosts(snapshot, [], imported.hosts);
  assert.match(result, /192.168.1.30\tregistry.internal registry/);
  assert.match(result, /192.168.1.2\told-alias/);
  assert.match(result, /192.168.1.3 keep-me/);
  assert(!result.includes('master-only'));
});

test('XML import rejects invalid, loopback and conflicting hosts mappings', () => {
  for (const ip of ['127.0.0.2', '::1', '0:0:0:0:0:0:0:1', '999.1.1.1', 'invalid', '2001:::1']) {
    assert.throws(() => validateNodeImport({ target, hosts: [{ ip, names: 'test' }] }), /hosts/);
  }
  assert.throws(() => validateNodeImport({ target, hosts: [{ ip: '192.168.1.2', names: 'test;id' }] }));
  assert.throws(() => validateNodeImport({ target, hosts: [{ ip: '192.168.1.2', names: 'test' }, { ip: '192.168.1.3', names: 'TEST' }] }), /不同 IP/);
});
