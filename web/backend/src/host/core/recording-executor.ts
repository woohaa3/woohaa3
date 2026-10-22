/**
 * 核心层 · recordingExecutor：本机录制执行器的私有控制通道
 * （change: 2026-10-17-add-native-offscreen-film-set-recording，任务 1.5 / design D2）。
 *
 * 该插件只负责**通道与注册**：
 * - 在用户私有目录建立 0700 目录与 0600 Unix-domain socket；
 * - 生成注册 nonce，并把 socket 路径/nonce 交给可信启动配置（桌面 supervisor 读取）；
 * - 维护执行器注册表（lease、能力、工作区隔离）。
 *
 * 它**不**调度任务、不渲染、不提交画布；那些在 canvas-service 的录制编排里。WebView 与本
 * 插件之间没有依赖：页面断开不会关闭 socket，也不会注销执行器。
 *
 * 平台不支持（Windows 等）时明确不提供 `ctx.recordingExecutor`，宿主能力查询据此返回
 * `recording-unsupported-platform`，不退化到 TCP 或浏览器编码。
 */
import type { HostPlugin } from "../context.js";
import { recordingExecutorPlatformSupported } from "../../recording-executor/platform.js";

/** 通道类型唯一来源在 `recording-executor/channel.ts`（含 sendControl/onControl）。 */
export type { RecordingExecutorChannel } from "../../recording-executor/channel.js";

export const recordingExecutorPlugin: HostPlugin<{ env?: Record<string, string | undefined>; checkoutDirectory?: string }> = {
  name: "recordingExecutor",
  inject: ["log"],
  async apply(ctx, config) {
    const log = ctx.log.scope("recording-executor");
    if (!recordingExecutorPlatformSupported()) {
      log({ event: "recording-executor-unsupported-platform", platform: process.platform });
      return;
    }
    const { createRecordingExecutorChannel } = await import("../../recording-executor/channel.js");
    const channel = await createRecordingExecutorChannel({
      ...(config?.env ? { env: config.env } : {}),
      ...(config?.checkoutDirectory ? { checkoutDirectory: config.checkoutDirectory } : {}),
      logger: log
    });
    if (!channel) return;
    ctx.effect(() => () => {
      void channel.close();
    });
    ctx.provide("recordingExecutor", channel);
    log({
      event: "recording-executor-ready",
      checkoutId: channel.checkoutId,
      socketPath: channel.socketPath
    });
  }
};
