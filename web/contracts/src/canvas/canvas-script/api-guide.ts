/**
 * Canvas Script API 签名、handle/key 规则与示例
 * （change: 2026-10-13-add-canvas-script-authoring，任务 1.2 / design D2、D3）。
 *
 * 这是**唯一**一份机器可读的 API 指南事实源：MCP `get_canvas_script_api` 直接返回它，
 * 指南文本与示例也由它派生，避免能力声明与执行器实现漂移。
 *
 * 语义边界：API 只记录语义操作，不立即写画布；`prompt` 是生成**输入**，不是已有作品输出。
 */
import { CANVAS_SCRIPT_API_NAMES, type CanvasScriptApiName } from "./types.js";
import { DEFAULT_CANVAS_SCRIPT_VERSION } from "./limits.js";

export type CanvasScriptApiSignature = {
  name: CanvasScriptApiName;
  /** 人类可读签名（形参语义，不是 TypeScript 声明）。 */
  signature: string;
  description: string;
  returns: string;
};

export const CANVAS_SCRIPT_HANDLE_RULES: readonly string[] = [
  "handle 只属于本次执行：节点与边 handle 区分种类，边 handle 不能作为节点参数。",
  "显式 key 在计划内唯一，节点与边共享同一命名空间；重复 key 拒绝并定位冲突调用。",
  "省略 key 时按调用序列稳定分配；显式 key 与自动 key 冲突同样拒绝。",
  "key 只是 plan-local ref，不是跨次 upsert 标识；最终 nodeId/edgeId 由服务端派生。",
  "伪造、跨执行、前向引用，以及对已删除节点继续操作都被拒绝。"
];

export const CANVAS_SCRIPT_PLACEMENT_RULES: readonly string[] = [
  "placement.mode 支持 absolute/auto/after/before/below。",
  "after/before/below 的 anchor 可以是 published 既有节点，也可以是本次计划内已创建或已移动的节点。",
  "尚未创建或已在同一计划中删除的锚点必须拒绝，不使用占位坐标。"
];

export const CANVAS_SCRIPT_IF_RULES: readonly string[] = [
  "局部条件沿用既有种类：node-exists、node-missing、prompt-equals、not-processing。",
  "所有写操作可携带 if；条件在权威队列内按最新状态复核。"
];

export const CANVAS_SCRIPT_API_SIGNATURES: readonly CanvasScriptApiSignature[] = [
  {
    name: "node",
    signature: "canvas.node(kind, { key?, title?, prompt?, placement? })",
    description: "记录 create_node；kind 取自 text/image/video/audio/model。只接受语义字段，拒绝 nodeData/canonical type。",
    returns: "本次执行的节点 handle"
  },
  { name: "setTitle", signature: "canvas.setTitle(node, title, { if? }?)", description: "修改节点标题，非空且最多 200 字符。", returns: "void" },
  { name: "layout", signature: "canvas.layout(nodes, { mode: 'grid', columns, gapX?, gapY?, origin? }, { if? }?)", description: "对节点按数组顺序网格排布，origin 为世界坐标。", returns: "void" },
  { name: "resize", signature: "canvas.resize(node, { width, height }, { if? }?)", description: "只改卡片矩形宽高，不移动节点；整理 2D 组后缩小组卡片时用它。", returns: "void" },
  {
    name: "existing",
    signature: "canvas.existing(nodeId)",
    description: "创建已有节点 handle；实际可见性/存在性由授权领域校验，不触发 IO。",
    returns: "指向既有 nodeId 的节点 handle"
  },
  {
    name: "connect",
    signature: "canvas.connect(from, to, { key?, label?, if? }?)",
    description: "记录 connect；from/to 必须是节点 handle。返回边 handle，边 handle 不可作节点参数。",
    returns: "本次执行的边 handle"
  },
  {
    name: "move",
    signature: "canvas.move(node, position, { if? }?)",
    description: "记录 move_node；position 为画布世界坐标 { x, y }。",
    returns: "void"
  },
  {
    name: "setPrompt",
    signature: "canvas.setPrompt(node, prompt, { if? }?)",
    description: "记录 set_prompt；prompt 是生成输入，不是已有作品输出。",
    returns: "void"
  },
  {
    name: "remove",
    signature: "canvas.remove(nodeOrNodes, { if? }?)",
    description: "记录 delete；节点或节点数组，按领域规则级联删除后代与关联边。",
    returns: "void"
  }
];

/**
 * 指南示例：循环创建 text + 3 个 image 节点并连线。
 *
 * 与 design D2 的示意一致；测试用同一常量驱动 recorder，验证生成预期语义操作。
 */
