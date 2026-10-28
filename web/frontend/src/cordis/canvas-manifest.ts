import { agentAssistantExtension } from "./plugins/agent-assistant/plugin.js";
/**
 * 页面 scope 与插件清单
 * （change: 2026-09-28-unify-canvas-presentation-navigation，task 2.3 / design D1；
 *   change: add-frontend-plugin-manager，task 1.1/1.2 / design D1；
 *   change: 2026-10-12-build-and-load-extensions-independently，任务 4.6/5.1：宿主目录只含
 *   **内置**插件；业务 extension 由发布目录异步加载，宿主构建不再扫描/编译 extension 源码）。
 *
 * Canvas 与 Task History 各自的插件清单。Task History **不**包含任何 Canvas 插件。
 *
 * `CANVAS_PLUGIN_CATALOG` 是宿主**内置**插件的唯一权威目录：装配信息（`create`/`required`）与
 * 展示元数据（`name`/`description`）。业务 extension（ChatGPT、片场、prompt-snippets、
 * task-activity、game-furnace、runninghub-provider）不再手写于此：它们由发布目录的纯 metadata
 * 与已校验 browser artifact 在运行时派生（design D4/D6），本模块只负责合并内置与运行时条目。
 *
 * 用户可配置的 optional Plugin 仍由显式 allowlist 固定；运行时把发布目录中的 browser-local
 * optional 追加进该集合（`CONFIGURABLE_OPTIONAL_PLUGIN_IDS` 只含宿主内置 node-history）。
 */
import { nodeDropExtension, NODE_DROP_PLUGIN_ID } from "./plugins/node-drop/plugin.js";
import { nodeMergeExtension, NODE_MERGE_PLUGIN_ID } from "./plugins/node-merge/plugin.js";
import type { Plugin } from "@deepseek-ai/cordis";
import type { FrontendExtensionDefinition } from "./kernel.js";
import { canvasNavigationExtension, CANVAS_NAVIGATION_PLUGIN_ID } from "./plugins/canvas-navigation/plugin.js";
import { canvasRuntimeExtension, CANVAS_RUNTIME_PLUGIN_ID } from "./plugins/canvas-runtime/plugin.js";
import { canvasShellExtension, CANVAS_SHELL_PLUGIN_ID } from "./plugins/canvas-shell/plugin.js";
import { canvasMenuExtension, CANVAS_MENU_PLUGIN_ID } from "./plugins/canvas-menu/plugin.js";
import { mediaPreviewExtension, MEDIA_PREVIEW_PLUGIN_ID } from "./plugins/media-preview/plugin.js";
import { mediaImportExtension, MEDIA_IMPORT_PLUGIN_ID } from "./plugins/media-import/plugin.js";
import { modelSceneExtension, MODEL_SCENE_PLUGIN_ID } from "./plugins/model-scene/plugin.js";
import { taskExecutionExtension, TASK_EXECUTION_PLUGIN_ID } from "./plugins/task-execution/plugin.js";
import {
  genericModelInteractionExtension,
  GENERIC_MODEL_PLUGIN_ID
} from "./plugins/task-execution/generic-plugin.js";
import {
  seedanceVideoInteractionExtension,
  SEEDANCE_INTERACTION_PLUGIN_ID
} from "./plugins/video-capture/seedance-plugin.js";
import { pasteImportExtension, PASTE_IMPORT_PLUGIN_ID } from "./plugins/paste-import/plugin.js";
import { nodeHistoryExtension, NODE_HISTORY_PLUGIN_ID } from "./plugins/node-history/plugin.js";
import { videoEditorExtension, VIDEO_EDITOR_PLUGIN_ID } from "./plugins/video-editor/video-editor-plugin.js";
import { imageViewerExtension, IMAGE_VIEWER_PLUGIN_ID } from "./plugins/image-viewer/plugin.js";
import { focusConnectionsExtension, FOCUS_CONNECTIONS_PLUGIN_ID } from "./plugins/focus-connections/plugin.js";
import { modelEditorExtension, MODEL_EDITOR_PLUGIN_ID } from "./plugins/model-editor/model-editor-plugin.js";
import { runStateExtension, RUN_STATE_PLUGIN_ID } from "./plugins/run-state/plugin.js";
import { canvasSwitcherExtension, CANVAS_SWITCHER_PLUGIN_ID } from "./plugins/canvas-switcher/plugin.js";
import {
  extensionManagerPlugin,
  EXTENSION_MANAGER_ID,
  type ExtensionManagerOptions
} from "./plugins/extension-manager/plugin.js";
import {
  providerCredentialsExtension,
  PROVIDER_CREDENTIALS_PLUGIN_ID
} from "./plugins/provider-credentials/plugin.js";
import { settingsEntryExtension, SETTINGS_ENTRY_PLUGIN_ID } from "./plugins/settings/entry.js";
import { settingsPlugin, SETTINGS_PLUGIN_ID, type ExtensionSettingsAssembly } from "./plugins/settings/plugin.js";
import type { CanvasExtensionMetadata } from "./plugins/extension-manager/contract.js";

