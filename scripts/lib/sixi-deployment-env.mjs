/**
 * 四喜发行形态的宿主部署环境。
 *
 * 为什么单独一个新文件：这几项收口要同时作用于 `desktop-host.mjs`（桌面壳）和 `dev.mjs`
 * （浏览器开发宿主）两条启动路径。把逻辑写进任何一条上游共用脚本，都会在合并上游时产生冲突，
 * 也会让两条路径各写一份而漂移。这里只放纯函数，两边各调一行。
 *
 * 收口的三件事（都是「用户只能经 ppserver 消耗积分、不能外接自己的 API」）：
 * 1. 扩展白名单：沿用 `desktop/host-extensions.json` 作为唯一清单，避免再维护一份。
 *    发行版靠它决定拷贝哪些目录；开发形态不拷贝目录，所以靠 `WOOHAA3_EXTENSION_ALLOWLIST` 对齐。
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

export const SDK_HOSTS_PLACEHOLDER = "sdk-agent-disabled.invalid";

/** 读发行版拷贝清单；读不到或为空返回 null（调用方按「不过滤」处理，宿主不该因为它起不来）。 */
export function readInventoryIds(repoRoot) {
  try {
    const ids = JSON.parse(fs.readFileSync(path.join(repoRoot, "desktop/host-extensions.json"), "utf8")).extensions;
    return Array.isArray(ids) && ids.length > 0 ? ids.filter((id) => typeof id === "string") : null;
  } catch {
    return null;
  }
}

/**
 * 返回要注入宿主进程的部署环境（只含需要覆盖的键）。
 *
 * @param repoRoot 仓库根；传入才会生成扩展白名单（发行包里没有 `desktop/` 目录，传 null 即可）。
 * @param inherited 启动方显式给的环境（`process.env` 或 `loadServiceEnv` 的结果）；非空值原样保留。
 */
export function sixiDeploymentEnv({ repoRoot = null, inherited = {} } = {}) {
  const explicit = (name) => {
    const value = inherited?.[name];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  };
  const out = {};
  if (repoRoot) {
    const allowlist = explicit("WOOHAA3_EXTENSION_ALLOWLIST") ?? readInventoryIds(repoRoot)?.join(",") ?? null;
    if (allowlist) out.WOOHAA3_EXTENSION_ALLOWLIST = allowlist;
  }
  out.WOOHAA3_SDK_AGENT_ALLOWED_HOSTS = explicit("WOOHAA3_SDK_AGENT_ALLOWED_HOSTS") ?? SDK_HOSTS_PLACEHOLDER;
  out.WOOHAA3_SDK_AGENT_BUILTIN_HOSTS = explicit("WOOHAA3_SDK_AGENT_BUILTIN_HOSTS") ?? "0";
  return out;
}
