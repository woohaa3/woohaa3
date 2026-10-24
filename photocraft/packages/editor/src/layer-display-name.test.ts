/**
 * 图层/笔刷名的中文显示（A11）。
 *
 * 默认名来自内核（也是 PSD 里的同一个字段），所以只翻译**显示**：存储名不动，
 * 外部软件打开同一份工程时图层名仍然对得上。
 */
import { describe, expect, it } from "vitest";
import { displayBrushGroupName, displayBrushPresetName, displayLayerName } from "./layer-display-name.js";

describe("displayLayerName", () => {
  it("翻译引擎默认图层名", () => {
    expect(displayLayerName("Layer")).toBe("图层");
    expect(displayLayerName("Layer 0")).toBe("图层 0");
    expect(displayLayerName("Layer 3")).toBe("图层 3");
  });

  it("翻译拷贝名，并保住第二份拷贝的序号", () => {
    expect(displayLayerName("Layer 0 copy")).toBe("图层 0 拷贝");
    expect(displayLayerName("Layer 0 copy 2")).toBe("图层 0 拷贝 2");
    expect(displayLayerName("Layer copy")).toBe("图层 拷贝");
  });

  it("翻译默认调整层名", () => {
    expect(displayLayerName("Curves")).toBe("曲线");
    expect(displayLayerName("Curves 1")).toBe("曲线 1");
    expect(displayLayerName("Photo Filter 2")).toBe("照片滤镜 2");
    expect(displayLayerName("Black & White")).toBe("黑白");
  });

  it("用户命名层的拷贝也换成本地「拷贝」", () => {
    expect(displayLayerName("开业啦 copy")).toBe("开业啦 拷贝");
    expect(displayLayerName("开业啦 copy 3")).toBe("开业啦 拷贝 3");
    expect(displayLayerName("海报 copy")).toBe("海报 拷贝");
  });

  it("用户起的名字原样显示（不猜、不改）", () => {
    for (const name of ["开业海报", "Curves layer", "我的 Layer 0", "Layer 0a", "background"]) {
      expect(displayLayerName(name)).toBe(name);
    }
  });

  it("空名与非法输入不抛", () => {
    expect(displayLayerName("")).toBe("");
    expect(displayLayerName(undefined as unknown as string)).toBeUndefined();
  });
});

describe("笔刷名", () => {
  it("翻译程序性默认笔刷名与分组", () => {
    expect(displayBrushPresetName("Hard Round")).toBe("硬边圆");
    expect(displayBrushPresetName("Soft Round")).toBe("柔边圆");
    expect(displayBrushGroupName("round")).toBe("圆形");
    expect(displayBrushGroupName("sampled")).toBe("采样笔尖");
  });

  it("导入的笔刷保留自己的名字", () => {
    expect(displayBrushPresetName("猫爪印")).toBe("猫爪印");
    expect(displayBrushGroupName("我的笔刷")).toBe("我的笔刷");
  });
});
