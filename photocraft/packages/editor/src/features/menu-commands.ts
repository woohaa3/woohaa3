import type { EditorWorkspaceController } from "../editor-workspace.js";
import { ADJUSTMENT_LABELS, COMMAND_LABELS, decodeDirectTargets } from "./adjustments/tool-parameters.js";
import type { EditorFeaturePanel } from "./index.js";

export type FeatureMenuCommand = { panel: EditorFeaturePanel; command: string; label: string; category?: string };
/** 菜单消费内核实际开放的清单，不复制滤镜或调整能力白名单。 */
export function featureMenuCommands(controller: EditorWorkspaceController): FeatureMenuCommand[] {
  const out: FeatureMenuCommand[] = [];
  const adjustments = controller.features?.adjustments?.directAdjustmentTargets?.();
  const targets = adjustments?.ok ? decodeDirectTargets(adjustments.value) : null;
  if (targets) {
    for (const kind of targets.kinds) out.push({ panel: "adjustments", command: kind, label: ADJUSTMENT_LABELS[kind], category: "调整" });
    for (const command of targets.commands) out.push({ panel: "adjustments", command, label: COMMAND_LABELS[command], category: "调整" });
  }
  const filters = controller.features?.filters?.filterCatalogue?.();
  if (filters?.ok) for (const filter of filters.value.filters) out.push({ panel: "filter", command: filter.id, label: filter.label, category: filter.category });
  for (const [command, label] of [["image.imageSize", "图像大小…"], ["image.canvasSize", "画布大小…"], ["image.trim", "裁边…"]]) {
    if (controller.snapshot().commands.get(command!)?.allowed) out.push({ panel: "compose", command: command!, label: label! });
  }
  return out;
}
