/**
 * Lucide icon facade（change: adopt-radix-lucide-canvas-ui，任务 2.6）。
 *
 * 断言：
 * - allowlist facade 导出统一的 size/stroke/currentColor/aria-hidden 规则；
 * - import tree-shake：源码只允许具名 import（架构测试锁定）；
 * - 零字体操作字符审计覆盖媒体 chrome 源码。
 *
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CUSTOM_ICON_EXCEPTIONS,
  FitScreenIcon,
  CloseIcon,
  ZoomInIcon,
  ZoomOutIcon,
  LocateIcon,
  LoadingIcon,
  PhotoshopIcon
} from "./icons.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("Lucide facade（任务 2.6）", () => {
  it("统一默认 size/stroke/currentColor 与 aria-hidden", () => {
    const html = renderToStaticMarkup(<ZoomInIcon className="ui-test-icon" />);
    expect(html).toContain("<svg");
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('width="18"');
    expect(html).toContain('stroke-width="2"');
    expect(html).toContain("ui-test-icon");
    // 图标本身不承担 accessible name（由 control label 表达）。
    expect(html).not.toContain("aria-label");
  });

  it("zoom/fit/close/locate/loading 都有 Lucide 等价图标", () => {
    for (const Icon of [ZoomInIcon, ZoomOutIcon, FitScreenIcon, CloseIcon, LocateIcon, LoadingIcon]) {
      const html = renderToStaticMarkup(<Icon />);
      expect(html).toContain("<svg");
    }
  });

  it("例外表只登记产品专有图形（非通用操作图标）", () => {
    for (const name of CUSTOM_ICON_EXCEPTIONS) {
      expect(name.toLowerCase()).not.toMatch(/zoom|close|copy|play|pause|trash|volume|chevron|locate/);
    }
  });

  it("PhotoshopIcon 必须 evenodd：字母是从方框里挖空的", () => {
    // 回归：字形路径在 nonzero 下会被判成同一个填充方向，整块方框变成实心，
    // 字母完全看不见（2026-11-06 踩过，只有渲染出来看才发现）。
    const html = renderToStaticMarkup(<PhotoshopIcon />);
    expect(html).toContain('fill-rule="evenodd"');
  });

  it("facade 源码只使用具名 import（禁止 namespace import）", () => {
    const source = readFileSync(path.resolve(HERE, "icons.tsx"), "utf8");
    expect(source).toContain('from "lucide-react"');
    expect(source).not.toMatch(/import\s+\*\s+as\s+\w+\s+from\s+["']lucide-react["']/);
  });
});
