# 来源

参考项目：`video_assets_3d_game`，固定提交 `2f8f45248ee8849d646c406b3bfb90051bdcda26`。本扩展不 import 该工作区，不复制其秘密或制作产物。按用户要求内置公开项目相机与身份板制作参数，见 `production-profile.ts`。逐文件 hash、目标、适配方式及排除清单见 [migration-manifest.json](migration-manifest.json)。

`src/state/shared/creature/` 的 `ids.ts`、`direction.ts`、`creature-design.ts`、`action.ts`、`motion-contract.ts`、`clip-generation.ts`、`zod-helpers.ts`、`errors.ts` 来自源项目 `scripts/creature-video/model/` 的纯领域模块，保留源 schema 标识以便检查和对接。更新时逐文件核对源变动，并验证八步依赖、镜像安全、动作图及 clipGeneration；不要用源项目旧预算函数恢复已废弃的独立锚点图片任务。

业务依据：源项目 `.agents/skills/creature-video-assets/SKILL.md` 及其 workflow、service-contracts、quality-gates、recovery、publishing，另含 `gbuffer-relight-integration` skill。源编号 06 已废弃；本扩展未实现该阶段。共享起手图仅由 `clipGeneration.sharedStartImage` 明确声明时计入。

生产移植包括方向图/动作片提示与依赖、SAM3/VideoMaMa 协议、原 RGB 与 straight alpha 合成、G-buffer 分辨率及时间分段规则、通道像素工具与 Relight shader。Task 与持久状态适配为当前宿主；Node worker、专用 cooker、流式解压和独立 viewer 在扩展内实现。最终包同时包含 Body/Surface/Material/Mask/Shadow/baseColor，不复用原 Body-only 发布结果。

未移植原 CLI shell、RunStore、Kino/Forgeax 生成适配、废弃 06、prop/terrain skill、游戏 target/store。原源码未声明统一上游许可证，清单保留用户授权私有来源说明；第三方工具许可单独记录在 `tools/manifest.json`。当前通道深度用于预览，尚不宣称有物理世界尺度的阴影标定。
