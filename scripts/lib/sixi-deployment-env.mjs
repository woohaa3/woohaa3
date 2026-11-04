/**
 * 四喜发行形态的宿主部署环境。
 *
 * 为什么单独一个新文件：这几项收口要同时作用于 `desktop-host.mjs`（桌面壳）和 `dev.mjs`
 * （浏览器开发宿主）两条启动路径。把逻辑写进任何一条上游共用脚本，都会在合并上游时产生冲突，
 * 也会让两条路径各写一份而漂移。这里只放纯函数，两边各调一行。
 *
 * 收口的三件事（都是「用户只能经 ppserver 消耗积分、不能外接自己的 API」）：
 * 1. 扩展白名单：清单在**本目录**的 `sixi-extension-inventory.json`，不引用上游文件。
 *    发行版靠它决定拷贝哪些目录；开发形态不拷贝目录，所以靠 `WOOHAA3_EXTENSION_ALLOWLIST` 对齐。
 *    曾经读过 `desktop/host-extensions.json`，上游 51ed5d16 把它删了改成「目录即权威」，
 *    读不到文件时这里静默退化成「不过滤」，六个第三方 provider 全部回到了设置页 ——
 *    清单必须跟着消费它的代码走。
 * 2. sdk-agent 的自定义 Base URL 白名单：该策略在「未设置 / 空 / *」时放行所有中转站，
 *    收紧不能靠留空，只能写一个永远匹配不到的占位（`.invalid` 是保留域名，不会解析到真实服务）。
 * 3. `application.ts` 里硬编码的四个官方模型 host（服务连接来源路径）。
 *
 * 运维要放开时，在启动宿主前显式设同名环境变量即可，显式值优先：
 * `WOOHAA3_EXTENSION_ALLOWLIST=*`、`WOOHAA3_SDK_AGENT_ALLOWED_HOSTS=host1,*.host2`、
 * `WOOHAA3_SDK_AGENT_BUILTIN_HOSTS=1`。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SDK_HOSTS_PLACEHOLDER = "sdk-agent-disabled.invalid";

/** 本文件同目录下的清单；不依赖仓库根，发行包里 `scripts/lib/` 会整体拷贝过去。 */
export const INVENTORY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "sixi-extension-inventory.json");

/**
 * 读四喜发行版扩展清单。
 *
 * 读不到或为空时返回**空数组**而不是 null：这里的语义是「发行版只装这几个」，
 * 退化成「不过滤」就等于把上游的全部扩展放回设置页（踩过，见文件头注释）。
 * 调用方拿到空数组会显式失败，而不是悄悄放开。
 */
export function readInventoryIds() {
  try {
    const ids = JSON.parse(fs.readFileSync(INVENTORY_FILE, "utf8")).extensions;
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id !== "") : [];
  } catch {
    return [];
  }
}

/**
 * 返回要注入宿主进程的部署环境（只含需要覆盖的键）。
 *
 * 白名单不再取决于有没有仓库根：清单就在本文件旁边，开发形态与发行包走同一条路径。
 * 清单为空是**部署错误**，这里抛出而不是返回空环境 —— 悄悄不过滤的后果见文件头注释。
 *
 * @param inherited 启动方显式给的环境（`process.env` 或 `loadServiceEnv` 的结果）；非空值原样保留。
 */
export function sixiDeploymentEnv({ inherited = {} } = {}) {
  const explicit = (name) => {
    const value = inherited?.[name];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  const out = {};
  const explicitAllowlist = explicit("WOOHAA3_EXTENSION_ALLOWLIST");
  if (explicitAllowlist) {
    out.WOOHAA3_EXTENSION_ALLOWLIST = explicitAllowlist;
  } else {
    const ids = readInventoryIds();
    if (ids.length === 0) {
      throw new Error(`四喜扩展清单为空或读不到：${INVENTORY_FILE}`);
    }
    out.WOOHAA3_EXTENSION_ALLOWLIST = ids.join(",");
  }
  out.WOOHAA3_SDK_AGENT_ALLOWED_HOSTS = explicit("WOOHAA3_SDK_AGENT_ALLOWED_HOSTS") ?? SDK_HOSTS_PLACEHOLDER;
  out.WOOHAA3_SDK_AGENT_BUILTIN_HOSTS = explicit("WOOHAA3_SDK_AGENT_BUILTIN_HOSTS") ?? "0";
  return out;
}
