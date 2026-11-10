/**
 * `woohaa3-executor` 的 local-agent 执行器模块。
 *
 * 由 daemon 通过 `--executor-module` 加载。它复用本扩展的 transports / discovery / codex-home，
 * 但**不**持有宿主连接服务、秘密或画布权限：
 * - 连接快照、工具 grant、画布读取和媒体字节都经每次回合的 host bridge 获取；
 * - 子进程由 daemon 的进程端口启动/回收；
 * - 只接受宿主已准备的 prepared turn（不重新构造业务提示词）。
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import net from "node:net";
import path from "node:path";
import type {
  AgentAdapterRunInput,
  AgentConnectionBinding,
  AgentConversationAdapterEvent,
  AgentEntryIntent,
  AgentImageInput,
  ConversationMessage,
  ServerCanvas
} from "@woohaa3/contracts";
import { AGENT_READ_ONLY_TOOLS } from "@woohaa3/contracts";
import type { ConnectionMetadataRecord, ConnectionService } from "@woohaa3/agent-connections";
import type { Executor, ExecutorRunContext } from "woohaa3-executor/protocol";
import { createExecutorClient } from "woohaa3-executor/client";
import { LOCAL_AGENT_ADAPTERS, readLocalAgentDeployment, type LocalAgentAdapterDescriptor } from "../shared.js";
import { defaultArgs } from "./index.js";
import { resolveLocalExecutable } from "./discovery.js";
import { prepareCodexConfigDir, resolveCodexHome } from "./codex-home.js";
import { createCodexAppServerTransport } from "./transports/codex-appserver-transport.js";
import { createOpenCodeTransport } from "./transports/opencode-transport.js";
import { createCodeBuddyTransport } from "./transports/codebuddy-transport.js";
import type { LocalAgentTransport } from "./transports/transport.js";
import { createLocalAgentConversationAdapter } from "./local-agent-connections.js";
import type { ProcessHandle, ProcessManager, StdioConnection } from "./process-manager.js";
import { loadMentionedReferenceImages } from "./reference-images.js";
import { redactEvent } from "@woohaa3/agent-connections";

export const LOCAL_AGENT_EXECUTOR_ID = "local-agent";

type LocalAgentBridge = { socketPath: string; token: string; workspaceKey: string };

type Payload = {
  owner: string;
  canvasId: string;
  conversationId: string;
  intent: AgentEntryIntent;
  connection: AgentConnectionBinding;
  /** 宿主在受理时冻结的连接快照（公共视图即可）。 */
  record: ConnectionMetadataRecord;
  history?: readonly ConversationMessage[];
  images?: readonly { bytes: string; contentType: string }[];
  mcpEndpoint?: { name: string; url: string };
  bridge?: LocalAgentBridge;
  candidate?: { images?: readonly { bytes: string; contentType: string }[]; outputSchema?: Record<string, unknown> };
};

function asPayload(input: { payload?: unknown }): Payload {
  const value = input.payload as Partial<Payload> | undefined;
  if (!value || typeof value !== "object" || !value.owner || !value.canvasId || !value.connection || !value.record) {
    throw new Error("local-agent executor 需要宿主 payload（owner/canvasId/connection/record）");
  }
  return value as Payload;
}

function connectStdio(stdioPath: string): Promise<StdioConnection> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(stdioPath);
    const listeners = new Set<(line: string) => void>();
    const stderrListeners = new Set<(line: string) => void>();
    let buffer = "";
    const consume = (chunk: Buffer | string) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) for (const listener of listeners) listener(line);
    };
    socket.once("connect", () => {
      socket.setEncoding("utf8");
      socket.on("data", consume);
      socket.on("error", (error) => { for (const listener of stderrListeners) listener(error.message); });
      resolve({
        send: (line) => socket.write(`${line}\n`),
        onLine: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        onStderr: (listener) => { stderrListeners.add(listener); return () => stderrListeners.delete(listener); },
        close: () => socket.destroy()
      });
    });
    socket.once("error", (error) => reject(error));
  });
}

