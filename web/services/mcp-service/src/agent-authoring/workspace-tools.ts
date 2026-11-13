import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AgentAuthoringToolDeps } from "./tool-policy.js";
import { structured } from "./tool-policy.js";

/** Shared across engines; identity and locations are supplied by the trusted grant. */
export function registerWorkspaceTools(server: McpServer, deps: Pick<AgentAuthoringToolDeps, "workspace" | "grant" | "principalId">): void {
  if (!deps.workspace) return;
  const register = (name: string, description: string, schema: z.ZodRawShape) => {
    server.registerTool(name, { description, inputSchema: z.strictObject(schema) }, async args => {
      if (!deps.grant || !deps.principalId) return { isError: true, content: [{ type: "text", text: "当前回合未取得桌面工作目录授权" }] };
      try {
        const result = await deps.workspace!({ tool: name, arguments: args, grant: deps.grant, principalId: deps.principalId });
        return structured({ ok: true, result }, "本机工作目录操作结果");
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code: (error as { code?: string }).code ?? "workspace-io-failed", message: error instanceof Error ? error.message : String(error) }) }] };
      }
    });
  };
  register("workspace_list", "列出当前画布工作目录的文件。路径相对画布目录。", { path: z.string().optional() });
  register("workspace_read", "读取画布工作目录的 UTF-8 文件及内容 hash。", { path: z.string().min(1) });
  register("workspace_write", "原子写入 UTF-8 文件。shared/ 用于跨助手共享；临时文件写入本回合 runs/。expectedHash=null 要求文件不存在。", { path: z.string().min(1), content: z.string(), expectedHash: z.string().nullable().optional() });
  register("workspace_mkdir", "创建画布内子目录。", { path: z.string().min(1) });
  register("workspace_execute", "在本机运行命令或辅助代码。Node 使用随包版本；其他程序需已安装。默认 cwd 是当前回合目录，显式 cwd 相对画布目录。返回 executionId 后查询结果，同一 operationId 不重复启动。代码以当前用户账号执行，cwd 不是系统沙箱。", { operationId: z.string().min(1).max(256), command: z.string().min(1), args: z.array(z.string()).optional(), cwd: z.string().optional(), shell: z.boolean().optional() });
  register("workspace_query", "按 executionId 和输出 cursor 查询真实运行状态、stdout/stderr 和退出码。after 是上次收到的最后输出 cursor。", { executionId: z.string().min(1), after: z.number().int().nonnegative().optional() });
  register("workspace_import", "将工作目录文件显式导入既有媒体资产服务，返回稳定 storageKey 等媒体身份。不会自动创建画布节点；按原角色的画布工具提交正式内容。源文件清理后已导入媒体仍保留。", { path: z.string().min(1), contentType: z.string().min(1) });
  register("workspace_stop", "停止当前回合指定执行及其进程树；未知进程不会被伪报为已停止。", { executionId: z.string().min(1) });
}
