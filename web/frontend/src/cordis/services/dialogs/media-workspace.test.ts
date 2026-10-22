/**
 * 媒体工作区静态审计
 * （change: 2026-09-29-align-node-media-dialogs，任务 1.1 / 1.2 / 1.3；
 *  change: adopt-radix-lucide-canvas-ui 任务 1.4：旧“Frontend 不得依赖 Radix/Lucide”
 *  守卫替换为 import firewall + icon 例外守卫）。
 *
 * 纯静态断言，锁定以下不变量：
 * - 媒体 Dialog 的生产源码不再用字体字符实现关闭/缩放/播放/静音/移除控件；
 * - 共享媒体工作区 CSS 只消费 `--app-*`，业务私有 `--mc-*` 不再出现在该区域；
 * - Radix/Lucide 由生产 Frontend 拥有（`shared/ui`），不再是 Showcase-only
 *   依赖；此处只锁定“唯一入口”边界，不禁止生产依赖本身。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, "../../../");
const UI_CSS = readFileSync(path.resolve(HERE, "../../ui/ui.css"), "utf8");
const FRONTEND_PKG = JSON.parse(
  readFileSync(path.resolve(HERE, "../../../../package.json"), "utf8")
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

/** 递归列出生产源码文件。 */
function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

/** 媒体 Dialog 生产源码（renderer + 共享 primitives）。 */
const MEDIA_SOURCES = [
  path.resolve(HERE, "Dialog.tsx"),
  path.resolve(HERE, "MediaDialog.tsx"),
  path.resolve(HERE, "../../plugins/video-capture/frame-capture-dialog.tsx"),
  path.resolve(HERE, "../../plugins/video-capture/video-edit-intents.tsx")
].map((file) => ({ file, source: readFileSync(file, "utf8") }));

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("媒体 Dialog 控件语言（任务 1.2）", () => {
  it("生产源码不再用字体字符实现关闭/缩放/播放/静音/移除", () => {
    const glyphs = ["✕", "▶", "❚❚", "🔇", "🔊"];
    for (const { file, source } of MEDIA_SOURCES) {
      const body = stripComments(source);
      for (const glyph of glyphs) {
        expect(body, `${path.basename(file)} 含字体字符 ${glyph}`).not.toContain(glyph);
      }
    }
  });

  it("图标按钮必须提供可访问名称（label）与可见 focus", () => {
    expect(UI_CSS).toMatch(/\.dlg__icon-button:focus-visible\s*\{[^}]*outline/);
    const dialog = readFileSync(path.resolve(HERE, "Dialog.tsx"), "utf8");
    // DialogIconButton 强制 label 作为可访问名；tooltip 作为原生 title 提示。
    expect(dialog).toContain("label: string");
    expect(dialog).toContain('label={props.label}');
    expect(dialog).toContain("title={props.tooltip}");
  });

  it("Radix/Lucide 是 Frontend 生产依赖，但 import 只存在于 primitives 层（import firewall）", () => {
    const deps = { ...(FRONTEND_PKG.dependencies ?? {}), ...(FRONTEND_PKG.devDependencies ?? {}) };
    // 生产 Frontend 拥有依赖（不再是 Showcase-only）。
    const radixDeps = Object.keys(deps).filter((name) => /^@radix-ui\//.test(name));
    expect(radixDeps.length).toBeGreaterThan(0);
    expect(Object.keys(deps).some((name) => /lucide/i.test(name))).toBe(true);

    // import firewall：Radix/Lucide imports 只允许出现在 shared/ui。
    const primitivesDir = path.join(SRC_ROOT, "shared", "ui");
    const offenders: string[] = [];
    for (const file of productionFiles(SRC_ROOT)) {
      if (file.startsWith(primitivesDir + path.sep)) continue;
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      if (/from\s+["']@radix-ui\//.test(source) || /from\s+["']lucide-react["']/.test(source)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("媒体工作区主题消费（任务 1.3）", () => {
  it("共享媒体工作区 chrome 区域无 --mc-* 引用", () => {
    const start = UI_CSS.indexOf(".dlg__body--media-workspace");
    const end = UI_CSS.indexOf(".dlg__section", start);
    const workspace = UI_CSS.slice(start, end);
    expect(workspace.length).toBeGreaterThan(0);
    expect(workspace).not.toContain("--mc-");
  });

  it("视频截帧 dialog 区域无 --mc-* 引用", () => {
    const start = UI_CSS.indexOf(".video-frame-dialog__preview");
    const end = UI_CSS.indexOf(".video-edit-dialog__timeline {", start);
    const capture = UI_CSS.slice(start, end);
    expect(capture.length).toBeGreaterThan(0);
    expect(capture).not.toContain("--mc-");
  });

  it("媒体 token 只作用于舞台与画面叠层", () => {
    // `.dlg__stage` 使用 media surface；chrome（header/toolbar/footer）使用 app token。
    expect(UI_CSS).toMatch(/\.dlg__stage\s*\{[^}]*var\(--app-media-dialog-surface\)/);
    expect(UI_CSS).toMatch(/\.dlg__header\s*\{[^}]*flex-shrink:\s*0/);
    expect(UI_CSS).toMatch(/\.dlg__footer\s*\{[^}]*var\(--app-web-border\)/);
  });
});

describe("媒体工作区 composition（任务 1.1）", () => {
  it("普通 Dialog DOM 不受影响：standard/sheet 无媒体工作区节点", () => {
    const dialog = readFileSync(path.resolve(HERE, "Dialog.tsx"), "utf8");
    // slots 是纯组合函数，仅在业务 renderer 显式使用时才产生节点。
    expect(dialog).toContain("export function DialogMediaWorkspace");
    expect(dialog).toContain("export function DialogStage");
    // standard/sheet variant 规则保留。
    expect(UI_CSS).toContain(".dlg--sheet");
    expect(UI_CSS).toContain(".dlg--alert");
  });

  it("Content 外框不依赖媒体 intrinsic size", () => {
    // stage 自身裁切（overflow hidden）且工作区高度由可用空间决定，不由媒体尺寸撑开。
    expect(UI_CSS).toMatch(/\.dlg__stage\s*\{[^}]*overflow:\s*hidden/);
    expect(UI_CSS).toMatch(/\.dlg__media-workspace\s*\{[^}]*height:\s*100%/);
  });
});
