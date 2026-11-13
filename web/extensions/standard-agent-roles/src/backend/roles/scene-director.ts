/**
 * scene-director：导演区（scene-area）共享世界创作角色。
 *
 * 迁移自 `target-prompt` 的 world/scene-area 分支。写资格仍由宿主签发的世界范围决定，
 * 角色声明只是允许集合。
 */
import { ASSISTANT_WORLD_TOOLS, ASSISTANT_WORLD_TOOL, ASSISTANT_WORLD_WRITE_TOOLS, WORLD_RESOURCE_TOOLS } from "@woohaa3/contracts";
import type { AgentRoleImplementation } from "@woohaa3/contracts";
import { conversationPrompt, CONVERSATION_INPUT_SCHEMA, OPEN_CONTEXT_SCHEMA, RECEIPTS_OUTPUT } from "../role-shared.js";
import { SCENE_DIRECTOR_FLOW, targetLine, TOOL_COMMON_RULES } from "../prompts.js";

export const sceneDirectorRole: AgentRoleImplementation = {
  definition: {
    id: "scene-director",
    revision: "7",
    title: "导演区作者",
    specialty: "在导演区共享世界中创建、修改模型与镜头，并制作确定性动画",
    instructions: ["你是 Woohaa3 导演区的共享世界创作 Agent。", ...TOOL_COMMON_RULES, ...SCENE_DIRECTOR_FLOW].join("\n"),
    inputSchema: CONVERSATION_INPUT_SCHEMA,
    contextSchema: OPEN_CONTEXT_SCHEMA,
    // 读上下文是所有世界范围的最小必需工具；具体写入/建模工具按本轮 scope 收窄。
    // 资源查询提供脚本/rig 精确读取，采样独立用于数据诊断。
    tools: {
      required: [ASSISTANT_WORLD_TOOL.readContext],
      optional: ["get_model_api", WORLD_RESOURCE_TOOLS.read, ASSISTANT_WORLD_TOOL.sampleAnimation, ASSISTANT_WORLD_TOOL.getHumanoidMotion, ...ASSISTANT_WORLD_WRITE_TOOLS]
    },
    nativeCapabilities: { required: [], optional: [] },
    requirements: { imageInput: false, toolCalling: true, structuredOutput: "none" },
    output: RECEIPTS_OUTPUT
  },
  prepare({ input, context, target, requestId, expectedContentHash }) {
    const lines = [`目标：${targetLine(target)}。`, `本次请求稳定 id：requestId="${requestId}"。`];
    if (typeof context === "object" && context !== null && "imageReconstruction" in context) {
      lines.push(
        "本轮是根据参考图片重建导演区场景：先调用 get_world_context 读取空导演区范围，再创建主要模型与一个覆盖全部主体的镜头。",
        "主体较多时同样先建骨架再分段追加，不要在一次参数里生成整份脚本；按图片还原主体、比例、空间布局与构图；只创建静态几何，不使用动画。模型脚本使用模型 API 的 Y-up 米制，世界变换使用 u/v/h 米制。",
        "图片只作为参考，不得要求用户上传文件；工具成功返回后才能说场景已创建。"
      );
    }
    lines.push(
      "仅在直接编写关节动画或程序化行走时，先用 read_world_resource（resourceType=world_model_rig, operation=get） 读取真实部件、参考姿态与行走 profile；profile 为 null 表示不支持程序化walk，不能伪造，也不代表不能编写其他关节动画。常规Kimodo动作直接animate_humanoid，不额外读取骨架。",
      "直接编写或返修关节脚本后，用 sample_scene_animation 采样关键姿态；warning 需按用户意图处理。Kimodo成功回执不追加无目的采样；只能报告数据验证，未看画面不可宣称视觉验收。"
    );
    if (expectedContentHash) lines.push(`宿主冻结的内容哈希：${expectedContentHash}；提交前仍以工具读取结果为准。`);
    lines.push(conversationPrompt(input));
    return {
      messages: [{ role: "user", content: lines.join("\n") }],
      tools: [...ASSISTANT_WORLD_TOOLS, "get_model_api"]
    };
  }
};
