/**
 * canvas-builder：2D 组（workflow-group-2d）搭建角色。
 *
 * 迁移自 `target-prompt` 的 canvas-group 分支。`import_generated_image` 属可选内建生图分支：
 * 只有通道真实开启 `generate-image` 时才收窄包含它，缺省不继承旧回合的生图能力。
 */
import { CANVAS_GROUP_TOOLS } from "@woohaa3/contracts";
import type { AgentRoleImplementation } from "@woohaa3/contracts";
import { conversationPrompt, CONVERSATION_INPUT_SCHEMA, OPEN_CONTEXT_SCHEMA, RECEIPTS_OUTPUT } from "../role-shared.js";
import { CANVAS_BUILDER_FLOW, IMAGE_IMPORT_FLOW, targetLine, TOOL_COMMON_RULES } from "../prompts.js";

const IMPORT_TOOL = "import_generated_image";
// 只在特定部署注册的工具：JSON plan 入口仅在脚本能力不可用时注册，节点直写/运行工具也只在
// 对应能力开启时注册。它们必须是 optional，否则脚本可用或 run 未启用时整个角色会被误判不可用。
const CONDITIONAL_TOOLS = new Set([
  "validate_canvas_plan",
  "apply_canvas_plan",
  "create_canvas_node",
  "connect_canvas_nodes",
  "resize_canvas_node",
  "resize_canvas_group",
  "delete_canvas_entities",
  "run_canvas_node",
  "get_canvas_run",
  "cancel_canvas_run",
  "get_node_output",
  "get_model_api",
  "get_model_node",
  "get_model_statistics",
  "submit_model_script",
  "submit_model_scripts",
  IMPORT_TOOL
]);
// 永远注册的读/脚本入口：脚本工具即使能力面不可用也会注册并在调用时给出原因。
const REQUIRED_TOOLS = CANVAS_GROUP_TOOLS.filter((tool) => !CONDITIONAL_TOOLS.has(tool));
const OPTIONAL_TOOLS = CANVAS_GROUP_TOOLS.filter((tool) => CONDITIONAL_TOOLS.has(tool));

export const canvasBuilderRole: AgentRoleImplementation = {
  definition: {
    id: "canvas-builder",
    revision: "1",
    title: "节点组搭建",
    specialty: "在单个 2D 组内组织卡片、编写画布脚本并执行组内节点",
    instructions: ["你是 Woohaa3 2D 组画布搭建 Agent。", ...TOOL_COMMON_RULES, ...CANVAS_BUILDER_FLOW].join("\n"),
    inputSchema: CONVERSATION_INPUT_SCHEMA,
    contextSchema: OPEN_CONTEXT_SCHEMA,
    tools: { required: [...REQUIRED_TOOLS], optional: OPTIONAL_TOOLS },
    nativeCapabilities: { required: [], optional: ["generate-image"] },
    requirements: { imageInput: false, toolCalling: true, structuredOutput: "none" },
    output: RECEIPTS_OUTPUT
  },
  prepare({ input, target, requestId, expectedContentHash, nativeCapabilities }) {
    const lines = [`目标：${targetLine(target)}。`, `本次请求稳定 id：requestId="${requestId}"。`];
    if (expectedContentHash) lines.push(`宿主冻结的组范围版本：${expectedContentHash}。`);
    if (nativeCapabilities.includes("generate-image")) lines.push(...IMAGE_IMPORT_FLOW);
    lines.push(conversationPrompt(input));
    return {
      messages: [{ role: "user", content: lines.join("\n") }],
      // prepare 返回全部声明工具，注册表再按本轮真实目录求交：脚本可用时不注册 plan/直写工具，
      // run 未启用时不注册运行工具，Codex 未开启生图时不注册导入工具。
      tools: nativeCapabilities.includes("generate-image")
        ? [...REQUIRED_TOOLS, ...OPTIONAL_TOOLS]
        : [...REQUIRED_TOOLS, ...OPTIONAL_TOOLS.filter((tool) => tool !== IMPORT_TOOL)]
    };
  }
};
