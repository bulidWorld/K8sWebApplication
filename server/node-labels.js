const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
const segment = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
function validKey(key) {
  const parts = key.split("/");
  const name = parts.pop();
  if (!name || name.length > 63 || !segment.test(name) || parts.length > 1)
    return false;
  return (
    !parts.length ||
    (parts[0].length > 0 &&
      parts[0].length <= 253 &&
      parts[0]
        .split(".")
        .every(
          (part) =>
            part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part),
        ))
  );
}
export function buildNodeLabelsPatch(current, body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !["uid", "resourceVersion", "changes"].includes(key),
    )
  )
    fail("标签请求包含不支持的字段");
  if (
    typeof body.uid !== "string" ||
    !body.uid ||
    typeof body.resourceVersion !== "string" ||
    !body.resourceVersion
  )
    fail("缺少节点 UID 或版本");
  if (
    body.uid !== current.metadata.uid ||
    body.resourceVersion !== current.metadata.resourceVersion
  )
    fail("节点已发生变化，请重新加载后再编辑。", 409);
  if (
    !body.changes ||
    typeof body.changes !== "object" ||
    Array.isArray(body.changes) ||
    !Object.keys(body.changes).length
  )
    fail("请提供标签变更");
  const labels = current.metadata.labels || {};
  const patch = [
    { op: "test", path: "/metadata/uid", value: body.uid },
    {
      op: "test",
      path: "/metadata/resourceVersion",
      value: body.resourceVersion,
    },
  ];
  if (!current.metadata.labels)
    patch.push({ op: "add", path: "/metadata/labels", value: {} });
  for (const [key, value] of Object.entries(body.changes)) {
    if (!validKey(key)) fail(`标签名称格式不正确：${key}`);
    if (
      value !== null &&
      (typeof value !== "string" ||
        value.length > 63 ||
        (value !== "" && !segment.test(value)))
    )
      fail(`标签值格式不正确：${key}`);
    const path = `/metadata/labels/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    if (value === null) {
      if (Object.hasOwn(labels, key)) patch.push({ op: "remove", path });
    } else if (!Object.hasOwn(labels, key) || labels[key] !== value)
      patch.push({ op: "add", path, value });
  }
  return patch;
}