export type ExtensionManifestOptions = {
  canvasId?: string;
  /** Plugin Manager 注入（startup snapshot 与 reload adapter）；缺省使用全启用与页面刷新。 */
  extensionManager?: ExtensionManagerOptions;
  /**
   * 运行时从发布目录加载的业务 extension 定义（always + 已启用 browser-local optional）。
   * 由 composition root 在创建 scope 前加载与筛选；宿主内置目录不含这些条目。
   */
  extensions?: readonly FrontendExtensionDefinition[];
  /** Plugin Manager 的运行时目录（内置 + 发布目录扩展展示元数据）。 */
  catalogMetadata?: readonly CanvasExtensionMetadata[];
  /** 运行时可配置 optional allowlist（内置 node-history + 发布目录 browser-local ID）。 */
  configurableOptionalIds?: readonly string[];
  /**
   * 设置专项扩展装配（change: 2026-10-17-move-settings-into-canvas-dialog，任务 5.2）。
   * 只供画布内设置弹窗按需加载未激活扩展的 settings-only 贡献。
   */
  settingsAssembly?: ExtensionSettingsAssembly;
};

export type { CanvasExtensionMetadata } from "./plugins/extension-manager/contract.js";

type CanvasExtensionCatalogEntry = CanvasExtensionMetadata & {
  /** 构造 Plugin 实例（闭包只捕获 options，不产生副作用）。 */
  create: (options: ExtensionManifestOptions) => Plugin;
};

/**
 * 用户可配置的 optional Canvas Plugin 稳定 allowlist（**宿主内置部分**）。
 *
 * 业务扩展的 browser-local optional（如 prompt-snippets）由发布目录派生，在
 * 运行时追加（`resolveConfigurableOptionalIds`）；该集合是静态可信边界的一部分。
 */
export const CONFIGURABLE_OPTIONAL_PLUGIN_IDS: readonly string[] = [NODE_HISTORY_PLUGIN_ID];

/** 合并宿主内置与运行时（发布目录）的可配置 optional ID（稳定排序、去重）。 */
export function resolveConfigurableOptionalIds(runtimeIds: readonly string[]): string[] {
  return [...new Set([...CONFIGURABLE_OPTIONAL_PLUGIN_IDS, ...runtimeIds])].sort();
}

/** 是否为用户可配置的 optional Plugin（内置 allowlist 判定；运行时 ID 另行合并）。 */
export function isConfigurableOptionalExtension(id: string): boolean {
  return CONFIGURABLE_OPTIONAL_PLUGIN_IDS.includes(id);
}

