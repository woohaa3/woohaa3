import { describe, expect, it } from "vitest";
import { rasterizeDrawable, type RasterCanvas } from "./media-raster.js";

describe("媒体帧光栅化", () => {
  it("大图聚焦请求不超过 Bevy 2048 上限，同时保留原图尺寸与比例", () => {
    const source = { width: 6000, height: 3000 };
    const canvas: RasterCanvas = {
      width: 0, height: 0,
      getContext: () => ({
        drawImage: () => undefined,
        getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })
      })
    };
    const raster = rasterizeDrawable({}, source, () => canvas, 4096);
    expect(raster).toMatchObject({ width: 2048, height: 1024 });
    expect(raster?.pixels.length).toBe(2048 * 1024 * 4);
    expect(source).toEqual({ width: 6000, height: 3000 });
  });

  it("连续同尺寸帧复用缓冲区，尺寸改变时重新分配并保持比例", () => {
    let width = 0;
    let height = 0;
    let resizes = 0;
    const canvas: RasterCanvas = {
      get width() { return width; },
      set width(next) { width = next; resizes += 1; },
      get height() { return height; },
      set height(next) { height = next; resizes += 1; },
      getContext: () => ({
        drawImage: () => undefined,
        getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })
      })
    };
    for (let frame = 0; frame < 3; frame += 1) {
      const raster = rasterizeDrawable({}, { width: 160, height: 90 }, () => canvas);
      expect(raster).toMatchObject({ width: 160, height: 90 });
    }
    expect(resizes).toBe(2);
    const resized = rasterizeDrawable({}, { width: 320, height: 180 }, () => canvas, 160);
    expect(resized).toMatchObject({ width: 160, height: 90 });
    expect(resizes).toBe(2);
    rasterizeDrawable({}, { width: 90, height: 160 }, () => canvas);
    expect(resizes).toBe(4);
  });

  it("RGBA 转换保留完整色彩和透明度", () => {
    const data = new Uint8ClampedArray([0, 128, 255, 64]);
    const canvas: RasterCanvas = {
      width: 1, height: 1,
      getContext: () => ({ drawImage: () => undefined, getImageData: () => ({ data }) })
    };
    const raster = rasterizeDrawable({}, { width: 1, height: 1 }, () => canvas);
    expect(raster?.pixels).toEqual(new Uint8Array([0, 128, 255, 64]));
  });

  it("读像素画布声明 willReadFrequently，避免每帧 GPU→CPU 回读", () => {
    const options: Array<unknown> = [];
    const canvas: RasterCanvas = {
      width: 0, height: 0,
      getContext: (_type, next) => {
        options.push(next);
        return { drawImage: () => undefined, getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) };
      }
    };
    rasterizeDrawable({}, { width: 8, height: 8 }, () => canvas);
    expect(options).toEqual([{ willReadFrequently: true }]);
  });

  it("像素与 ImageData 共享同一缓冲，不做整帧复制", () => {
    const data = new Uint8ClampedArray(2 * 2 * 4).fill(7);
    const canvas: RasterCanvas = {
      width: 0, height: 0,
      getContext: () => ({ drawImage: () => undefined, getImageData: () => ({ data }) })
    };
    const raster = rasterizeDrawable({}, { width: 2, height: 2 }, () => canvas);
    expect(raster?.pixels.buffer).toBe(data.buffer);
    expect(raster?.pixels.byteOffset).toBe(data.byteOffset);
    // 视图写入即 ImageData 可见（未发生拷贝）。
    raster!.pixels[0] = 9;
    expect(data[0]).toBe(9);
  });
});
