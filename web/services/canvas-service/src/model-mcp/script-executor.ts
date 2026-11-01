/**
 * Canvas Service 侧 modelScript 执行适配器
 * （change: enhance-model-scene-authoring-api，任务 7.1 / 7.2 / design D10）。
 *
 * 读取权威 `modelScript` 与版本 descriptor，调用与 Frontend 共用的版本 dispatch，
 * 执行 validator 与确定性重跑，**只返回规范化 Scene IR**（绝不把原始脚本交给 renderer）。
 *
 * JS 执行边界：默认用进程内 `worker_threads` 承载实际执行，并禁止网络/文件系统/环境变量/
 * 随机源。`worker_threads` 只作为可终止调度单元，**不宣称为安全沙箱**；因此执行入口只注入
 * 版本化 `scene` API 与确定性 helper。
 *
 * change: 2026-10-22-remove-agent-execution-limits，任务 6.1 / design D6：原固定 2 秒 CPU
 * 时间、20 万字符源码与 8 MiB 输出额度已删除。脚本承载于可从外部终止的独立故障域：用户可随时
 * 停止，真实内存分配失败按实际资源故障报告，不影响宿主与其他任务。
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
  /**
   * 显式取消期限（毫秒，相对本次执行）。**不是应用执行额度**：缺省不设上限，合法长脚本继续
   * 执行；用户停止仍可外部终止（`signal`）。
   */
  timeoutMs?: number;
  /** 外部取消信号：用户停止时终止隔离执行并丢弃结果。 */
  signal?: AbortSignal;
  /** 测试可注入：同步执行（跳过 worker）。 */
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
  if (options.signal?.aborted) {
    return { ok: false, stage: "execute", code: "cancelled", message: "脚本执行已被用户停止" };
  }
  if (!isSupportedModelScriptVersion(version)) {
    return {
      ok: false,
      stage: "compile",
      code: "version-mismatch",
      message: `不支持的 modelScriptVersion ${String(version)}`
    };
  }

  const result = options.executeSync
    ? options.executeSync(source, version)
    : await runIsolated(source, version, options.timeoutMs, options.signal);
  return result;
}

/**
 * 在可终止的 worker 中执行。
 *
 * `timeoutMs` 只在调用方给了**显式**取消期限时启用；用户取消经 `signal` 从执行器外终止。
 * 两者都不是应用执行额度（任务 6.1）。
 */
function runIsolated(
  source: string,
  version: SupportedModelScriptVersion,
  timeoutMs: number | undefined,
  signal?: AbortSignal
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
    const finish = () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    const timer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          finish();
          void worker.terminate();
          resolve({ ok: false, stage: "execute", code: "model-script-timeout", message: "脚本执行超过了本次请求的显式截止时间" });
        }, timeoutMs)
      : undefined;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      finish();
      void worker.terminate();
      resolve({ ok: false, stage: "execute", code: "cancelled", message: "脚本执行已被用户停止" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    worker.on("message", (message: { kind?: string; result?: ExecuteSceneResult } | null) => {
      // Node --watch uses this channel for watch:import/watch:require notifications.
      if (!message || message.kind !== "model-script-result") return;
      if (settled) return;
      settled = true;
      finish();
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
      finish();
      resolve({ ok: false, stage: "execute", code: "runtime-error", message: error.message });
    });
    worker.on("exit", (code) => {
      if (settled) return;
      settled = true;
      finish();
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
