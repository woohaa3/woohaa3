import { getRuntimeComponentManager } from "@woohaa3/runtime-components";
import { createLeasedTransport } from "./managed-runtime.js";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { AgentEngineId } from "@woohaa3/contracts";
import type { AgentSdkTransport } from "./adapters/agent-sdk-adapter.js";
const require = createRequire(import.meta.url);

export function createFixedEngineRuntime(dirs: { configDir: string; workspaceDir: string }) {
  const transports = new Map<AgentEngineId, AgentSdkTransport>();
  async function resolve(engine: AgentEngineId): Promise<AgentSdkTransport> {
    if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("SDK Agent requires Node >=22");
    const manager = getRuntimeComponentManager();
    const component = engine === "codex-agent-sdk" ? "codex" : engine === "claude-agent-sdk" ? "claude" : engine === "dsh-agent-sdk" ? "dsh" : null;
    if (manager && component) {
      // Health/readiness may check availability, but must never initiate downloads.
      const state = await manager.inspect(component);
      if (state.status !== "ready") throw new Error(`请在设置 → 运行时组件中安装或选择 ${component}。${state.error ?? ""}`);
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
  return { resolve };
}
export type FixedEngineRuntime = ReturnType<typeof createFixedEngineRuntime>;
