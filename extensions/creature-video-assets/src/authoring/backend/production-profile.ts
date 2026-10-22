import type { WorkflowRun } from "../../state/shared/workflow.js";

// Copied from video_assets_3d_game's camera_first_frame.json and creature-video/defaults.json.
export const DEFAULT_PRODUCTION_PROFILE: NonNullable<WorkflowRun["productionProfile"]> = {
  cameraSummary: "锁定正交 2.5D 斜俯视机位：俯角 50.479°、绕 Y 轴 -170.103°、垂直视场 52.88°、画幅 1.8:1、相机高于目标 26.596 世界单位；画面比例与屏幕时钟方向语义固定，不允许随动作平移、旋转、缩放或推拉。",
  cameraHash: "7ba0e095542e9d4e384b18663ab96e873530cab97cccc0da6e4b151a4bd37a69",
  identityAspectRatio: 1,
  identityParameters: { aspectRatio: "1:1", requestSize: "4K", requestQuality: "high", format: "png" },
};