function requireAdapter(payload: Payload): LocalAgentAdapterDescriptor {
  const adapter = LOCAL_AGENT_ADAPTERS.find((candidate) => candidate.adapterId === payload.connection.adapterId);
  if (!adapter) throw new Error(`未知本机 adapter：${payload.connection.adapterId}`);
  return adapter;
}

function binaryFor(adapter: LocalAgentAdapterDescriptor, env: NodeJS.ProcessEnv): { command: string; configured: string | null } {
  const deployment = readLocalAgentDeployment(env);
  switch (adapter.adapterId) {
    case "codex-appserver": return { command: "codex", configured: deployment.codexBin };
    case "opencode-server": return { command: "opencode", configured: deployment.opencodeBin };
    case "codebuddy-server": return { command: "codebuddy", configured: deployment.codebuddyBin };
    default: throw new Error(`未知本机 adapter：${adapter.adapterId}`);
  }
}

export type LocalAgentExecutorOptions = {
  /** 测试注入传输；生产缺省按 adapter 创建真实实现。 */
  transports?: Record<string, LocalAgentTransport>;
  /** 测试/部署注入可执行文件；缺省按环境/PATH 解析。 */
  executableFor?: (adapterId: string) => string | null;
  deployment?: Partial<ReturnType<typeof readLocalAgentDeployment>>;
};

function createProcessManager(
  payload: Payload,
  adapter: LocalAgentAdapterDescriptor,
  context: ExecutorRunContext,
  options: LocalAgentExecutorOptions
): { manager: ProcessManager; workDir: string; configDir: string } {
  const deployment = { ...readLocalAgentDeployment(process.env), ...(options.deployment ?? {}) };
  const workRoot = deployment.workDir ?? path.join(context.stateDir, "local-agent-work");
  const segment = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, process.platform === "win32" ? 32 : 64);
  const workDir = path.join(workRoot, segment(adapter.adapterId), segment(payload.owner), segment(payload.connection.connectionId));
  const configDir = path.join(workDir, "config");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const { command, configured } = binaryFor(adapter, process.env);
  const executable = options.executableFor?.(adapter.adapterId) ?? resolveLocalExecutable(configured, command, process.env);
  if (!executable) throw new Error(`未安装 ${adapter.label} 所需运行时（${command}）`);
  const handles = new Map<string, ProcessHandle>();
  const sourceCodexHome = adapter.adapterId === "codex-appserver" ? deployment.codexHome ?? resolveCodexHome(process.env) : null;
  const manager: ProcessManager = {
    probe: async () => ({ ok: true, version: "executor" }),
    ensure: async (input) => {
      const key = `${input.adapterId}\u0000${input.owner}\u0000${input.connectionId}`;
      const existing = handles.get(key);
      if (existing) return existing;
      if (sourceCodexHome) prepareCodexConfigDir(configDir, sourceCodexHome);
      const env: Record<string, string> = {
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("WOOHAA3_"))),
        PATH: process.env.PATH ?? "",
        ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        ...(adapter.adapterId === "codex-appserver" ? { HOME: configDir, XDG_CONFIG_HOME: configDir } : {})
      };
      const info = await context.processes.ensure({
        adapterId: adapter.adapterId,
        owner: input.owner,
        connectionId: input.connectionId,
        requestId: input.requestId,
        command: executable,
        args: [...defaultArgs(adapter.adapterId)],
        cwd: workDir,
        env,
        kind: adapter.transport === "stdio-jsonrpc" ? "stdio" : "http",
        portMin: deployment.portRange.min,
        portMax: deployment.portRange.max
      });
      const handle: ProcessHandle = {
        key,
        adapterId: adapter.adapterId,
        owner: input.owner,
        connectionId: input.connectionId,
        kind: adapter.transport === "stdio-jsonrpc" ? "stdio" : "http",
        loopbackUrl: info.loopbackUrl,
        ...(info.httpHeaders ? { httpHeaders: info.httpHeaders } : {}),
        pid: info.pid,
        workDir,
        configDir,
        startedAt: info.startedAt,
        ...(info.stdioPath ? { stdio: await connectStdio(info.stdioPath) } : {})
      };
      handles.set(key, handle);
      return handle;
    },
    get: (input) => handles.get(`${input.adapterId}\u0000${input.owner}\u0000${input.connectionId}`) ?? null,
    stop: async (input) => {
      const key = `${input.adapterId}\u0000${input.owner}\u0000${input.connectionId}`;
      handles.get(key)?.stdio?.close();
      handles.delete(key);
      await context.processes.stop(input);
    },
    stopAll: async () => {
      for (const key of [...handles.keys()]) {
        const handle = handles.get(key)!;
        handle.stdio?.close();
        await context.processes.stop({ adapterId: handle.adapterId, owner: handle.owner, connectionId: handle.connectionId });
      }
      handles.clear();
    },
    activeCount: () => handles.size
  };
  return { manager, workDir, configDir };
}

