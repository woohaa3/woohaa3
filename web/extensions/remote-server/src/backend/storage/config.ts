/**
 * 服务端托管存储后端的配置解析（属于 remote-server 的存储能力，不是独立插件）。
 *
 * 为什么不再有自己的配置前缀与 `defineConfigSchema`：接入服务端只该有**一份**部署配置
 * （`config.local.json` + `WOOHAA3_REMOTE_SERVER_*` 环境变量 + 设置面非秘密项），由
 * `deployment.ts` 读取。存储后端只是这份配置的消费者——`serverUrl` 与设备凭证与「登录 /
 * 同步上游」用的是同一对值。再造一套 `storage.server.*` 只会让同一个部署出现
 * 「登录用一个地址、读写字节用另一个地址」的分裂。
 *
 * 配置不全**不抛错**：返回缺项由调用方记日志并跳过注册——存储后端可以由 local / cos 顶上，
 * 缺配置不该让宿主启动失败。
 *
 * 注册门槛只有 `serverUrl`：设备凭证是**可选**的。没有凭证时后端照样注册，调用期由共享会话
 * （`../session.js`）报 `unconfigured` / `unauthenticated`——与登录、同步上游同一口径：
 * 「还没登录」是运行期状态，不是启动期配置错误；而且运行期还可以用网关断言或设备码登录。
 */
import type { RemoteServerDeployment } from "../../deployment.js";

/** 设置在 `storage.primary` / `storage.expose` 里引用的后端 id（与 local / cos 并列）。 */
export const SERVER_STORAGE_BACKEND_ID = "server";

/** 设置页与日志里的显示名。 */
export const SERVER_STORAGE_LABEL = "服务端托管存储";

/**
 * 已解析的服务端存储配置。
 *
 * **刻意不含设备凭证**：换会话由 remote-server 的会话来源负责（凭据在那里读、在那里用），
 * 存储后端只需要「已经拿到会话」。少传一个秘密就少一处可能被日志或错误体带出去的地方。
 */
export type ServerStorageConfig = {
  /** 已规范化（去掉尾部斜杠）的基址；可能是绝对地址，也可能是站内路径。 */
  serverUrl: string;
  /**
   * 对象键前缀（可空）。
   *
   * 服务端自己已有一层 `storage.key_prefix`；客户端这一层是给「同桶多部署隔离」留的余量，
   * 缺省为空，等于不额外加前缀。
   */
  keyPrefix: string;
};

export type ServerStorageConfigResolution =
  | { readonly ok: true; readonly config: ServerStorageConfig }
  | { readonly ok: false; readonly missing: readonly string[]; readonly invalid?: string };

/**
 * 从 remote-server 的部署配置归一化出存储所需的项。
 *
 * 唯一门槛是 `serverUrl`：设备凭证**不参与判定**，也不会被复制进返回值。没有凭证时后端仍然
 * 注册——会话可以在运行期通过网关断言或设备码登录获得，调用期由共享会话给稳定失败码
 * （`unconfigured` / `unauthenticated`）；在这里拒绝注册只会让「先配地址、后登录」的部署
 * 永远没有服务端存储可用。
 *
 * 校验口径与 `deployment.ts` 完全一致（它已经对 `serverUrl` 做过有界校验），因此这里只处理
 * 「缺项」，不再重复实现一套 URL 规则——两套规则迟早会不一致。
 */
export function resolveServerStorageConfig(
  deployment: RemoteServerDeployment,
  options: { keyPrefix?: string } = {}
): ServerStorageConfigResolution {
  const missing: string[] = [];
  if (deployment.serverUrl === null) missing.push("serverUrl");
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    config: {
      serverUrl: deployment.serverUrl!,
      keyPrefix: normalizeKeyPrefix(options.keyPrefix ?? deployment.keyPrefix)
    }
  };
}

/** 去掉两端斜杠；非字符串一律当空（调用方传进来的通常是设置面里的任意值）。 */
export function normalizeKeyPrefix(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/^\/+|\/+$/g, "") : "";
}
