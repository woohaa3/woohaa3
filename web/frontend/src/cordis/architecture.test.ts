/**
 * 前端插件运行时架构审计
 * （change: adopt-frontend-cordis-plugin-runtime，design D4/D7/D12）。
 *
 * 静态保证：
 * - 三大服务 API path 常量只存在于 `cordis/services/paths.ts`；
 * - feature/plugin 生产代码不直接创建 fetch/WebSocket/EventSource 或拼三大服务 path；
 * - feature 代码只存在于 `cordis/` 树下；
 * - 业务 registry 不在 import evaluation 时注册；
 * - 只有 kernel/bootstrap 创建 Cordis Context。
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = fileURLToPath(new URL("../", import.meta.url));
// wasm 绑定目录由构建生成（bevy-wasm 由 Rust 产物注入），
// 不参与「页面 / 共享 / feature 三层」的源码归属审计。
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

/** 路径归一为 posix，避免 Windows 的 `\` 让 `/test-support/` 之类的排除失效。 */
function isTestSupportOrTest(absoluteOrRelative: string): boolean {
  const normalized = absoluteOrRelative.split(path.sep).join("/");
  return normalized.includes(".test.") || normalized.includes("/test-support/");
}

function productionFiles(dir: string): string[] {
  return walk(dir, /\.(ts|tsx)$/).filter((file) => !isTestSupportOrTest(file));
}

const PATH_MODULE = path.join(SRC_ROOT, "cordis", "services", "paths.ts");
const CORDIS_DIR = path.join(SRC_ROOT, "cordis");

