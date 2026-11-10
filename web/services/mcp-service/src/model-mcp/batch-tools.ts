import { z } from "zod";
import { createToolRegistrar } from "./guide.js";
import { jsonResult, toolError } from "./tool-results.js";
import type { ModelMcpHttpOptions, ToolRegistration } from "./http-types.js";

const id = z.string().trim().min(1).max(200);
const requestSchema = z.strictObject({
  canvasId: id,
  requestId: id,
  version: z.literal("woohaa-model-js-v2").optional(),
  commonSource: z.string().optional(),
  items: z
    .array(
      z.strictObject({
        nodeId: id,
        source: z.string().min(1),
        expectedModelContentHash: id.optional(),
      }),
    )
    .min(1)
});
const result = (outcome: { ok: boolean }) => ({
  ...jsonResult(outcome),
  ...(!outcome.ok ? { isError: true } : {}),
});

export function registerModelBatchTools(
  reg: ToolRegistration,
  options: ModelMcpHttpOptions,
): void {
  const register = createToolRegistrar(reg);
  register(
    "get_model_nodes",
    {
      title: "批量读取模型节点",
      description: `从同一权威快照读取同一 revision 的模型版本、提示词和参考输入。默认省略源码；需要编辑既有脚本时 includeSource=true。大响应可按同一快照继续读取，不按模型数量或响应总量要求缩小请求。`,
      inputSchema: z.strictObject({
        canvasId: id,
        nodeIds: z.array(id).min(1),
        includeSource: z.boolean().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      options.service?.getModelNodes
        ? result(await options.service.getModelNodes(input))
        : toolError("批量模型读取当前不可用"),
  );

  register(
    "validate_model_scripts",
    {
      title: "预检模型批次",
      description: `批量执行并校验模型脚本和内容哈希条件，不写画布、不占 requestId、不签发 token。commonSource 加换行后前置到每项 source，在独立 scene 中运行。返回逐节点模型版本、局部几何 AABB 与操作数；失败返回 index/nodeId/errors。批次按实际资源调度并整批一次原子保存，不按模型数量、源码字节、执行时长或并发批次数量拒绝合法工作。`,
      inputSchema: requestSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      options.service?.validateScripts
        ? result(await options.service.validateScripts(input))
        : toolError("模型批量预检当前不可用"),
  );

  register(
    "submit_model_scripts",
    {
      title: "原子提交多个模型与镜头",
      description:
        "整套素材优先使用：所有脚本校验通过，并在权威队列复核每个节点类型及哈希后，以一个事务保存全部模型与镜头。commonSource 只传一次，落库为每节点独立完整脚本。相同 requestId/内容返回冻结首次回执，变更内容必须换 requestId；任何一项失败均零写入。预检后原样提交，无需 token。",
      inputSchema: requestSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      options.service?.submitScripts
        ? result(await options.service.submitScripts(input))
        : toolError("模型批量提交当前不可用"),
  );
}