export const CANVAS_SCRIPT_GUIDE_EXAMPLE = `const brief = canvas.node("text", {
  key: "brief", title: "场景描述", prompt: "雨夜里的城市街道",
  placement: { mode: "absolute", position: { x: 0, y: 0 } }
});
for (let i = 0; i < 3; i++) {
  const shot = canvas.node("image", {
    key: "shot-" + i, title: "镜头 " + (i + 1), prompt: "第 " + (i + 1) + " 个机位",
    placement: { mode: "absolute", position: { x: 400, y: i * 320 } }
  });
  canvas.connect(brief, shot, { key: "edge-" + i });
}`;

/** 指南文本：人类可读，但事实与签名表同源。 */
export const CANVAS_SCRIPT_GUIDE_TEXT = `# Canvas Script API 指南（${DEFAULT_CANVAS_SCRIPT_VERSION}）

推荐流程：\`list_canvases\` -> \`get_canvas_capabilities\` -> \`get_canvas_graph\` -> \`get_canvas_script_api\`
-> \`validate_canvas_script\` -> \`submit_canvas_script\` -> \`run_canvas_node\`。

画布创建与修改优先使用 Canvas Script。同一任务中已知的节点、连线和修改应在预算内合并为一个脚本，
一次预检、一次原子提交；只有超出预算或依赖前次结果时才拆分。

脚本在一个同步函数体内执行，注入 \`canvas\` API。只支持变量、循环、函数与确定性计算；
不提供网络、文件、环境、凭据、进程、模块加载、时间、随机源、动态代码或异步任务。

## API 签名

${CANVAS_SCRIPT_API_SIGNATURES.map((entry) => `- \`${entry.signature}\` — ${entry.description}`).join("\n")}

## 布局

画布只支持节点与连线，不支持分组容器。用 canvas.layout 网格排布普通卡片，标题用 setTitle 表达用途。
connect 只表达真实生成输入。
模型没有卡片：\`model\` 只接受 absolute placement，画布点投影到 h=0 地面生成共享世界实例，按真实尺度渲染；
模型不参与 grid、after/before/below 或卡片避让，图查询的 size/worldBounds 使用世界包围盒。

## handle 与 key 规则

${CANVAS_SCRIPT_HANDLE_RULES.map((rule) => `- ${rule}`).join("\n")}

## placement 规则

${CANVAS_SCRIPT_PLACEMENT_RULES.map((rule) => `- ${rule}`).join("\n")}

## 局部条件（if）

${CANVAS_SCRIPT_IF_RULES.map((rule) => `- ${rule}`).join("\n")}

## 执行边界

脚本在隔离的执行域内运行，可被用户随时停止；没有应用侧的源码字节、执行时长、操作数或 API 调用次数上限。

- 真实内存不足会作为执行域的资源故障返回，不影响其他请求
- 相同脚本在独立执行域各运行一次以校验确定性
- 大脚本/大计划完整记录后由同一 planner 校验并一次原子提交

## 示例

\`\`\`js
${CANVAS_SCRIPT_GUIDE_EXAMPLE}
\`\`\`

## 约定

- \`prompt\` 是生成输入，不冒充已有文本作品输出；节点执行必须在画布提交成功后经 \`run_canvas_node\` 触发。
- 提交成功后脚本源码不写入画布、数据库、历史或日志；重试相同身份与内容返回首次回执。
- model 种类映射为带共享世界实例的 \`model3d\` 空模型；实际模型源码通过独立 model authoring 工具提交。
- 2D 组作用域内新建的节点会自动进入根组成员表；\`canvas.resize\` 只改卡片尺寸，不改成员关系。`;

/** 机器可读的能力声明（供 `get_canvas_script_api`）。 */
export function canvasScriptApiDescriptor() {
  return {
    version: DEFAULT_CANVAS_SCRIPT_VERSION,
    versions: [DEFAULT_CANVAS_SCRIPT_VERSION],
    apis: CANVAS_SCRIPT_API_SIGNATURES,
    apiNames: CANVAS_SCRIPT_API_NAMES,
    handleRules: CANVAS_SCRIPT_HANDLE_RULES,
    placementRules: CANVAS_SCRIPT_PLACEMENT_RULES,
    ifRules: CANVAS_SCRIPT_IF_RULES,
    // 声明真实的执行边界（隔离 + 可取消），不声明任何应用侧总量额度。
    execution: {
      isolated: true,
      cancellable: true,
      deterministicDoubleRun: true,
      applicationQuotas: []
    },
    examples: {
      basic: CANVAS_SCRIPT_GUIDE_EXAMPLE
    }
  };
}
