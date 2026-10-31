import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';

// Prefer the default-route interface; never suggest a container bridge or loopback.
export async function detectLocalAddress({ interfaces = networkInterfaces, routes = () => readFile('/proc/net/route', 'utf8') } = {}) {
  let adapters;
  try { adapters = interfaces(); } catch { return ''; }
  const candidates = Object.entries(adapters).flatMap(([name, addresses]) =>
    /^(lo$|docker\d*|veth|br-|cni|flannel|virbr|kube-ipvs)/.test(name) ? [] :
      (addresses || []).filter(item => item.family === 'IPv4' && !item.internal && !/^(127\.|169\.254\.|0\.)/.test(item.address)).map(item => ({ name, address: item.address })),
  );
  let defaults = [];
  try {
    defaults = (await routes()).trim().split('\n').slice(1).map(line => line.trim().split(/\s+/))
      .filter(fields => fields[1] === '00000000' && fields[7] === '00000000' && (parseInt(fields[3], 16) & 1))
      .sort((a, b) => Number(a[6]) - Number(b[6]));
  } catch { /* Other platforms can still use a non-loopback adapter. */ }
  for (const route of defaults) {
    const match = candidates.find(item => item.name === route[0]);
    if (match) return match.address;
  }
  return candidates[0]?.address || '';
}
