/**
 * 剩余 Canvas UI 迁移架构审计
 * （change: adopt-radix-remaining-canvas-ui，任务 8.2 / design D1–D8）。
 *
 * 静态保证（在 `adopt-radix-lucide-canvas-ui` 的 import firewall 之上）：
 * - 业务 Plugin 不再自绘通用操作 `<svg>`，也不再用字体/emoji 字符充当操作图标；
 * - 业务 Plugin 不为可迁移的浮层新增 document/window 级 outside-click/Escape 监听；
 * - 手写 `role="menu"` / `role="tablist"` 导航被 primitive 取代；
 * - 允许的例外（产品专有图形、装饰符号、Lexical/Bevy-owned）显式登记。
 *
 * @vitest-environment node
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PLUGINS_DIR = path.join(SRC_ROOT, "cordis", "plugins");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "bevy-wasm"]);

function walk(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match.test(entry.name)) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function productionFiles(dir: string): string[] {
  return walk(dir, /\.(ts|tsx)$/).filter(
    (file) => !file.includes(".test.") && !file.includes("/test-support/")
  );
}

/**
 * 允许保留的自绘通用图形/装饰符号的显式例外（文件相对路径）。
 *
 * 独立安装的编辑器由各扩展自行维护 UI primitives 与样式；本审计只看宿主 `cordis/plugins`。
 */
const SVG_EXCEPTIONS = new Set<string>([
  // 发送/执行的实心纸飞机是产品专有图形（Lucide Send 线条风格不等价）。
  "cordis/plugins/task-execution/execution-panel/icons.tsx",
  // 小地图是画布空间的自定义数据可视化（节点/连线/视口框），不是可替换的通用操作图标
  // （2026-10-26）。
  "cordis/plugins/canvas-shell/canvas-minimap.tsx",
  // 开发期报错助手是**开发工具**（仅在 DEV 构建加载），警告三角不值得为它引入图标库
  // （change: 2026-10-30-add-dev-error-assistant）。
  "cordis/plugins/dev-error-assistant/panel.tsx"
]);

/** 允许保留字体/装饰符号的文件（纯装饰、无独立交互语义）。 */
const GLYPH_EXCEPTIONS = new Set<string>([
  // 分节符（纯装饰）与帧选中标记（状态指示，非操作图标）。
  "cordis/plugins/task-execution/execution-panel/format-toolbar.tsx",
  "cordis/plugins/video-capture/frame-capture-dialog.tsx"
]);

/**
 * 允许保留手写 `<button>` 的文件（不可迁移：rich-text 富文本约定或 Lexical-owned）。
 *
 * 注：审计不笼统禁止 `<button>` —— Radix `Trigger asChild`、语义化 list item、form 控件与
 * 富文本格式栏本就需要原生 button。真正被禁止的是「自绘通用图标/字体操作字符/手写
 * menu·tablist 导航/手写浮层 dismiss」，由上方的专门断言覆盖。
 */
const BUTTON_EXCEPTIONS = new Set<string>([
  "cordis/plugins/task-execution/execution-panel/format-toolbar.tsx",
  "cordis/plugins/task-execution/mention/lexical-typeahead-menu.tsx"
]);

/** 允许保留手工浮层 dismiss 的文件（不可迁移：Lexical/Bevy-owned 或 host 层级路由）。 */
const LISTENER_EXCEPTIONS = new Set<string>([
  // Lexical typeahead 生命周期由 LexicalTypeaheadMenuPlugin 拥有。
  "cordis/plugins/task-execution/mention/MentionEditor.tsx",
  // execution host 的 panel/expanded Escape 分层是宿主层级路由，非同层浮层。
  "cordis/plugins/task-execution/model-execution-host.tsx",
  // 共享的 useEscapeLayer 工具本身实现 window keydown（由例外文件消费）。
  "cordis/plugins/task-execution/execution-panel/panel-shared.ts",
  // 视频 overlay canvas 的 resize 重绘由 canvas 拥有，非 DOM 浮层。
  "cordis/plugins/video-capture/video-edit-overlay.ts",
  // 视频编辑 dialog 的 Escape 分层（先关标注/再关）由 dialog 拥有。
  "cordis/plugins/video-capture/video-edit-dialog.tsx",
  // 场景体验条监听画布上的任意输入/Escape 以取消取景导航，不是浮层 dismiss。
  "cordis/plugins/scene-experience/experience-bar.tsx",
]);

