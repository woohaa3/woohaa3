/**
 * Canvas Script 受限执行：引擎宿主与 QuickJS Worker
 * （change: 2026-10-13-add-canvas-script-authoring，任务 2.1 / 2.2 / 2.4 / 2.5 / design D4）。
 *
 * 隔离模型（如实描述，不夸大）：
 * - **Worker** 只是调度/终止单元：它让宿主能在 CPU 卡死时 `terminate()`，**不是**安全边界。
 * - **QuickJS 独立 realm** 是 JS 宿主隔离边界：每次请求新建 runtime + context，跨边界只传
 *   严格 JSON（operation 数组与阶段化错误），绝不传宿主函数或对象原型。
 * - 语言入口限制（prelude 删除/置空动态代码与宿主访问）与独立 realm 一起落实限制。二者
 *   都不是「绝对安全」的证明，因此本模块只声称「受限且有预算」。
 *
 * 资源释放：worker 先 postMessage 结果，再 best-effort `dispose()` runtime/context 并
 * `parentPort.close()`；宿主无论成功、启动失败、异常还是超时都 `terminate()` worker。
 * 已知限制：被中断的崩坏脚本可能在 `dispose()` 触发 QuickJS 断言；worker 内已 try/catch，
 * 宿主仍会 terminate，不影响其他请求（见 notes/verification.md 的记录）。
 */
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CANVAS_SCRIPT_LIMITS, type CanvasScriptError } from "@woohaa3/contracts";
import { CANVAS_SCRIPT_READ_EXPRESSION, canvasScriptPrelude } from "./prelude.js";

/** 一次受限执行的输入。 */
export type CanvasScriptExecutionInput = {
  /** 用户源码（已通过严格 codec；本层再按 UTF-8 字节数兜底）。 */
  source: string;
  /** 支持的语义种类（进入 prelude，保证能力声明与执行一致）。 */
  nodeKinds: readonly string[];
  /** prompt 字符上限（与任务协议一致）。 */
  promptMaxChars: number;
  /** 节点位置坐标绝对值上限。 */
  positionAbsMax: number;
  /** 本次执行（含双跑共享）的总 deadline（epoch 毫秒）。 */
  deadlineMs: number;
  heapLimitBytes?: number;
  maxOperations?: number;
  maxApiCalls?: number;
};

/** 单个 realm 内的记录结果（严格 JSON）。 */
export type CanvasScriptRealmResult = {
  ops: unknown[];
  fatal: {
    code: string;
    message: string;
    api?: string;
    field?: string;
    operationIndex?: number;
  } | null;
  apiCalls: number;
};

export type CanvasScriptEngineOutcome =
  | { ok: true; operations: unknown[]; apiCalls: number }
  | { ok: false; error: CanvasScriptError };

export type CanvasScriptEngineOptions = {
  /** 允许进程内直接执行（测试用）。生产装配不得开启。 */
  executeInline?: (input: CanvasScriptExecutionInput) => CanvasScriptRealmResult;
  /** QuickJS 调用栈上限（字节）。 */
  stackLimitBytes?: number;
};

const REALM_FILENAME = "canvas-script.js";

/** 解析 `quickjs-emscripten` 的绝对 URL（eval worker 落在进程 cwd，不能靠包名解析）。 */
export function quickJsModuleUrl(): string {
  const meta = import.meta as ImportMeta;
  if (typeof meta.resolve === "function") return meta.resolve("quickjs-emscripten");
  let dir = fileURLToPath(new URL(".", meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = path.join(dir, "node_modules", "quickjs-emscripten", "dist", "index.js");
    if (existsSync(candidate)) return pathToFileURL(candidate).href;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("找不到 quickjs-emscripten");
}

/**
 * 受限执行器：相同输入在**两个独立 realm** 内各跑一次并比较规范化 operations。
 *
 * 不一致返回 `non-deterministic`；两次执行共享同一个 `deadlineMs`（design D4）。
 */
export class CanvasScriptEngine {
  private readonly options: CanvasScriptEngineOptions;

  constructor(options: CanvasScriptEngineOptions = {}) {
    this.options = options;
  }

  async execute(input: CanvasScriptExecutionInput): Promise<CanvasScriptEngineOutcome> {
    const first = await this.runRealm(input);
    if (!first.ok) return first;
    const second = await this.runRealm(input);
    if (!second.ok) return second;

    if (canonical(first.value.ops) !== canonical(second.value.ops)) {
      return {
        ok: false,
        error: {
          code: "non-deterministic",
          stage: "record",
          message: "相同脚本在独立 realm 下生成不一致的计划",
          retryable: false,
          suggestion: "移除依赖外部状态或顺序不确定的构造后重试"
        }
      };
    }
    return { ok: true, operations: first.value.ops, apiCalls: first.value.apiCalls };
  }

  private async runRealm(input: CanvasScriptExecutionInput): Promise<
    { ok: true; value: CanvasScriptRealmResult } | { ok: false; error: CanvasScriptError }
  > {
    const preludeSource = canvasScriptPrelude({
      nodeKinds: input.nodeKinds,
      maxOperations: input.maxOperations ?? CANVAS_SCRIPT_LIMITS.maxOperations,
      maxApiCalls: input.maxApiCalls ?? CANVAS_SCRIPT_LIMITS.maxApiCalls,
      promptMaxChars: input.promptMaxChars,
      textMaxChars: input.promptMaxChars,
      positionAbsMax: input.positionAbsMax
    });

    if (this.options.executeInline) {
      try {
        return { ok: true, value: this.options.executeInline(input) };
      } catch (error) {
        return { ok: false, error: runtimeError(error) };
      }
    }

    return runRealmInWorker(
      {
        preludeSource,
        readExpression: CANVAS_SCRIPT_READ_EXPRESSION,
        source: input.source,
        deadlineMs: input.deadlineMs,
        heapLimitBytes: input.heapLimitBytes ?? CANVAS_SCRIPT_LIMITS.heapLimitBytes,
        stackLimitBytes: this.options.stackLimitBytes ?? CANVAS_SCRIPT_LIMITS.stackLimitBytes
      },
      quickJsModuleUrl()
    );
  }
}

/** 规范化 operation JSON（键排序、数组顺序保留），用于双跑比较。 */
export function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [key, nested] of entries) out[key] = sortDeep(nested);
    return out;
  }
  return value;
}