function connectionService(payload: Payload): ConnectionService {
  const record = payload.record;
  return {
    get: async (owner: string, connectionId: string) => owner === payload.owner && connectionId === record.connectionId ? record : null,
    list: async (owner: string) => owner === payload.owner ? [record] : [],
    readCredential: async () => null,
    credentialConfigured: async () => false,
    setStatus: async () => ({ ok: true, value: record }),
    resolveNativeBinding: async () => null,
    setNativeBinding: async () => ({ ok: true, value: record })
  } as unknown as ConnectionService;
}

export function createLocalAgentExecutor(options: LocalAgentExecutorOptions = {}): Executor {
  return {
    id: LOCAL_AGENT_EXECUTOR_ID,
    kind: "agent",
    async run(input, context) {
      const payload = asPayload(input);
      const adapter = requireAdapter(payload);
      const prepared = input.prepared;
      if (!prepared) return { status: "failed", error: { code: "role-not-found", message: "本回合没有宿主准备的角色请求" } };
      if (payload.connection.connectionId !== payload.record.connectionId || payload.connection.adapterId !== payload.record.adapterId) {
        return { status: "failed", error: { code: "connection-unavailable", message: "连接快照与冻结身份不一致" } };
      }
      const { manager } = createProcessManager(payload, adapter, context, options);
      const transport: LocalAgentTransport = options.transports?.[adapter.adapterId] ?? (adapter.adapterId === "codex-appserver"
        ? createCodexAppServerTransport({ protocolVersion: "2025-06-18", clientVersion: "0.1.0" })
        : adapter.adapterId === "opencode-server"
          ? createOpenCodeTransport()
          : createCodeBuddyTransport({ writeRotationVerified: true }));
      const bridge = payload.bridge ? createExecutorClient({ socketPath: payload.bridge.socketPath, token: payload.bridge.token, workspaceKey: payload.bridge.workspaceKey }) : null;
      const toolNames = input.kind === "agent" ? [...prepared.tools] : [];
      let toolToken: string | null = null;
      let successfulWrite = false;
      let toolFailure: string | undefined;
      try {
        if (toolNames.length > 0) {
          if (!bridge || !payload.mcpEndpoint) return { status: "failed", error: { code: "capability-unsupported", message: "宿主未提供本轮工具授权或 MCP 入口" } };
          const grant = await bridge.call<{ token: string }>("tools.issue", {
            delegation: { subject: payload.owner, authLevel: "authenticated" },
            workId: input.requestId,
            canvasId: payload.canvasId,
            nodeId: payload.intent.nodeId ?? "",
            mode: payload.intent.mode,
            ...(payload.intent.cameraId ? { cameraId: payload.intent.cameraId } : {}),
            ...(payload.intent.worldScope ? { worldScope: payload.intent.worldScope } : {}),
            tools: toolNames
          });
          toolToken = grant.token;
        }
        let mentionedImages: AgentImageInput[] | undefined;
        let mentionedNote = "";
        if (payload.intent.mode === "canvas-group" && payload.intent.nodeId && bridge) {
          try {
            const canvas = await bridge.call<ServerCanvas>("canvas.read", { subject: payload.owner, canvasId: payload.canvasId });
            const result = await loadMentionedReferenceImages(canvas, payload.intent.prompt, payload.intent.nodeId, async (storageKey) => {
              const media = await bridge.call<{ bytes: string; contentType: string }>("media.read", { storageKey, canvasId: payload.canvasId });
              return { bytes: Buffer.from(media.bytes, "base64"), contentType: media.contentType };
            });
            if (result) { mentionedImages = [...result.images]; mentionedNote = result.note; }
          } catch (error) {
            context.emit("stage", { stage: "reference-images-unavailable", detail: error instanceof Error ? error.message : String(error) });
          }
        }
        const candidate = payload.candidate
          ? {
              images: (payload.candidate.images ?? []).map((image) => ({ bytes: Buffer.from(image.bytes, "base64"), contentType: image.contentType })),
              outputSchema: payload.candidate.outputSchema ?? (prepared.output.kind === "candidate" ? prepared.output.schema : {})
            }
          : undefined;
        const adapterInput: AgentAdapterRunInput = {
          owner: payload.owner,
          canvasId: payload.canvasId,
          conversationId: payload.conversationId,
          turnId: input.turnId,
          requestId: input.requestId,
          intent: payload.intent,
          connection: payload.connection,
          prepared,
          history: [...(payload.history ?? [])],
          ...(candidate ? { candidate } : {}),
          ...(payload.images ? { images: payload.images.map((image) => ({ bytes: Buffer.from(image.bytes, "base64"), contentType: image.contentType })) } : {}),
          signal: context.signal,
          emit: (event: AgentConversationAdapterEvent) => {
            if (event.type === "tool-completed" && toolNames.includes(event.tool)) {
              if (event.ok === false) toolFailure = event.summary ?? "工具执行失败";
              if (event.ok === true && !AGENT_READ_ONLY_TOOLS.includes(event.tool)) successfulWrite = true;
            }
            context.emit(event.type, event);
          }
        };
        const instance = createLocalAgentConversationAdapter(adapter, {
          service: connectionService(payload),
          processManager: manager,
          transports: { [adapter.adapterId]: transport },
          argsFor: defaultArgs,
          onGeneratedImage: (image) => context.emit("generated-image", image),
          ...(payload.mcpEndpoint ? { mcpEndpoint: payload.mcpEndpoint } : {}),
          ...(bridge ? { tools: { issue: async () => ({ token: toolToken ?? "", canvasIds: [payload.canvasId], nodeIds: [], tools: toolNames, workId: input.requestId }), revoke: async () => undefined, authorize: () => ({ ok: true }) } } : {}),
          resolveMentionedImages: async () => mentionedImages ? { images: mentionedImages, note: mentionedNote } : undefined,
          logger: (event) => context.emit("log", redactEvent(event))
        });
        const outcome = await instance.run(adapterInput);
        if (outcome.status === "succeeded" && payload.intent.action !== "discuss" && toolNames.length > 0 && !successfulWrite) {
          return { status: "failed", error: { code: "canvas-not-modified", message: toolFailure ?? "推理结束，但没有成功的画布写入回执" } };
        }
        return outcome.status === "succeeded"
          ? { status: "succeeded", result: { outcome } }
          : outcome.status === "cancelled"
            ? { status: "cancelled", error: outcome.error ?? { code: "cancelled", message: "已取消" }, result: { outcome } }
            : { status: "failed", error: outcome.error ?? { code: "agent-failed", message: "本机执行失败" }, result: { outcome } };
      } catch (error) {
        return { status: "failed", error: { code: "local-agent-executor-failed", message: error instanceof Error ? error.message : String(error) } };
      } finally {
        if (toolToken) await bridge?.call("tools.revoke", { workId: input.requestId, subject: payload.owner }).catch(() => undefined);
      }
    }
  };
}

/** daemon `--executor-module` 约定入口。 */
export const createExecutor = createLocalAgentExecutor;
