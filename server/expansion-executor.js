// Task engine embedded in the root web process. Configuration and keys are root-owned.
import {
  readFile,
  writeFile,
  mkdir,
  rename,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { isIP } from "node:net";
import path from "node:path";
import { createLogCollector, redactLog } from "./expansion-logs.js";
import { remoteSsh } from "./remote-ssh.js";

const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
export function targetRevision(target) { return createHash("sha256").update(JSON.stringify(target)).digest("hex"); }
export function publicTarget(target) {
  return { id: target.id, host: target.host, nodeName: target.nodeName, user: target.user, auth: target.auth || "key", port: target.port, hostFingerprint: target.hostFingerprint, revision: targetRevision(target) };
}
export function validateConfig(c) {
  if (!/^1\.(3[1-5])\.\d+$/.test(c.kubernetesVersion || ""))
    fail("仅支持 Kubernetes 1.31–1.35，必须指定完整补丁版本");
  for (const key of [
    "kubeconfig",
    "knownHosts",
        "stateDirectory",
  ])
    if (!path.isAbsolute(c[key] || "")) fail(`${key} 必须为绝对路径`);
  if (!/^https:\/\/[a-zA-Z0-9.:-]+$/.test(c.apiServer || ""))
    fail("apiServer 必须是 HTTPS 地址且不含路径");
  if (c.containerdPackageVersion !== "auto" && !/^[12]\.[\w.+:~\-]+$/.test(c.containerdPackageVersion || ""))
    fail("containerd 包版本必须为 auto 或完整的 1.x / 2.x 软件包版本");
  if (!Array.isArray(c.targets)) fail("目标机器列表无效");
  const ids = new Set(),
    hosts = new Set(),
    names = new Set();
  for (const t of c.targets) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(t.id || "") || ids.has(t.id))
      fail("目标 ID 无效或重复");
    ids.add(t.id);
    if (isIP(t.host) !== 4 || hosts.has(t.host))
      fail("第一期只支持唯一的 IPv4 地址");
    hosts.add(t.host);
    if (
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(t.nodeName || "") ||
      names.has(t.nodeName)
    )
      fail("节点名称无效或重复");
    names.add(t.nodeName);
    if (
      !/^[a-z_][a-z0-9_-]*$/.test(t.user || "") ||
      (t.auth !== "password" && !path.isAbsolute(t.identityFile || ""))
    )
      fail("SSH 用户或密钥路径无效");
    if (t.auth === "password" && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(t.hostFingerprint || "")) fail("目标 SSH 主机指纹无效");
    if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535)
      fail("SSH 端口无效");
  }
  return c;
}
// Password and script travel only over SSH stdin, never command arguments.
export function sudoInput(script, password) {
  if (!password) return { args: ["sudo", "-n", "bash", "-s"], input: `${script}\n` };
  const wrapper = `set -eu
umask 077
IFS= read -r password
SCRIPT_FILE=$(mktemp /tmp/kubescope-script.XXXXXX)
trap 'rm -f "$SCRIPT_FILE"' EXIT
cat > "$SCRIPT_FILE"
# sudo reads only the password; the root script reads its own file with stdin closed.
# One sudo invocation avoids timestamp cache / parent-process differences.
printf '%s\\n' "$password" | sudo -S -k -p '' -- bash -c 'exec bash "$1" </dev/null' _ "$SCRIPT_FILE"
`;
  // SSH passes the remote command through a shell; quote the fixed wrapper once.
  return { args: ["bash", "-c", "'" + wrapper.replaceAll("'", "'\\''") + "'"], input: `${password}\n${script}\n` };
}
function validatePassword(value) {
  if (value !== undefined && (typeof value !== "string" || Buffer.byteLength(value) > 1024 || /[\r\n\0]/.test(value)))
    fail("sudo 密码不能包含换行或空字符，且不能超过 1024 字节");
  return value || "";
}
export function command(file, args, input = "", timeout = 120000, { onOutput } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LC_ALL: "C" },
    });
    let output = "",
      tooLarge = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (chunk) => {
      onOutput?.("stdout", chunk);
      output += chunk;
      if (onOutput && file === "/usr/bin/ssh") output = output.slice(-65536);
      if (output.length > 1024 * 1024) {
        tooLarge = true;
        child.kill("SIGKILL");
      }
    });
    // Output is only persisted by the task collector after redaction.
    child.stderr.on("data", chunk => onOutput?.("stderr", chunk));
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error(`${path.basename(file)} 无法启动`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (file === "/usr/bin/ssh" && code === 77) {
        reject(new Error("sudo 验证失败：请检查密码、sudo 授权及是否要求终端"));
      } else if (code !== 0 || tooLarge)
        reject(
          new Error(
            `${path.basename(file)} 执行失败（退出码 ${code ?? "未知/超时"}），请查看执行日志`,
          ),
        );
      else resolve(output);
    });
    child.stdin.end(input);
  });
}
export async function createExecutor(config, run = command, connect = remoteSsh) {
  const c = validateConfig(config);
  const runtimePolicy = await readFile(new URL("./provision/runtime-policy.sh", import.meta.url), "utf8");
  await mkdir(c.stateDirectory, { recursive: true, mode: 0o700 });
  const stateFile = path.join(c.stateDirectory, "tasks.json");
  let tasks;
  try {
    tasks = JSON.parse(await readFile(stateFile, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    tasks = [];
  }
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(tasks);
    writes = writes.then(async () => {
      await writeFile(`${stateFile}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${stateFile}.tmp`, stateFile);
    });
    return writes;
  };
  for (const t of tasks)
    if (["checking", "running", "checked"].includes(t.status)) {
      t.status = "interrupted";
      t.logs.push("执行器重启，任务中断；核对主机状态后重新预检");
    }
  await persist();
  let busy = false;
  let currentLog;
  const localRun = (file, args, input, timeout) => run(file, args, input, timeout, { onOutput: (stream, chunk) => { if (stream === "stderr") currentLog?.feed("master/stderr", chunk); } });
  const kubectl = (args) =>
    localRun("/usr/bin/kubectl", [
      "--kubeconfig",
      c.kubeconfig,
      "--request-timeout=15s",
      ...args,
    ]);
  const ssh = (t, script, password, sshPassword, timeout = 20 * 60 * 1000) => {
    const remote = t.user === "root" ? { args: ["bash", "-s"], input: `${script}\n` } : sudoInput(script, password);
    const onOutput = (stream, chunk) => currentLog?.feed(`node/${stream}`, chunk);
    if (t.auth === "password" || t.hostFingerprint) return (t.auth === "password" ? Promise.resolve(undefined) : readFile(t.identityFile)).then(privateKey => connect(t, remote, sshPassword, undefined, { onOutput, timeout, privateKey })).finally(() => currentLog?.flush());
    return run(
      "/usr/bin/ssh",
      [
        "-F",
        "/dev/null",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${c.knownHosts}`,
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-i",
        t.identityFile,
        "-p",
        String(t.port),
        `${t.user}@${t.host}`,
        ...remote.args,
      ],
      remote.input,
      timeout,
      { onOutput },
    ).finally(() => currentLog?.flush());
  };
  async function step(task, label, action) {
    task.stage = label;
    task.logs.push(`${new Date().toISOString()} ${label}`);
    await persist();
    return action();
  }
  async function check(task, target, password, sshPassword) {
    const masterVersion = JSON.parse(
      await localRun("/usr/bin/kubeadm", ["version", "-o", "json"]),
    ).clientVersion.gitVersion;
    if (masterVersion !== `v${c.kubernetesVersion}`)
      fail("master kubeadm 版本与配置不一致");
    await kubectl([
      "get",
      "configmap",
      "kubeadm-config",
      "-n",
      "kube-system",
      "-o",
      "json",
    ]);
    const version = JSON.parse(await kubectl(["version", "-o", "json"]))
      .serverVersion.gitVersion.replace(/^v/, "")
      .split("+")[0];
    if (version !== c.kubernetesVersion)
      fail("配置的 Kubernetes 版本与 API Server 不一致");
    const nodes = JSON.parse(
      await kubectl(["get", "nodes", "-o", "json"]),
    ).items;
    if (
      nodes.some(
        (n) =>
          n.metadata.name === target.nodeName ||
          n.status?.addresses?.some((a) => a.address === target.host),
      )
    )
      fail("节点名或 IP 已存在；请核对现有节点，禁止重复初始化");
    const script = runtimePolicy + "\n" + await readFile(
      new URL("./provision/precheck.sh", import.meta.url),
      "utf8",
    );
    await ssh(
      target,
      `export TARGET_IP='${target.host}'\nexport API_SERVER='${c.apiServer}'\n${script}`,
      password,
      sshPassword,
    );
  }
  async function execute(task, joining, password, sshPassword) {
    const target = c.targets.find((t) => t.id === task.targetId);
    let tokenId, installationStarted = false, logTimer;
    const addLog = (source, line) => {
      task.logs.push(`${new Date().toISOString()} [${source}] ${line}`);
      while (task.logs.length > 400 || Buffer.byteLength(task.logs.join('\n')) > 64 * 1024) { task.logs.shift(); task.logsTruncated = true; }
      if (!logTimer) logTimer = setTimeout(() => { logTimer = undefined; persist().catch(() => {}); }, 250);
    };
    currentLog = createLogCollector([password, sshPassword], addLog);
    try {
      await step(task, "检查集群版本、SSH、系统与网络", () =>
        check(task, target, password, sshPassword),
      );
      if (!joining) {
        task.status = "checked";
        task.checkedAt = Date.now();
        task.stage = "预检通过，可开始扩容";
        return;
      }
      await step(
        task,
        "初始化系统并安装锁定版本的 containerd、kubelet、kubeadm",
        async () => {
          const script = runtimePolicy + "\n" + await readFile(
            new URL("./provision/install.sh", import.meta.url),
            "utf8",
          );
          installationStarted = true;
          await ssh(
            target,
            `export K8S_VERSION='${c.kubernetesVersion}'\nexport CONTAINERD_VERSION='${c.containerdPackageVersion}'\n${script}`,
            password,
            sshPassword,
          );
        },
      );
      await step(task, "生成临时凭据并加入集群", async () => {
        const localVersion = JSON.parse(
          await localRun("/usr/bin/kubeadm", ["version", "-o", "json"]),
        ).clientVersion.gitVersion;
        if (localVersion !== `v${c.kubernetesVersion}`)
          fail("master kubeadm 版本与配置不一致");
        const join = (
          await localRun("/usr/bin/kubeadm", [
            "token",
            "create",
            "--kubeconfig",
            c.kubeconfig,
            "--ttl",
            "30m",
            "--print-join-command",
          ])
        ).trim();
        const match = join.match(
          /^kubeadm join (\S+) --token ([a-z0-9]{6}\.[a-z0-9]{16}) --discovery-token-ca-cert-hash (sha256:[a-f0-9]{64})$/,
        );
        if (!match) fail("无法解析入群参数");
        tokenId = match[2].split(".")[0];
        if (`https://${match[1]}` !== c.apiServer)
          fail("入群端点与预检端点不一致");
        const joinConfig = {
          apiVersion: "kubeadm.k8s.io/v1beta4",
          kind: "JoinConfiguration",
          discovery: {
            bootstrapToken: {
              apiServerEndpoint: match[1],
              token: match[2],
              caCertHashes: [match[3]],
            },
          },
          nodeRegistration: {
            name: target.nodeName,
            criSocket: "unix:///run/containerd/containerd.sock",
            kubeletExtraArgs: [{ name: "node-ip", value: target.host }],
          },
        };
        await ssh(
          target,
          `set -euo pipefail\numask 077\nJOIN_FILE=$(mktemp /run/kubescope-join.XXXXXX)\ntrap 'rm -f "$JOIN_FILE"' EXIT\ncat > "$JOIN_FILE" <<'KUBESCOPE_JOIN_CONFIG'\n${JSON.stringify(joinConfig)}\nKUBESCOPE_JOIN_CONFIG\nkubeadm join --config "$JOIN_FILE"\n`,
          password,
          sshPassword,
        );
      });
      await step(task, "等待节点 Ready 并验证系统 Pod", async () => {
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
          const nodeList = JSON.parse(
            await kubectl(["get", "nodes", "-o", "json"]),
          );
          const n = nodeList.items.find(
            (item) => item.metadata.name === target.nodeName,
          );
          if (!n) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            continue;
          }
          const pods = JSON.parse(
            await kubectl([
              "get",
              "pods",
              "-n",
              "kube-system",
              "--field-selector",
              `spec.nodeName=${target.nodeName}`,
              "-o",
              "json",
            ]),
          ).items;
          if (
            n.status?.conditions?.some(
              (x) => x.type === "Ready" && x.status === "True",
            ) &&
            n.status?.addresses?.some(
              (a) => a.type === "InternalIP" && a.address === target.host,
            ) &&
            pods.length &&
            pods.every(
              (p) =>
                p.status?.conditions?.some(
                  (x) => x.type === "Ready" && x.status === "True",
                ) || p.status?.phase === "Succeeded",
            )
          ) {
            task.capacity = n.status.allocatable;
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        fail(
          "节点或系统 Pod 未在 10 分钟内就绪；请检查 CNI、镜像仓库和 kubelet",
        );
      });
      task.status = "succeeded";
      task.stage = "节点已就绪；业务 DNS、跨节点网络及存储需按集群实际配置验收";
    } catch (e) {
      currentLog.flush();
      task.failedStage = task.stage;
      task.error = redactLog(e.message, [password, sshPassword]);
      addLog("error", task.error);
      if (installationStarted && !/sudo|认证|指纹/.test(task.error)) {
        task.stage = "扩容失败，正在收集节点诊断日志";
        addLog("diagnostic", "收集 kubelet、containerd 和 apt 的近期日志（只读，最长 30 秒）");
        try {
          const diagnostic = await readFile(new URL("./provision/diagnostics.sh", import.meta.url), "utf8");
          await ssh(target, diagnostic, password, sshPassword, 30000);
        } catch (diagnosticError) { addLog("diagnostic", redactLog(diagnosticError.message, [password, sshPassword])); }
      }
      task.stage = `扩容失败：${task.failedStage}`;
      task.status = "failed";
    } finally {
      password = "";
      sshPassword = "";
      if (tokenId) {
        try {
          await localRun("/usr/bin/kubeadm", [
            "token",
            "delete",
            tokenId,
            "--kubeconfig",
            c.kubeconfig,
          ]);
        } catch {
          task.logs.push("临时凭据撤销失败，将在 30 分钟后过期");
        }
      }
      currentLog.flush();
      currentLog = undefined;
      while (task.logs.length > 400 || Buffer.byteLength(task.logs.join("\n")) > 64 * 1024) { task.logs.shift(); task.logsTruncated = true; }
      clearTimeout(logTimer);
      task.updatedAt = new Date().toISOString();
      await persist();
      busy = false;
    }
  }
  // All request mutations are serialized; the worker itself runs asynchronously.
  let queue = Promise.resolve();
  const handle = async (method, pathname, body = {}) => {
    if (method === "GET" && pathname === "/targets")
      return {
        enabled: true,
        busy,
        version: c.kubernetesVersion,
        targets: c.targets.map(publicTarget),
        tasks: tasks.slice(-50).reverse(),
      };
    const match = pathname.match(/^\/tasks\/([a-f0-9-]{36})(\/start)?$/);
    if (method === "GET" && match && !match[2])
      return tasks.find((t) => t.id === match[1]) || fail("任务不存在", 404);
    if (method !== "POST") fail("接口不存在", 404);
    let password = validatePassword(body.sudoPassword);
    let sshPassword = validatePassword(body.sshPassword);
    delete body.sshPassword;
    if (body.start !== undefined && typeof body.start !== "boolean") fail("start 必须是布尔值");
    delete body.sudoPassword;
    if (busy) fail("已有扩容任务执行中，请等待完成", 409);
    if (pathname === "/tasks") {
      const target = c.targets.find((t) => t.id === body.targetId);
      if (!target) fail("目标机器不在允许列表");
      if (target.auth === "password" && !sshPassword) fail("请输入新节点 SSH 登录密码");
      if (Object.keys(body).some((k) => !["targetId", "source", "start"].includes(k)))
        fail("不支持的请求字段");
      if (tasks.length >= 1000) fail("任务历史已达上限，请管理员归档", 409);
      const task = {
        id: randomUUID(),
        targetId: target.id,
        target: publicTarget(target),
        status: body.start ? "running" : "checking",
        stage: "等待预检",
        logs: [],
        source: body.source,
        createdAt: new Date().toISOString(),
      };
      const joining = body.start === true;
      if (joining) { task.startedAt = task.createdAt; task.startSource = body.source; }
      tasks.push(task);
      busy = true;
      try {
        await persist();
      } catch (e) {
        busy = false;
        tasks.pop();
        throw e;
      }
      setImmediate(() =>
        execute(task, joining, password, sshPassword).catch((e) => {
          console.error("Task persistence failure:", e.message);
          process.exit(1);
        }),
      );
      return task;
    }
    if (match?.[2]) {
      const task = tasks.find((t) => t.id === match[1]);
      if (!task) fail("任务不存在", 404);
      if (
        task.status !== "checked" ||
        Date.now() - task.checkedAt > 10 * 60 * 1000
      )
        fail("预检过期或未通过，请重新预检", 409);
      task.status = "running";
      task.startedAt = new Date().toISOString();
      task.startSource = body.source;
      busy = true;
      await persist();
      setImmediate(() =>
        execute(task, true, password, sshPassword).catch((e) => {
          console.error("Task persistence failure:", e.message);
          process.exit(1);
        }),
      );
      return task;
    }
    fail("接口不存在", 404);
  };
  return (method, pathname, body) => {
    const result = queue.then(() => handle(method, pathname, body));
    queue = result.catch(() => {});
    return result;
  };
}
