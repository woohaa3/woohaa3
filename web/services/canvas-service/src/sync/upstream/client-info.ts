/**
 * 远端同步客户端在会话握手（`Hello.client`）里自报的展示元数据。
 *
 * 它**只用于管理与排障观测**：woohaa-server 的管理端调试通道按连接展示"哪台机器、
 * 什么版本"连上来；服务端不据此做任何鉴权、授权或同步判定，也不会因为它缺失而拒绝
 * 连接。旧客户端不发送时观测端显示"未上报"。
 *
 * 为什么版本从本包的 `package.json` 取而不是从宿主传：同步链路属于本包（`ws` 客户端
 * 只在这里创建），版本跟着代码走才不会出现"宿主改了版本、同步客户端还报旧值"。发布
 * 本机宿主打包时把 `desktop/tauri.conf.json` 的发布版本写进 `host-manifest.json`，
 * 启动时注入 `WOOHAA3_APP_VERSION`，因此打包产物上报的是真实发布版本。
 */
import pkg from "../../../package.json";

/** 客户端在 Hello 里自报的三项。字段与 `session.proto` 的 `ClientInfo` 一一对应。 */
export type UpstreamClientInfo = {
  /** 产品名，固定为 `woohaa3-host`：连远端的是本机宿主进程，而不是浏览器。 */
  name: string;
  /** 版本；空串表示未知（观测端显示"未上报"）。 */
  version: string;
  /** 平台，例如 `darwin-arm64`。 */
  platform: string;
};

/** 客户端产品名。浏览器不直连远端，所以这里只有本机宿主一种。 */
export const UPSTREAM_CLIENT_NAME = "woohaa3-host";

/**
 * 默认客户端元数据。
 *
 * 版本来源优先级：`WOOHAA3_APP_VERSION`（发布构建注入）→ 本包 `package.json`。
 * 平台取 `process.platform-process.arch`：这是同步客户端实际运行所在的平台，
 * 与用户浏览器 UA 无关（浏览器不直连远端）。
 */
export function defaultUpstreamClientInfo(): UpstreamClientInfo {
  const fromEnv = process.env.WOOHAA3_APP_VERSION;
  return {
    name: UPSTREAM_CLIENT_NAME,
    version: fromEnv !== undefined && fromEnv !== "" ? fromEnv : pkg.version,
    platform: `${process.platform}-${process.arch}`
  };
}

/**
 * 握手 `User-Agent`：`woohaa3-host/0.1.0 darwin-arm64`。
 *
 * `ws` 默认不发 UA，服务端观测端就会一直看到空值；显式给一个可用 UA 让"谁连上来的"
 * 在不看 Hello 的情况下也能认。去掉换行，避免构造出非法的请求头。
 */
export function upstreamUserAgent(info: UpstreamClientInfo): string {
  const product = info.version === "" ? info.name : `${info.name}/${info.version}`;
  const parts = [product, info.platform].filter((part) => part !== "");
  return parts.join(" ").replace(/[\r\n]+/g, " ");
}
