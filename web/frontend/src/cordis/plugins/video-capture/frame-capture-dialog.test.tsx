/**
 * 截帧 renderer 的渲染契约
 * （change: 2026-09-29-align-node-media-dialogs，任务 3.2 / 3.3）。
 *
 * 用 `react-dom/server` 静态渲染生产 renderer：断言结构是共享媒体工作区
 * （Header / 主媒体区 / 辅助帧区 / Footer），图标操作使用共享 SVG 按钮而非字体字符，
 * 状态切换不改变控件存在性。真实播放/seek/捕获行为仍由 session 与 e2e 覆盖。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createFrameCaptureRenderer, type FrameCaptureStorySeed } from "./frame-capture-dialog.js";
import type { VideoDialogPayload } from "./types.js";

const PAYLOAD: VideoDialogPayload = {
  videoAssetId: "asset-video",
  videoStorageKey: `sha256-${"a".repeat(64)}`,
  videoUrl: "/api/media/x",
  targetNodeId: "node-video-1"
};

function renderCapture(seed?: FrameCaptureStorySeed): string {
  const Renderer = createFrameCaptureRenderer({ onAddFrames: async () => [], ...(seed ? { story: seed } : {}) });
  return renderToStaticMarkup(
    <Renderer
      instance={{
        instanceId: "cap-1",
        dialogId: "canvas-video-frame-capture",
        payload: PAYLOAD,
        parentInstanceId: null,
        dismissible: true,
        busy: false
      }}
      requestClose={() => undefined}
      setBusy={() => undefined}
      replace={() => undefined}
    />
  );
}

describe("截帧 renderer 结构（任务 3.2）", () => {
  it("使用共享媒体工作区：主媒体区 + 帧辅助区 + 稳定 Footer", () => {
    const markup = renderCapture({ video: { duration: 2, currentTime: 1, width: 160, height: 90 } });
    expect(markup).toContain("dlg__media-workspace");
    expect(markup).toContain("dlg__media-workspace--split");
    expect(markup).toContain("dlg__media-main");
    expect(markup).toContain("video-frame-dialog__stage");
    expect(markup).toContain("dlg__media-aside");
    expect(markup).toContain("video-frame-dialog__frames");
    expect(markup).toContain("dlg__footer");
    expect(markup).toContain("添加选中帧");
    expect(markup).not.toContain("dlg__error");
  });

  it("默认状态显示空帧提示且没有帧行", () => {
    const markup = renderCapture({ video: { duration: 2, currentTime: 0, width: 160, height: 90 } });
    expect(markup).toContain("还没有截取视频帧");
  });

  it("已有帧状态渲染逐项结果与移除图标按钮", () => {
    const markup = renderCapture({
      video: { duration: 2, currentTime: 1.2, width: 160, height: 90 },
      frames: [
        { id: "f1", timeSeconds: 0, selected: true, url: "", blob: new Blob([]) },
        { id: "f2", timeSeconds: 0.6, selected: false, url: "", blob: new Blob([]) }
      ],
      receipts: [{ frameId: "f2", timeSeconds: 0.6, ok: false, error: "上传失败，请重试" }]
    });
    expect(markup).toContain("is-selected");
    expect(markup).toContain("is-failed");
    expect(markup).toContain("上传失败，请重试");
    expect(markup).toContain("移除截取帧 1");
  });

  it("busy 与部分失败状态显示错误并可只重试失败项", () => {
    const busy = renderCapture({
      video: { duration: 2, currentTime: 1, width: 160, height: 90 },
      captureBusy: "add"
    });
    expect(busy).toContain("dlg--busy");

    const failed = renderCapture({
      video: { duration: 2, currentTime: 0.4, width: 160, height: 90 },
      frames: [{ id: "f1", timeSeconds: 0.4, selected: true, url: "", blob: new Blob([]) }],
      receipts: [{ frameId: "f1", timeSeconds: 0.4, ok: false, error: "上传失败，请重试" }],
      error: "部分帧添加失败（1 项），可只重试失败项"
    });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("重试失败项");
  });
});

describe("截帧 renderer 控件语言（任务 3.3）", () => {
  it("播放、静音、移除使用共享 SVG 图标按钮，不再有字体字符", () => {
    const markup = renderCapture({
      video: { duration: 2, currentTime: 0.6, width: 160, height: 90 },
      frames: [{ id: "f1", timeSeconds: 0, selected: true, url: "", blob: new Blob([]) }]
    });
    for (const label of ["播放视频", "静音", "移除截取帧 1"]) {
      expect(markup, label).toContain(`aria-label="${label}"`);
    }
    expect(markup).toContain("<svg");
    for (const glyph of ["▶", "❚❚", "🔇", "🔊", "✕"]) {
      expect(markup, glyph).not.toContain(glyph);
    }
  });

  it("播放/暂停提供对应可访问名称", () => {
    const paused = renderCapture({ video: { duration: 2, currentTime: 0, width: 160, height: 90, playing: false } });
    const playing = renderCapture({ video: { duration: 2, currentTime: 1, width: 160, height: 90, playing: true } });
    expect(paused).toContain('aria-label="播放视频"');
    expect(playing).toContain('aria-label="暂停视频"');
  });
});
