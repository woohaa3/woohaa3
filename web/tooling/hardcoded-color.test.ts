/**
 * 硬编码 chrome 色守卫（change: unify-application-theme-tokens，任务 5.1 / design D9）。
 *
 * 扫描 Web 应用 CSS/TS/TSX 与 Bevy canvas chrome Rust 源码，阻止 canonical preset /
 * generated artifacts 之外新增 hex、rgb/hsl 或品牌 `Color::srgb*` 字面值。
 *
 * 允许例外按「文件 + 用途」精确登记，禁止整目录宽泛忽略。例外仅限：
 * 透明合成常量、用户/领域内容颜色、媒体像素处理、测试输入与明确第三方边界。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO_ROOT = path.resolve(WEB_ROOT, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "server-dist",
  ".git",
  "test-results",
  "playwright-report",
  "test-support"
]);

export type ColorViolation = { file: string; value: string };

/** 精确登记的例外：`repo 相对路径` → 用途说明。 */
export const COLOR_ALLOWLIST: Record<string, string> = {
  "web/ui/src/icons/mcp-client-marks.tsx": "第三方客户端品牌标记的原始配色，非应用 chrome",
  "web/frontend/src/cordis/services/model-download.ts": "导出模型材质的黑白回退值（领域内容色，非 UI chrome）",
  // canonical 生成物：本身即 token 定义来源（由 generate-theme-tokens.mjs 产出）。
  "web/ui/src/styles/generated-theme.css": "canonical --app-* token 定义（生成物）",
  // 用户选择的标注色（文字色 / 高亮色），属领域内容色，不随主题重写（design D9）。
  "web/frontend/src/cordis/plugins/task-execution/execution-panel/ExecutionPanel.tsx":
    "用户可选的标注/文字颜色默认值（领域内容色）",
  // 富文本格式工具栏：`<input type="color">` 的文字色 / 高亮色初始值，同样属领域内容色。
  "web/frontend/src/cordis/plugins/task-execution/execution-panel/format-toolbar.tsx":
    "用户可选的文字/高亮颜色默认值（领域内容色）",
  // 测试夹具：模型聚焦 harness 的 Scene IR 输入（测试输入，非 app chrome）。
  "web/frontend/src/cordis/plugins/canvas-shell/test-support/model-focus-harness.ts":
    "测试夹具的 Scene IR 模型颜色输入",
  // Bevy：authored 模型材质、媒体像素与中性灯光/回退色，均非 app chrome（design D9 / D5）。
  "bevy/src/model3d/scene.rs": "模型 authored baseColor/emissive 解析与中性回退",
  "bevy/src/model3d/mod.rs": "模型 authored color 解析与中性回退",
  "bevy/src/model3d/preview.rs": "原生 renderer 演示灯光/背景（非 canvas chrome）",
  // 颜色转换工具：接收调用方提供的 u32/分量，不含品牌字面值（仅数值移位）。
  "bevy/src/canvas2d/layout.rs": "u32 → Color 转换工具，非颜色字面值",
  "bevy/src/theme.rs": "hex → Color 转换与 token 访问器，非颜色字面值",
  // showcase 夹具：确定性占位媒体字节（内联 SVG），属媒体内容色而非 app chrome。
  "web/ui/showcase/src/task-history-fixtures.ts": "确定性占位媒体（内联 SVG）内容色",
  // showcase 夹具：生成历史占位缩略图（内联 SVG），同上属媒体内容色。
  "web/ui/showcase/src/canvas-history-fixtures.ts": "确定性占位媒体（内联 SVG）内容色",
  // showcase 夹具：用户标注色默认值（领域内容色），与 ExecutionPanel 同类。
  "web/ui/showcase/src/video-dialog-fixtures.tsx": "用户标注色默认值（领域内容色）",
  // showcase 夹具：程序化模型 fixture 的 Scene IR 输入（领域内容色，非 app chrome）。
  "web/ui/showcase/src/fixtures/shot-camera-fixture.tsx": "程序化模型 Scene IR 输入（领域内容色）",
  // showcase 夹具：图片编辑色板/原图占位内容色（领域内容色，与生产色板一致）。
  "web/ui/showcase/src/image-focus-fixtures.tsx": "图片编辑色板与原图占位内容色（领域内容色）"
};

/** 透明的中性合成常量（允许，不构成品牌色）。 */
function isNeutralLiteral(value: string): boolean {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return (
    normalized === "transparent" ||
    /^rgba?\(0,0,0,0(\.0+)?\)$/.test(normalized) ||
    /^rgba?\(255,255,255,0(\.0+)?\)$/.test(normalized)
  );
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/^[ \t]*#.*$/gm, "");
}

