/**
 * 发布装配期的扩展启停覆盖。
 *
 * 只改「首次安装的默认值」（release catalog 的 metadata.defaultEnabled）；运行期仍由站点控制面
 * 的 desiredEnabled 优先。抽成纯函数是为了在不构建真实 artifact 的情况下验证语义。
 */
export function applyExtensionDefaults(entries, defaults, { allowMissing = false, onSkip = null } = {}) {
  const byId = new Map(entries.map((entry) => [entry.metadata.extensionId, entry]));
  const applied = [];
  for (const [extensionId, enabled] of Object.entries(defaults ?? {})) {
    const entry = byId.get(extensionId);
    if (entry && entry.metadata.configScope === "site") {
      throw new Error(
        "站点级扩展不能在 catalog metadata 里声明启停：" + extensionId +
        "（契约禁止混用两套默认值；站点级请用 profile 的 extensions.siteDefaultEnabled，由发布装配改写 extension.json）"
      );
    }
    if (!entry) {
      const available = [...byId.keys()].sort().join("、") || "无";
      if (allowMissing) {
        if (onSkip) onSkip(extensionId, available);
        continue;
      }
      throw new Error("profile 指定了未发布的扩展启停：" + extensionId + "（可用：" + available + "）");
    }
    entry.metadata = { ...entry.metadata, defaultEnabled: enabled };
    applied.push({ extensionId, defaultEnabled: enabled });
  }
  return applied;
}
