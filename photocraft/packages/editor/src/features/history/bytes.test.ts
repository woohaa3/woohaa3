/**
 * 字节往返回归（U75 ATN / U76 批处理与数据集交付）。
 *
 * 跨 wasm 边界的字节统一走 base64：这里验证大字节不爆栈、非法输入返回 null 而不是抛异常，
 * 以及交付文件名的主干提取。纯函数测试，不加载 wasm。
 */
import { describe, expect, it } from "vitest";
import { fileStem, fromBase64, toBase64 } from "./bytes.js";

describe("base64 往返", () => {
  it("往返保持字节不变（含 0 与 255）", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    expect(toBase64(bytes)).toBe("AAF/gP7/");
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  it("空字节得到空串，且空串解回空数组", () => {
    expect(toBase64(new Uint8Array())).toBe("");
    expect(fromBase64("")).toEqual(new Uint8Array());
  });

  it("超过单次展开上限的字节也不爆栈（1 MiB）", () => {
    const bytes = new Uint8Array(1024 * 1024).fill(0xa5);
    const encoded = toBase64(bytes);
    expect(encoded.length).toBe(Math.ceil(bytes.length / 3) * 4);
    const decoded = fromBase64(encoded);
    expect(decoded?.length).toBe(bytes.length);
    expect(decoded?.[0]).toBe(0xa5);
    expect(decoded?.at(-1)).toBe(0xa5);
  });

  it("容忍 base64 里的换行/空白（PEM 风格的行宽）", () => {
    expect(fromBase64("AAF/\ngP7/\n")).toEqual(new Uint8Array([0, 1, 127, 128, 254, 255]));
  });

  it("非法 base64 返回 null，不抛异常", () => {
    expect(fromBase64("不是 base64")).toBeNull();
    expect(fromBase64("A")).toBeNull();
    expect(fromBase64("AA=A")).toBeNull();
  });
});

describe("交付文件名", () => {
  it("去掉最后一个扩展名，但保留点开头的名字", () => {
    expect(fileStem("actions.atn")).toBe("actions");
    expect(fileStem("色彩 组.atn")).toBe("色彩 组");
    expect(fileStem("a.b.png")).toBe("a.b");
    expect(fileStem("无扩展名")).toBe("无扩展名");
    expect(fileStem(".hidden")).toBe(".hidden");
  });
});