/** 宿主**内置** Canvas page scope 权威目录（稳定顺序）。 */
export const CANVAS_PLUGIN_CATALOG: readonly CanvasExtensionCatalogEntry[] = [
  { id: NODE_DROP_PLUGIN_ID, name: "节点拖入", description: "将复制拖入交给目标节点所属扩展。", required: true, configurable: false, create: () => nodeDropExtension() },
  {
    id: NODE_MERGE_PLUGIN_ID,
    name: "节点合并",
    description: "把同类型节点拖到另一节点，确认后切换当前版本、合并历史并删除来源。",
    required: true,
    configurable: false,
    create: () => nodeMergeExtension()
  },
  {
    id: MEDIA_PREVIEW_PLUGIN_ID,
    name: "媒体预览",
    description: "双击图片或视频节点时打开受控预览弹窗。",
    required: true,
    configurable: false,
    create: () => mediaPreviewExtension
  },
  // required：画布 presentation navigation（menu/panel/mode 唯一状态源）；先于 canvas-runtime。
  {
    id: CANVAS_NAVIGATION_PLUGIN_ID,
    name: "画布导航",
    description: "统一菜单、面板与聚焦模式的唯一状态源。",
    required: true,
    configurable: false,
    create: () => canvasNavigationExtension()
  },
  // required：页面级 Canvas 运行时（提供 canvasRuntime）；先于 canvas-shell/model-editor。
  {
    id: CANVAS_RUNTIME_PLUGIN_ID,
    name: "画布运行时",
    description: "页面级画布渲染与视口运行时。",
    required: true,
    configurable: false,
    create: (options) => canvasRuntimeExtension({ canvasId: options.canvasId })
  },
  {
    id: CANVAS_SHELL_PLUGIN_ID,
    name: "画布外壳",
    description: "承载画布宿主、工具栏与输入门禁。",
    required: true,
    configurable: false,
    create: () => canvasShellExtension()
  },
  // required：多画布切换器 chrome（当前标题 + 分页列表 + 新建 + 重命名）。
  {
    id: CANVAS_SWITCHER_PLUGIN_ID,
    name: "画布切换器",
    description: "查看、创建与切换多个画布。",
    required: true,
    configurable: false,
    create: (options) => canvasSwitcherExtension({ canvasId: options.canvasId })
  },
  {
    id: MODEL_SCENE_PLUGIN_ID,
    name: "模型场景",
    description: "模型节点的场景快照与投影。",
    required: true,
    configurable: false,
    create: (options) => modelSceneExtension({ canvasId: options.canvasId })
  },
  {
    id: MEDIA_IMPORT_PLUGIN_ID,
    name: "媒体导入",
    description: "上传与引用本地媒体资源。",
    required: true,
    configurable: false,
    create: () => mediaImportExtension
  },
  {
    id: CANVAS_MENU_PLUGIN_ID,
    name: "画布菜单",
    description: "画布右键上下文菜单。",
    required: true,
    configurable: false,
    create: () => canvasMenuExtension
  },
  // required：内置 generic 模型交互（text/image/audio/普通 video）。
  {
    id: GENERIC_MODEL_PLUGIN_ID,
    name: "通用模型交互",
    description: "文本、图片、音频与普通视频节点的参数面板。",
    required: true,
    configurable: false,
    create: () => genericModelInteractionExtension()
  },
  {
    id: TASK_EXECUTION_PLUGIN_ID,
    name: "任务执行",
    description: "节点任务提交、取消与执行面板。",
    required: true,
    configurable: false,
    create: (options) => taskExecutionExtension({ canvasId: options.canvasId })
  },
  // required：Seedance 视频编辑/截帧 Model Interaction Plugin（注册 Panel + Dialogs）。
  {
    id: SEEDANCE_INTERACTION_PLUGIN_ID,
    name: "Seedance 视频交互",
    description: "视频编辑与截帧的模型交互面板。",
    required: true,
    configurable: false,
    create: () => seedanceVideoInteractionExtension()
  },
  // RunningHub App 工作流交互由 `runninghub-provider` extension 的 server-active 入口提供
  // （发布目录加载；change: 2026-10-12-build-and-load-extensions-independently）。
  // 任务活动浮层由 `task-activity` extension 的 browser-local 入口提供。
  // required：统一生成运行状态（change: 2026-10-12-unify-generation-history-strip，design D1/D2）。
  // 所有生成入口（任务/3D/片场/镜头/截图/导出）的唯一展示源；先于消费它的面板与投影。
  {
    id: RUN_STATE_PLUGIN_ID,
    name: "生成运行状态",
    description: "统一文本/图片/视频/音频/3D/片场/截图/导出的运行状态。",
    required: true,
    configurable: false,
    create: (options) => runStateExtension({ canvasId: options.canvasId })
  },
  // required：文件 paste/drop 与单图替换（change: add-frontend-plugin-manager 改为 required）。
  {
    id: PASTE_IMPORT_PLUGIN_ID,
    name: "粘贴导入",
    description: "粘贴/拖放文件导入并支持单图替换。",
    required: true,
    configurable: false,
    create: () => pasteImportExtension()
  },
  // 提示词片段库由 `prompt-snippets` extension 的 browser-local 入口提供。
  // optional：节点生成历史（仍由宿主拥有，装配与配置路径不变）。
  {
    id: NODE_HISTORY_PLUGIN_ID,
    name: "节点历史",
    description: "查看节点生成历史并快照回滚。",
    required: false,
    configurable: true,
    icon: "history",
    create: (options) => nodeHistoryExtension({ canvasId: options.canvasId })
  },
  // required：模型编辑 gizmo/镜头工具栏（change: add-frontend-plugin-manager 改为 required）。
  {
    id: MODEL_EDITOR_PLUGIN_ID,
    name: "模型编辑",
    description: "模型聚焦编辑的 gizmo 与镜头工具栏。",
    required: true,
    configurable: false,
    create: (options) => modelEditorExtension({ canvasId: options.canvasId })
  },
  // required：宿主默认图片聚焦查看器（change: default-image-focus-viewer）。
  // 图片编辑器（PhotoCraft）是市场扩展；它未安装/未启用时仍要能双击看图，因此宿主保留只读
  // 查看工作区：编辑器扩展一旦贡献 kind=image 工作区，本插件自动让位。
  {
    id: IMAGE_VIEWER_PLUGIN_ID,
    name: "图片查看",
    description: "图片聚焦的默认查看工作区（扩展缺席时原地取景查看）。",
    required: true,
    configurable: false,
    create: () => imageViewerExtension()
  },
  // required：视频聚焦工作区（change: 2026-10-10-add-video-node-focus-workspace）。
  {
    id: VIDEO_EDITOR_PLUGIN_ID,
    name: "视频编辑",
    description: "视频聚焦工作区：原地播放、二维取景、截帧与历史预览。",
    required: true,
    configurable: false,
    create: () => videoEditorExtension()
  },
  // required：聚焦双侧连接圆点（change: 2026-10-08-add-image-focus-editing-and-unified-node-history）。
  {
    id: FOCUS_CONNECTIONS_PLUGIN_ID,
    name: "聚焦连接",
    description: "聚焦时在屏幕两侧显示直接前序/后序节点。",
    required: true,
    configurable: false,
    create: () => focusConnectionsExtension()
  },
  // required：插件管理数据层与 capability（change: 2026-10-16-consolidate-canvas-settings-entries：
  // 管理界面在设置页「插件配置」，画布不再注册入口与弹窗）。
  {
    id: EXTENSION_MANAGER_ID,
    name: "插件管理器",
    description: "投影浏览器本地偏好、站点插件与生成模型，供设置页「插件配置」消费。",
    required: true,
    configurable: false,
    create: (options) => extensionManagerPlugin(options.extensionManager ?? {})
  },
  // required：Provider 凭据弹窗（change: 2026-10-06-add-runninghub-api-models-and-provider-credentials；
  // change: 2026-10-16-consolidate-canvas-settings-entries：不再是工具条入口，只作为生成面板授权的落点）。
  {
    id: PROVIDER_CREDENTIALS_PLUGIN_ID,
    name: "Provider 凭据",
    description: "旧凭据入口兼容跳转到 AI 助手；共享 Key 在设置或生成 tab 编辑。",
    required: true,
    configurable: false,
    create: () => providerCredentialsExtension()
  },
  { id: "agent-assistant", name: "AI 助手", description: "管理个人助手连接与外部 Agent 指引。", required: true, configurable: false, create: () => agentAssistantExtension() },
  // required：应用设置（画布内唯一大型弹窗 + 左下角入口）
  // （change: 2026-10-17-move-settings-into-canvas-dialog：设置不再是独立页面 scope）。
  {
    id: SETTINGS_PLUGIN_ID,
    name: "设置",
    description: "在画布内打开核心服务、插件配置与外观设置。",
    required: true,
    configurable: false,
    create: (options) =>
      settingsPlugin({
        catalog: options.catalogMetadata ?? [],
        ids: options.configurableOptionalIds ?? [],
        assembled: options.extensionManager?.assembled ?? {},
        ...(options.extensionManager?.failed ? { failed: options.extensionManager.failed } : {}),
        ...(options.extensionManager?.failures ? { failures: options.extensionManager.failures } : {}),
        ...(options.extensionManager?.preferenceStore ? { preferenceStore: options.extensionManager.preferenceStore } : {}),
        ...(options.settingsAssembly ? { extensionSettings: options.settingsAssembly } : {})
      })
  },
  // required：应用设置页入口（左下角 canvas.toolbar-action）。
  {
    id: SETTINGS_ENTRY_PLUGIN_ID,
    name: "设置入口",
    description: "从画布打开应用设置弹窗。",
    required: true,
    configurable: false,
    create: () => settingsEntryExtension()
  }
];