function runtimeError(error: unknown): CanvasScriptError {
  return {
    code: "script-runtime-error",
    stage: "record",
    message: error instanceof Error ? error.message : String(error),
    retryable: false
  };
}

type WorkerRequest = {
  preludeSource: string;
  readExpression: string;
  source: string;
  deadlineMs: number;
  heapLimitBytes: number;
  stackLimitBytes: number;
};

/** worker → 宿主的结果封套。 */
type WorkerResponse =
  | { kind: "ok"; payload: CanvasScriptRealmResult }
  | { kind: "limit"; code: "script-memory-limit" | "script-timeout" }
  | {
      kind: "error";
      error: {
        stage: "compile" | "record";
        code: string;
        message: string;
        api?: string;
        field?: string;
        operationIndex?: number;
        line?: number;
        column?: number;
      };
    };

function runRealmInWorker(
  request: WorkerRequest,
  quickjsUrl: string
): Promise<{ ok: true; value: CanvasScriptRealmResult } | { ok: false; error: CanvasScriptError }> {
  return new Promise((resolve) => {
    let settled = false;
    const remaining = Math.max(1, request.deadlineMs - Date.now());
    // Worker 内的 CPU interrupt 是主终止路径；这个定时器是更外层的兜底
    // （interrupt 无法打断 native 循环/分配）。
    const hardTimeout = setTimeout(() => settle({ ok: false, error: timeoutError() }), remaining + 250);
    const worker = new Worker(WORKER_BOOTSTRAP, {
      eval: true,
      workerData: { qjsUrl: quickjsUrl },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 }
    });

    function settle(outcome: { ok: true; value: CanvasScriptRealmResult } | { ok: false; error: CanvasScriptError }): void {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      void worker.terminate();
      resolve(outcome);
    }

    worker.on("message", (message: WorkerResponse) => {
      // Node --watch also sends watch:import/watch:require over this channel.
      // Only our result envelopes may settle a realm; late messages are ignored.
      if (settled || !message || typeof message !== "object") return;
      if (message.kind !== "ok" && message.kind !== "limit" && message.kind !== "error") return;
      if (message.kind === "error" && (!message.error || typeof message.error.code !== "string"
        || typeof message.error.message !== "string")) {
        return settle({ ok: false, error: runtimeError(new Error("隔离执行单元返回了无效错误回执")) });
      }
      if (message.kind === "ok") return settle({ ok: true, value: message.payload });
      if (message.kind === "limit") return settle({ ok: false, error: limitError(message.code) });
      return settle({ ok: false, error: mapScriptError(message.error) });
    });
    worker.on("error", (error) => settle({ ok: false, error: runtimeError(error) }));
    worker.on("exit", (code) => {
      if (code !== 0) {
        settle({
          ok: false,
          error: { code: "script-runtime-error", stage: "record", message: `隔离执行单元异常退出 ${code}`, retryable: true }
        });
      }
    });
    worker.postMessage(request);
  });
}

function timeoutError(): CanvasScriptError {
  return {
    code: "script-timeout",
    stage: "record",
    message: `脚本执行超过 ${CANVAS_SCRIPT_LIMITS.executionTimeoutMs} 毫秒预算`,
    retryable: false,
    suggestion: "减少循环规模或拆分批次"
  };
}

function limitError(code: "script-memory-limit" | "script-timeout"): CanvasScriptError {
  return code === "script-memory-limit"
    ? { code, stage: "record", message: "脚本超过执行内存预算", retryable: false, suggestion: "减少一次性构造的数据量" }
    : timeoutError();
}

