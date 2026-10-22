import { createHash } from "node:crypto";
import type { ApplicationBackendHost, ApplicationExtensionMcpTool } from "@woohaa3/contracts";
import { createGameFurnaceNodeData, isGameFurnaceNodeData, GAME_FURNACE_NODE_TYPE } from "../geometry.js";
import { createGameFurnaceState, projectIdFor, MAX_GAME_HTML_BYTES, type GameFurnaceState } from "../shared.js";
import { planGameFurnaceDrop, isSelfOrAncestorDrop } from "../collection.js";
import { resourceDependencyPaths, resourceRelativePath } from "../package.js";
import type { GameFurnaceController } from "../backend.js";
import { projectKey } from "./support.js";
import { GAME_FURNACE_AUTHORING } from "../authoring.js";

const node = { type: "string" as const, description: "炼丹炉节点 ID" };
export const GAME_FURNACE_MCP_TOOLS: readonly ApplicationExtensionMcpTool[] = [
  { name: "create_game_furnace", route: "game-furnace/mcp/create", permission: "write", newWork: true,
    description: "创建游戏炼丹炉3D节点及空项目；返回 nodeId 和 inputHash。随后 update_game_furnace 设置需求并收集素材。",
    parameters: { title: { type: "string", optional: true }, position: { type: "object", optional: true } } },
  { name: "get_game_furnace", route: "game-furnace/mcp/get", permission: "read",
    description: "编写前先读取炼丹炉需求、素材快照、resourcePaths、inputHash及authoring交付约定。随后prepare_game_project准备独立目录及素材，Agent自行编码和构建，宿主只登记产物与提供静态入口；成功提交不等于素材和玩法已验收。",
    parameters: { nodeId: node } },
  { name: "update_game_furnace", route: "game-furnace/mcp/update", permission: "write",
    description: "更新游戏需求（name/description/gameplay）或收集sourceNodeIds素材快照与固定引用；保留来源节点，返回新inputHash。随后调用prepare_game_project复制素材到public/assets，由Agent自行构建。",
    parameters: { nodeId: node, expectedInputHash: { type: "string" }, requirements: { type: "object", optional: true }, sourceNodeIds: { type: "strings", optional: true } } },
  { name: "prepare_game_project", route: "game-furnace/mcp/prepare", permission: "write", newWork: true,
    description: "开始制作游戏：为当前炼丹炉/固定inputHash创建独立项目目录，将收集素材复制到public/assets，返回projectId、projectDirectory及素材路径。宿主不写游戏逻辑、不安装依赖、不执行构建；Agent在该目录完成编码和构建，之后submit_game登记已有dist。重复准备不覆盖Agent代码。目录属于宿主机器，远程Agent须确认访问或同步能力。",
    parameters: { nodeId: node, expectedInputHash: { type: "string" } } },
  { name: "submit_game", route: "game-furnace/mcp/submit", permission: "write", newWork: true,
    description: "登记Agent已经构建好的游戏：提交prepare_game_project返回的projectId，outputDirectory默认dist（仅项目内相对目录）。宿主只校验并保存固定静态文件，不执行构建；缺少index.html/素材或存在越界路径、符号链接则拒绝。requestId幂等，inputHash防冲突。html仅旧格式兼容，与projectId二选一；使用preview_game入口做真实浏览器验收。",
    parameters: { nodeId: node, expectedInputHash: { type: "string" }, projectId: { type: "string", optional: true }, outputDirectory: { type: "string", optional: true }, html: { type: "string", optional: true, maxLength: MAX_GAME_HTML_BYTES },
      title: { type: "string", optional: true }, controlsSummary: { type: "string", optional: true }, resourceIds: { type: "strings", optional: true } } },
  { name: "preview_game", route: "game-furnace/mcp/preview", permission: "read",
    description: "为固定buildId申请短期只读静态站点入口entryUrl与文件清单。通过入口的相对HTTP路径加载JS/CSS/assets，不返回素材base64。Agent须打开入口验证实际素材与玩法；工具不会自动执行浏览器验收。",
    parameters: { nodeId: node, buildId: { type: "string" } } }
];

