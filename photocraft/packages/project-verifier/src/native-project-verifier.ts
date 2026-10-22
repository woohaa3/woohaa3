/**
 * 原生工程核验适配器
 * （change: 2026-10-16-integrate-photocraft-image-editing，任务 2.3 / design D5；
 *  change: 2026-10-21-extract-photocraft-subproject，任务 3.1 —— 迁入 PhotoCraft 并实例化）。
 *
 * 默认用进程内的有界 TS 核验（`project-verification.ts`）。部署时可选接入**原生无 UI 核验
 * 工具**（`rust/crates/project-verify`）：它与编辑器共用同一固定文档解析实现，能力边界与
 * 格式解析不会与编辑器漂移。
 *
 * 适配器本身承担设计要求的进程纪律：
 * - 只以**参数数组**启动（绝不经过 shell，绝不拼接用户输入到命令行）；
 * - 字节只走 stdin，绝不落盘、绝不请求外部地址；
 * - 单次调用有**墙钟超时**，超时 SIGKILL；
 * - stdout/stderr 有**字节上限**，防止被核验进程刷爆内存；
 * - 并发上限在**实例内**生效，多请求排队而不是无限起进程。
 *
 * 迁移变更（design D5）：不再使用模块级全局配置与全局并发计数器，改为
 * `createNativeProjectVerifier()` 返回的可释放实例。Media 每个服务实例持有一个，
 * 因此：
 * - 多个 Media 实例（测试里的多服务、真实部署的多进程内嵌场景）互不影响并发额度；
 * - `dispose()` 立即关闭该实例并唤醒排队者，不会遗留租约；
 * - 关闭后的实例按「不可用」错误失败，不静默回退到另一实例的配置。
 *
 * 未配置原生工具时 `verifyProjectThroughAdapter` 直接走进程内核验，行为与迁移前一致。
 */
import { spawn } from "node:child_process";
import {
  IMAGE_PROJECT_CONTENT_TYPE,
  ProjectVerificationError,
  inspectEmbeddedPhotocraftProject,
  verifyPhotocraftProject,
  type ProjectVerificationSummary
} from "./project-verification.js";

/** 适配器专有的失败原因（不覆盖工程内容本身的原因）。 */
export type NativeVerifierErrorCode =
  | "native-verifier-unavailable"
  | "native-verifier-failed"
  | "native-verifier-timeout"
  | "native-verifier-output-too-large";

export class NativeVerifierError extends Error {
  readonly code: NativeVerifierErrorCode;

  constructor(code: NativeVerifierErrorCode, message: string) {
    super(message);
    this.name = "NativeVerifierError";
    this.code = code;
  }
}

export type NativeProjectVerifierOptions = {
  /** 原生核验工具可执行文件路径（由部署方提供，不接受用户输入）。 */
  binaryPath: string;
  /** 单次调用的墙钟上限（毫秒）。 */
  timeoutMs?: number;
  /** 实例内并发上限（排队请求数由调用方限流，这里只限同时运行数）。 */
  maxConcurrent?: number;
  /** stdout/stderr 各自允许的最大字节数。 */
  maxOutputBytes?: number;
  /**
   * 子进程启动实现（仅测试注入）。
   *
   * 生产永远用 `node:child_process.spawn`。注入点的唯一用途是：在不依赖真实平台可执行文件的
   * 前提下断言「参数数组形态」与 `--embedded-smart` 传递，因为 Windows 上无法用「复制 node.exe
   * + NODE_OPTIONS 注入脚本」的假工具接收这个参数（Node 会在解析自身参数时就拒绝未知开关）。
   */
  spawnImpl?: SpawnLike;
};

