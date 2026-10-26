export const nodeReady = (n) =>
  n.status?.conditions?.find((c) => c.type === "Ready")?.status === "True";
export const containers = (p) => [
  ...(p.status?.initContainerStatuses || []),
  ...(p.status?.containerStatuses || []),
];
export const podStatus = (p) => {
  if (p.metadata.deletionTimestamp) return "Terminating";
  const states = containers(p);
  const waiting = states.find((c) => c.state?.waiting?.reason);
  if (waiting) return waiting.state.waiting.reason;
  const terminated = states.find((c) => c.state?.terminated?.exitCode > 0);
  if (terminated) return terminated.state.terminated.reason || "Error";
  if (
    p.status?.phase === "Running" &&
    !(
      p.status?.containerStatuses?.length &&
      p.status.containerStatuses.every((c) => c.ready)
    )
  )
    return "NotReady";
  return p.status?.phase || "Unknown";
};
export const readyPods = (items) =>
  items.filter((p) => podStatus(p) === "Running").length;
export const age = (date) => {
  if (!date) return "—";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(date).getTime()) / 1000),
  );
  return seconds < 60
    ? `${seconds} 秒`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分钟`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)} 小时`
        : `${Math.floor(seconds / 86400)} 天`;
};
export const cpu = (value) =>
  value?.endsWith("m") ? parseFloat(value) / 1000 : Number(value || 0);
export const memory = (value) => {
  const match = String(value || "0").match(/^([\d.]+)([a-zA-Z]*)$/);
  if (!match) return 0;
  return (
    (Number(match[1]) *
      ({
        Ki: 1024,
        Mi: 1024 ** 2,
        Gi: 1024 ** 3,
        Ti: 1024 ** 4,
        K: 1e3,
        M: 1e6,
        G: 1e9,
        T: 1e12,
      }[match[2]] || 1)) /
    1024 ** 3
  );
};