// 内置目录跨 ID 唯一（任何业务装配前稳定失败）。
assertUniqueCatalogIds(CANVAS_PLUGIN_CATALOG);

function assertUniqueCatalogIds(entries: readonly { id: string }[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new Error(`Canvas 插件清单含跨来源重复 ID：${entry.id}`);
    }
    seen.add(entry.id);
  }
}

/** 宿主内置目录的纯展示元数据投影。 */
export function builtinCanvasCatalogMetadata(): CanvasExtensionMetadata[] {
  return CANVAS_PLUGIN_CATALOG.map(({ id, name, description, required, configurable, icon }) => ({
    id,
    name,
    description,
    required,
    configurable,
    ...(icon ? { icon } : {})
  }));
}

/**
 * Canvas 权威展示元数据（内置 + 运行时发布目录扩展；顺序即清单顺序）。
 *
 * `extra` 由 composition root 从发布目录纯 metadata 派生；不能下载 JS/CSS 或构造 plugin。
 */
export function canvasExtensionCatalogMetadata(
  extra: readonly CanvasExtensionMetadata[] = []
): CanvasExtensionMetadata[] {
  const merged = [...builtinCanvasCatalogMetadata(), ...extra];
  assertUniqueCatalogIds(merged);
  return merged;
}

/** Canvas page scope 插件清单（内置 + 运行时加载的扩展定义）。 */
export function createCanvasExtensionManifest(options: ExtensionManifestOptions = {}): FrontendExtensionDefinition[] {
  const builtin = CANVAS_PLUGIN_CATALOG.map((entry) => ({
    id: entry.id,
    required: entry.required,
    configurable: entry.configurable,
    name: entry.name,
    description: entry.description,
    plugin: entry.create(options)
  }));
  const extensions = options.extensions ? [...options.extensions] : [];
  assertUniqueCatalogIds([...builtin, ...extensions]);
  return [...builtin, ...extensions];
}