/** `node:child_process.spawn` 的最小可替换形状。 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { stdio: ["pipe", "pipe", "pipe"] }
) => {
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  stdin: { on(event: "error", listener: () => void): unknown; end(chunk?: Uint8Array): unknown };
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal: NodeJS.Signals): unknown;
};

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_OUTPUT_BYTES = 1 << 20;

type Configured = {
  binaryPath: string;
  timeoutMs: number;
  maxConcurrent: number;
  maxOutputBytes: number;
  spawnImpl: SpawnLike;
};

/** 可创建、可释放的原生核验实例。 */
export type NativeProjectVerifier = {
  /** 是否已配置原生工具（未配置时走进程内有界核验）。 */
  configured(): boolean;
  /** 用原生工具核验（未配置时抛 `native-verifier-unavailable`）。 */
  verify(bytes: Uint8Array, options?: { embeddedSmart?: boolean }): Promise<ProjectVerificationSummary>;
  /** ingest 入口：已配置时优先原生，适配器问题回退进程内核验；内容拒绝不回退。 */
  verifyForIngest(
    bytes: Uint8Array,
    contentType: string,
    options?: { maxBytes?: number }
  ): Promise<ProjectVerificationSummary>;
  /** embedded-smart 入口：外侧结构 + 原生摘要必须一致，任一失败都不接收。 */
  verifyEmbeddedForIngest(
    bytes: Uint8Array,
    contentType: string,
    options?: { maxBytes?: number }
  ): Promise<ProjectVerificationSummary>;
  /** 释放实例：唤醒排队者并让其以「不可用」失败。幂等。 */
  dispose(): void;
  /** 当前同时运行的原生调用数（测试用于断言实例隔离）。 */
  inflight(): number;
};