const WEB_COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/g;
/** Bevy 品牌色：`Color::srgb_u8(12, 34, 56)` 等含数字字面量的调用。 */
const BEVY_COLOR_PATTERN = /Color::(?:srgba?_u8|srgba?|srgb|rgb|rgba)\s*\(\s*\d/g;

/** 纯函数：给定文件内容与相对路径，返回违规颜色值（可注入 fixture 验证守卫有效性）。 */
export function scanHardcodedColors(input: {
  file: string;
  source: string;
  /** 只扫描与 chrome 相关的文件；false 时跳过（如无关模块）。 */
  chrome?: boolean;
}): ColorViolation[] {
  if (input.chrome === false) return [];
  if (COLOR_ALLOWLIST[input.file]) return [];
  const source = stripComments(input.source);
  const matches = source.match(WEB_COLOR_PATTERN) ?? [];
  const values = matches.filter((value) => !isNeutralLiteral(value));
  return values.map((value) => ({ file: input.file, value }));
}

/** 纯函数：Bevy chrome 文件的品牌 `Color::srgb*` 扫描。 */
export function scanHardcodedRustColors(input: {
  file: string;
  source: string;
}): ColorViolation[] {
  if (COLOR_ALLOWLIST[input.file]) return [];
  const source = stripComments(input.source);
  const matches = source.match(BEVY_COLOR_PATTERN) ?? [];
  return matches.map((value) => ({ file: input.file, value }));
}

function collectFiles(dir: string, match: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, match, out);
    else if (match.test(entry.name) && !/\.test\.|^tests\.rs$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("硬编码 chrome 色守卫（任务 5.1 / design D9）", () => {
  it("Web 应用 CSS/TS/TSX 不含未登记颜色 literal", () => {
    const files = [
      ...collectFiles(path.join(WEB_ROOT, "ui/src"), /\.(css|ts|tsx)$/),
      ...collectFiles(path.join(WEB_ROOT, "frontend/src"), /\.(css|ts|tsx)$/),
      ...collectFiles(path.join(WEB_ROOT, "ui/showcase/src"), /\.(css|ts|tsx)$/),
      ...collectFiles(path.join(WEB_ROOT, "ui/showcase/.ladle"), /\.(css|ts|tsx)$/)
    ];
    expect(files.length, "应至少扫描到一个 Web 文件").toBeGreaterThan(0);
    const violations: ColorViolation[] = [];
    for (const file of files) {
      // 例外清单用 `/` 分隔：Windows 上 `path.relative` 给的是 `\`，不归一就会整条失效。
      const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      violations.push(...scanHardcodedColors({ file: relative, source: readFileSync(file, "utf8") }));
    }
    expect(violations, format(violations)).toEqual([]);
  });

  it("Bevy 2D canvas chrome 不含品牌 Color::srgb* 字面值", () => {
    const files = collectFiles(path.join(REPO_ROOT, "bevy/src/canvas2d"), /\.rs$/);
    expect(files.length).toBeGreaterThan(0);
    const violations: ColorViolation[] = [];
    for (const file of files) {
      const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      violations.push(...scanHardcodedRustColors({ file: relative, source: readFileSync(file, "utf8") }));
    }
    expect(violations, format(violations)).toEqual([]);
  });

  it("守卫能检出故意新增的硬编码颜色（fixture）", () => {
    expect(
      scanHardcodedColors({ file: "web/frontend/src/cordis/ui/new.css", source: ".x { color: #ff0000; }" })
    ).toEqual([{ file: "web/frontend/src/cordis/ui/new.css", value: "#ff0000" }]);
    expect(
      scanHardcodedColors({ file: "web/frontend/src/cordis/ui/new.tsx", source: "const c = 'rgb(1, 2, 3)';" })
    ).toHaveLength(1);
    // 透明/中性常量放行。
    expect(
      scanHardcodedColors({ file: "web/frontend/src/cordis/ui/new.css", source: ".x { background: rgba(0, 0, 0, 0); }" })
    ).toEqual([]);
    // 登记例外放行。
    expect(
      scanHardcodedColors({ file: "web/ui/src/styles/generated-theme.css", source: ".x { color: #ff0000; }" })
    ).toEqual([]);
    // Bevy 品牌色检出。
    expect(
      scanHardcodedRustColors({ file: "bevy/src/canvas2d/mod.rs", source: "let c = Color::srgb_u8(1, 2, 3);" })
    ).toHaveLength(1);
  });

  it("allowlist 逐文件登记，不使用目录级忽略", () => {
    for (const [file, reason] of Object.entries(COLOR_ALLOWLIST)) {
      expect(file, reason).toMatch(/\.(css|ts|tsx|rs)$/);
      expect(file.endsWith("/"), `${file} 不能是目录`).toBe(false);
      expect(reason.length, file).toBeGreaterThan(0);
    }
  });
});

function format(violations: ColorViolation[]): string {
  return violations.map((v) => `${v.file} -> ${v.value}`).join("\n");
}
