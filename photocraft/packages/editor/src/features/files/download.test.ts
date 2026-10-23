/**
 * U02/U03 副本交付的回归（change: 2026-10-22-add-photocraft-file-workflows）。
 *
 * 「复制整份文档」曾生成字节却无处交付（`onDuplicate` 无人提供），按钮可用、结果不可达。
 * 这里锁定两件事：字节**真的**交给浏览器下载；文件名不会被用户输入变成路径或丢扩展名。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { downloadBytes, projectFileName } from "./download.js";

/** 记录一次 `a.click()` 的下载请求并让 URL API 可用。 */
function captureDownload() {
  const created: string[] = [];
  const revoked: string[] = [];
  const clicked: { href: string; download: string }[] = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test/${created.length}`;
    created.push(url);
    return url;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); }) as typeof URL.revokeObjectURL;
  const createElement = document.createElement.bind(document);
  const spy = vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    const node = createElement(tag);
    if (tag === "a") {
      (node as HTMLAnchorElement).click = () => {
        clicked.push({ href: (node as HTMLAnchorElement).href, download: (node as HTMLAnchorElement).download });
      };
    }
    return node;
  }) as typeof document.createElement);
  return {
    clicked,
    created,
    revoked,
    restore() {
      spy.mockRestore();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  };
}

describe("U02/U03 副本字节交付", () => {
  it("把字节交给一次下载，并在之后释放 URL", () => {
    const capture = captureDownload();
    try {
      const result = downloadBytes(new Uint8Array([1, 2, 3]), "副本.pcraft");
      expect(result).toEqual({ ok: true });
      expect(capture.clicked).toEqual([{ href: "blob:test/0", download: "副本.pcraft" }]);
      // 释放 URL 是必须的：否则每复制一次就泄漏一份文档大小的内存引用。
      expect(capture.revoked).toEqual(["blob:test/0"]);
    } finally {
      capture.restore();
    }
  });

  it("空字节与不支持的环境明确拒绝，不假装已交付", () => {
    expect(downloadBytes(new Uint8Array([]), "x.pcraft")).toMatchObject({ ok: false });
    const originalCreate = URL.createObjectURL;
    // 模拟宿主环境没有 URL.createObjectURL。
    (URL as { createObjectURL?: unknown }).createObjectURL = undefined;
    try {
      const result = downloadBytes(new Uint8Array([1]), "x.pcraft");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("不支持本地下载");
    } finally {
      URL.createObjectURL = originalCreate;
    }
  });

  it("文件名去掉路径与控制字符，并保证 .pcraft 扩展名", () => {
    expect(projectFileName("海报")).toBe("海报.pcraft");
    expect(projectFileName("海报.pcraft")).toBe("海报.pcraft");
    expect(projectFileName("海报.PCRAFT")).toBe("海报.PCRAFT");
    // 用户输入不得变成路径穿越。
    expect(projectFileName("../../etc/passwd")).toBe("passwd.pcraft");
    expect(projectFileName("a\\b\\封面")).toBe("封面.pcraft");
    expect(projectFileName("封\u0000面")).toBe("封面.pcraft");
    // 空名回落稳定默认值，而不是产出 `undefined.pcraft` 或裸 `.pcraft`。
    expect(projectFileName("   ")).toBe("photocraft-副本.pcraft");
    expect(projectFileName("///")).toBe("photocraft-副本.pcraft");
  });
});
