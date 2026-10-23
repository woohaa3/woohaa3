/**
 * 节点执行面板的纯辅助
 * （change: 2026-09-28-split-frontend-god-plugins，task 6；从 node-execution-panel.tsx 拆出）。
 */
import type {
  CanvasNodeData,
  CanvasTaskCatalog,
  CanvasTaskCatalogModel,
  CanvasTaskInputBinding,
  CanvasReferenceMediaKind,
  ServerCanvas
} from "@woohaa3/contracts";
import { catalogBlockingReasons, catalogStateBlockingReasons, capabilityForModel } from "./catalog-projection.js";
import { resolveNodeReferenceInputs } from "./input-resolution.js";
import { readGenerationMode, validateGenerationModeInputs } from "@woohaa3/contracts";
import { resolveModelMcpServerUrl } from "../../mcp-endpoint.js";
import { resolveCanonicalMediaUrl } from "../../services/media-remote.js";
import type { CatalogState } from "../../contracts.js";
import type { NodePanelKind } from "./node-panel-registry.js";

/** 模型 MCP 服务器地址（同源 `/mcp/*`；不写规范状态）。 */
export { resolveModelMcpServerUrl };

/**
 * 解析选中节点的 target modelKey（change: add-pluggable-model-interactions，D8）。
 *
 * 优先级：面板 draft → 规范 `nodeData.parameters.model` → 规范 `nodeData.modelKey`
 * → catalog 默认模型。Host 用它作为 draft identity 与 commit 身份。
 */
export function resolveSelectedModelKey(input: {
  nodeData: CanvasNodeData;
  draftParameters: Record<string, unknown> | undefined;
  models: readonly CanvasTaskCatalogModel[];
  defaultModelKey: string;
}): string {
  const candidates = [
    input.draftParameters?.model,
    input.nodeData.parameters?.model,
    input.nodeData.modelKey
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate === "") continue;
    if (input.models.some((model) => model.modelKey === candidate)) return candidate;
  }
  return input.defaultModelKey;
}

export function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export type ResolveBlockingReasonsInput = {
  panelKind: NodePanelKind | null;
  nodeId: string;
  disabledReason: string | null;
  pendingSelection: boolean;
  catalog: CanvasTaskCatalog | null;
  catalogState: CatalogState;
  model: string;
  canvas: ServerCanvas | null;
  panelParameters: Record<string, unknown>;
};

/**
 * 汇总面板阻止原因（目录状态 → 模型能力 → 参考输入 → 生成模式约束）。
 *
 * 目录状态先于模型配置判断：loading / error 时 `modelConfig` 仍是「按空目录投影」的结果，
 * 直接读它会把加载失败误报成「没有可用模型」。
 */
export function resolveBlockingReasons(input: ResolveBlockingReasonsInput): string[] {
  const { panelKind, nodeId, disabledReason, pendingSelection, catalog, catalogState, model, canvas } = input;
  const reasons: string[] = [];
  if (disabledReason) reasons.push(disabledReason);
  if (pendingSelection) reasons.push("节点仍在等待保存，暂不可执行任务");
  if (catalog) {
    reasons.push(...catalogBlockingReasons(catalog));
  } else {
    reasons.push(...catalogStateBlockingReasons(catalogState));
  }
  if (catalog?.available && catalog.models.length > 0 && panelKind) {
    const capability = capabilityForModel(catalog, panelKind, model);
    if (!capability) {
      reasons.push("该节点没有可用模型");
    } else if (canvas) {
      const resolution = resolveNodeReferenceInputs({
        canvas,
        nodeId,
        bindings: capability.bindings
      });
      reasons.push(...resolution.blockingReasons.filter(reason => reason !== "等待镜头参考图片准备完成"));
      // 视频生成模式约束（edit_video / first_last_frame）：与 Canvas Service 共用同一规则，
      // 面板在 provider 调用前就给出稳定原因，而不是静默提交注定失败的输入。
      const mode = readGenerationMode(input.panelParameters);
      if (mode !== "omni_reference") {
        reasons.push(
          ...validateGenerationModeInputs(
            mode,
            resolution.references.map((reference) => ({
              role: reference.role,
              mediaKind: reference.input.mediaKind
            })),
            capability.bindings
          )
        );
      }
    }
  }
  return dedupe(reasons);
}

/** 参考候选：画布上未连接、且类型可作为输入来源的节点。 */
export function computePickerCandidates(
  canvas: ServerCanvas | null,
  nodeId: string,
  options: { bindings?: readonly CanvasTaskInputBinding[] } = {}
): Array<{
  nodeId: string;
  label: string;
  mediaKind: string;
  previewUrl: string | null;
  disabled?: boolean;
  reason?: string;
}> {
  if (!canvas) return [];
  const connected = new Set(
    canvas.document.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source)
  );
  return canvas.document.nodes
    .filter((node) => node.id !== nodeId && !connected.has(node.id))
    .filter((node) => node.type === "image" || node.type === "video" || node.type === "audio" || node.type === "text")
    .map((node) => {
      const data = canvas.nodeData[node.id];
      const assetId = typeof data?.outputAssetId === "string" ? data.outputAssetId : null;
      const asset = assetId ? canvas.assets.find((entry) => entry.id === assetId) : undefined;
      const assetKind = asset?.mediaKind;
      const mediaKind: string = node.type === "text" ? "text" : (assetKind ?? node.type);
      // 候选不可用（上游尚无 ready 输出）时提供稳定禁用原因；仍展示缩略图/fallback。
      const ready = asset ? asset.status === "ready" : node.type === "text";
      const acceptable = !options.bindings
        ? true
        : mediaKind === "text"
          ? false
          : options.bindings.some((binding) =>
              binding.mediaKinds.includes(mediaKind as CanvasReferenceMediaKind)
            );
      const disabled = !ready || !acceptable;
      const reason = !ready ? `上游节点 ${node.id} 还没有可用输出` : !acceptable ? "当前模型不接受该媒体类型" : undefined;
      return {
        nodeId: node.id,
        label: data?.title || node.id,
        mediaKind,
        previewUrl: asset ? resolveCanonicalMediaUrl(asset, canvas.id) : null,
        ...(disabled ? { disabled, reason } : {})
      };
    });
}
