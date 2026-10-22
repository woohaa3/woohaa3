import { describe, expect, it } from "vitest";
import { furnaceUploadFile } from "../src/frontend/upload-file.js";

describe("保留无 decoder 原件", () => {
  it("未知 MIME 转为惰性 binary，字节/名称/时间不变", async () => {
    const file = new File([new Uint8Array([0,255,12])], "scene.glb", { type: "model/gltf-binary", lastModified: 42 });
    const uploaded = furnaceUploadFile(file);
    expect(uploaded.type).toBe("application/octet-stream");
    expect(uploaded.name).toBe(file.name);
    expect(uploaded.lastModified).toBe(42);
    expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(new Uint8Array(await file.arrayBuffer()));
  });
  it("支持的媒体不改变上传类型", () => {
    const file = new File(["png"], "hero.png", { type: "image/png" });
    expect(furnaceUploadFile(file)).toBe(file);
  });
});