/** 把 worker 报告的脚本错误映射为带定位的稳定错误（不回显源码）。 */
function mapScriptError(error: {
  stage: "compile" | "record";
  code: string;
  message: string;
  api?: string;
  field?: string;
  operationIndex?: number;
  line?: number;
  column?: number;
}): CanvasScriptError {
  const out: CanvasScriptError = {
    code: error.code,
    stage: error.stage,
    message: error.message.split("\n")[0]!.slice(0, 300),
    retryable: false
  };
  if (error.api !== undefined) out.api = error.api;
  if (error.field !== undefined) out.field = error.field;
  if (error.operationIndex !== undefined) out.operationIndex = error.operationIndex;
  if (error.line !== undefined) out.line = error.line;
  if (error.column !== undefined) out.column = error.column;
  if (error.stage === "compile") out.suggestion = "修正脚本语法后使用合法请求重试";
  return out;
}

/**
 * Worker 引导（`eval: true` + `type: "module"`）。
 *
 * 结果先 postMessage 再 best-effort 释放：即使释放步骤触发 QuickJS 断言，宿主也已拿到结果。
 */
const WORKER_BOOTSTRAP = `
import { parentPort, workerData } from "node:worker_threads";
const { getQuickJS, DefaultIntrinsics } = await import(workerData.qjsUrl);

function stackLine(stack) {
  if (typeof stack !== "string") return undefined;
  const match = /canvas-script\\.js:(\\d+)/.exec(stack);
  return match ? Number(match[1]) : undefined;
}

parentPort.once("message", async (request) => {
  let out;
  let QuickJS;
  try {
    QuickJS = await getQuickJS();
  } catch (error) {
    parentPort.postMessage({ kind: "error", error: { stage: "record", code: "script-runtime-error", message: String((error && error.message) || error) } });
    return;
  }

  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(request.heapLimitBytes);
  runtime.setMaxStackSize(request.stackLimitBytes);
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    if (Date.now() > request.deadlineMs) { interrupted = true; return true; }
    return false;
  });
  const ctx = runtime.newContext({ intrinsics: { ...DefaultIntrinsics, Date: false, Promise: false } });

  // 读取记录状态（严格 JSON）：用于把 fatal 映射回稳定 code/api/field/operationIndex。
  function readState() {
    const read = ctx.evalCode(request.readExpression);
    if (read.error) { const d = ctx.dump(read.error); read.error.dispose(); return null; }
    const json = ctx.dump(read.value);
    read.value.dispose();
    try { return JSON.parse(json); } catch (error) { return null; }
  }

  try {
    const prelude = ctx.evalCode(request.preludeSource, "canvas-prelude.js");
    if (prelude.error) {
      const d = ctx.dump(prelude.error);
      prelude.error.dispose();
      out = { kind: "error", error: { stage: "record", code: "script-unavailable", message: "受限执行器初始化失败：" + String((d && d.message) || "") } };
    } else {
      prelude.value.dispose();
      const result = ctx.evalCode(request.source, "canvas-script.js");
      if (result.error) {
        const dumped = ctx.dump(result.error);
        result.error.dispose();
        const name = String((dumped && dumped.name) || "Error");
        const message = String((dumped && dumped.message) || "脚本执行失败");
        const state = readState();
        const fatal = state && state.fatal;
        if (fatal && typeof fatal.code === "string") {
          out = { kind: "error", error: {
            stage: "record", code: fatal.code, message: fatal.message,
            api: fatal.api, field: fatal.field, operationIndex: fatal.operationIndex,
            line: stackLine(dumped && dumped.stack)
          } };
        } else if (name === "SyntaxError") {
          out = { kind: "error", error: { stage: "compile", code: "script-runtime-error", message: message, line: typeof dumped.lineNumber === "number" ? dumped.lineNumber : undefined } };
        } else if (name === "InternalError" && /out of memory/i.test(message)) {
          out = { kind: "limit", code: "script-memory-limit" };
        } else if (name === "InternalError" && /interrupt/i.test(message)) {
          out = { kind: "limit", code: "script-timeout" };
        } else {
          out = { kind: "error", error: { stage: "record", code: "script-runtime-error", message: message, line: stackLine(dumped && dumped.stack) } };
        }
      } else {
        result.value.dispose();
        const state = readState();
        if (!state) out = { kind: "error", error: { stage: "record", code: "script-runtime-error", message: "无法读取记录结果" } };
        else if (interrupted) out = { kind: "limit", code: "script-timeout" };
        else out = { kind: "ok", payload: state };
      }
    }
  } catch (error) {
    const message = String((error && error.message) || error);
    if (/out of memory/i.test(message)) out = { kind: "limit", code: "script-memory-limit" };
    else if (/interrupt/i.test(message) || interrupted) out = { kind: "limit", code: "script-timeout" };
    else out = { kind: "error", error: { stage: "record", code: "script-runtime-error", message: message, line: stackLine(error && error.stack) } };
  }

  parentPort.postMessage(out);
  try { ctx.dispose(); } catch (error) {}
  try { runtime.dispose(); } catch (error) {}
  parentPort.close();
});
`;

export { REALM_FILENAME };
