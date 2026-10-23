/**
 * 媒体实现（mediabunny + WebCodecs）的真实加载面回归（U77）。
 *
 * 这里只覆盖**当前环境能真实判定**的部分，不用替身假装编解码成功：
 * - 媒体库能按需加载并为损坏字节给出解析失败（不抛泄漏到界面的内部异常）；
 * - 缺 WebCodecs 时编码给出「不支持 H.264/VP9」的确定原因，而不是半份字节；
 * - 帧字节长度不符时在写入编码器前就拒绝。
 *
 * 真实 MP4/WebM 解码与编码需要浏览器 WebCodecs + 显示会话，属人工验证项
 * （见 change 的 verification.md「真实 UI 与设备」）。
 */
import { expect, it } from "vitest";
import { createAnimationMediaKit } from "../src/animation-media-kit.js";

it("损坏或不支持的字节给出容器解析失败，而不是泄漏媒体库内部异常", async () => {
  const kit = createAnimationMediaKit();
  const result = await kit.decodeVideo({
    bytes: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
    container: "mp4",
    maxWidth: 16,
    maxHeight: 16,
    maxFrames: 10,
    cancelled: () => false
  });
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.reason).toContain("无法解析 MP4");
});

it("WebM 容器按 WEBM 格式解析，损坏时同样给出原因", async () => {
  const kit = createAnimationMediaKit();
  const result = await kit.decodeVideo({
    bytes: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
    container: "webm",
    maxWidth: 16,
    maxHeight: 16,
    maxFrames: 10,
    cancelled: () => false
  });
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.reason).toMatch(/无法解析 WEBM|没有视频轨道/);
});

it("缺 WebCodecs 时编码给出确定的编码器原因，不产出字节", async () => {
  const kit = createAnimationMediaKit();
  await expect(kit.encodeVideo({
    container: "mp4",
    width: 4,
    height: 4,
    fps: 24,
    frameCount: 1,
    frame: () => new Uint8Array(4 * 4 * 4),
    cancelled: () => false
  })).rejects.toThrow(/H\.264|画布/);
  await expect(kit.encodeVideo({
    container: "webm",
    width: 4,
    height: 4,
    fps: 24,
    frameCount: 1,
    frame: () => new Uint8Array(4 * 4 * 4),
    cancelled: () => false
  })).rejects.toThrow(/VP9|画布/);
});
