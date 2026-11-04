/**
 * Paste Import Plugin
 * （change: add-paste-import-workflows，design D1/D2/D8/D10）。
 *
 * 静态可信的 optional feature：向 `input.paste` / `input.drop` typed slots 注册稳定
 * owner/ID 的 contribution，编排 clipboard adapter、文件导入与单图替换确认。
 *
 * 边界：
 * - 不创建第二套 document listener / remote client / Dialog stack / selection store；
 * - 只通过注入的 `slots`、`importService`、`canvasSession`、`selection`、`canvasRuntime`、
 *   `dialogs` 协作；不直接 fetch 或拼三大服务 path；
 * - dispose 时撤销 slot、adapter、dialog；进行中的异步操作以 item/instance identity 忽略迟到结果。
 */
import { ALERT_DIALOG_ID } from "../../services/dialogs/alert-dialog.js";
import type { Context } from "@deepseek-ai/cordis";
import type { Plugin } from "@deepseek-ai/cordis";
import { definePlugin } from "../../plugin.js";
import { IMPORT_SERVICE, type ImportService } from "../service-keys.js";
import { imageEditAssetIdsOf, imageEditProjectObjectOf, parseCanvasCopyPayload, type CanvasCopyPayload } from "../canvas-shell/clipboard/payload.js";
import { planCanvasPaste } from "../canvas-shell/clipboard/planner.js";
import { DUPLICATE_CANVAS_EVENT } from "../canvas-shell/interaction-keyboard.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { ClipboardAdapterRegistry } from "./adapter.js";
import { classifyFileList, classifyTransferFiles, dedupeClassifiedFiles, type ClassifiedFile } from "./datatransfer.js";
import { resolveDropIntent, resolvePasteIntent, transferHasFiles } from "./dispatcher.js";
import { evaluateReplaceEligibility } from "./replace-eligibility.js";
import {
  PASTE_REPLACE_DIALOG_ID,
  createReplaceConfirmRenderer,
  replaceConfirmDefinition
} from "./replace-dialog.js";

export const PASTE_IMPORT_PLUGIN_ID = "paste-import";

/** 页内剪贴板 fallback 的全局键（与 canvas shell 共用同一约定）。 */
const MEMORY_CLIPBOARD_KEY = "__canvasMemoryClipboard";

type ReplaceIntent = { id: string; file: File; nodeId: string; nodeLabel: string; zoom: number };

