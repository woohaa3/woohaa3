/**
 * U02 剪贴板来源的回归（change: 2026-10-22-add-photocraft-file-workflows）。
 *
 * spec 要求「剪贴板为空/失效、读取被拒绝」时说明**具体原因**。四种失败如果合并成一个
 * 「读取失败」，用户就不知道该换浏览器、去授权，还是先复制一张图——所以这里逐类断言。
 */
import { describe, expect, it } from "vitest";
import { readClipboardImage } from "./clipboard.js";

const imageBlob = (bytes: number[]) => new Blob([new Uint8Array(bytes)], { type: "image/png" });

/** 造一个只有指定类型与读取结果的剪贴板项。 */
const item = (types: string[], read: () => Promise<Blob>) => ({ types, getType: read });

const host = (read: () => Promise<readonly ReturnType<typeof item>[]>) => ({ clipboard: { read } });

describe("U02 剪贴板图像读取", () => {
  it("取到图像时返回字节与展示名", async () => {
    const result = await readClipboardImage(host(async () => [item(["image/png"], async () => imageBlob([1, 2, 3]))]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.bytes]).toEqual([1, 2, 3]);
    expect(result.label).toBe("剪贴板图像.png");
  });

  it("跳过文本项，取后面那张图像", async () => {
    const result = await readClipboardImage(host(async () => [
      item(["text/plain"], async () => new Blob(["hi"])),
      item(["image/tiff"], async () => imageBlob([9]))
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bytes.length).toBe(1);
    expect(result.label).toBe("剪贴板图像.tiff");
  });

  it("环境没有异步剪贴板 API 时明确说不支持，并指向文件选择", async () => {
    const result = await readClipboardImage({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unsupported");
    expect(result.message).toContain("选择图像文件");
  });

  it("权限被拒绝与被其它原因拒绝分开报告", async () => {
    const denied = new Error("denied");
    denied.name = "NotAllowedError";
    const refused = await readClipboardImage(host(async () => { throw denied; }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe("denied");
      expect(refused.message).toContain("剪贴板读取权限");
    }

    const other = await readClipboardImage(host(async () => { throw new Error("permissions policy"); }));
    expect(other.ok).toBe(false);
    if (!other.ok) {
      expect(other.reason).toBe("denied");
      // 不能把「策略禁用」也说成用户拒绝授权：要把真实原因带出来。
      expect(other.message).toContain("permissions policy");
    }
  });

  it("剪贴板里只有文本或为空时说明要先复制图像", async () => {
    const onlyText = await readClipboardImage(host(async () => [item(["text/plain"], async () => new Blob(["x"]))]));
    expect(onlyText.ok).toBe(false);
    if (!onlyText.ok) {
      expect(onlyText.reason).toBe("empty");
      expect(onlyText.message).toContain("请先复制一张图像");
    }

    const nothing = await readClipboardImage(host(async () => [] as const));
    expect(nothing.ok).toBe(false);
    if (!nothing.ok) expect(nothing.reason).toBe("empty");
  });

  it("有图像项但读不出字节时报告可重试原因", async () => {
    const unreadable = await readClipboardImage(host(async () => [
      item(["image/png"], async () => { throw new Error("decode blob failed"); })
    ]));
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) {
      expect(unreadable.reason).toBe("unreadable");
      expect(unreadable.message).toContain("重新复制");
    }
  });

  it("图像项字节为空时继续找下一项，而不是交出空字节", async () => {
    const result = await readClipboardImage(host(async () => [
      item(["image/png"], async () => imageBlob([])),
      item(["image/jpeg"], async () => imageBlob([7, 7]))
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.bytes]).toEqual([7, 7]);
    expect(result.label).toBe("剪贴板图像.jpeg");
  });
});
