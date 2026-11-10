export function registryRemoteScript(config) {
  const encoded = Buffer.from(JSON.stringify(config)).toString('base64');
  return `set -eu
python3 - <<'PY'
import base64, json, os, pathlib, re, shutil, subprocess, sys
config = json.loads(base64.b64decode('${encoded}'))
changes = {}
containerd_changed = False
root = pathlib.Path(config.get('root', '/'))
def at(name): return root / name.lstrip('/')
lock = at('/run/kubescope-registry.lock')
def log(message):
    print('LOG:' + message, flush=True)
def safe(file):
    file = pathlib.Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    if file.parent.resolve() != file.parent or file.is_symlink() or (file.exists() and not file.is_file()):
        raise RuntimeError('配置路径不能包含符号链接或特殊文件：' + str(file))
    return file
def write(file, data):
    file = safe(file)
    data = data.encode() if isinstance(data, str) else data
    old = file.read_bytes() if file.exists() else None
    if old == data: return False
    changes[str(file)] = old
    if old is not None: shutil.copy2(file, str(file) + '.kubescope-' + config['backupId'] + '.bak')
    file.write_bytes(data)
    os.chmod(file, 0o644)
    return True
def run(*args):
    subprocess.run(args, check=True, timeout=45)
def update_hosts():
    names = {name.lower() for name in config['hostsDomains']}
    if not names: return False
    file = safe(at('/etc/hosts'))
    source = file.read_text()
    if len(source.encode()) > 65536 or '\\0' in source: raise RuntimeError('hosts 内容无效或超过 64 KiB')
    found = {name: [] for name in names}
    for line in source.splitlines():
        fields = line.split('#', 1)[0].split()
        for alias in fields[1:]:
            if alias.lower() in found: found[alias.lower()].append(fields[0])
    change = {name for name, ips in found.items() if ips != [config['hostsIp']]}
    if not change: log('/etc/hosts 映射已正确，无需修改'); return False
    output = []
    for line in source.splitlines():
        content, sep, comment = line.partition('#')
        fields = content.split()
        if len(fields) < 2 or not any(alias.lower() in change for alias in fields[1:]): output.append(line); continue
        kept = [alias for alias in fields[1:] if alias.lower() not in change]
        output.append((fields[0] + '\\t' + ' '.join(kept) + (' #' + comment if sep else '')) if kept else ('#' + comment if sep else ''))
    result = '\\n'.join(output).rstrip() + '\\n' + config['hostsIp'] + '\\t' + ' '.join(sorted(change)) + ' # kubescope registry\\n'
    write(file, result)
    log('/etc/hosts 映射已更新：' + ', '.join(sorted(change)))
    return True
def transform_toml(source):
    version = re.search(r'^\\s*version\\s*=\\s*(\\d+)', source, re.M)
    version = int(version.group(1)) if version else 1
    if version not in (2, 3): raise RuntimeError('containerd config.toml 仅支持 version 2 或 3')
    plugin = 'io.containerd.cri.v1.images' if version == 3 else 'io.containerd.grpc.v1.cri'
    section = '[plugins."' + plugin + '".registry]'
    lines = source.split('\\n'); output = []; active = False; found = False; inserted = False
    for line in lines:
        if line.lstrip().startswith('['):
            if active and not inserted: output.append('  config_path = "/etc/containerd/certs.d"'); inserted = True
            active = line.strip().replace("'", '"').split('#')[0].strip() == section
            if active: found = True; inserted = False
        if active and re.match(r'^\\s*config_path\\s*=', line):
            output.append('  config_path = "/etc/containerd/certs.d"'); inserted = True
        else: output.append(line)
    if active and not inserted: output.append('  config_path = "/etc/containerd/certs.d"')
    if not found: output.append('\\n' + section + '\\n  config_path = "/etc/containerd/certs.d"')
    return '\\n'.join(output)
def install_trust():
    blocks = re.findall(r'-----BEGIN CERTIFICATE-----[\\s\\S]*?-----END CERTIFICATE-----', config['ca'])
    directory = at('/usr/local/share/ca-certificates')
    prefix = 'kubescope-registry-' + config['registryId'] + '-'
    changed = False
    for index, block in enumerate(blocks, 1): changed = write(directory / (prefix + str(index) + '.crt'), block + '\\n') or changed
    if directory.exists():
        for file in directory.iterdir():
            suffix = file.name.removeprefix(prefix)
            if file.name.startswith(prefix) and re.fullmatch(r'\\d+\\.crt', suffix) and int(suffix[:-4]) > len(blocks):
                safe(file); changes[str(file)] = file.read_bytes(); shutil.copy2(file, str(file) + '.kubescope-' + config['backupId'] + '.bak'); file.unlink(); changed = True
    if changed:
        log('刷新系统 CA 信任')
        if str(root) == '/': run('update-ca-certificates')
    else: log('系统 CA 信任无需更新')
    return changed
try:
    lock.mkdir(mode=0o700)
    log('已获取宿主机配置锁')
    hosts_changed = update_hosts() if config.get('mapHosts') else False
    if config.get('hostsOnly'):
        result = {'hostsUpdated': hosts_changed, 'restarted': False, 'backupId': config['backupId']}
    else:
        trust_changed = install_trust()
        if config.get('trustOnly'):
            result = {'hostsUpdated': hosts_changed, 'trustUpdated': trust_changed, 'restarted': False, 'backupId': config['backupId']}
        else:
            config_file = safe(at('/etc/containerd/config.toml'))
            source = config_file.read_text()
            for domain in config['domains']:
                log('配置镜像源 ' + domain)
                directory = at('/etc/containerd/certs.d') / domain
                ca_file = str(directory / 'kubescope-ca.crt')
                server = 'https://registry-1.docker.io' if domain == 'docker.io' else 'https://' + domain
                hosts = 'server = ' + json.dumps(server) + '\\n'
                for endpoint in config['urls']:
                    hosts += '[host.' + json.dumps(endpoint) + ']\\n  capabilities = ["pull", "resolve"]\\n  ca = ' + json.dumps(ca_file) + '\\n'
                write(directory / 'kubescope-ca.crt', config['ca'])
                write(directory / 'hosts.toml', hosts)
            after = transform_toml(source)
            restarted = False
            if after != source:
                log('更新 containerd config_path 并重启服务')
                write(config_file, after); containerd_changed = True
                if str(root) == '/': run('containerd', '--config', '/etc/containerd/config.toml', 'config', 'dump'); run('systemctl', 'restart', 'containerd')
                restarted = True
            else: log('containerd 无需重启')
            result = {'hostsUpdated': hosts_changed, 'trustUpdated': trust_changed, 'restarted': restarted, 'backupId': config['backupId']}
    print('RESULT:' + json.dumps(result), flush=True)
except Exception as error:
    log('配置失败：' + str(error) + '；正在回滚')
    for file, old in reversed(list(changes.items())):
        try:
            if old is None: pathlib.Path(file).unlink(missing_ok=True)
            else: pathlib.Path(file).write_bytes(old)
        except Exception as rollback_error: log('回滚失败：' + str(rollback_error))
    if containerd_changed and str(root) == '/':
        try: run('systemctl', 'restart', 'containerd')
        except Exception as rollback_error: log('containerd 回滚重启失败：' + str(rollback_error))
    try:
        if config.get('ca') and str(root) == '/': run('update-ca-certificates')
    except Exception as rollback_error: log('系统 CA 回滚刷新失败：' + str(rollback_error))
    sys.exit(1)
finally:
    try: lock.rmdir()
    except OSError: pass
PY`;
}
