/**
 * Dialog system 架构审计（change: add-frontend-dialog-system，任务 5.4 / 6.1 / design D9；
 * change: adopt-frontend-cordis-plugin-runtime 迁移到 cordis 树）。
 *
 * 静态保证：
 * - 已迁移弹窗不再保留第二套 document-level Escape/遮罩/焦点管理器；
 * - Dialog 只在 Frontend，不进入 contracts/services 服务实现；
 * - 生产代码里 document-level 的 Escape 监听只由 DialogHost 拥有。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REPO_WEB = path.resolve(SRC_ROOT, "..", "..");

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

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

/** 去掉注释，避免解释性提及触发误报。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function productionFiles(dir: string): string[] {
  return walk(dir, /\.(ts|tsx)$/).filter((file) => !file.includes(".test.") && !file.includes("/test-support/"));
}

describe("Dialog system 架构审计", () => {
  it("media-preview 迁移后不再存在 MediaLightbox 组件", () => {
    const files = productionFiles(SRC_ROOT);
    const offenders = files.filter((file) => /MediaLightbox/.test(stripComments(readFileSync(file, "utf8"))));
    expect(offenders.map((file) => path.relative(SRC_ROOT, file))).toEqual([]);
  });

  it("document-level keydown 实现已由 Radix adapter 接管（Host 内无手写 Escape/Tab 实现）", () => {
    const files = productionFiles(SRC_ROOT);
    const withDocumentKeydown = files.filter((file) => {
      const source = stripComments(readFileSync(file, "utf8"));
      return /document\.addEventListener\(\s*["']keydown["']/.test(source);
    });
    // change: adopt-radix-lucide-canvas-ui 任务 6.3：Escape/outside/Tab 契约改由 Radix
    // DialogSurface（DismissableLayer + FocusScope）承担；Host 不再自己 addEventListener。
    const relative = withDocumentKeydown.map((file) => path.relative(SRC_ROOT, file)).sort();
    expect(relative).toEqual([]);
    const host = readFileSync(path.join(SRC_ROOT, "cordis", "services", "dialogs", "DialogHost.tsx"), "utf8");
    expect(host).toContain("DialogSurfaceRoot");
    expect(host).not.toMatch(/trapTab/);
  });

  it("应用根不再维护 preview open state", () => {
    const files = [
      path.join(SRC_ROOT, "cordis", "app-host.tsx"),
      path.join(SRC_ROOT, "cordis", "plugins", "canvas-shell", "canvas-host.tsx")
    ];
    const combined = files.map((file) => stripComments(readFileSync(file, "utf8"))).join("\n");
    expect(combined).toContain("DialogHost");
    expect(combined).not.toContain("MediaLightbox");
    expect(combined).not.toMatch(/const \[preview,\s*setPreview\]/);
  });

  it("Dialog 代码不进入 contracts / 服务实现", () => {
    for (const unit of ["contracts/src", "services"]) {
      const dir = path.join(REPO_WEB, unit);
      const files = walk(dir, /\.(ts|tsx)$/);
      for (const file of files) {
        const source = stripComments(readFileSync(file, "utf8"));
        expect(source, `${path.relative(REPO_WEB, file)} 不应依赖 dialog system`).not.toContain("services/dialogs");
        expect(source).not.toContain("DialogHost");
      }
    }
  });

  it("应用根不直接 open 未注册 dialog（媒体预览只经 Plugin 事件消费）", () => {
    const files = productionFiles(SRC_ROOT).filter(
      (file) => file.includes(`${path.sep}cordis${path.sep}`)
    );
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      const openCalls = source.match(/dialogId:\s*["'][^"']+["']/g) ?? [];
      for (const call of openCalls) {
        const normalized = call.replace(/\s+/g, " ");
        expect([
          "dialogId: MEDIA_PREVIEW_DIALOG_ID",
          "dialogId: ALERT_DIALOG_ID",
          "dialogId: PASTE_REPLACE_DIALOG_ID",
          "dialogId: SNIPPET_EDITOR_DIALOG_ID",
          "dialogId: SNIPPET_LIBRARY_DIALOG_ID",
          "dialogId: SNIPPET_DELETE_DIALOG_ID",
          "dialogId: SNIPPET_TAG_DELETE_DIALOG_ID",
          "dialogId: VIDEO_FRAME_CAPTURE_DIALOG_ID",
          "dialogId: VIDEO_EDIT_DIALOG_ID",
          // ChatGPT 授权入口打开 Provider 凭据弹窗（change: 2026-10-08-add-chatgpt-oauth-3d-generation）。
          "dialogId: \"provider-credentials\"",
          // 画布内设置（change: 2026-10-17-move-settings-into-canvas-dialog）：唯一
          // 注册者为 settings 插件，E2E 镜像经 CanvasNavigation.requestOpenDialog 打开。
          "dialogId: SETTINGS_DIALOG_ID",
          'dialogId: "agent-assistant"',
          'dialogId: "settings"'
        ]).toContain(normalized);
      }
    }
  });

  it("窄屏 fullscreen 弹窗不使用 100vw（不应溢出 overlay 安全区内边距）", () => {
    // 回归：overlay 是 `display:grid; place-items:center` 且含安全区内边距，
    // `@media (max-width:560px)` 下 `.dlg--fullscreen { width: 100vw }` 会让弹窗宽度超过
    // overlay content box 并向两侧溢出，导致窄屏横向滚动（`video-dialogs.spec.ts` 390×844）。
    const css = readFileSync(path.join(SRC_ROOT, "cordis", "ui", "ui.css"), "utf8");
    const media = css.match(/@media \(max-width: 560px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(media).toContain(".dlg--fullscreen");
    const fullscreen = media.match(/\.dlg--fullscreen\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(fullscreen).toContain("width: 100%");
    expect(fullscreen).not.toContain("100vw");
  });
});
