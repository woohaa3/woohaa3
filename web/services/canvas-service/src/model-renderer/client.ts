/**
 * 原生 model renderer 常驻进程 client
 * （change: enhance-model-scene-authoring-api，任务 7.3 / design D11）。
 *
 * 职责：
 * - 启动并常驻 `model-renderer` 子进程；
 * - 通过 framed stdio 协议发送 Scene IR + capture options（不发送 JavaScript）；
 * - 有界并发队列、单请求超时、进程退出检测与受控重启；
 * - 稳定的 `renderer-unavailable` / `render-timeout` / `render-failed` 错误码。
 *
 * Renderer 不可用 MUST NOT 影响画布存储、Yjs 或非预览 MCP 工具：本 client 只抛结构化错误。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";

/** 与 Rust `renderer_protocol` 对齐的协议常量。 */
export const RENDERER_PROTOCOL_VERSION = "woohaa-model-renderer-protocol-v4";
export const RENDER_VERSION = "woohaa-model-render-v4";
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_PREVIEW_EDGE = 2048;

import type { ContentMotionRequest, ContentSceneFrame } from "@woohaa3/contracts";

/** 渲染器协议里的动画采样载荷（契约层 `ContentMotionRequest` 的别名）。 */
export type RendererMotionRequest = ContentMotionRequest;

/** 渲染器请求：场景帧（`ContentSceneFrame`）+ 请求标识与截图参数。 */
export type RendererSceneRequest = ContentSceneFrame & {
  requestId: string;
  capture: { width: number; height: number; background: string; cameraPreset: string };
};

export type RendererResult =
  | { ok: true; png: Buffer; renderVersion: string }
  | { ok: false; code: string; message: string };

export type RendererClientOptions = {
  /** renderer 可执行文件路径；缺失时 client 恒定返回 renderer-unavailable。 */
  command?: string;
  args?: readonly string[];
  /** 单请求超时（毫秒）。 */
  timeoutMs?: number;
  /** 并发上限（同时 in-flight 的请求数）。 */
  concurrency?: number;
  /** 队列上限；超出返回 render-busy。 */
  maxQueue?: number;
  /** 子进程启动失败/退出后是否重启；默认 true。 */
  restartOnExit?: boolean;
  env?: NodeJS.ProcessEnv;
  logger?: (event: Record<string, unknown>) => void;
};

export type RendererClient = {
  render: (request: RendererSceneRequest) => Promise<RendererResult>;
  /** 当前是否认为 renderer 可用（进程已启动且未处于不可用态）。 */
  available: () => boolean;
  close: () => Promise<void>;
};

type Pending = {
  request: RendererSceneRequest;
  resolve: (result: RendererResult) => void;
  timer: NodeJS.Timeout;
};

/**
 * 创建 renderer client。
 *
 * 未配置 `command` 时视为 renderer-unavailable：仍可被 composition 注入，让预览工具
 * 返回稳定错误而不影响其它能力。
 */
