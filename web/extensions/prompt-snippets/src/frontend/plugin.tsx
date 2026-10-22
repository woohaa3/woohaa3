/**
 * Prompt Snippets Plugin
 * （change: add-prompt-snippet-library，design D8/D10/D11；
 *   change: 2026-10-10-extract-optional-feature-extensions，任务 4.1/4.2：由宿主
 *   `cordis/plugins/prompt-snippets` 迁入独立 browser-local extension 包，使用注入的
 *   `canvasRemote`/`mediaRemote`/`dialogs`/`slots`/`canvasState` capability 与公开
 *   `MentionEditor`/`collectDirectMappings`，不 import 宿主内部 store 或业务实现）。
 *
 * 静态可信的 optional feature：提供 feature-owned `snippetCatalog` 与 `promptSnippetSource`
 * capability，通过注入能力协作。
 *
 * 产品形态对齐参考实现（design D10 修订）：
 * - **保存**：节点右键菜单「保存为片段…」捕获当前节点 prompt 并打开编辑器；
 * - **引用**：执行面板提示词输入框键入 `#` 触发片段候选，选中后 materialize 插入草稿；
 * - 另提供 library/editor/delete dialogs 用于管理片段与标签。
 *
 * dispose 撤销全部注册、capability、请求与打开实例。
 */
import type { Context, Plugin } from "@deepseek-ai/cordis";
import { defineExtensionPlugin, PROMPT_SNIPPET_SOURCE } from "@woohaa3/frontend/extension-api";
import type {
  CanvasRemoteService,
  CanvasScopeService,
  CanvasStoreFacade,
  ContextMenuContext,
  DialogsService,
  MediaRemoteService,
  PromptSnippetSource,
  SlotsService
} from "@woohaa3/frontend/extension-api";
import { SnippetLibraryIcon } from "@woohaa3/frontend/extension-api";
import { PROMPT_SNIPPETS_PLUGIN_ID } from "../shared.js";
import type { SnippetCatalog } from "./catalog.js";
import { createSnippetCatalog } from "./catalog.js";
import { collectDirectMappings } from "@woohaa3/contracts";
import { collectMaterialCandidates, type MaterialCandidate } from "./materials.js";
import {
  SNIPPET_DELETE_DIALOG_ID,
  SNIPPET_EDITOR_DIALOG_ID,
  SNIPPET_LIBRARY_DIALOG_ID,
  SNIPPET_TAG_DELETE_DIALOG_ID,
  snippetDeleteDefinition,
  snippetEditorDefinition,
  snippetLibraryDefinition,
  snippetTagDeleteDefinition
} from "./dialogs.js";
import { createLibraryRenderer } from "./library-dialog.js";
import { createEditorRenderer } from "./editor-dialog.js";
import { createDeleteConfirmRenderer, createTagDeleteConfirmRenderer } from "./delete-dialog.js";
import { createMaterialPreviewStore } from "./preview.js";
import {
  materializeSnippetBody,
  captureNodePromptAsSnippetBody,
  type PromptSnippet,
  type PromptSnippetMediaMaterial,
  type PromptSnippetTextMaterial,
  type ServerCanvas
} from "@woohaa3/contracts";

export { PROMPT_SNIPPETS_PLUGIN_ID } from "../shared.js";
export const PROMPT_SNIPPET_SOURCE_KEY = PROMPT_SNIPPET_SOURCE;
/** 节点右键菜单里的「保存为片段」项（design D10 修订）。 */
export const SAVE_SNIPPET_MENU_ID = "save-as-snippet";

/** 宿主在 extension scope 注入的能力。 */
type ExtensionContext = Context & {
  canvasRemote: CanvasRemoteService;
  mediaRemote: MediaRemoteService;
  dialogs: DialogsService;
  slots: SlotsService;
  canvasScope: CanvasScopeService;
  canvasState: CanvasStoreFacade;
};

