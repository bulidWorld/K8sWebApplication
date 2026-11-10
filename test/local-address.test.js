import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLocalAddress } from '../server/cluster/local-address.js';

const ipv4 = address => ({ family: 'IPv4', internal: false, address });
const header = 'Iface Destination Gateway Flags RefCnt Use Metric Mask';

test('自动地址优先选择默认路由网卡，并按 metric 排序', async () => {
  const address = await detectLocalAddress({
    interfaces: () => ({ eth0: [ipv4('192.168.1.10')], eth1: [ipv4('10.0.0.10')] }),
    routes: async () => `${header}\neth0 00000000 0101A8C0 0003 0 0 100 00000000\neth1 00000000 0100000A 0003 0 0 10 00000000`,
  });
  assert.equal(address, '10.0.0.10');
});

test('无路由信息时排除回环、容器网卡、IPv6 和链路本地地址', async () => {
  assert.equal(await detectLocalAddress({
    interfaces: () => ({ lo: [{ ...ipv4('127.0.0.1'), internal: true }], docker0: [ipv4('172.17.0.1')], 'br-abcd': [ipv4('172.18.0.1')], eth0: [{ family: 'IPv6', address: '::1' }, ipv4('169.254.1.1'), ipv4('192.168.1.10')] }),
    routes: async () => { throw new Error('unavailable'); },
  }), '192.168.1.10');
});

test('无可用网卡或检测异常时返回空值，允许手动填写', async () => {
  assert.equal(await detectLocalAddress({ interfaces: () => ({ docker0: [ipv4('172.17.0.1')] }), routes: async () => '' }), '');
  assert.equal(await detectLocalAddress({ interfaces: () => { throw new Error('unavailable'); } }), '');
});
