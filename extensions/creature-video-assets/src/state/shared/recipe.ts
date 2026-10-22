import type { StageId } from "./creature/ids.js";
export const EXTENSION_ID = "creature-video-assets";
export const WORKFLOW_VERSION = 1;
export type StageDefinition = {
  id: StageId; title: string; kind: "text" | "image" | "video" | "web";
  input: string; output: string; review: readonly string[]; visibleInputs: readonly StageId[];
};
export const STAGES: readonly StageDefinition[] = [
  { id: "01_brief", title: "需求与生物设计", kind: "text", input: "描述生物的形象、用途、运动方式和制作限制；参考图可选。", output: "生物设计说明与结构化设计", review: ["形象、材质和识别特征符合需求", "镜像限制、动作范围与制作约束明确"], visibleInputs: [] },
  { id: "02_identity_board", title: "三视图身份板", kind: "image", input: "自动沿用已批准的设计，可补充本轮制图要求。", output: "正、侧、背三视图身份板", review: ["三视图保持同一身份与比例", "细节、相机和背景符合制作要求"], visibleInputs: ["01_brief"] },
  { id: "03_direction_plan", title: "方向规划", kind: "text", input: "选择交付方向并确认镜像策略。", output: "方向表、母版与镜像映射", review: ["方向语义与交付范围正确", "镜像安全和相机约束已确认"], visibleInputs: ["01_brief", "02_identity_board"] },
  { id: "04_action_design", title: "动作设计", kind: "text", input: "补充动作、触发、转换和预算要求。", output: "动作状态、转换、事件帧和制作计划", review: ["Idle、终态、触发和动作范围正确", "循环、收势、事件帧与硬切规则明确", "制作任务数及预算可以接受"], visibleInputs: ["01_brief", "02_identity_board", "03_direction_plan"] },
  { id: "05_direction_stills", title: "母方向站定图", kind: "image", input: "自动沿用设计、身份板和方向规划，由系统生成方向图。", output: "母方向站定图与派生镜像", review: ["方向与身份正确", "主体尺度、脚底线和留白一致"], visibleInputs: ["02_identity_board", "03_direction_plan"] },
  { id: "07_rgb_videos", title: "RGB 动作视频", kind: "video", input: "先制作试片；试片通过后，确认批量制作范围。", output: "RGB 视频、关键帧与动作边界证据", review: ["身份、方向、相机与动作符合设计", "循环、硬切、收势和事件帧正确", "范围完整、24 FPS、无音轨且检查通过"], visibleInputs: ["04_action_design", "05_direction_stills"] },
  { id: "08_matting", title: "透明底处理", kind: "video", input: "自动引用 RGB，补充主体分割描述和抠像参数。", output: "RGB、SAM、Alpha 与 RGBA 对照", review: ["主体完整，毛发和边缘无明显拖影", "深浅底与棋盘格合成符合预期", "帧数、尺寸、FPS 和 PTS 一致"], visibleInputs: ["07_rgb_videos"] },
  { id: "09_publish", title: "通道与发布", kind: "web", input: "检查运行候选与所有通道，确认发布目标。", output: "G-buffer 证据与实际运行候选", review: ["Workbench 的 Original、Surface、Material 已验收", "各层同源同帧，方向与动作切换正确", "Stop、Exit、加载失败回退与回滚检查通过"], visibleInputs: ["03_direction_plan", "04_action_design", "08_matting"] }
];
export const stageDefinition = (id: StageId): StageDefinition => STAGES.find(stage => stage.id === id)!;