export function promptSnippetsExtension(): Plugin.Function<void> {
  return defineExtensionPlugin<ExtensionContext>(
    (ctx) => {
      const catalog = createSnippetCatalog({ remote: ctx.canvasRemote });
      ctx.provide("snippetCatalog" as never, catalog as never);
      const previews = createMaterialPreviewStore({
        getCanvas: () => ctx.canvasState.getCanvas(),
        remote: ctx.canvasRemote,
        mediaRemote: ctx.mediaRemote
      });
      // 注册 disposer 收集器：dialog 冲突等中途失败时也能回滚已注册的 slot/dialog。
      const disposers: Array<() => void> = [];
      // search 结果缓存：materialize 需要完整片段（含 materials），search 只回摘要。
      const snippetCache = new Map<string, PromptSnippet>();
      ctx.effect(
        () => () => {
          for (const dispose of disposers.splice(0)) dispose();
          catalog.dispose();
          previews.dispose();
          snippetCache.clear();
        },
        "prompt-snippets-cleanup"
      );

      const candidates = (): MaterialCandidate[] => collectMaterialCandidates(ctx.canvasState.getCanvas());

      const openEditor = (payload: { mode: "create" | "edit"; snippetId?: string; nodeId?: string }) => {
        ctx.dialogs.open({ dialogId: SNIPPET_EDITOR_DIALOG_ID, payload });
      };

      const requestDelete = (snippet: PromptSnippet) => {
        ctx.dialogs.open({
          dialogId: SNIPPET_DELETE_DIALOG_ID,
          payload: { snippetId: snippet.id, name: snippet.name }
        });
      };

      const requestDeleteTag = (tag: { id: string; name: string }) => {
        ctx.dialogs.open({
          dialogId: SNIPPET_TAG_DELETE_DIALOG_ID,
          payload: { tagId: tag.id, name: tag.name }
        });
      };

      /**
       * 应用片段到目标节点：materialize 为目标节点规范 token（未连接素材降级为可读文本）。
       *
       * 只读 canonical 画布的直接输入 mapping，不创建 edge/asset/mapping；不写 Y.Doc。
       */
      const materializeForNode = (snippet: PromptSnippet, nodeId: string): string => {
        const canonical = ctx.canvasState.getCanvas();
        const mappings = canonical
          ? collectDirectMappings(canonical, nodeId).flatMap((mapping) => {
              const slotId = mapping.slotId;
              if (!slotId) return [];
              const explicit = (mapping.sourceAssetIds ?? []).filter((id): id is string => typeof id === "string" && id !== "");
              const sourceAssetId = explicit[0] ?? canonical.nodeData[mapping.sourceNodeId]?.outputAssetId;
              const asset = typeof sourceAssetId === "string"
                ? canonical.assets.find((entry) => entry.id === sourceAssetId)
                : undefined;
              const mediaKind = asset?.mediaKind;
              if (asset?.status !== "ready") return [];
              if (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio" && mediaKind !== "text") return [];
              return [
                {
                  slotId,
                  role: mapping.role,
                  assetId: asset.id,
                  ...(typeof asset.metadata?.storageKey === "string" ? { storageKey: asset.metadata.storageKey } : {}),
                  ...(typeof asset.metadata?.checksum === "string" ? { checksum: asset.metadata.checksum } : {}),
                  contentKind: mediaKind
                }
              ];
            })
          : [];
        return materializeSnippetBody({
          body: snippet.body,
          materials: snippet.materials,
          targetMappings: mappings
        }).body;
      };

      /** 片段引用来源 capability：供执行面板 `#` 引用消费（design D10 修订）。 */
      const snippetSource: PromptSnippetSource = {
        search: async (query: string) => {
          const result = await ctx.canvasRemote.listSnippets({ query: query.trim() || undefined, limit: 20 });
          if (!result.ok) return [];
          for (const snippet of result.value.items) snippetCache.set(snippet.id, snippet);
          return result.value.items.map((snippet) => ({
            id: snippet.id,
            name: snippet.name,
            summary: summarizeBody(snippet.body)
          }));
        },
        materialize: (snippetId: string, nodeId: string): string | null => {
          const snippet = snippetCache.get(snippetId);
          if (!snippet) return null;
          return materializeForNode(snippet, nodeId);
        }
      };
      ctx.provide(PROMPT_SNIPPET_SOURCE as never, snippetSource as never);

      /** 从节点 prompt 捕获片段并打开编辑器（节点右键「保存为片段」）。 */
      const saveNodeAsSnippet = (nodeId: string): void => {
        const canonical = ctx.canvasState.getCanvas();
        if (!canonical) return;
        const nodeData = canonical.nodeData[nodeId] as { prompt?: string; panelPrompt?: string; title?: string } | undefined;
        const draftFromNode = nodeData?.prompt ?? nodeData?.panelPrompt ?? "";
        const captured = captureNodePromptAsSnippetBody({
          prompt: draftFromNode,
          resolveSlot: (slotId) => slotMaterialForNode(canonical, nodeId, slotId)
        });
        ctx.dialogs.open({
          dialogId: SNIPPET_EDITOR_DIALOG_ID,
          payload: {
            mode: "create",
            nodeId,
            draftName: captured.body.replace(/\{\{[^}]*\}\}/g, "").trim().slice(0, 40) || nodeData?.title || "",
            draftBody: captured.body
          }
        });
      };

      /** 打开片段库（右下角控件面板的「提示词片段管理」入口）。 */
      const openLibrary = (): void => {
        ctx.dialogs.open({ dialogId: SNIPPET_LIBRARY_DIALOG_ID, payload: {} });
      };

      // 右下角控件面板：提示词片段管理图标（change: unify-canvas-corner-controls）。
      const removeToolbarAction = ctx.slots.register("canvas.toolbar-action", {
        id: "prompt-snippets-library",
        owner: PROMPT_SNIPPETS_PLUGIN_ID,
        priority: 10,
        label: "提示词片段管理",
        icon: SnippetLibraryIcon,
        onActivate: openLibrary
      });
      disposers.push(removeToolbarAction);

      const disposeLibrary = ctx.dialogs.registerDialog(SNIPPET_LIBRARY_DIALOG_ID, {
        definition: snippetLibraryDefinition,
        renderer: createLibraryRenderer(catalog, {
          openEditor,
          requestDelete,
          requestDeleteTag
        })
      });
      disposers.push(disposeLibrary);
      const disposeEditor = ctx.dialogs.registerDialog(SNIPPET_EDITOR_DIALOG_ID, {
        definition: snippetEditorDefinition,
        renderer: createEditorRenderer({
          catalog,
          candidates,
          previews,
          actions: {
            loadSnippet: async (snippetId) => {
              const result = await ctx.canvasRemote.getSnippet(snippetId);
              return result.ok ? result.value : null;
            },
            saveCreate: (input) => catalog.createSnippet(input),
            saveUpdate: (input) => catalog.updateSnippet(input)
          }
        })
      });
      disposers.push(disposeEditor);
      const disposeDelete = ctx.dialogs.registerDialog(SNIPPET_DELETE_DIALOG_ID, {
        definition: snippetDeleteDefinition,
        renderer: createDeleteConfirmRenderer(async (payload) => {
          const result = await catalog.deleteSnippet(payload.snippetId);
          if (result.ok) {
            ctx.dialogs.close();
            return { ok: true };
          }
          return { ok: false, error: result.error };
        })
      });
      disposers.push(disposeDelete);
      const disposeTagDelete = ctx.dialogs.registerDialog(SNIPPET_TAG_DELETE_DIALOG_ID, {
        definition: snippetTagDeleteDefinition,
        renderer: createTagDeleteConfirmRenderer(async (tagId) => {
          const result = await catalog.deleteTag(tagId);
          if (result.ok) {
            ctx.dialogs.close();
            return { ok: true };
          }
          return { ok: false, error: result.error };
        })
      });
      disposers.push(disposeTagDelete);

      // 节点右键菜单 contribution：保存当前提示词为片段（design D10 修订）。
      const removeContextMenu = ctx.slots.register("canvas.context-menu", {
        id: "prompt-snippets-save",
        owner: PROMPT_SNIPPETS_PLUGIN_ID,
        priority: 10,
        items: ({ nodeId, connectFrom }: ContextMenuContext) => {
          // 只在命中节点（非拉线到空白）时提供；保存片段是只读捕获，不要求可写。
          if (!nodeId || connectFrom) return [];
          return [{ id: SAVE_SNIPPET_MENU_ID, label: "保存为片段…" }];
        },
        onSelect: (itemId, context) => {
          if (itemId !== SAVE_SNIPPET_MENU_ID || !context.nodeId) return;
          saveNodeAsSnippet(context.nodeId);
        }
      });
      disposers.push(removeContextMenu);
    },
    {
      name: PROMPT_SNIPPETS_PLUGIN_ID,
      inject: ["canvasRemote", "mediaRemote", "dialogs", "slots", "canvasScope", "canvasState"]
    }
  );
}

