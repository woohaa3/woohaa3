/**
 * local-agent 后端入口
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 3.1/3.2/3.3/4.1/6.1/6.3 / design D1/D9）。
 *
 * 经统一后端宿主注册：
 * - 连接发现 capability `agent-connection-provider:local-agent`；
 * - 会话 adapter capability（每个 adapterId 一个）；
 * - 受控 HTTP handler `/api/local-agent/*`（连接 CRUD、登录指引、探测）；
 * - 可回收资源（dispose 停止**自有**专用进程；不删除凭据/历史，不停其他扩展或用户进程）。
 *
 * **扫描/加载本模块不创建任何进程**（design D1）：只有显式执行才 `ensure`。
 * 是否启用本机来源由站点插件开关决定，扩展激活本身不启动任何工具进程。
 */
import type {
  ApplicationBackendExtensionDefinition,
  ApplicationExtensionRequestContext,
  ApplicationExtensionRawRequest,
  ApplicationExtensionRawResponse,
  AgentConnectionProvider,
} from "@woohaa3/contracts";
import {
  agentConnectionProviderCapabilityId,
  agentConversationAdapterCapabilityId,
  filmSetConversionCapabilityId,
} from "@woohaa3/contracts";
import {
  createAssistantFilmSetConversionProvider,
  createConnectionProvider,
  createConnectionService,
  redactEvent,
} from "@woohaa3/agent-connections";
import {
  LOCAL_AGENT_ADAPTERS,
  LOCAL_AGENT_PLUGIN_ID,
  readLocalAgentDeployment,
  type LocalAgentDeployment,
} from "../shared.js";
import { createProcessManager } from "./process-manager.js";
import { prepareCodexConfigDir, resolveCodexHome } from "./codex-home.js";
import { createCodexAppServerTransport } from "./transports/codex-appserver-transport.js";
import { createOpenCodeTransport } from "./transports/opencode-transport.js";
import { createCodeBuddyTransport } from "./transports/codebuddy-transport.js";
import type { LocalAgentTransport } from "./transports/transport.js";
import {
  createLocalAgentDescriptors,
  createLocalAgentConversationAdapter,
  type LocalAgentRuntimeOptions,
} from "./local-agent-connections.js";
import { createLocalAgentHandler } from "./handler.js";
import { loadMentionedReferenceImages } from "./reference-images.js";
import { getRuntimeComponentManager } from "@woohaa3/runtime-components";
import { createRuntimeExecutableResolver } from "./runtime-executable.js";
import { resolveLocalExecutable } from "./discovery.js";
import os from "node:os";
import path from "node:path";

export type LocalAgentExtensionOptions = {
  /** 部署 env（缺省读 process.env；宿主组合注入自身生效 env）。 */
  env?: Record<string, string | undefined>;
  deployment?: Partial<LocalAgentDeployment>;
  /** 测试注入传输（避免真实进程）。 */
  transports?: Record<string, LocalAgentTransport>;
  /** 受控 MCP 工具 endpoint（回环；工具执行时注入）。 */
  mcpEndpoint?: { name: string; url: string };
  /** Codex App Server 协议版本（与安装 CLI 对应）。 */
  codexProtocolVersion?: string;
  /** 是否已核验 CodeBuddy 写工具轮换（默认 true，允许写入）。 */
  codebuddyWriteRotationVerified?: boolean;
};

/** 各 adapter 的专用进程启动参数（不含任意 shell 串）。 */
export function defaultArgs(adapterId: string): readonly string[] {
  switch (adapterId) {
    case "codex-appserver":
      return ["app-server", "--stdio"];
    case "opencode-server":
      return ["serve", "--hostname", "127.0.0.1"];
    case "codebuddy-server":
      return ["--serve", "--host", "127.0.0.1", "--auth", "none", "--strict-mcp-config"];
    default:
      return [];
  }
}

