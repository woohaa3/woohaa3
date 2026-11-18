/**
 * 更新通道的桌面桥（change: 2026-11-18-add-desktop-update-channels）。
 *
 * 与 `window-controls.ts` 同一层、同一套受控通道：只走 `woohaa-native` 的 `/update-channel`，
 * 浏览器里没有该能力时直接判定为不支持，不做静默降级。
 *
 * 「接收开发者版本」只影响**下次启动**的更新检查，不改变当前运行版本，因此写入成功后
 * 界面必须如实说明这一点，不能暗示立即升级。
 */
import { desktopBootstrap, isDesktopHost } from "../extension-api/host-platform.js";
import { nativeProtocolUrl } from "./native-protocol.js";

export type UpdateChannelName = string;

export type UpdateChannelState = {
  channel: UpdateChannelName;
  pendingRollback: boolean;
};

export type UpdateChannelOptions = UpdateChannelState & {
  /** 本安装包可查询的通道集合；决定设置项是否出现。 */
  available: UpdateChannelName[];
};

type Envelope = { ok: boolean; value?: UpdateChannelOptions; error?: string };

async function request(method: "GET" | "POST", body?: unknown): Promise<UpdateChannelOptions> {
  if (!isDesktopHost(globalThis)) throw new Error("更新通道仅支持桌面版");
  const bootstrap = desktopBootstrap(globalThis);
  if (!bootstrap) throw new Error("更新通道不可用");
  const response = await fetch(nativeProtocolUrl("update-channel"), {
    method,
    headers: { "Content-Type": "application/json", "X-Woohaa-Token": bootstrap.token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000)
  });
  const result = await response.json() as Envelope;
  if (!response.ok || !result.ok || !result.value) throw new Error(result.error ?? "更新通道操作失败");
  return result.value;
}

/** 读当前选择与可用集合。 */
export function readUpdateChannel(): Promise<UpdateChannelOptions> {
  return request("GET");
}

/** 写通道选择；从 alpha 关回 stable 时由壳层顺带写入一次性回退意图。 */
export function writeUpdateChannel(channel: UpdateChannelName): Promise<UpdateChannelOptions> {
  return request("POST", { channel });
}

/** 只有安装包自带 alpha 地址时才谈得上「接收开发者版本」。 */
export function offersDeveloperChannel(options: UpdateChannelOptions): boolean {
  return options.available.includes("alpha");
}
