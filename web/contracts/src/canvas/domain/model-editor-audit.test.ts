/**
 * 模型编辑 gizmo/镜头截图静态审计
 * （change: add-model-editor-gizmo-shot-capture，任务 5.4）。
 *
 * 纯静态断言，读取仓库源文本：
 * - 生产路径不创建第二个 canvas / renderer；
 * - 不产生独立 camera/shot 画布节点或 edge；
 * - 镜头/截图不把 Blob、object URL、data URL 或临时签名 URL 写入 nodeData；
 * - 不新增媒体协议（复用既有 Media upload + asset.upsert）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");

function read(relative: string): string {
  return readFileSync(resolve(repoRoot, relative), "utf8");
}

describe("模型编辑/镜头截图静态审计", () => {
  it("镜头作为 nodeData.modelCameras 子资源，不新增 camera/shot 节点类型", () => {
    const commands = read("web/contracts/src/canvas/commands.ts");
    // 不出现独立的 shot/camera 节点命令。
    expect(commands.includes('"shot.add"')).toBe(false);
    expect(commands.includes('"camera.add"')).toBe(false);
    // 镜头通过既有 nodeData.patch 写入。
    expect(commands).toContain('"nodeData.patch"');
  });

  it("截图复用既有 Media upload 与原子 asset.upsert + node.add，不新增媒体协议", () => {
    const capture = read("web/frontend/src/cordis/plugins/model-editor/model-shot-capture.ts");
    expect(capture).toContain("planUploadedNode");
    expect(capture).toContain("buildUploadedAsset");
    // 不自行发起新的 fetch/协议。
    expect(capture.includes("fetch(")).toBe(false);
  });

  it("截图会话不把 Blob/object URL 写入 nodeData 或命令", () => {
    const capture = read("web/frontend/src/cordis/plugins/model-editor/model-shot-capture.ts");
    // 命令构造路径不含 data:/blob: URL 字面量，也不创建 object URL。
    expect(capture.includes("data:image")).toBe(false);
    expect(capture.includes("createObjectURL")).toBe(false);
    // 不把内部 Blob 引用塞进命令 value。
    expect(capture.includes("url: blob")).toBe(false);
  });

  it("capture camera 在同一 Bevy App 内（不创建第二个 canvas/window）", () => {
    // change: add-reusable-bevy-shot-camera —— 离屏 Image/capture 相机由可复用 shot_camera 模块
    // 拥有；兼容 adapter（capture.rs）只路由请求，不再自行创建相机。
    const preview = read("bevy/src/shot_camera/runtime.rs");
    expect(preview).toContain("RenderTarget::Image");
    expect(preview).toContain("Camera3d");
    const capture = read("bevy/src/shot_camera/capture.rs");
    expect(capture).toContain("Screenshot");
    // 不创建第二个窗口 / 第二个 renderer。
    for (const source of [preview, capture, read("bevy/src/model3d/capture.rs")]) {
      expect(source.includes("Window {")).toBe(false);
      expect(source.includes("new_windows")).toBe(false);
    }
  });

  it("镜头 session-only 字段不进入 canonical nodeData 白名单", () => {
    const runtime = read("web/contracts/src/canvas/domain/runtime-node-data.ts");
    // 选中/preview/capture 状态被列为 local-only（复制时丢弃）。
    expect(runtime).toContain('"selectedCameraId"');
    expect(runtime).toContain('"cameraPreviewUrl"');
    // 只有 modelCameras 进入 patch 白名单。
    expect(runtime).toContain("modelCameras");
  });
});