describe("前端协议边界审计", () => {
  it("三大服务 API path 字面量只出现在 cordis/services/paths.ts", () => {
    const files = productionFiles(SRC_ROOT).filter((file) => file !== PATH_MODULE);
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      if (/["'`]\/api\/(canvases|media|pptask|model-mcp)/.test(source)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("命令式 WebSocket/EventSource 只在 Cordis remote adapter 中创建", () => {
    const allowed = new Set<string>([
      path.join(CORDIS_DIR, "services", "canvas-remote.ts"),
      path.join(CORDIS_DIR, "services", "task-remote.ts"),
      path.join(CORDIS_DIR, "services", "media-remote.ts")
    ]);
    const offenders: string[] = [];
    for (const file of productionFiles(SRC_ROOT)) {
      if (allowed.has(file)) continue;
      const source = stripComments(readFileSync(file, "utf8"));
      if (/\bnew WebSocket\s*\(/.test(source) || /\bnew EventSource\s*\(/.test(source)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("业务 registry 不再有 import-time 注册副作用", () => {
    const offenders = productionFiles(SRC_ROOT).filter((file) => {
      const source = stripComments(readFileSync(file, "utf8"));
      return /^\s*registerBuiltinDialogs\s*\(/m.test(source) || /^\s*dialogRegistry\.register/m.test(source);
    });
    expect(offenders.map((file) => path.relative(SRC_ROOT, file))).toEqual([]);
  });

  it("Cordis Context 只在 kernel bootstrap 中创建", () => {
    const allowed = new Set<string>([path.join(CORDIS_DIR, "kernel.ts")]);
    const offenders = productionFiles(SRC_ROOT).filter((file) => {
      if (allowed.has(file)) return false;
      const source = stripComments(readFileSync(file, "utf8"));
      return /new Context\s*\(/.test(source);
    });
    expect(offenders.map((file) => path.relative(SRC_ROOT, file))).toEqual([]);
  });

  it("paths.ts 是唯一持有三大服务 path 的模块", () => {
    const pathOwners = productionFiles(SRC_ROOT).filter((file) => file.endsWith(`${path.sep}paths.ts`));
    expect(pathOwners).toEqual([PATH_MODULE]);
  });

  it("独立页面与共享模块位于页面/共享层，插件 feature 在 cordis/ 树下", () => {
    // change: 2026-10-10-extract-task-history-page：独立页面（pages/）与页面/Canvas/Showcase
    // 共用的只读契约与基础 UI（shared/）是显式分层，不再是 cordis 子树下的 feature。
    // change: 2026-10-10-unify-extension-frontend-entry：`extension-api/` 是对外的公共前端能力
    // 入口（leaf API），与 cordis 宿主树分层。
    const allowedTop = new Set(["bevy-wasm", "cordis", "desktop", "pages", "shared", "extension-api", "plugin-api", "media-image-wasm"]);
    const entries = readdirSync(SRC_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !SKIP_DIRS.has(name));
    expect(entries.filter((name) => !allowedTop.has(name))).toEqual([]);
  });

  it("Canvas feature 不维护第二套 menu/panel open state（change: unify-canvas-presentation-navigation）", () => {
    // 旧的 runtime menu API 与 controller panel open authority 已迁移到 Canvas Navigation。
    const offenders: string[] = [];
    for (const file of productionFiles(CORDIS_DIR)) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      const source = stripComments(readFileSync(file, "utf8"));
      // 禁止重新引入 runtime menu API（Canvas Navigation 的 closeMenu 是许可的 facade）。
      if (/canvasRuntime\.(subscribeMenu|setMenu|closeMenu|menu)\s*[(.]/.test(source)) {
        offenders.push(`${relative}: runtime menu API`);
      }
      // 禁止 feature 直接调用 controller 的 focus 入口（应经 Canvas Navigation adapter）。
      if (
        /canvasRuntime\.(enterModelFocus|exitModelFocusForHistory)\s*\(/.test(source) &&
        !relative.includes("canvas-runtime/host") &&
        !relative.includes("canvas-runtime/plugin")
      ) {
        offenders.push(`${relative}: direct canvasRuntime focus call`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("node-history/selection 不直接改变 runtime focus/open identity（change: fix-model-focus-navigation-and-camera-parity，task 1.4）", () => {
    const offenders: string[] = [];
    for (const file of productionFiles(path.join(CORDIS_DIR, "plugins", "node-history"))) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      const source = stripComments(readFileSync(file, "utf8"));
      // controller.close 不再是 UI open identity 入口：只能由 route cleanup 调用（plugin 的订阅）。
      const closeCalls = source.match(/controller\.close\(\)/g) ?? [];
      const inWorkspaceCleanup = relative.endsWith("canvas-history-browser.tsx") && /return \(\) => controller\.close\(\);/.test(source);
      const inSubscription = /else if \(state\) \{\s*controller\.close\(\);/m.test(source);
      if (closeCalls.length > 1 || (closeCalls.length === 1 && !inSubscription && !inWorkspaceCleanup)) {
        offenders.push(`${relative}: controller.close as open identity`);
      }
      // 历史 UI 不得直接驱动 runtime focus owner。
      if (/canvasRuntime\.(applyFocusTarget|enterDirectFocus|exitModelFocus)\s*\(/.test(source)) {
        offenders.push(`${relative}: direct runtime focus control`);
      }
    }
    // selection 不直接退出 runtime focus（应经 Navigation reconcile/invalidate）。
    const selection = stripComments(readFileSync(path.join(CORDIS_DIR, "plugins", "canvas-shell", "model-focus-lifecycle.ts"), "utf8"));
    if (/nodeSelectionStore/.test(selection)) {
      offenders.push("canvas-shell/model-focus-lifecycle.ts: selection drives focus exit");
    }
    expect(offenders).toEqual([]);
  });

  it("公共 focus 平台层不反向依赖具体 Plugin 或 shell 实现（change: 2026-10-12-unify-node-editors-and-focus-transitions，任务 2.5）", () => {
    // cordis/focus 是纯平台层：类型、几何、workspace/header 与 host。它可以依赖 typed slot /
    // Navigation 契约、kernel Service 与 shared UI，但 MUST NOT import 具体 editor/plugin 或
    // shell 的 React 实现（否则「公共层」会反向绑定业务，破坏唯一 owner 与替换性）。
    const focusDir = path.join(CORDIS_DIR, "focus");
    const offenders: string[] = [];
    for (const file of productionFiles(focusDir)) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      const source = stripComments(readFileSync(file, "utf8"));
      if (/from\s+["'][^"']*cordis\/plugins\//.test(source)) offenders.push(`${relative}: imports plugin`);
      // shell 的 React 实现（focus-workspace/focus-layout 等）不得被公共层反向引用。
      if (/from\s+["'][^"']*canvas-shell[^"']*["']/.test(source)) offenders.push(`${relative}: imports canvas-shell`);
    }
    expect(offenders).toEqual([]);
  });

  it("独立任务历史页面与插件适配层不 import Canvas Session/Runtime/plugins 或 Cordis UI", () => {    // change: 2026-10-10-extract-task-history-page：页面（pages/task-history）不依赖 Cordis
    // Context/Canvas 实现/Cordis 专属 UI；插件目录只保留宿主适配（路由与 Service 解析）。
    const offenders: string[] = [];
    const pageDir = path.join(SRC_ROOT, "pages", "task-history");
    for (const file of productionFiles(pageDir)) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      const source = stripComments(readFileSync(file, "utf8"));
      if (/canvas-session|canvas-runtime|canvas-navigation|plugins\/canvas-/.test(source)) offenders.push(`${relative}: canvas impl`);
      if (/from\s+["'][^"']*cordis\/ui/.test(source)) offenders.push(`${relative}: cordis ui`);
      if (/@deepseek-ai\/cordis/.test(source)) offenders.push(`${relative}: cordis context`);
    }
    // 旧插件目录只保留路由/Service/Router 适配，不含页面实现或页面专有导出。
    const pluginDir = path.join(CORDIS_DIR, "plugins", "task-history");
    const pluginFiles = productionFiles(pluginDir).map((f) => path.relative(SRC_ROOT, f).split(path.sep).join("/"));
    expect(pluginFiles.sort()).toEqual(["cordis/plugins/task-history/plugin.tsx"]);
    for (const file of productionFiles(pluginDir)) {
      const source = stripComments(readFileSync(file, "utf8"));
      if (/canvas-session|canvas-runtime|canvas-navigation|plugins\/canvas-/.test(source)) {
        offenders.push(`${path.relative(SRC_ROOT, file)}: canvas impl`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("共享模块不依赖页面、Cordis 宿主或具体插件（change: 2026-10-10-extract-task-history-page）", () => {
    const SHARED_DIR = path.join(SRC_ROOT, "shared");
    const offenders: string[] = [];
    for (const file of productionFiles(SHARED_DIR)) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      const source = stripComments(readFileSync(file, "utf8"));
      // 共享层不得反向 import 页面、cordis 插件或 Cordis Context。
      if (/from\s+["'][^"']*\/pages\//.test(source)) offenders.push(`${relative}: imports pages`);
      if (/from\s+["'][^"']*\/plugins\//.test(source)) offenders.push(`${relative}: imports plugin`);
      if (/from\s+["'][^"']*\/cordis\//.test(source)) offenders.push(`${relative}: imports cordis`);
      if (/@deepseek-ai\/cordis/.test(source)) offenders.push(`${relative}: imports cordis context`);
    }
    expect(offenders).toEqual([]);
  });

  it("请求/连接契约的权威定义只在 shared/task-history（页面与 Remote 共用，无重复定义）", () => {
    // change: 2026-10-10-extract-task-history-page，design D3：Cordis 契约只聚合、不重复。
    const authority = path.join(SRC_ROOT, "shared", "task-history", "client.ts");
    expect(readFileSync(authority, "utf8")).toContain("export class TaskHistoryError");
    const offenders: string[] = [];
    for (const file of productionFiles(SRC_ROOT)) {
      if (file === authority) continue;
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
      const source = stripComments(readFileSync(file, "utf8"));
      if (/class\s+TaskHistoryError\b/.test(source)) offenders.push(`${relative}: duplicate TaskHistoryError`);
    }
    expect(offenders).toEqual([]);
  });

  it("插件不新增未评审的跨插件内部 import", () => {
    // change: 2026-09-28-split-frontend-god-plugins，task 7.3。
    // 跨插件复用应优先通过 service-keys capability / typed slot / kernel Service / 平台 UI；
    // 以下为本次拆分后已评审并接受的既有依赖（低层运行时、共享纯逻辑与平台工具）。
    // 新增依赖会改变该集合，必须评审后更新本清单。
    const REVIEWED = new Set<string>([
      // canvas-runtime ↔ canvas-shell：运行时宿主装载 controller 与聚焦目标解析（type-only 依赖）。
      "cordis/plugins/canvas-runtime/host.ts -> canvas-shell",
      // canvas-runtime ↔ canvas-shell：拖动吸附策略的注入转发只引用 controller 类型
      // （内置插件 alignment-guides；与 host.ts 同一类 type-only 依赖）。
      "cordis/plugins/canvas-runtime/alignment-snap-refs.ts -> canvas-shell",
      "cordis/plugins/canvas-runtime/plugin.tsx -> canvas-shell",
      // canvas-runtime 查询桥复用 gizmo 请求类型（type-only）。
      "cordis/plugins/canvas-runtime/query-bridge.ts -> canvas-shell",
      // canvas-runtime ↔ media-preview：共享受控媒体 URL 解析。
      "cordis/plugins/canvas-runtime/video-source.ts -> media-preview",
      // node-history / model-editor ↔ canvas-runtime：共享同一离屏回读通道的单飞锁与
      // RGBA→PNG 编码（桥接槽 latest-wins，两类作业必须串行）
      // （change: 2026-10-26-move-generation-history-to-ai-center，design D6）。
      "cordis/plugins/node-history/model-thumbnail-render.ts -> canvas-runtime",
      "cordis/plugins/model-editor/model-shot-capture-run.ts -> canvas-runtime",
      // canvas-shell ↔ canvas-runtime：运行时是 canvas-shell 的低层依赖。
      "cordis/plugins/canvas-shell/interaction-controller.ts -> canvas-runtime",
      "cordis/plugins/canvas-shell/interaction-core.ts -> canvas-runtime",
      "cordis/plugins/canvas-shell/interaction-types.ts -> canvas-runtime",
      "cordis/plugins/canvas-shell/interaction-hover.ts -> canvas-runtime",
      "cordis/plugins/canvas-shell/interaction-queries.ts -> canvas-runtime",
      "cordis/plugins/canvas-shell/hit-test.ts -> canvas-runtime",
      // Sole frame submission owner reads the runtime capability, position mirror and
      // shared hot-path diagnostics (change: 2026-10-13-optimize-canvas-static-incremental-rendering, D3).
      "cordis/plugins/canvas-shell/interaction-frame-submission.ts -> canvas-runtime",
      "cordis/plugins/canvas-shell/model-gizmo-hit.ts -> canvas-runtime",
      "cordis/plugins/canvas-shell/scene-builder.ts -> canvas-runtime",
      // canvas-shell ↔ canvas-menu / media-preview：宿主渲染菜单与双击预览。
      "cordis/plugins/canvas-shell/canvas-host.tsx -> canvas-menu",
      "cordis/plugins/canvas-shell/interaction-double-click.ts -> media-preview",
      // settings ↔ extension-manager：画布内设置弹窗复用插件管理的数据层（facade）与契约类型
      // （change: 2026-10-17-move-settings-into-canvas-dialog：设置内容迁入 cordis/plugins/settings）。
      "cordis/plugins/settings/plugin.tsx -> extension-manager",
      "cordis/plugins/settings/plugin-groups.ts -> extension-manager",
      "cordis/plugins/settings/plugin-settings-section.tsx -> extension-manager",
      "cordis/plugins/settings/plugin-state-control.tsx -> extension-manager",
      // provider-credentials ↔ settings：凭据弹窗复用设置行的 store 与只读投影（同一份 /api/settings）。
      "cordis/plugins/provider-credentials/panel.tsx -> settings",
      // agent-assistant ↔ settings / task-execution：助手执行统一走公共 composer，
      // 后端设置 store 与执行面板控制器按既有契约共用
      // （change: 2026-10-21-unify-assistant-execution）。
      "cordis/plugins/agent-assistant/assistant.tsx -> settings",
      "cordis/plugins/agent-assistant/plugin.tsx -> settings",
      "cordis/plugins/canvas-menu/canvas-creation-agent.tsx -> task-execution",
      // settings ↔ extension-manager：设置分区与入口链接只读取扩展管理契约类型（type-only）。
      "cordis/plugins/settings/backend-settings-section.tsx -> extension-manager",
      "cordis/plugins/settings/extension-point-links.ts -> extension-manager",
      "cordis/plugins/settings/generation-providers.ts -> extension-manager",
      // canvas-menu ↔ canvas-runtime：共享 canvas-context menu type 常量。
      "cordis/plugins/canvas-menu/plugin.ts -> canvas-runtime",
      // model-editor ↔ canvas-shell / model-scene / media-import：聚焦会话、场景 store 与上传共享。
      "cordis/plugins/model-editor/model-camera-store.ts -> canvas-shell",
      "cordis/plugins/model-editor/model-camera-store.ts -> model-scene",
      "cordis/plugins/model-editor/model-editor-plugin.tsx -> canvas-shell",
      // MP4 export shares the pure uploaded-asset / atomic node planner with still capture.
      // media-import ↔ paste-import：导入共享 clipboard/datatransfer 分类。
      "cordis/plugins/media-import/service.ts -> paste-import",
      // model-scene ↔ canvas-runtime：共享 scene-diagnostics 热路径计数器。
      "cordis/plugins/model-scene/model-scene-store.ts -> canvas-runtime",
      // paste-import ↔ canvas-shell：内部剪贴板编解码共享。
      "cordis/plugins/paste-import/dispatcher.ts -> canvas-shell",
      "cordis/plugins/paste-import/plugin.tsx -> canvas-shell",
      // prompt-snippets ↔ task-execution：mention 编辑器与参考映射共享。
      // change: 2026-10-10-extract-optional-feature-extensions：片段前端迁至独立包，宿主不再
      // 存在该跨插件内部 import。
      // video-capture(Seedance Plugin) ↔ task-execution：共享 intent controller 类型契约
      // （change: add-pluggable-model-interactions 任务 5.4：controller 仍归 Seedance Plugin）。
      "cordis/plugins/video-capture/controller-types.ts -> task-execution",
      // film-set-drop ↔ canvas-shell：复用片场 drop 分派与拖入规划（change: 2026-10-08-make-film-set-model-only）。
      "cordis/plugins/node-drop/plugin.ts -> canvas-shell",
      // drop overlay 消费共享分派的 accepted 目标解析类型（change: 2026-10-12-align-film-set-scope-with-isometric-grid）。
      "cordis/plugins/node-drop/drop-overlay.ts -> canvas-shell",
      // node-merge 高亮复用共享节点索引的 `mergeRectsByType`（折叠/托管/有效尺寸只有一份判定；
      // change: 2026-10-27-merge-same-type-node-history，design D2）。
      "cordis/plugins/node-merge/merge-overlay.ts -> canvas-shell",
      // canvas-runtime ↔ media-preview：片场媒体会话与既有视频会话共用受控媒体 URL 解析。
      "cordis/plugins/canvas-runtime/composite-asset-media-session.ts -> media-preview",
      // canvas-runtime 装配契约复用聚焦目标类型（type-only；从 host 抽出）。
      "cordis/plugins/canvas-runtime/canvas-runtime-options.ts -> canvas-shell",
      // image-viewer ↔ canvas-shell / canvas-runtime：宿主默认图片聚焦查看器复用共享滚轮分类、
      // 媒体栅格化与图片加载失败分类，与 video-editor 走同一条共享路径
      // （change: default-image-focus-viewer）。
      "cordis/plugins/image-viewer/image-viewer-workspace.tsx -> canvas-shell",
      "cordis/plugins/image-viewer/session.ts -> canvas-runtime",
      // video-editor ↔ canvas-shell / canvas-runtime / video-capture / media-preview：视频聚焦工作区
      // 复用共享二维媒体栅格化、滚轮分类、聚焦布局类型与共享截帧主体/受控媒体 URL
      // （change: 2026-10-10-add-video-node-focus-workspace；
      //   change: 2026-10-12-unify-node-editors-and-focus-transitions，design D1）。
      "cordis/plugins/video-editor/video-editor-overlay.tsx -> canvas-shell",
      "cordis/plugins/video-editor/video-editor-overlay.tsx -> video-capture",
      "cordis/plugins/video-editor/video-editor-plugin.tsx -> video-capture",
      "cordis/plugins/video-editor/session.ts -> canvas-runtime",
      // 拆分的类型契约沿用原会话的时间线与解码接口。
      "cordis/plugins/video-editor/session-types.ts -> canvas-runtime",
      "cordis/plugins/video-editor/targets.ts -> media-preview",
      // node-drop ↔ canvas-shell：扩展节点 drop 分派与命中复用宿主纯逻辑（与 plugin.ts 同一依赖）。
      "cordis/plugins/node-drop/drop-overlay.ts -> canvas-shell",
      // task-execution ↔ canvas-shell：提示词输入复用共享的平台判定纯函数与快捷键路由
      // （change: 2026-10-09-improve-canvas-workflow，任务 3.1）。
      "cordis/plugins/task-execution/model-execution-host.tsx -> canvas-shell",
      // canvas-runtime 装配/手势辅助复用 canvas-shell 交互类型与聚焦布局
      // （change: 2026-10-09-add-film-set-object-motion-and-editing 的拆分）。
      "cordis/plugins/canvas-runtime/attach-interaction-options.ts -> canvas-shell",
      // 聚焦 content rect 持有器改用公共 `cordis/focus/types`，不再 import shell（design D4）。
      // 聚焦区域投影保持既有 controller 布局与首帧重取景契约。
      "cordis/plugins/canvas-runtime/project-focus-content-rect.ts -> canvas-shell",
      "cordis/plugins/canvas-runtime/focus-target-transition.ts -> canvas-shell",
      "cordis/plugins/canvas-runtime/model-editor-gestures.ts -> canvas-shell",
      // model-editor ↔ model-scene：对象编辑安装从组合 store 读取身份映射。
      // model-editor ↔ canvas-shell：对象模式手势复用聚焦输入与手势类型。
      // model-editor ↔ canvas-shell：对象局部键盘 action 复用交互契约类型
      // （change: 2026-10-10-improve-film-set-editing-and-inspector）。
      // canvas-shell ↔ model-scene：场景合成读取片场组合身份（itemRoots）。
      // Render warning UI consumes only the typed renderer status surface, without mutating resources.
      "cordis/plugins/canvas-shell/canvas-render-warnings.tsx -> canvas-runtime",
      // 纯视口增量路由读取 runtime 能力（base/version），不接受第二套 viewport
      // （change: 2026-10-10-optimize-canvas-interaction-hot-path，任务 3.4）。
      "cordis/plugins/canvas-shell/interaction-frame-plan.ts -> canvas-runtime",
      // canvas-shell 装配画布页时挂载场景体验条；canvas-switcher 复用同一导入入口的 UI 组件。
      // 两者都只渲染 scene-experience 的展示组件，不共享其状态机。
      "cordis/plugins/canvas-shell/canvas-host.tsx -> scene-experience",
      "cordis/plugins/canvas-switcher/chrome.tsx -> scene-experience",
      // scene-experience 只读取 canvas-runtime 的只读场景诊断快照（帧健康/失败分类）。
      "cordis/plugins/scene-experience/experience-bar.tsx -> canvas-runtime",
      // 徽标几何与共享索引读取 model-scene 已准备资源（extent/aabb/placement）：组徽标与渲染
      // 使用同一口径的几何事实，避免前端再算一份（change: 2026-10-30-remove-group-badge-scaling）。
      "cordis/plugins/canvas-shell/canvas-node-index.ts -> model-scene",
      "cordis/plugins/canvas-shell/group-badge-projection.ts -> model-scene",
      // task-execution 的 dock 揭示读取共享组徽标投影，与画布命中/布局共用同一几何。
      "cordis/plugins/task-execution/dock-reveal.ts -> canvas-shell",
      // 图库「添加到画布」复用粘贴导入的网格错位（`planImportLayout`）：同一位置连点两次不会叠成
      // 一个节点，且与粘贴导入同一套间距，不各算一份（2026-11-02 图库跨画布放置引入）。
      "cordis/plugins/canvas-shell/image-library.ts -> paste-import"
    ]);
    const extensionsDir = path.join(CORDIS_DIR, "plugins");
    const extensionNames = readdirSync(extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const offenders = new Set<string>();
    for (const from of extensionNames) {
      const dir = path.join(extensionsDir, from);
      for (const file of walk(dir, /\.(ts|tsx)$/)) {
        if (isTestSupportOrTest(file)) continue;
        const source = stripComments(readFileSync(file, "utf8"));
        const relative = path.relative(SRC_ROOT, file).split(path.sep).join("/");
        for (const match of source.matchAll(/from\s+["']\.\.\/([a-z-]+)\//g)) {
          const to = match[1];
          if (to === from || !extensionNames.includes(to) || to === "service-keys") continue;
          offenders.add(`${relative} -> ${to}`);
        }
      }
    }
    const unexpected = [...offenders].filter((entry) => !REVIEWED.has(entry)).sort();
    const resolved = [...REVIEWED].filter((entry) => !offenders.has(entry)).sort();
    expect({ unexpected, resolved }).toEqual({ unexpected: [], resolved: [] });
  });

  it("canvas-shell 生产代码不重新实现 2D/3D 几何命中（change: 2026-09-29-move-canvas-hot-paths-to-rust-wasm）", () => {
    // 2D 命中/框选/贝塞尔采样、普通画布模型 ray/AABB picking 与 gizmo projector 已迁至 Rust
    // interaction state；生产模块 MUST NOT 重新出现旧 TS 命中实现。
    const files = productionFiles(path.join(CORDIS_DIR, "plugins", "canvas-shell"));
    const banned = /\b(hitTest|selectInRect|curvePoints|hitModelAtScreen|makeFocusProjector|makeShotProjector)\b/;
    const offenders: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      if (banned.test(source)) offenders.push(path.relative(SRC_ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it("Task Execution 不直接耦合 Task Activity（change: formalize-frontend-event-bus，任务 6.3）", () => {
    // 提交协调器只抛 `task.activity.*` 事件；不得查询 Task Activity service 或调用其 store。
    const banned = /\b(TASK_ACTIVITY_SERVICE|SubmitActivityHook|insertOptimistic|markLocalFailure)\b/;
    const offenders: string[] = [];
    for (const file of productionFiles(path.join(CORDIS_DIR, "plugins", "task-execution"))) {
      if (banned.test(stripComments(readFileSync(file, "utf8")))) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("生产事件名不使用已废弃的 canvas/* 前缀（change: formalize-frontend-event-bus，任务 7.3）", () => {
    const banned = /["'`]canvas\/(image-preview|video-frame-capture|node-history)["'`]/;
    const offenders: string[] = [];
    for (const file of productionFiles(CORDIS_DIR)) {
      // 目录的旧事件名清单是审计事实源，允许出现。
      if (file.endsWith(`${path.sep}events${path.sep}catalog.ts`)) continue;
      if (banned.test(stripComments(readFileSync(file, "utf8")))) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("插件不得访问未声明的注入服务（change: 2026-10-09-improve-canvas-workflow，任务 1.7 回归）", () => {
    // Cordis 在未 `inject` 时读取服务会抛错（cannot get property ... without inject），
    // 运行期异常会中断指针手势（拖拽卡死）并阻断编辑历史。这里静态保证：插件文件里
    // 通过 `ctx.<service>` 访问的 Context 服务都必须出现在该插件的 `inject` 列表。
    const contextServices = [
      "canvasRemote", "taskRemote", "applicationRemote", "mediaRemote", "canvasSession", "canvasEdit",
      "canvasLocate", "dialogs", "slots", "inputScopes", "canvasRuntime", "canvasNavigation",
      "appRouter", "selection", "parameterPreview", "taskCatalog", "canvasCatalog", "canvasSelection",
      "canvasPreparation",
      "canvasRecovery", "canvasMenu", "importService", "theme", "snippetCatalog", "focusExit",
      "modelInteractions", "pluginManager", "applicationPluginStatus", "generationModelsStatus",
      "compositeAssets"
    ];
    const offenders: string[] = [];
    for (const file of productionFiles(path.join(CORDIS_DIR, "plugins"))) {
      const source = stripComments(readFileSync(file, "utf8"));
      // 每个 definePlugin 的 meta.inject 列表（可能跨多行）。
      const injects = [...source.matchAll(/inject\s*:\s*\[([^\]]*)\]/g)].map((match) => match[1]);
      const injected = new Set(
        injects.flatMap((list) => [...list.matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1]))
      );
      // 只检查 definePlugin 文件（有 inject 声明）；纯工具模块无 ctx 生命周期。
      if (injects.length === 0) continue;
      const accessed = new Set(
        [...source.matchAll(/ctx\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((match) => match[1]!)
      );
      const missing = [...accessed].filter((name) => contextServices.includes(name) && !injected.has(name));
      if (missing.length > 0) offenders.push(`${path.relative(SRC_ROOT, file)} -> ${missing.sort().join(",")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("服务工厂/store 与 install-services 不得以属性访问插件期服务（change: 2026-10-09，任务 4.1 回归）", () => {
    // `install*Services` 在插件装配前运行，其 `ctx` 未注入任何插件期服务；`ctx.<service>`
    // 会抛 "cannot get property ... without inject"（例如查找定位的 controller）。这类文件
    // 只能访问本 scope 已 provide 的服务，或对插件期服务用 `ctx.get(name)` 惰性读取。
    const pluginProvided = [
      "canvasRuntime", "canvasNavigation", "canvasEdit", "canvasLocate", "modelInteractions",
      "pluginManager", "applicationPluginStatus", "generationModelsStatus",
      "snippetCatalog", "focusExit"
    ];
    // 这些服务由 install-services 自身 provide，安装期可安全属性访问。
    const selfProvided = ["canvasRemote", "taskRemote", "applicationRemote", "mediaRemote", "canvasSession",
      "canvasEdit", "canvasLocate", "inputScopes", "taskCatalog", "selection", "parameterPreview",
      "modelInteractions", "applicationPluginStatus", "generationModelsStatus", "settingsRemote",
      "dialogs", "slots", "theme", "appRouter", "canvasCatalog", "canvasSelection"];
    const files = [
      "cordis/install-services.ts",
      "cordis/page-scope.ts",
      ...productionFiles(path.join(CORDIS_DIR, "services")).map((file) => path.relative(SRC_ROOT, file))
    ];
    const offenders: string[] = [];
    for (const relative of files) {
      let source: string;
      try {
        source = stripComments(readFileSync(path.join(SRC_ROOT, relative), "utf8"));
      } catch {
        continue;
      }
      const accessed = new Set([...source.matchAll(/ctx\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((match) => match[1]!));
      const bad = [...accessed].filter((name) => pluginProvided.includes(name) && !selfProvided.includes(name));
      if (bad.length > 0) offenders.push(`${relative} -> ${bad.sort().join(",")}`);
    }
    expect(offenders).toEqual([]);
  });
});
