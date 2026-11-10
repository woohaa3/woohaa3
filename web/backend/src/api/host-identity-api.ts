/**
 * 宿主身份端点：`GET /api/host/identity`（契约见 `@woohaa3/contracts` 的 `HostIdentity`）。
 *
 * ## 为什么是 GET 且不做管理员授权
 *
 * 它回的是**本机可见的自我描述**，不是业务数据：数据目录路径对同机进程本来就不是秘密，
 * 版本与启动时刻更不是。要它做管理员授权会毁掉它的唯一用途——外部工具（比如把画布挂进
 * 别的 Agent 宿主的插件）需要在**没有凭据**的情况下先认出「这是哪一份实例」，认出来之后
 * 才谈得上选它、连它。
 *
 * 反过来，它**不**提供任何写路径、不列画布、不回设置：即使被同机任意进程调用，也拿不到
 * 用户内容。这正是它与 `/api/settings`（管理员授权）的分工。
 *
 * ## 为什么不做缓存
 *
 * 扫描器会在一个端口上反复问同一句话。它要的就是「现在这个进程还是不是那个实例」，
 * 缓存会把已经退出的实例继续报成活的。一次应答是几十字节，没必要省。
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HOST_IDENTITY_PATH, WOOHAA3_PROTOCOL_VERSION, type HostIdentity } from "@woohaa3/contracts";

export type HostIdentityApiDependencies = {
  /** 数据目录绝对路径：实例指纹的主要来源。 */
  dataDir: string;
  /** 本次进程启动时刻；缺省取模块装载时刻。 */
  startedAt?: Date;
  /** 宿主应用版本；取不到时传空串。 */
  version?: string;
};

/**
 * 派生实例指纹。
 *
 * 由数据目录与启动时刻共同决定：前者区分「这份数据是谁的」，后者区分「同一份数据的哪一次启动」。
 * 用 sha256 是为了让它定长且不泄漏目录结构之外的东西（目录本身仍然单独回传，那是给人看的）。
 * @param input - 数据目录与启动时刻。
 * @returns 十六进制指纹（截断到 16 位：够区分本机实例，又不至于让日志难读）。
 */
export function deriveInstanceId(input: { dataDir: string; startedAt: Date }): string {
  return createHash("sha256").update(`${input.dataDir}\u0000${input.startedAt.toISOString()}`).digest("hex").slice(0, 16);
}

/**
 * 造一份身份。
 *
 * 启动时刻与实例指纹在构造时固定：同一次进程生命周期内每次请求都回同一份身份，
 * 外部工具据此判断「还是那个实例」。
 * @param deps - 数据目录、启动时刻与版本。
 * @returns 可反复回传的身份。
 */
export function createHostIdentity(deps: HostIdentityApiDependencies): HostIdentity {
  const startedAt = deps.startedAt ?? new Date();
  const dataDir = deps.dataDir;
  return {
    instanceId: deriveInstanceId({ dataDir, startedAt }),
    dataDir,
    startedAt: startedAt.toISOString(),
    version: deps.version ?? "",
    protocolVersion: WOOHAA3_PROTOCOL_VERSION
  };
}

/**
 * 造端点处理器。
 * @param identity - 固定下来的身份。
 * @returns 命中即响应并返回 true；不命中返回 false 交下游。
 */
export function createHostIdentityApiHandler(identity: HostIdentity): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "");
    if (pathname !== HOST_IDENTITY_PATH) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { code: "unsupported", message: "仅支持 GET" });
      return true;
    }
    sendJson(res, 200, identity);
    return true;
  };
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(status >= 400 ? { ...body, protocolVersion: WOOHAA3_PROTOCOL_VERSION } : body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // no-store：外部工具要的是「现在还是不是那个实例」，缓存会把已退出的实例报活。
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}
