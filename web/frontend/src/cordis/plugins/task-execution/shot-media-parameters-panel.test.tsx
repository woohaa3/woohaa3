import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShotMediaParametersPanel } from "./shot-media-parameters-panel.js";

const VIDEO = {
  kind: "video" as const,
  title: "运镜",
  width: 720,
  height: 1280,
  aspect: "9:16",
  durationSeconds: 3,
  frameRate: 30,
  loop: true
};

const IMAGE = {
  kind: "image" as const,
  title: "定妆照",
  width: 1280,
  height: 720,
  aspect: "16:9",
  durationSeconds: 0,
  frameRate: 0,
  loop: false
};

describe("镜头参数面板", () => {
  it("视频显示分辨率、画幅、时长、帧率与循环，并保留关闭入口", () => {
    const html = renderToStaticMarkup(<ShotMediaParametersPanel nodeId="shot" parameters={VIDEO} onClose={() => undefined} />);
    expect(html).toContain("镜头视频参数");
    expect(html).toContain("运镜");
    expect(html).toContain("视频");
    expect(html).toContain("720 × 1280");
    expect(html).toContain("9:16");
    expect(html).toContain("3 秒");
    expect(html).toContain("30 fps");
    expect(html).toContain("循环");
    expect(html).toContain("关闭执行面板");
    expect(html).toContain("由所属片场镜头托管");
  });

  it("静态图片不显示时长、帧率与播放状态", () => {
    const html = renderToStaticMarkup(<ShotMediaParametersPanel nodeId="shot" parameters={IMAGE} />);
    expect(html).toContain("镜头图片参数");
    expect(html).toContain("图片");
    expect(html).toContain("1280 × 720");
    expect(html).toContain("16:9");
    expect(html).not.toContain("时长");
    expect(html).not.toContain("帧率");
    expect(html).not.toContain("关闭执行面板");
  });
});
