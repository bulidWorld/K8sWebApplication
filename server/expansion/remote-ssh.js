import ssh2 from 'ssh2';
import { createHash } from 'node:crypto';
const fingerprint = key => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

// Probe the host key before sending any login credential. The user must confirm it.
export function probeHost(target, Client = ssh2.Client) {
  return new Promise((resolve, reject) => {
    const conn = new Client(); let found = false;
    const timer = setTimeout(() => { conn.destroy(); reject(new Error('读取 SSH 主机指纹超时')); }, 15000);
    conn.on('error', () => { if (!found) { clearTimeout(timer); reject(new Error('无法读取 SSH 主机指纹，请检查地址、端口和网络')); } });
    conn.on('close', () => { if (!found) { clearTimeout(timer); reject(new Error('SSH 连接关闭，未取得主机指纹')); } });
    conn.connect({ host: target.host, port: target.port, username: target.user, readyTimeout: 10000, authHandler: ['none'], hostVerifier: key => {
      found = true; clearTimeout(timer); resolve(fingerprint(key)); queueMicrotask(() => conn.destroy()); return false;
    } });
  });
}

export function remoteSsh(target, remote, password, Client = ssh2.Client, { onOutput, timeout = 20 * 60 * 1000, privateKey } = {}) {
  return new Promise((resolve, reject) => {
    const conn = new Client(); let settled = false, mismatch = false, output = '';
    const finish = (error) => { if (settled) return; settled = true; clearTimeout(timer); conn.end(); error ? reject(error) : resolve(output); };
    const timer = setTimeout(() => { finish(new Error('SSH 操作超时，需检查目标机器状态')); conn.destroy(); }, timeout);
    conn.on('error', () => finish(new Error(mismatch ? 'SSH 主机指纹发生变化，请重新核对目标机器' : 'SSH 连接或认证失败，请检查登录密码、用户和网络')));
    conn.on('close', () => { if (!settled) finish(new Error('SSH 连接意外关闭，请检查目标状态')); });
    conn.on('ready', () => conn.exec(remote.args.join(' '), (error, stream) => {
      if (error) return finish(new Error('无法启动远程扩容脚本'));
      stream.on('error', () => finish(new Error('远程 SSH 通道异常')));
      stream.on('data', chunk => { onOutput?.('stdout', chunk); output += chunk; if (onOutput) output = output.slice(-65536); if (output.length > 1024 * 1024) { finish(new Error('远程输出超过限制')); conn.destroy(); } });
      stream.stderr.on('data', chunk => onOutput?.('stderr', chunk));
      stream.on('close', code => finish(code === 0 ? null : new Error(code === 77 ? 'sudo 验证失败，请检查 sudo 密码及授权' : `远程脚本失败（退出码 ${code ?? '未知'}），请查看下方执行日志`)));
      stream.end(remote.input);
    }));
    conn.connect({ host: target.host, port: target.port, username: target.user, ...(privateKey ? { privateKey } : { password }), readyTimeout: 15000, keepaliveInterval: 15000, keepaliveCountMax: 3, hostVerifier: key => {
      mismatch = fingerprint(key) !== target.hostFingerprint; return !mismatch;
    } });
  });
}