export function createNativeProjectVerifier(
  options: NativeProjectVerifierOptions | null = null
): NativeProjectVerifier {
  let config: Configured | null = null;
  if (options) {
    if (!options.binaryPath) {
      throw new NativeVerifierError("native-verifier-unavailable", "缺少原生核验工具路径");
    }
    config = {
      binaryPath: options.binaryPath,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxConcurrent: Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT),
      maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      spawnImpl: options.spawnImpl ?? (spawn as unknown as SpawnLike)
    };
  }

  let running = 0;
  let disposed = false;
  const waiters: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (disposed) {
      throw new NativeVerifierError("native-verifier-unavailable", "原生核验实例已释放");
    }
    if (config === null) return;
    if (running < config.maxConcurrent) {
      running += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    if (disposed) {
      throw new NativeVerifierError("native-verifier-unavailable", "原生核验实例已释放");
    }
    running += 1;
  }

  function release(): void {
    running -= 1;
    waiters.shift()?.();
  }

  async function verify(
    bytes: Uint8Array,
    verifyOptions: { embeddedSmart?: boolean } = {}
  ): Promise<ProjectVerificationSummary> {
    const current = config;
    if (current === null) {
      throw new NativeVerifierError("native-verifier-unavailable", "未配置原生核验工具");
    }
    if (disposed) {
      throw new NativeVerifierError("native-verifier-unavailable", "原生核验实例已释放");
    }
    await acquire();
    try {
      const output = await runVerifier(current, bytes, verifyOptions.embeddedSmart === true);
      const parsed = JSON.parse(output) as
        | { ok: true; summary: Record<string, unknown> }
        | { ok: false; code: string; message: string };
      if (parsed.ok) {
        return {
          formatVersion: Number(parsed.summary.formatVersion ?? 0),
          generator: String(parsed.summary.generator ?? ""),
          canvasWidth: Number(parsed.summary.canvasWidth ?? 0),
          canvasHeight: Number(parsed.summary.canvasHeight ?? 0),
          layerCount: Number(parsed.summary.layerCount ?? 0),
          depth: Number(parsed.summary.depth ?? 0),
          entryCount: Number(parsed.summary.entryCount ?? 0),
          decompressedBytes: Number(parsed.summary.decompressedBytes ?? 0),
          objectKinds: Array.isArray(parsed.summary.objectKinds)
            ? parsed.summary.objectKinds.map((kind) => String(kind))
            : []
        };
      }
      throw new ProjectVerificationError(parsed.code as ProjectVerificationError["code"], parsed.message);
    } finally {
      release();
    }
  }

  async function verifyForIngest(
    bytes: Uint8Array,
    contentType: string,
    verifyOptions: { maxBytes?: number } = {}
  ): Promise<ProjectVerificationSummary> {
    if (contentType !== IMAGE_PROJECT_CONTENT_TYPE) {
      throw new ProjectVerificationError(
        "unsupported-content-type",
        `不是工程媒体类型：${contentType || "(空)"}`
      );
    }
    if (config === null || disposed) {
      return verifyPhotocraftProject(bytes, verifyOptions);
    }
    try {
      return await verify(bytes);
    } catch (error) {
      if (error instanceof NativeVerifierError) {
        // 适配器不可用：回退到进程内有界核验（同样是拒绝边界，只是实现不同）。
        return verifyPhotocraftProject(bytes, verifyOptions);
      }
      // 原生工具明确报告的内容原因：不回退、不掩盖。
      throw error;
    }
  }

  async function verifyEmbeddedForIngest(
    bytes: Uint8Array,
    contentType: string,
    verifyOptions: { maxBytes?: number } = {}
  ): Promise<ProjectVerificationSummary> {
    if (contentType !== IMAGE_PROJECT_CONTENT_TYPE) {
      throw new ProjectVerificationError("unsupported-content-type", "不是工程媒体类型");
    }
    // 内部 embedded-smart 模式**不**允许回退：外层结构检查之后再要求原生成功。
    const structure = inspectEmbeddedPhotocraftProject(bytes, verifyOptions);
    const native = await verify(bytes, { embeddedSmart: true });
    for (const key of [
      "formatVersion",
      "canvasWidth",
      "canvasHeight",
      "layerCount",
      "depth",
      "entryCount",
      "decompressedBytes"
    ] as const) {
      if (native[key] !== structure[key]) {
        throw new NativeVerifierError("native-verifier-failed", `原生核验摘要不一致：${key}`);
      }
    }
    if (native.objectKinds.join(",") !== structure.objectKinds.join(",")) {
      throw new NativeVerifierError("native-verifier-failed", "原生核验对象类型不一致");
    }
    return native;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    config = null;
    // 唤醒所有排队者，让它们以「已释放」失败而不是永久挂起。
    for (const waiter of waiters.splice(0)) waiter();
  }

  return {
    configured: () => config !== null && !disposed,
    verify,
    verifyForIngest,
    verifyEmbeddedForIngest,
    dispose,
    inflight: () => running
  };
}

/** 未配置原生工具的实例（Media 默认形态）：只做进程内有界核验。 */
export function createProcessOnlyVerifier(): NativeProjectVerifier {
  return createNativeProjectVerifier(null);
}

function runVerifier(config: Configured, bytes: Uint8Array, embeddedSmart = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = config.spawnImpl(config.binaryPath, embeddedSmart ? ["--embedded-smart"] : [], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new NativeVerifierError("native-verifier-timeout", `原生核验超过 ${config.timeoutMs}ms`));
    }, config.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > config.maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new NativeVerifierError("native-verifier-output-too-large", "原生核验输出超过上限"));
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= config.maxOutputBytes) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish(new NativeVerifierError("native-verifier-unavailable", `无法启动原生核验工具：${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      if (stdout.trim().length === 0) {
        finish(
          new NativeVerifierError(
            "native-verifier-failed",
            `原生核验未输出结果（退出码 ${code ?? "null"}）：${stderr.trim().slice(0, 200)}`
          )
        );
        return;
      }
      finish(null, stdout.trim());
    });
    child.stdin.on("error", () => {
      // 核验工具提前退出时写入会失败；最终以 close/stdout 判定。
    });
    child.stdin.end(bytes);
  });
}
