/**
 * Canvas Service 侧 modelScript 执行适配器
 * （change: enhance-model-scene-authoring-api，任务 7.1 / 7.2 / design D10）。
 *
 * 读取权威 `modelScript` 与版本 descriptor，调用与 Frontend 共用的版本 dispatch，
 * 执行 validator 与确定性重跑，**只返回规范化 Scene IR**（绝不把原始脚本交给 renderer）。
 *
 * JS 执行边界：默认用进程内 `worker_threads` 承载实际执行，设置 CPU 时间、源码长度与
 * 输出预算，并禁止网络/文件系统/环境变量/随机源。`worker_threads` 只作为可终止调度单元，
 * **不宣称为安全沙箱**；因此执行入口只注入版本化 `scene` API 与确定性 helper。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  isSupportedModelScriptVersion,
  MODEL_SCRIPT_V2_VERSION,
  PREFERRED_MODEL_SCRIPT_VERSION,
  type ModelScriptFailure,
  type SupportedModelScriptVersion
} from "@woohaa3/contracts";
import type { SceneV2Op } from "@woohaa3/contracts";

/** 源码长度上限（与 MCP 提交一致）。 */
export const EXECUTOR_MAX_SOURCE_CHARS = 200_000;
/** 默认 CPU 时间上限（毫秒）。 */
export const EXECUTOR_DEFAULT_TIMEOUT_MS = 2_000;
/** 规范化后的 Scene IR JSON 字节上限。 */
export const EXECUTOR_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type ExecuteSceneResult =
  | {
      ok: true;
      version: SupportedModelScriptVersion;
      sceneVersion: string;
      ops: SceneV2Op[];
      json: string;
      sourceHash: string;
    }
  | ModelScriptFailure;

export type ScriptExecutorOptions = {
  /** CPU 时间上限（毫秒）；默认 2000。 */
  timeoutMs?: number;
  /** 源码长度上限；默认 200_000。 */
  maxSourceChars?: number;
  /** 输出 JSON 字节上限；默认 8 MiB。 */
  maxOutputBytes?: number;
  /** 测试可注入：同步执行（跳过 worker），仍做预算校验。 */
  executeSync?: (source: string, version: SupportedModelScriptVersion) => ExecuteSceneResult;
  now?: () => number;
};

/**
 * 执行权威脚本并返回规范化 Scene IR。
 *
 * 未知版本稳定失败；超时/异常/超预算返回稳定 code，不阻塞调用方。
 */
export async function executeSceneIr(
  source: string,
  version: unknown,
  options: ScriptExecutorOptions = {}
): Promise<ExecuteSceneResult> {
  const maxSourceChars = options.maxSourceChars ?? EXECUTOR_MAX_SOURCE_CHARS;
  if (source.length > maxSourceChars) {
    return { ok: false, stage: "compile", code: "source-too-long", message: "脚本超过长度上限" };
  }
  if (!isSupportedModelScriptVersion(version)) {
    return {
      ok: false,
      stage: "compile",
      code: "version-mismatch",
      message: `不支持的 modelScriptVersion ${String(version)}`
    };
  }

  const maxOutputBytes = options.maxOutputBytes ?? EXECUTOR_MAX_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? EXECUTOR_DEFAULT_TIMEOUT_MS;
  const result = options.executeSync
    ? options.executeSync(source, version)
    : await runIsolated(source, version, timeoutMs);

  if (!result.ok) return result;
  if (Buffer.byteLength(result.json, "utf8") > maxOutputBytes) {
    return { ok: false, stage: "validate", code: "output-too-large", message: "Scene IR 超过输出预算" };
  }
  return result;
}