/** 去掉 `key` 的 material 描述（capture 需要生成本地 key）。 */
type MaterialWithoutKey = Omit<PromptSnippetMediaMaterial, "key"> | Omit<PromptSnippetTextMaterial, "key">;

/** 节点某 slot 的 material 描述（capture 用）；无法权威解析返回 null。 */
function slotMaterialForNode(
  canvas: ServerCanvas,
  nodeId: string,
  slotId: string
): MaterialWithoutKey | null {
  const mapping = collectDirectMappings(canvas, nodeId).find((entry) => entry.slotId === slotId);
  if (!mapping) return null;
  const explicit = (mapping.sourceAssetIds ?? []).filter((id): id is string => typeof id === "string" && id !== "");
  const sourceAssetId = explicit[0] ?? canvas.nodeData[mapping.sourceNodeId]?.outputAssetId;
  const asset = typeof sourceAssetId === "string"
    ? canvas.assets.find((entry) => entry.id === sourceAssetId)
    : undefined;
  if (!asset || asset.status !== "ready") return null;
  const label = asset.title || asset.id;
  const mediaKind = asset.mediaKind;
  if (mediaKind === "text") {
    return { mediaKind: "text", assetId: asset.id, label, text: asset.text ?? "" };
  }
  if (mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio") return null;
  const storageKey = asset.metadata?.storageKey;
  const checksum = asset.metadata?.checksum;
  const contentType = asset.metadata?.contentType;
  const size = asset.metadata?.size;
  if (typeof storageKey !== "string" || typeof checksum !== "string" || typeof contentType !== "string" || typeof size !== "number") {
    return null;
  }
  return { mediaKind, assetId: asset.id, storageKey, checksum, contentType, size, label };
}

/** 片段正文摘要（`#` 候选列表展示；移除 token 便于阅读）。 */
function summarizeBody(body: string): string {
  const text = body.replace(/\{\{[^}]*\}\}/g, "（素材）").replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export type { SnippetCatalog };