export function pasteImportExtension(): Plugin.Function<void> {
  return definePlugin(
    (ctx: Context) => {
      const adapters = new ClipboardAdapterRegistry();
      const replaceIntents = new Map<string, ReplaceIntent>();
      let intentSequence = 0;
      // dispose 后忽略迟到异步结果（design D10）。
      let disposed = false;
      // 收集注册 disposer，交给一个 ctx.effect 统一回收：即使后续注册（如 dialog 冲突）
      // 抛错，Cordis 的回滚也会执行 effect cleanup，不残留 paste/drop contribution。
      const disposers: Array<() => void> = [];

      const importService = (): ImportService | undefined => {
        if (disposed) return undefined;
        return ctx.get(IMPORT_SERVICE) as ImportService | undefined;
      };

      const writable = (): boolean => {
        if (disposed) return false;
        try {
          return ctx.canvasSession.isWritable() && !ctx.inputScopes.blocksCanvas();
        } catch {
          return false;
        }
      };

      // --- 内部节点载荷粘贴（优先级最高）------------------------------------
      const pasteInternal = (payload: CanvasCopyPayload): boolean => {
        if (!writable()) return true; // 认领事件：避免浏览器把 JSON 文本贴到页面。
        if (disposed) return true;
        const canonical = woohaa3CanvasStore.getState().canvas;
        const session = ctx.canvasSession;
        if (!canonical || !session) return true;
        const currentTarget = () => !disposed && ctx.canvasSession === session && woohaa3CanvasStore.getState().canvas?.id === canonical.id;
        const controller = ctx.canvasRuntime.controller();
        if (!controller) return true;
        const pointer = ctx.canvasRuntime.lastPointerWorld();
        const anchor = pointer
          ? { kind: "point" as const, position: pointer }
          : (() => {
              const surface = controller.surface();
              return { kind: "viewport-center" as const, hostSize: { width: surface.width, height: surface.height } };
            })();
        const apply = (verified: CanvasCopyPayload) => {
          if (!writable() || disposed) return;
          const current = woohaa3CanvasStore.getState().canvas;
          if (!current || current.id !== canonical.id) return;
          let reported = false;
          const report = (description: string) => {
            if (!currentTarget()) return;
            reported = true;
            ctx.dialogs.open({ dialogId: ALERT_DIALOG_ID, payload: { title: "无法粘贴作品", description } });
          };
          try {
            const plan = planCanvasPaste({ lifecycle: ctx.get("compositeAssets")?.managedLifecycles, canvas: current, payload: verified, anchor, viewport: controller.viewport(), onRefusal: report });
            if (plan) void Promise.resolve(ctx.canvasEdit.record(plan.commands, plan.newNodeIds.length > 1 ? `粘贴 ${plan.newNodeIds.length} 个作品` : "粘贴作品"))
              .then((result) => { if (!result.ok) report(`粘贴失败：${result.reason}`); })
              .catch((error: unknown) => report(`粘贴失败：${error instanceof Error ? error.message : "请稍后重试"}`));
            else if (!reported) report("复制内容无效或引用不可用，请重新选择作品后复制。");
          } catch {
            report("复制内容无效或无法提交，请重新选择作品后重试。");
          }
        };
        const projects = payload.nodes.flatMap((node) => {
          const project = imageEditProjectObjectOf(payload.nodeData[node.id]);
          return project ? [project] : [];
        });
        if (projects.length === 0) apply(payload);
        else {
          // 同步认领 paste，异步授权与探测结束后才构造提交；不阻塞浏览器事件。
          const assetIds = new Set(payload.nodes.flatMap((node) => imageEditAssetIdsOf(payload.nodeData[node.id])));
          for (const node of payload.nodes) {
            const output = payload.nodeData[node.id]?.outputAssetId;
            if (typeof output === "string") assetIds.add(output);
          }
          void ctx.canvasRemote.verifyImageProjectReferences({ canvasId: canonical.id,
            sourceCanvasId: payload.sourceCanvasId ?? canonical.id, nodeIds: payload.nodes.map((node) => node.id),
            assetIds: [...assetIds], projects }).then((result) => {
              if (result.ok) apply({ ...payload, assets: [ ...(payload.assets ?? []).filter((asset) => !assetIds.has(asset.id)), ...result.value.assets ] });
              else if (currentTarget()) ctx.dialogs.open({ dialogId: ALERT_DIALOG_ID, payload: { title: "无法粘贴图片工程", description: result.error } });
            }).catch(() => { if (currentTarget()) ctx.dialogs.open({ dialogId: ALERT_DIALOG_ID, payload: { title: "无法粘贴图片工程", description: "无法核验工程与来源素材，请稍后重试" } }); });
        }
        return true;
      };

      // --- 文件导入（每文件独立原子提交）------------------------------------
      const importFiles = async (files: ClassifiedFile[] | readonly File[], anchorWorld: { x: number; y: number } | null) => {
        if (disposed) return;
        const service = importService();
        if (!service) return;
        const raw = files.map((entry) => (entry instanceof File ? entry : entry.file));
        await service.importBatch({
          files: raw,
          anchor: { world: anchorWorld },
          source: "paste",
          selectedNodeIds: ctx.selection.getSnapshot().nodeIds
        });
      };

      const replaceAnchor = (): { x: number; y: number } | null => {
        if (disposed) return null;
        const controller = ctx.canvasRuntime.controller();
        if (!controller) return null;
        const pointer = ctx.canvasRuntime.lastPointerWorld();
        if (pointer) return pointer;
        const surface = controller.surface();
        const viewport = controller.viewport();
        return {
          x: (surface.width / 2 - viewport.x) / viewport.zoom,
          y: (surface.height / 2 - viewport.y) / viewport.zoom
        };
      };

      // --- 单图替换确认 -----------------------------------------------------
      const maybeOfferReplace = (files: readonly File[]): boolean => {
        const { files: classified } = classifyFileList(files);
        const selection = ctx.selection.getSnapshot().nodeIds;
        const eligibility = evaluateReplaceEligibility({
          files: classified,
          selectedNodeIds: selection,
          canvas: woohaa3CanvasStore.getState().canvas,
          writable: ctx.canvasSession.isWritable() && !ctx.inputScopes.blocksCanvas()
        });
        if (!eligibility.eligible) return false;
        const canonical = woohaa3CanvasStore.getState().canvas;
        const node = canonical?.document.nodes.find((entry) => entry.id === eligibility.nodeId);
        const nodeLabel =
          (canonical?.nodeData[eligibility.nodeId] as { title?: string } | undefined)?.title ||
          node?.type ||
          eligibility.nodeId;
        const id = `replace-${Date.now().toString(36)}-${intentSequence++}`;
        const controller = ctx.canvasRuntime.controller();
        replaceIntents.set(id, {
          id,
          file: files[0]!,
          nodeId: eligibility.nodeId,
          nodeLabel,
          zoom: controller?.viewport().zoom ?? 1
        });
        const opened = ctx.dialogs.open({
          dialogId: PASTE_REPLACE_DIALOG_ID,
          payload: { intentId: id, fileName: files[0]!.name, nodeLabel }
        });
        if (!opened.ok) {
          replaceIntents.delete(id);
          return false;
        }
        return true;
      };

      // rollback scope：注册的 contribution 与临时资源统一回收。
      ctx.effect(
        () => () => {
          disposed = true;
          for (const dispose of disposers.splice(0)) dispose();
          adapters.dispose();
          replaceIntents.clear();
        },
        "paste-import-cleanup"
      );

      // --- paste contribution ----------------------------------------------
      const removePaste = ctx.slots.register("input.paste", {
        id: "paste-import",
        owner: PASTE_IMPORT_PLUGIN_ID,
        priority: 0,
        handle: (event: ClipboardEvent): boolean => {
          // 图片文档有独立剪贴板；即使焦点落在编辑区外也不粘贴画布节点。
          if (ctx.canvasRuntime.imageFocusProjection?.()) return true;
          if (ctx.inputScopes.blocksCanvas()) return false;
          const data = event.clipboardData;
          const text = data?.getData("text/plain") ?? null;
          const internal = parseCanvasCopyPayload(text);
          // 页内 fallback：浏览器未派发可用文本时使用复制时的内存载荷。
          const fallbackText = text || readMemoryClipboard();
          const resolvedInternal = internal ?? parseCanvasCopyPayload(fallbackText);
          if (!resolvedInternal && fallbackText) {
            try {
              if (JSON.parse(fallbackText)?.format === "infinspire-canvas-copy-v1") {
                if (writable()) ctx.dialogs.open({ dialogId: ALERT_DIALOG_ID, payload: { title: "无法粘贴作品", description: "复制内容无效，请重新选择作品后复制。" } });
                return true;
              }
            } catch { /* Ordinary clipboard text. */ }
          }
          const { files } = classifyTransferFiles(data);
          const intent = resolvePasteIntent({
            text,
            internalPayload: resolvedInternal,
            files,
            adapters
          });
          // 同步 claim：只有确定要处理时才阻止默认。
          if (intent.kind === "none") return false;
          if (intent.kind === "internal") return pasteInternal(intent.payload);
          if (intent.kind === "adapter") {
            // adapter 只产出受限计划；bytes 仍经 importService → mediaRemote 上传。
            void importFiles(intent.files, replaceAnchor());
            return true;
          }
          // files
          void handleFilesPaste(intent.files);
          return true;
        }
      });
      disposers.push(removePaste);

      const onDuplicate = (event: Event) => {
        if (ctx.canvasRuntime.imageFocusProjection?.()) return;
        const detail = (event as CustomEvent<unknown>).detail;
        const payload = typeof detail === "string" ? parseCanvasCopyPayload(detail) : null;
        if (payload) pasteInternal(payload);
        else if (writable()) ctx.dialogs.open({ dialogId: ALERT_DIALOG_ID, payload: { title: "无法重复作品", description: "复制内容无效，请重新选择作品后重试。" } });
      };
      window.addEventListener(DUPLICATE_CANVAS_EVENT, onDuplicate);
      disposers.push(() => window.removeEventListener(DUPLICATE_CANVAS_EVENT, onDuplicate));

      const handleFilesPaste = async (files: ClassifiedFile[]): Promise<void> => {
        const raw = files.map((entry) => entry.file);
        if (maybeOfferReplace(raw)) return;
        const deduped = await dedupeClassifiedFiles(files);
        await importFiles(deduped, replaceAnchor());
      };

      // --- drop contribution ------------------------------------------------
      const removeDrop = ctx.slots.register("input.drop", {
        id: "paste-import",
        owner: PASTE_IMPORT_PLUGIN_ID,
        priority: 0,
        // dragover 只判定「含文件」：任何文件都必须 preventDefault（阻止浏览器导航打开），
        // 精确的类型/大小拒绝发生在 drop 阶段。
        canAccept: (event: DragEvent) => transferHasFiles(event.dataTransfer),
        handle: (event: DragEvent): boolean => {
          if (ctx.inputScopes.blocksCanvas()) return false;
          const { files } = classifyTransferFiles(event.dataTransfer);
          const intent = resolveDropIntent(files);
          if (intent.kind !== "files") return false;
          const world = event.clientX || event.clientY
            ? ctx.canvasRuntime.clientToWorld({ x: event.clientX, y: event.clientY })
            : replaceAnchor();
          void (async () => {
            const deduped = await dedupeClassifiedFiles(intent.files);
            await importFiles(deduped, world);
          })();
          return true;
        }
      });
      disposers.push(removeDrop);

      // --- replace dialog + resolver ---------------------------------------
      const disposeReplaceDialog = ctx.dialogs.registerDialog(PASTE_REPLACE_DIALOG_ID, {
        definition: replaceConfirmDefinition,
        renderer: createReplaceConfirmRenderer(async (instanceId, intentId, choice) => {
          const intent = replaceIntents.get(intentId);
          if (!intent) return { ok: false, error: "替换请求已失效，请重新粘贴" };
          const service = importService();
          if (!service) return { ok: false, error: "导入能力不可用" };
          if (choice === "replace") {
            const result = await service.replaceSelectedImage({ file: intent.file, nodeId: intent.nodeId });
            if (!result.ok) return { ok: false, error: result.error ?? "替换失败" };
          } else {
            const result = await service.importBatch({
              files: [intent.file],
              anchor: { world: replaceAnchor() },
              source: "paste",
              selectedNodeIds: []
            });
            const failed = result.items.find((item) => item.stage === "failed");
            if (failed) return { ok: false, error: failed.error ?? "导入失败" };
          }
          replaceIntents.delete(intentId);
          ctx.dialogs.close(instanceId);
          return { ok: true };
        })
      });
      disposers.push(disposeReplaceDialog);
    },
    {
      name: PASTE_IMPORT_PLUGIN_ID,
      inject: ["slots", "inputScopes", "canvasSession", "canvasRemote", "canvasEdit", "selection", "canvasRuntime", "dialogs"]
    }
  );
}

function readMemoryClipboard(): string | null {
  const target = globalThis as unknown as Record<string, unknown>;
  const memory = target[MEMORY_CLIPBOARD_KEY];
  return typeof memory === "string" ? memory : null;
}
