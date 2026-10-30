/**
 * 站点级扩展的发布默认启停。
 *
 * 契约把两套默认值分开：browser-local 扩展用 artifact metadata 的 `defaultEnabled`；站点级扩展
 * 只能用 `extension.json` 的 `site.defaultEnabled`（`frontend-browser.ts` 明确拒绝站点级声明前者）。
 * 所以发版要强制站点级启停，唯一合法落点是**打包进 release 的 extension.json**。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** 覆盖项里的 id 必须都真的装进了本次 release，否则报错（避免拼错后静默不生效）。 */
export function validateSiteDefaultIds({ overrides, availableIds }) {
  const available = new Set(availableIds);
  const missing = Object.keys(overrides ?? {}).filter(id => !available.has(id));
  if (missing.length > 0) {
    const list = [...available].sort().join("、") || "无";
    throw new Error("profile 指定了未装进本次 release 的站点级扩展：" + missing.join("、") + "（可用：" + list + "）");
  }
}

/** 改写打包内 extension.json 的 site.defaultEnabled；返回生效记录。 */
export function applySiteDefaultEnabled({ extensionDir, enabled }) {
  const file = path.join(extensionDir, "extension.json");
  const descriptor = JSON.parse(readFileSync(file, "utf8"));
  if (!descriptor || typeof descriptor.site !== "object" || descriptor.site === null) {
    throw new Error("扩展未声明 site，不能作为站点级启用/停用：" + extensionDir);
  }
  descriptor.site = { ...descriptor.site, defaultEnabled: enabled };
  writeFileSync(file, JSON.stringify(descriptor, null, 2) + "\n");
  return { extensionId: typeof descriptor.extensionId === "string" ? descriptor.extensionId : path.basename(extensionDir), defaultEnabled: enabled };
}