describe("剩余 Canvas UI 迁移审计（任务 8.2）", () => {
  it("业务 Plugin 不自绘通用操作 <svg>（除登记例外）", () => {
    const offenders: string[] = [];
    for (const file of productionFiles(PLUGINS_DIR)) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (SVG_EXCEPTIONS.has(relative)) continue;
      if (/<svg\b/.test(stripComments(readFileSync(file, "utf8")))) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it("业务 Plugin 不用字体/emoji 字符充当操作图标（除登记装饰例外）", () => {
    const opGlyphs = /[\u270F\u2716\u2714\u25AD\u21B6\u21B7\u2728\u2699\u2699\uFE0F]/u;
    const offenders: string[] = [];
    for (const file of productionFiles(PLUGINS_DIR)) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (GLYPH_EXCEPTIONS.has(relative)) continue;
      const source = readFileSync(file, "utf8");
      if (/<button[^>]*>\s*[✏️✕▭↶↷✨]/u.test(source) || opGlyphs.test(source) && /<button[^>]*>\s*[^\s<]/u.test(source)) {
        // 仅当字形直接出现在按钮子节点时才算违规，避免误伤 aria-label/注释。
        const buttonGlyph = /<button[^>]*>\s*([✏✕✖▭↶↷✨✓✔×⋯])/u.test(source);
        if (buttonGlyph) offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("业务 Plugin 不为可迁移浮层新增 document/window outside-click/Escape 监听（除例外）", () => {
    const offenders: string[] = [];
    for (const file of productionFiles(PLUGINS_DIR)) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (LISTENER_EXCEPTIONS.has(relative)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      if (
        /(?:document|window|globalThis)\.addEventListener\(\s*["'](mousedown|pointerdown|keydown|Escape)["']/.test(
          source
        )
      ) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("手写 role=menu/tablist 导航只在 primitive/Lexical 例外内出现", () => {
    const allowed = new Set<string>([
      // Lexical typeahead 菜单（ownership 归 Lexical）。
      "cordis/plugins/task-execution/mention/lexical-typeahead-menu.tsx",
      // 参考 picker 是 listbox 组合，由 Popover 承载。
      "cordis/plugins/task-execution/reference-chips.tsx",
      // 键盘路由里的 selector 字符串（不是渲染的 markup）。
      "cordis/plugins/canvas-shell/input/shortcuts.ts",
      // 核心服务配置的横向标签切换：带计数徽标与稳定 data-testid 契约，
      // Tabs/SegmentedControl 无法透传逐项 testid 与徽标组合
      // （change: 2026-10-21-unify-assistant-execution 引入）。
      "cordis/plugins/settings/backend-settings-section.tsx",
      // 市场来源切换：逐项带「不可用」徽标与来源专属样式，SegmentedControl 无法承载
      // 逐项内容（2026-10-28 扩展层级导航引入）。
      "cordis/plugins/settings/marketplace-install-ui.tsx"
    ]);
    const offenders: string[] = [];
    for (const file of productionFiles(PLUGINS_DIR)) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (allowed.has(relative)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      // 只匹配 JSX 属性形式的 role=，不匹配 selector 字符串（'[role="menu"]'）。
      if (/\srole="(menu|menuitem|menuitemradio|tablist|tab)"/.test(source)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it("手写 icon-only <button> 只在登记例外内出现（其余走生产 IconButton）", () => {
    const offenders: string[] = [];
    for (const file of productionFiles(PLUGINS_DIR)) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      if (BUTTON_EXCEPTIONS.has(relative)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      // 只定位「aria-label + 仅含图标/glyph、无可见文本」的原生 button（应为 IconButton）。
      // 带可见标签的组合按钮、Radix Trigger 与 form 控件不受此约束。
      for (const match of source.matchAll(
        /<button\b([^>]*)>\s*([^<]{0,6})\s*<\/(?:)button>/g
      )) {
        const attrs = match[1] ?? "";
        const inner = (match[2] ?? "").trim();
        if (/aria-label=/.test(attrs) && inner.length > 0) offenders.push(`${relative}: ${inner}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("例外表不得登记已被 primitive 覆盖的通用控件文件", () => {
    // 防止用例外表把可迁移控件「合法化」。
    for (const entry of SVG_EXCEPTIONS) {
      expect(entry.toLowerCase()).not.toMatch(/zoom|close|play|pause|trash|volume|chevron|menu/);
    }
  });
});
