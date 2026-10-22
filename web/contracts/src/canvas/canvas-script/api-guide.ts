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
import { CANVAS_SCRIPT_LIMITS, DEFAULT_CANVAS_SCRIPT_VERSION } from "./limits.js";

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
  {
    name: "group",
    signature: "canvas.group(members, { key?, title, layout?, placement?, if? })",
    description: "创建真实命名分类组，至少一个同直属 parent 的节点或组。成员关系保存为 parentId；支持嵌套。layout 为 {mode:'grid', columns, gapX?, gapY?, origin?}。",
    returns: "本次执行的组节点 handle"
  },
  { name: "reparent", signature: "canvas.reparent(nodes, groupOrNull, { if? }?)", description: "移入组或移出到顶层，保持世界位置；拒绝循环和祖先/后代混选。", returns: "void" },
  { name: "ungroup", signature: "canvas.ungroup(group, { if? }?)", description: "只移除组容器，直属成员提升一级，保留内容和真实连线。remove(group) 则级联删除。", returns: "void" },
  { name: "setTitle", signature: "canvas.setTitle(nodeOrGroup, title, { if? }?)", description: "修改节点或组标题，非空且最多 200 字符。", returns: "void" },
  { name: "layout", signature: "canvas.layout(nodes, { mode: 'grid', columns, gapX?, gapY?, origin? }, { if? }?)", description: "对同层节点或组按数组顺序网格排布，origin 为世界坐标。组按完整边界排布，移动后代不重复。", returns: "void" },
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

/** 分类是画布结构，与模型内部 scene.group 分开。 */
export const CANVAS_SCRIPT_ORGANIZATION_EXAMPLE = `const categories = [];
for (const [key, title, assets] of [
  ["characters", "角色", ["潜入者", "巡逻守卫"]],
  ["architecture", "建筑", ["地砖", "安全门"]],
  ["cover", "掩体", ["物资箱"]],
  ["props", "道具机关", ["门禁卡", "警报器"]],
  ["markers", "提示标记", ["撤离区域"]]
]) {
  const members = assets.map((name, i) => canvas.node("model", {
    key: key + "-" + i, title: name, prompt: "俯视角潜行游戏素材：" + name
  }));
  categories.push(canvas.group(members, {
    key, title, layout: { mode: "grid", columns: 3, gapX: 60, gapY: 60 }
  }));
}
canvas.group(categories, {
  key: "kit", title: "潜行游戏素材库",
  layout: { mode: "grid", columns: 2, gapX: 100, gapY: 100 },
  placement: { mode: "absolute", position: { x: -2600, y: 0 } }
});`;

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

## 分类整理

素材库应按用途创建有标题的真实分类组，再将分类组放入总组。只有一个成员也能成组。
标题前缀、排成几行、文本说明不能代替组。组只表达归属，不应为了分类而添加 connect。
connect 只表达真实生成输入。canvas.node 不接受 group kind；使用 canvas.group。
预检检查 organization.groups 中的 title/memberIds/worldBounds，再提交并读回 parentId 核对。
模型新建尺寸为 248×232。图查询 size/worldBounds、相对定位、grid 与组包围框都使用和界面一致的有效尺寸；已有 196×64 模型卡片也按实际预览尺寸参与布局，无需手工补偿尺寸。
get_canvas_graph 的 parentId=null 查询顶层，parentId=组 ID 分页读取直属成员。

## handle 与 key 规则

${CANVAS_SCRIPT_HANDLE_RULES.map((rule) => `- ${rule}`).join("\n")}

## placement 规则

${CANVAS_SCRIPT_PLACEMENT_RULES.map((rule) => `- ${rule}`).join("\n")}

## 局部条件（if）

${CANVAS_SCRIPT_IF_RULES.map((rule) => `- ${rule}`).join("\n")}

## 预算

- 源码 UTF-8 上限：${CANVAS_SCRIPT_LIMITS.sourceMaxBytes} 字节
- 单次执行时间上限：${CANVAS_SCRIPT_LIMITS.executionTimeoutMs} 毫秒
- JS 堆上限：${CANVAS_SCRIPT_LIMITS.heapLimitBytes} 字节
- 展开操作上限：${CANVAS_SCRIPT_LIMITS.maxOperations}

## 示例

\`\`\`js
${CANVAS_SCRIPT_GUIDE_EXAMPLE}
\`\`\`

## 分类素材库示例

\`\`\`js
${CANVAS_SCRIPT_ORGANIZATION_EXAMPLE}
\`\`\`

## 约定

- \`prompt\` 是生成输入，不冒充已有文本作品输出；节点执行必须在画布提交成功后经 \`run_canvas_node\` 触发。
- 提交成功后脚本源码不写入画布、数据库、历史或日志；重试相同身份与内容返回首次回执。
- model 种类映射为合法自包含 \`model3d\` 占位模型；实际模型源码通过独立 model authoring 工具提交。`;

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
    limits: CANVAS_SCRIPT_LIMITS,
    organizationExample: CANVAS_SCRIPT_ORGANIZATION_EXAMPLE,
    example: CANVAS_SCRIPT_GUIDE_EXAMPLE
  };
}