export function createRendererClient(options: RendererClientOptions = {}): RendererClient {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const maxQueue = Math.max(0, options.maxQueue ?? 32);
  const log = options.logger ?? (() => undefined);
  const command = options.command;

  let child: ChildProcessWithoutNullStreams | null = null;
  let available = command !== undefined;
  let closed = false;
  let startFailed = false;
  let inFlight = 0;
  const queue: Pending[] = [];
  let stdoutBuffer = Buffer.alloc(0);
  let pendingPngLength: number | null = null;
  let current: Pending | null = null;
  let stderrTail = "";

  const failAll = (code: string, message: string) => {
    pendingPngLength = null;
    stdoutBuffer = Buffer.alloc(0);
    if (current) {
      clearTimeout(current.timer);
      current.resolve({ ok: false, code, message });
      current = null;
    }
    for (const pending of queue.splice(0)) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, code, message });
    }
  };

  const handleExit = (exitCode: number | null) => {
    child = null;
    const message = `renderer 进程退出（code=${exitCode}）${stderrTail ? `：${stderrTail}` : ""}`;
    log({ event: "model-renderer-exit", code: exitCode, stderr: stderrTail.slice(-500) });
    if (closed) {
      failAll("renderer-unavailable", "renderer 已关闭");
      return;
    }
    failAll("render-failed", message);
    if (options.restartOnExit ?? true) {
      try {
        start();
      } catch (error) {
        available = false;
        log({ event: "model-renderer-restart-failed", message: String(error) });
      }
    } else {
      available = false;
    }
  };

  const start = () => {
    if (closed || command === undefined) {
      available = false;
      return;
    }
    const spawned = spawn(command, [...(options.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env
    });
    child = spawned;
    available = true;
    stderrTail = "";
    spawned.stdout.on("data", (chunk: Buffer) => onStdout(chunk));
    spawned.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
    });
    spawned.on("error", (error) => {
      available = false;
      startFailed = true;
      log({ event: "model-renderer-error", message: error.message });
      failAll("renderer-start-failed", "原生预览进程启动失败，请检查可执行文件与运行依赖后重启本机宿主");
    });
    spawned.on("exit", (code) => handleExit(code));
    log({ event: "model-renderer-started", pid: spawned.pid });
  };

  const onStdout = (chunk: Buffer) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    for (;;) {
      if (current === null) {
        stdoutBuffer = Buffer.alloc(0);
        pendingPngLength = null;
        return;
      }
      if (pendingPngLength !== null) {
        if (stdoutBuffer.length < 4 + pendingPngLength) return;
        const pngLength = pendingPngLength;
        pendingPngLength = null;
        const png = stdoutBuffer.subarray(4, 4 + pngLength);
        stdoutBuffer = stdoutBuffer.subarray(4 + pngLength);
        clearTimeout(current.timer);
        current.resolve({ ok: true, png: Buffer.from(png), renderVersion: RENDER_VERSION });
        current = null;
        pump();
        continue;
      }
      if (stdoutBuffer.length < 4) return;
      const jsonLength = stdoutBuffer.readUInt32BE(0);
      if (jsonLength === 0 || jsonLength > MAX_MESSAGE_BYTES) {
        clearTimeout(current.timer);
        current.resolve({ ok: false, code: "render-failed", message: "renderer 响应长度非法" });
        current = null;
        stdoutBuffer = Buffer.alloc(0);
        return;
      }
      if (stdoutBuffer.length < 4 + jsonLength) return;
      const json = stdoutBuffer.subarray(4, 4 + jsonLength).toString("utf8");
      stdoutBuffer = stdoutBuffer.subarray(4 + jsonLength);
      let parsed: { ok?: boolean; code?: string; message?: string; pngLen?: number };
      try {
        parsed = JSON.parse(json);
      } catch {
        clearTimeout(current.timer);
        current.resolve({ ok: false, code: "render-failed", message: "renderer 响应不是合法 JSON" });
        current = null;
        return;
      }
      if (parsed.ok !== true) {
        clearTimeout(current.timer);
        current.resolve({ ok: false, code: parsed.code ?? "render-failed", message: parsed.message ?? "渲染失败" });
        current = null;
        continue;
      }
      pendingPngLength = parsed.pngLen ?? 0;
    }
  };

  const pump = () => {
    if (current !== null || queue.length === 0 || child === null) return;
    const pending = queue.shift() as Pending;
    current = pending;
    const body = JSON.stringify({
      protocolVersion: RENDERER_PROTOCOL_VERSION,
      requestId: pending.request.requestId,
      sceneVersion: pending.request.sceneVersion,
      signature: pending.request.signature,
      extent: pending.request.extent,
      ops: pending.request.ops,
      capture: pending.request.capture,
      ...(pending.request.placement ? { placement: pending.request.placement } : {}),
      ...(pending.request.motion ? { motion: pending.request.motion } : {}),
      ...(pending.request.compositeAssetFrame ? { compositeAssetFrame: pending.request.compositeAssetFrame } : {})
    });
    const payload = Buffer.from(body, "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    try {
      child.stdin.write(Buffer.concat([header, payload]));
    } catch (error) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, code: "render-failed", message: String(error) });
      current = null;
      pump();
    }
  };

  const render = (request: RendererSceneRequest): Promise<RendererResult> => {
    if (closed) return Promise.resolve({ ok: false, code: "renderer-unavailable", message: "renderer 已关闭" });
    if (command === undefined || !available || child === null) {
      return Promise.resolve({ ok: false, code: startFailed ? "renderer-start-failed" : "renderer-unavailable", message: startFailed ? "原生预览进程启动失败，请检查运行依赖后重启本机宿主" : "未配置可用的原生 model renderer，请构建并配置后重启本机宿主" });
    }
    if (inFlight >= concurrency && queue.length >= maxQueue) {
      return Promise.resolve({ ok: false, code: "render-busy", message: "预览请求超过并发/队列上限" });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = queue.findIndex((entry) => entry.resolve === resolve);
        if (index >= 0) queue.splice(index, 1);
        if (current?.resolve === resolve) {
          current = null;
          stdoutBuffer = Buffer.alloc(0);
          pendingPngLength = null;
        }
        resolve({ ok: false, code: "render-timeout", message: "渲染超过超时上限" });
      }, timeoutMs);
      const pending: Pending = { request, resolve, timer };
      queue.push(pending);
      inFlight += 1;
      const originalResolve = pending.resolve;
      pending.resolve = (result) => {
        if (inFlight > 0) inFlight -= 1;
        originalResolve(result);
      };
      pump();
    });
  };

  if (command !== undefined && !closed) start();

  return {
    render,
    available: () => available && child !== null,
    close: async () => {
      closed = true;
      available = false;
      failAll("renderer-unavailable", "renderer 已关闭");
      const proc = child;
      child = null;
      if (proc) {
        proc.kill("SIGTERM");
        // 简单等待退出，避免悬挂 fd。
        await new Promise<void>((resolve) => {
          proc.once("exit", () => resolve());
          setTimeout(resolve, 2000);
        });
      }
    }
  };
}

/** 缓存键：`sourceHash + sceneVersion + renderVersion + normalizedCaptureOptions`（+动画身份/时刻）。 */
export function renderCacheKey(input: {
  sourceHash: string;
  sceneVersion: string;
  renderVersion: string;
  capture: { width: number; height: number; background: string; cameraPreset: string };
  /** 动画完整快照身份；静态模型省略（change: 2026-10-06-fix-model-media...，D6）。 */
  animationIdentity?: string;
  timeSeconds?: number;
}): string {
  const capture = `${input.capture.width}x${input.capture.height}:${input.capture.background}:${input.capture.cameraPreset}`;
  const animation = input.animationIdentity ? `${input.animationIdentity}\u0000${input.timeSeconds ?? 0}` : "";
  return createHash("sha1")
    .update(`${input.sourceHash}\u0000${input.sceneVersion}\u0000${input.renderVersion}\u0000${capture}\u0000${animation}`)
    .digest("hex");
}