/** 扩展自有编排；宿主只提供通用节点读写与认证后的上下文。 */
export function registerGameFurnaceMcp(host: ApplicationBackendHost, controller: GameFurnaceController): void {
  const pending = new Map<string, Promise<unknown>>();
  for (const tool of GAME_FURNACE_MCP_TOOLS) {
    host.registerHandler({ route: tool.route, auth: "authenticated", purpose: tool.newWork ? "new-work" : tool.permission === "read" ? "read" : "work-control",
      async handle({ body, context }) {
        const args = body as Record<string, unknown>;
        const subject = context.principal?.subject;
        const nodes = host.services.extensionNodes;
        if (!subject || !nodes) return { body: { ok: false, code: "unauthorized", message: "缺少节点授权能力" } };
        const canvasId = String(args.canvasId ?? "");
        const requestId = String(args.requestId ?? "");
        const nodeId = tool.name === "create_game_furnace" ? `furnace-${createHash("sha256").update(JSON.stringify([canvasId, subject, requestId])).digest("hex")}` : String(args.nodeId ?? "");
        const key = projectKey(canvasId, nodeId);
        const previous = pending.get(key) ?? Promise.resolve();
        const work = previous.catch(() => undefined).then(async () => {
          const canvas = await nodes.read({ subject, canvasId, permission: tool.permission });
          if (tool.name === "create_game_furnace") {
            if (!requestId) return failure("malformed-request", "缺少 requestId");
            const position = args.position as { x?: unknown; y?: unknown } | undefined;
            const x = position?.x ?? 0, y = position?.y ?? 0;
            if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return failure("malformed-request", "position 必须是有限 x/y");
            const existing = canvas.document.nodes.find(n => n.id === nodeId);
            if (!existing) await nodes.commit({ subject, canvasId, nodeId, requestId: `create:${requestId}`, expectedRevision: canvas.revision,
              value: createGameFurnaceNodeData(typeof args.title === "string" ? args.title : undefined), create: { position: { x, y } } });
          }
          const current = tool.name === "create_game_furnace" ? await nodes.read({ subject, canvasId, permission: "write" }) : canvas;
          const target = current.document.nodes.find(n => n.id === nodeId);
          const data = current.nodeData[nodeId];
          if (target?.type !== GAME_FURNACE_NODE_TYPE || !isGameFurnaceNodeData(data)) return failure("unsupported-node", "目标不是炼丹炉节点");
          const storageKey = data.projectStorageKey;
          if (typeof storageKey === "string") {
            const opened = await controller.openProject({ canvasId, nodeId, projectStorageKey: storageKey });
            if (opened.ok !== true) return opened;
          } else if (!controller.runtime()?.projects.has(key)) {
            const saved = await controller.saveProject({ canvasId, nodeId, state: createGameFurnaceState(projectIdFor(canvasId, nodeId)) as unknown as GameFurnaceState });
            if (saved.ok !== true) return saved;
          }
          let result: Record<string, unknown> = { ok: true };
          const project = controller.runtime()!.projects.get(key)!;
          if (tool.name === "update_game_furnace") {
            if (args.expectedInputHash !== project.inputHash) return failure("content-conflict", "输入已变化，请重新读取项目");
            const operations = [];
            if (args.requirements) operations.push({ type: "requirements.patch", patch: args.requirements });
            if (Array.isArray(args.sourceNodeIds) && args.sourceNodeIds.length) {
              if (isSelfOrAncestorDrop(current, nodeId, args.sourceNodeIds as string[])) return failure("invalid-resource", "不能收集炼丹炉自身");
              const plan = planGameFurnaceDrop(current, args.sourceNodeIds as string[]);
              if (!plan) return failure("invalid-resource", "来源素材不存在或未就绪");
              operations.push(...plan.operations);
            }
            if (!operations.length) return failure("malformed-request", "缺少需求或素材更新");
            result = await controller.collectResources({ canvasId, nodeId, operations: operations as never });
          } else if (tool.name === "prepare_game_project") {
            return controller.prepareProject({ canvasId, nodeId, expectedInputHash: String(args.expectedInputHash ?? "") });
          } else if (tool.name === "submit_game") {
            result = await controller.submitGame({ canvasId, nodeId, requestId, expectedInputHash: String(args.expectedInputHash ?? ""), ...(typeof args.html === "string" ? { html: args.html } : {}), ...(typeof args.projectId === "string" ? { projectId: args.projectId, outputDirectory: args.outputDirectory as string | undefined } : {}),
              title: args.title as string | undefined, controlsSummary: args.controlsSummary as string | undefined, resourceIds: args.resourceIds as string[] | undefined });
          } else if (tool.name === "preview_game") {
            return controller.openPreview({ canvasId, nodeId, buildId: String(args.buildId ?? "") });
          }
          if (result.ok !== true) return result;
          const latest = controller.runtime()!.projects.get(key)!;
          // CAS 使用操作开始时的画布 revision；冲突不得覆盖并发编辑。
          if (tool.permission === "write") {
            await nodes.commit({ subject, canvasId, nodeId, requestId: `associate:${requestId}:${latest.projectStorageKey}`, expectedRevision: current.revision,
              value: { projectStorageKey: latest.projectStorageKey, inputHash: latest.inputHash, activeBuildId: latest.state.activeBuildId ?? null } });
          }
          return { ...result, ok: true, ...latest, canvasId, nodeId,
            resourcePaths: latest.state.resources.map(r => ({ resourceId: r.resourceId, path: resourceRelativePath(r), dependencies: resourceDependencyPaths(r) })),
            authoring: GAME_FURNACE_AUTHORING };
        });
        pending.set(key, work);
        try { return { body: await work }; } finally { if (pending.get(key) === work) pending.delete(key); }
      }
    });
  }
}
function failure(code: string, message: string): Record<string, unknown> { return { ok: false, code, message }; }
