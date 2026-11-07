/**
 * 执行面板模块边界审计（change: 2026-10-27-merge-nonessential-panel-chunks，任务 5.1）。
 *
 * 约束的是「没有独立激活路径、总与父入口同时执行」的模块不再单独承担一次请求：
 * 1. 文本宿主、模型执行宿主与模型参数面板随 `task-execution/plugin.tsx` 静态装配，不再是懒加载入口；
 * 2. model3d authoring 的参考图包装与 composer 由**一个**合并入口一次解析；
 * 3. 打开执行面板不再预加载提交动画（`execution-launch`），它只在提交反馈时按需加载。
 *
 * 源码断言固定导入/调用形态；构建产物断言在 `dist/assets` 存在时执行。产物缺失时跳过并
 * 明确报告原因——缺失产物不算通过，需要产物结论的验收步骤保持未完成。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FRONTEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = (relative: string) => path.join(FRONTEND_ROOT, "src", relative);
const read = (relative: string) => readFileSync(SRC(relative), "utf8");

const PLUGIN = "cordis/plugins/task-execution/plugin.tsx";
const HOST = "cordis/host.tsx";
const DIST_ASSETS = path.join(FRONTEND_ROOT, "dist", "assets");
const distReady = existsSync(DIST_ASSETS);
if (!distReady) {
  console.warn(
    `[panel-chunk-boundaries] 跳过构建产物断言：${path.relative(FRONTEND_ROOT, DIST_ASSETS)} 不存在。` +
      "先运行 `pnpm -C client/web/frontend run build`；产物结论保持未验证，不得视为通过。"
  );
}

describe("执行面板模块边界：源码", () => {
  it("文本宿主由执行面板定义静态装配，不存在独立懒加载入口", () => {
    const plugin = read(PLUGIN);
    expect(plugin).toContain('import { TextExecutionHost } from "./text-execution-host.js";');
    expect(plugin).not.toContain('lazy(() => import("./text-execution-host.js")');
    // 文本分支外层不再需要本变更移除的空转 `Suspense`；composer 的骨架仍在 host 内部。
    expect(plugin).not.toContain("<Suspense fallback={<ExecutionPanelPending nodeId={route.nodeId} presentation={surface} runtime={runtime} />}>\n            <TextExecutionHost");
  });

  it("模型执行宿主与参数面板由执行面板定义静态装配，不再单独成 chunk", () => {
    const plugin = read(PLUGIN);
    // 四喜形态经提示词技能适配层接入宿主（`PromptSkillExecutionHost` 内部静态依赖 `ModelExecutionHost`），
    // 同样是静态装配：两种导入形态都满足「没有独立激活路径」。
    expect(plugin).toMatch(
      /import \{ (?:PromptSkillExecutionHost as )?ModelExecutionHost \} from "\.\/(?:prompt-skill|model)-execution-host\.js";/
    );
    expect(plugin).toContain('import { ModelParameterPanel } from "./model-parameter-panel.js";');
    expect(plugin).not.toContain('lazy(() => import("./model-execution-host.js")');
    expect(plugin).not.toContain('lazy(() => import("./model-parameter-panel.js")');
    // 静态入口同样不再需要外层加载骨架。
    expect(plugin).not.toContain("<Suspense fallback={<ExecutionPanelPending");
  });

  it("model3d 只懒加载合并入口，不再把包装模块作为独立入口", () => {
    const host = read(HOST);
    expect(host).toContain('lazy(() => import("./plugins/task-execution/authoring-model-generate-panel.js")');
    expect(host).not.toContain('lazy(() => import("./plugins/task-execution/authoring-model-generate-host.js")');
    // 文本路径仍只加载 composer，不把模型参考图 renderer 带进文本面板。
    expect(host).toContain('lazy(() => import("./plugins/task-execution/authoring-generate-panel.js")');
  });

  it("合并入口静态组合包装与真实 composer", () => {
    const panel = read("cordis/plugins/task-execution/authoring-model-generate-panel.tsx");
    expect(panel).toContain('import { AuthoringGeneratePanel } from "./authoring-generate-panel.js";');
    expect(panel).toContain('import { AuthoringModelGenerateHost } from "./authoring-model-generate-host.js";');
    expect(panel).toContain("render={AuthoringGeneratePanel}");
  });

  it("打开面板不再预加载提交动画，只保留提交反馈时的按需加载", () => {
    const plugin = read(PLUGIN);
    expect(plugin).not.toContain("void loadLaunch().catch(() => {})");
    // 唯一的 `loadLaunch()` 调用点是 `activitySink.launch`（提交进入反馈窗口时）。
    expect(plugin.match(/loadLaunch\(\)/g) ?? []).toHaveLength(1);
    // 动态导入本身保留：动画仍是独立按需 chunk，不并入主包。
    expect(plugin).toContain('import("./execution-launch.js")');
    expect(plugin).toContain("EXECUTION_LAUNCH.waitMs");
  });
});

describe("执行面板模块边界：构建产物", () => {
  it.skipIf(!distReady)("文本/模型执行宿主、参数面板与模型 authoring 包装不再是独立 chunk", () => {
    const entries = readdirSync(DIST_ASSETS);
    const forbiddenChunks = entries.filter(
      (name) =>
        /^text-execution-host-.*\.js$/.test(name) ||
        /^model-execution-host-(?!helpers-).*\.js$/.test(name) ||
        /^model-parameter-panel-.*\.js$/.test(name) ||
        /^authoring-model-generate-host-.*\.js$/.test(name)
    );
    expect(
      forbiddenChunks,
      `以下模块没有独立激活路径，必须并入父入口：${forbiddenChunks.join(", ")}`
    ).toEqual([]);
    // 提交动画仍是按需资源，本次不合并它。
    expect(entries.some((name) => /^execution-launch-.*\.js$/.test(name))).toBe(true);
  });

  it.skipIf(!distReady)("主包仍不含 composer 与 MentionEditor（懒加载边界保留）", () => {
    const main = readdirSync(DIST_ASSETS).find((name) => /^main-.*\.js$/.test(name));
    expect(main, "主包 chunk 缺失").toBeDefined();
    const bundle = readFileSync(path.join(DIST_ASSETS, main!), "utf8");
    // 文本/模型面板打开时才加载的独立模块仍由动态导入引用，不进入主包内联实现。
    expect(bundle).toContain("./authoring-generate-panel-");
    // composer 专属标记不得出现在主包里：说明面板代码没有被静态拖入启动闭包。
    expect(bundle).not.toContain("authoring-generate-empty");
    // MentionEditor 的大模块仍单独成 chunk（主包只引用它的按需入口）。
    expect(readdirSync(DIST_ASSETS).some((name) => /^MentionEditor-.*\.js$/.test(name))).toBe(true);
  });
});
