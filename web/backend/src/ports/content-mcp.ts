/**
 * 内容 owner MCP 工具桥（change: 2026-10-28-generic-extension-content-ownership，任务 5.2）。
 *
 * 目录直接来自 `ContentContributionRegistry`；停用/重载即从目录消失。工具名、参数、权限与
 * handler 都由 owner 声明，宿主只做认证、授权与路由/处理器转发，不认识业务名称。
 */
import type { ApplicationExtensionMcpTool, CanvasAuthority, ContentContributionResolver, ContentMcpToolContext } from "@woohaa3/contracts";
import { dispatchContentRoute } from "@woohaa3/contracts";
import type { ModelMcpHttpOptions } from "@woohaa3/mcp-service";
import type { ToolGrantRegistry } from "./authoring-adapters.js";

type ToolEntry = { readonly extensionId: string; readonly tool: NonNullable<ContentContributionResolver["implementations"] extends never ? never : import("@woohaa3/contracts").ContentMcpTool> };

export function createContentMcpBridge(options: {
  content: () => ContentContributionResolver;
  grants: ToolGrantRegistry;
  developmentPrincipal?: string;
  loopbackDevelopment: boolean;
  authorizeCanvas?: (input: { subject: string; canvasId: string; permission: "read" | "write" }) => Promise<boolean>;
  authority?: {
    resolveRoom: (canvasId: string) => Promise<CanvasAuthority | null>;
    readNode?: ContentMcpToolContext["readNode"];
    applyCommands?: ContentMcpToolContext["applyCommands"];
    recording?: ContentMcpToolContext["recording"];
    themeBackdrop?: ContentMcpToolContext["themeBackdrop"];
  };
}): NonNullable<ModelMcpHttpOptions["extensionTools"]> {
  const entries = (): ToolEntry[] => options.content().implementations().flatMap((contribution) =>
    (contribution.mcpTools ?? []).map((tool) => ({ extensionId: contribution.extensionId, tool }))
  );
  return {
    list: (): readonly ApplicationExtensionMcpTool[] => entries().map(({ extensionId, tool }) => ({
      name: tool.name,
      description: tool.description,
      route: `content/${extensionId}/${tool.route?.path.join("/") ?? tool.name}`,
      permission: tool.permission ?? "write",
      ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      parameters: tool.parameters ?? {}
    })),
    async call(input) {
      const entry = entries().find(({ tool }) => tool.name === input.name);
      if (!entry) return { ok: false, code: "not-found", message: "工具未注册" };
      let subject: string | undefined;
      if (input.bearerToken) {
        const args = input.args as { canvasId?: unknown; nodeId?: unknown; clipId?: unknown; itemId?: unknown; cameraId?: unknown };
        const decision = options.grants.authorize({
          token: input.bearerToken,
          tool: input.name,
          canvasId: String(args.canvasId ?? ""),
          ...(typeof args.nodeId === "string" ? { nodeId: args.nodeId } : {}),
          ...(typeof args.clipId === "string" ? { clipId: args.clipId } : {}),
          ...(typeof args.itemId === "string" ? { itemId: args.itemId } : {}),
          ...(typeof args.cameraId === "string" ? { cameraId: args.cameraId } : {}),
          ...(typeof (args as { op?: { newClipId?: unknown } }).op?.newClipId === "string"
            ? { clipId: String((args as { op: { newClipId: string } }).op.newClipId) }
            : {})
        });
        if (!decision.ok) return { ok: false, code: "unauthorized", message: decision.reason };
        subject = options.grants.subject(input.bearerToken);
      } else if (input.loopback && options.loopbackDevelopment) {
        subject = options.developmentPrincipal;
      }
      if (!subject?.trim()) return { ok: false, code: "unauthorized", message: "缺少已认证 principal" };
      const canvasId = typeof input.args.canvasId === "string" ? input.args.canvasId : "";
      if (!canvasId) return { ok: false, code: "invalid-arguments", message: "缺少 canvasId" };
      if (options.authorizeCanvas && !(await options.authorizeCanvas({ subject, canvasId, permission: entry.tool.permission ?? "write" }))) {
        return { ok: false, code: "unauthorized", message: "无权访问目标画布" };
      }
      const diagnostic = entry.tool.authorize?.(input.args);
      if (diagnostic) return { ok: false, code: diagnostic.code, message: diagnostic.reason };
      try {
        if (entry.tool.route) {
          const routed = await dispatchContentRoute(options.content(), entry.extensionId, entry.tool.route.method, entry.tool.route.path, input.args);
          if (!routed.ok) return { ok: false, code: routed.code, message: routed.code };
          return { ok: routed.result.status < 400, status: routed.result.status, body: routed.result.body };
        }
        if (input.bearerToken && entry.tool.grantArgs) {
          const extra = entry.tool.grantArgs(input.args);
          if (extra) {
            const args = input.args as { canvasId?: unknown; nodeId?: unknown };
            const denied = options.grants.authorize({
              token: input.bearerToken,
              tool: entry.tool.name,
              ...(typeof args.canvasId === "string" ? { canvasId: args.canvasId } : {}),
              ...(typeof args.nodeId === "string" ? { nodeId: args.nodeId } : {}),
              ...extra
            });
            if (!denied.ok) return { ok: false, code: "unauthorized", message: denied.reason };
          }
        }
        const authority = options.authority;
        if (!authority) return { ok: false, code: "unavailable", message: "内容权威端口未装配" };
        const context: ContentMcpToolContext = {
          extensionId: entry.extensionId,
          ...(subject ? { subject } : {}),
          ...(subject ? { actorId: subject } : {}),
          permission: entry.tool.permission ?? "write",
          resolveRoom: authority.resolveRoom,
          ...(authority.readNode ? { readNode: authority.readNode } : {}),
          ...(authority.applyCommands ? { applyCommands: authority.applyCommands } : {}),
          ...(authority.recording ? { recording: authority.recording } : {}),
          ...(authority.themeBackdrop ? { themeBackdrop: authority.themeBackdrop } : {})
        };
        const result = await entry.tool.handle(input.args, context);
        if (!result.ok) {
          const structured = typeof result.structured === "object" && result.structured !== null ? result.structured as { code?: unknown; message?: unknown } : null;
          return {
            ok: false,
            code: typeof structured?.code === "string" ? structured.code : "extension-failed",
            message: typeof structured?.message === "string" ? structured.message : result.text ?? "内容工具执行失败"
          };
        }
        return { ok: true, ...(result.text ? { text: result.text } : {}), ...(result.structured !== undefined ? { structured: result.structured } : {}) };
      } catch {
        return { ok: false, code: "extension-failed", message: "内容工具执行失败" };
      }
    }
  };
}