/** 在可终止的 worker 中执行，CPU 超时则终止并返回 model-script-timeout。 */
function runIsolated(
  source: string,
  version: SupportedModelScriptVersion,
  timeoutMs: number
): Promise<ExecuteSceneResult> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(WORKER_BOOTSTRAP, {
      eval: true,
      workerData: { source, version, contractsUrl: contractsModuleUrl() },
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 4
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      resolve({ ok: false, stage: "execute", code: "model-script-timeout", message: "脚本执行超过 CPU 时间上限" });
    }, timeoutMs);

    worker.on("message", (message: { kind?: string; result?: ExecuteSceneResult } | null) => {
      // Node --watch uses this channel for watch:import/watch:require notifications.
      if (!message || message.kind !== "model-script-result") return;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      const result = message.result;
      if (!result || typeof result.ok !== "boolean"
        || (!result.ok && (typeof result.stage !== "string" || typeof result.code !== "string" || typeof result.message !== "string"))
        || (result.ok && (!Array.isArray(result.ops) || typeof result.json !== "string"))) {
        resolve({ ok: false, stage: "execute", code: "runtime-error", message: "模型执行单元返回了无效回执" });
      } else resolve(result);
    });
    worker.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stage: "execute", code: "runtime-error", message: error.message });
    });
    worker.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, stage: "execute", code: "runtime-error", message: `worker 异常退出 ${code}` });
      }
    });
  });
}

/**
 * worker 引导脚本（`eval: true`）。
 *
 * 动态 import 共享 `@woohaa3/contracts`（与 Frontend 同一份 executor dispatch），
 * 只注入版本化 `scene` API；不提供网络、文件系统、环境变量、当前时间或随机源。
 */
/**
 * 解析 `@woohaa3/contracts` 的绝对 URL。
 *
 * eval worker 的模块 URL 落在进程 cwd，不能靠包名解析；从本模块位置解析后再传给 worker。
 * Vite 测试运行时没有 `import.meta.resolve`，那时从当前文件向上查找包入口。
 */
function contractsModuleUrl(): string {
  const meta = import.meta as ImportMeta;
  if (typeof meta.resolve === "function") return meta.resolve("@woohaa3/contracts");
  let dir = fileURLToPath(new URL(".", meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, "node_modules", "@woohaa3", "contracts", "dist", "index.js");
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("找不到 @woohaa3/contracts");
}

const WORKER_BOOTSTRAP = `
import { parentPort, workerData } from "node:worker_threads";
const send = result => parentPort.postMessage({ kind: "model-script-result", result });
try {
  const contracts = await import(workerData.contractsUrl);
  const { executeModelScriptVersioned, sceneIrVersionFor } = contracts;
  const { source, version } = workerData;
  const result = executeModelScriptVersioned(source, version);
  if (!result.ok) {
    send(result);
  } else {
    let hash = 5381;
    for (let i = 0; i < source.length; i += 1) hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
    send({
      ok: true,
      version,
      sceneVersion: sceneIrVersionFor(version),
      ops: result.scene.ops,
      json: result.json,
      sourceHash: (hash >>> 0).toString(36)
    });
  }
} catch (error) {
  send({
    ok: false,
    stage: "execute",
    code: "runtime-error",
    message: error && error.message ? error.message : String(error)
  });
}
`;

/** 规范化捕获选项。 */
export type NormalizedCaptureOptions = {
  width: number;
  height: number;
  background: string;
  cameraPreset: string;
};

/** 归一化 preview capture options，并返回校验错误（越界/非法）。 */
export function normalizeCaptureOptions(input: {
  width?: number;
  height?: number;
  background?: string;
  cameraPreset?: string;
}): { ok: true; options: NormalizedCaptureOptions } | { ok: false; code: string; message: string } {
  const width = input.width ?? 512;
  const height = input.height ?? 512;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 2048 || height > 2048) {
    return { ok: false, code: "malformed-request", message: "预览尺寸必须在 64..2048" };
  }
  const background = input.background ?? "transparent";
  if (background !== "transparent" && !/^#?[0-9a-fA-F]{3,8}$/.test(background)) {
    return { ok: false, code: "malformed-request", message: "背景必须是 transparent 或 #rrggbb" };
  }
  const cameraPreset = input.cameraPreset ?? "dimetric";
  // `dimetric`（静态几何检查）与 `initial`（动画节点保存的初始镜头）
  // （change: 2026-10-06-fix-model-media-references-and-animation-preview，D4）。
  if (cameraPreset !== "dimetric" && cameraPreset !== "initial") {
    return { ok: false, code: "malformed-request", message: "未知 camera preset" };
  }
  return { ok: true, options: { width, height, background, cameraPreset } };
}

export { PREFERRED_MODEL_SCRIPT_VERSION, MODEL_SCRIPT_V2_VERSION };
