import { getRuntimeComponentManager } from "@woohaa3/runtime-components";
import { createLeasedTransport } from "./managed-runtime.js";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { AgentEngineId } from "@woohaa3/contracts";
import type { AgentSdkTransport } from "./adapters/agent-sdk-adapter.js";
import { componentForEngine, createFixedEnginePreparation, type EnginePreparation, type FixedEnginePreparation } from "./runtime-preparation.js";
const require = createRequire(import.meta.url);

export function createFixedEngineRuntime(dirs: { configDir: string; workspaceDir: string }, options: { preparation?: FixedEnginePreparation } = {}) {
  const transports = new Map<AgentEngineId, AgentSdkTransport>();
  const preparation = options.preparation ?? createFixedEnginePreparation();
  /**
   * 首次执行前准备固定引擎；失败携带真实来源与重试原因，绝不降级成普通 HTTP 或换引擎。
   * 开发桌面没有 runtime manager 时返回随仓依赖（不下载、不写用户缓存）。
   */
  async function prepare(engine: AgentEngineId): Promise<EnginePreparation> {
    if (Number(process.versions.node.split(".")[0]) < 22) return { engine, component: componentForEngine(engine), state: "unavailable", code: "NODE_TOO_OLD", reason: "SDK Agent requires Node >=22" };
    return preparation.prepare(engine);
  }
  async function resolve(engine: AgentEngineId): Promise<AgentSdkTransport> {
    const manager = getRuntimeComponentManager();
    const component = componentForEngine(engine);
    if (manager && component) {
      const prepared = await prepare(engine);
      if (prepared.state !== "ready") throw Object.assign(new Error(prepared.reason ?? "运行时尚未就绪"), { code: "runtime-missing" });
      const cached = transports.get(engine);
      if (cached) return cached;
      const managed = createLeasedTransport(manager, component, async (entry) => {
        switch (component) {
          case "codex": return (await import("./adapters/codex-transport.js")).createCodexTransport({ ...dirs, executablePath: entry });
          case "claude": return (await import("./adapters/claude-transport.js")).createClaudeTransport({ ...dirs, executablePath: entry });
          default: return (await import("./adapters/dsh-transport.js")).createDshTransport({ ...dirs, runtimeEntry: entry });
        }
      });
      transports.set(engine, managed);
      return managed;
    }
    const existing = transports.get(engine);
    if (existing) return existing;
    let transport: AgentSdkTransport;
    switch (engine) {
      case "codex-agent-sdk": {
        const { Codex } = await import("@openai/codex-sdk");
        // Constructor resolves the packaged platform CLI; never searches global PATH.
        new Codex({ apiKey: "runtime-probe", env: {} });
        transport = (await import("./adapters/codex-transport.js")).createCodexTransport(dirs);
        break;
      }
      case "claude-agent-sdk": {
        await import("@anthropic-ai/claude-agent-sdk");
        const sdkRequire = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
        const musl = process.platform === "linux" && !(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime;
        const platform = `${process.platform}-${process.arch}${musl ? "-musl" : ""}`;
        const nativePackage = sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${platform}/package.json`);
        const executable = path.join(path.dirname(nativePackage), process.platform === "win32" ? "claude.exe" : "claude");
        await access(executable, constants.X_OK);
        transport = (await import("./adapters/claude-transport.js")).createClaudeTransport({ ...dirs, executablePath: executable });
        break;
      }
      case "dsh-agent-sdk": {
        const module = await import("./adapters/dsh-transport.js");
        await access(module.dshRuntimePath(), constants.R_OK);
        transport = module.createDshTransport(dirs);
        break;
      }
      case "gemini-agent-adk":
        transport = (await import("./adapters/gemini-transport.js")).createGeminiTransport();
    }
    transports.set(engine, transport);
    return transport;
  }
  return { resolve, prepare };
}
export type FixedEngineRuntime = ReturnType<typeof createFixedEngineRuntime>;