export function createLocalAgentExtension(
  options: LocalAgentExtensionOptions = {},
): ApplicationBackendExtensionDefinition {
  return {
    extensionId: LOCAL_AGENT_PLUGIN_ID,
    activate: (host) => {
      const env = options.env ?? (process.env as Record<string, string | undefined>);
      const deployment: LocalAgentDeployment = {
        ...readLocalAgentDeployment(env),
        ...options.deployment,
      };
      // 复用后端机器现有 Codex 配置/登录：每个连接拿到只读符号链接，Codex 会话仍写专用目录。
      // 未显式配置 WOOHAA3_LOCAL_AGENT_CODEX_HOME 时按 CODEX_HOME → $HOME/.codex 解析。
      const sourceCodexHome = deployment.codexHome ?? resolveCodexHome(env);
      const documents = host.services.documents;
      if (!documents) {
        host.logger({
          event: "local-agent-disabled",
          reason: "宿主未配置 documents 存储",
        });
        return;
      }
      const service = createConnectionService({
        documents,
        ...(host.services.secrets ? { secrets: host.services.secrets } : {}),
      });

      // 停用后拒绝新回合（dispose 期间置 false）；已接受回合由宿主结算，专用进程随后回收。
      let admitted = true;

      const localExecutableFor = (adapterId: string): string | null => {
        const command =
          adapterId === "codex-appserver"
            ? "codex"
            : adapterId === "opencode-server"
              ? "opencode"
              : adapterId === "codebuddy-server"
                ? "codebuddy"
                : null;
        if (!command) return null;
        const configured =
          adapterId === "codex-appserver"
            ? deployment.codexBin
            : adapterId === "opencode-server"
              ? deployment.opencodeBin
              : deployment.codebuddyBin;
        return resolveLocalExecutable(configured, command, env);
      };

      const executables = createRuntimeExecutableResolver({ local: localExecutableFor, getManager: () => deployment.codexBin ? undefined : getRuntimeComponentManager() });
      const executableFor = executables.executableFor;
      const processManager = createProcessManager({
        acquireExecutable: executables.acquire,
        workDirRoot:
          deployment.workDir ?? path.join(os.tmpdir(), "woohaa3-local-agent"),
        portRange: deployment.portRange,
        executableFor,
        ...((env.WOOHAA3_AGENT_RUNTIME_SOCKET && env.WOOHAA3_AGENT_RUNTIME_TOKEN && env.WOOHAA3_AGENT_WORKSPACE_KEY)
          ? { supervisor: {
            socketPath: env.WOOHAA3_AGENT_RUNTIME_SOCKET,
            token: env.WOOHAA3_AGENT_RUNTIME_TOKEN,
            workspaceKey: env.WOOHAA3_AGENT_WORKSPACE_KEY,
            portRange: deployment.portRange,
          } }
          : {}),
        prepareConfigDir: ({ adapterId, configDir }) => {
          if (adapterId !== "codex-appserver" || !sourceCodexHome) return;
          const prepared = prepareCodexConfigDir(configDir, sourceCodexHome);
          if (prepared.linked.length > 0) {
            host.logger({
              event: "local-agent-codex-config-linked",
              sourceHome: sourceCodexHome,
              files: prepared.linked,
            });
          } else if (!prepared.sourceFound) {
            host.logger({
              event: "local-agent-codex-home-missing",
              sourceHome: sourceCodexHome,
            });
          }
        },
        logger: (event) => host.logger(redactEvent(event)),
      });

      // 传输：未注入时用真实实现（stdio 由 process-manager 句柄提供；HTTP 只连回环）。
      const transports: Record<string, LocalAgentTransport> =
        options.transports ?? {
          "codex-appserver": createCodexAppServerTransport({
            protocolVersion: options.codexProtocolVersion ?? "2025-06-18",
            clientVersion: "0.1.0",
            logger: (event) => host.logger(redactEvent(event)),
          }),
          "opencode-server": createOpenCodeTransport({
            logger: (event) => host.logger(redactEvent(event)),
          }),
          "codebuddy-server": createCodeBuddyTransport({
            writeRotationVerified:
              options.codebuddyWriteRotationVerified ?? true,
            logger: (event) => host.logger(redactEvent(event)),
          }),
        };

      const runtimeOptions: LocalAgentRuntimeOptions = {
        service,
        // 停用后拒绝新回合（dispose 期间置 false）；是否可用由站点插件开关决定。
        admission: () => admitted,
        processManager,
        transports,
        argsFor: defaultArgs,
        ...(options.mcpEndpoint ? { mcpEndpoint: options.mcpEndpoint } : {}),
        ...(host.services.authoring?.tools
          ? { tools: host.services.authoring.tools }
          : {}),
        resolveMentionedImages: async ({ owner, canvasId, rootGroupId, prompt }) => {
          const readCanvas = host.services.extensionNodes?.read;
          const readMedia = host.services.media.resources?.read;
          if (!readCanvas || !readMedia) return undefined;
          const canvas = await readCanvas({ subject: owner, canvasId, permission: "read" });
          return loadMentionedReferenceImages(canvas, prompt, rootGroupId, (storageKey) => readMedia(storageKey, canvasId));
        },
        logger: (event) => host.logger(redactEvent(event)),
      };

      const provider: AgentConnectionProvider = createConnectionProvider({
        id: LOCAL_AGENT_PLUGIN_ID,
        extensionId: LOCAL_AGENT_PLUGIN_ID,
        service,
        descriptors: createLocalAgentDescriptors(),
      });
      host.registerCapability({
        id: agentConnectionProviderCapabilityId(LOCAL_AGENT_PLUGIN_ID),
        value: provider,
      });

      for (const adapter of LOCAL_AGENT_ADAPTERS) {
        const instance = createLocalAgentConversationAdapter(adapter, runtimeOptions);
        host.registerCapability({ id: filmSetConversionCapabilityId(adapter.adapterId), value: createAssistantFilmSetConversionProvider(instance) });
        host.registerCapability({
          id: agentConversationAdapterCapabilityId(adapter.adapterId),
          value: instance,
        });
      }

      const handler = createLocalAgentHandler({
        service,
        transports,
        argsFor: defaultArgs,
        executableFor,
        processManager,
      });
      const register = (
        route: string,
        method: "GET" | "POST",
        purpose: "read" | "auth-transaction" | "work-control",
      ) => {
        host.registerRawHttpHandler?.({
          route,
          method,
          auth: "public",
          purpose,
          handle: async (
            req: ApplicationExtensionRawRequest,
            res: ApplicationExtensionRawResponse,
            context: ApplicationExtensionRequestContext,
          ) => {
            await handler.handle(req, res, context);
          },
        });
      };
      // route 相对 publicPath：扩展名前缀由宿主按 extensionId 自动添加，插件不要再写一遍。
      register("connections", "GET", "read");
      register("connections", "POST", "auth-transaction");
      register("connections/*", "POST", "auth-transaction");
      register("check", "POST", "read");

      host.logger({
        event: "local-agent-activated",
        adapters: LOCAL_AGENT_ADAPTERS.length,
      });

      return {
        dispose: async () => {
          // Supervisor 模式下 backend reload 只断开 client，CLI 进程由稳定宿主持有；
          // 没有 Supervisor 时保留旧的进程内回收语义。
          admitted = false;
          if (!env.WOOHAA3_AGENT_RUNTIME_SOCKET) await processManager.stopAll();
          host.logger({ event: "local-agent-disposed" });
        },
      };
    },
  };
}
