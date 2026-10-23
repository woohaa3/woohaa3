import { ensureWoohaa3CanvasInputMappingSlotId, inferWoohaa3CanvasInputRole } from "./core";
import type { Woohaa3CanvasDocument } from "./core";
import type { CanvasNodeData, CanvasNodeInputMapping } from "./types";

export type InputMappingRepair = (
  targetType: string | undefined,
  mappings: CanvasNodeInputMapping[],
  nodesById: ReadonlyMap<string, Woohaa3CanvasDocument["nodes"][number]>,
  nodeData: Record<string, CanvasNodeData>
) => CanvasNodeInputMapping[];

export function reconcileInputMappings(
  nodeData: Record<string, CanvasNodeData>,
  document: Woohaa3CanvasDocument,
  options: { repairRoles?: InputMappingRepair } = {}
): Record<string, CanvasNodeData> {
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  const nodesById = new Map(document.nodes.map((node) => [node.id, node]));
  const sourcesByTarget = new Map<string, Set<string>>();
  for (const edge of document.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const sources = sourcesByTarget.get(edge.target) ?? new Set<string>();
    sources.add(edge.source);
    sourcesByTarget.set(edge.target, sources);
  }

  let changed = false;
  // 覆盖所有既有 nodeData 以及“有 incoming edge 但还没有 nodeData 条目”的目标节点，
  // 使 edge 与 mapping 在同一提交内一致（design D1）。
  const targetIds = new Set<string>([...Object.keys(nodeData), ...sourcesByTarget.keys()]);
  const next = Object.fromEntries([...targetIds].map((nodeId) => {
    const data = (nodeData[nodeId] ?? {}) as CanvasNodeData;
    const existingMappings = Array.isArray(data.inputMapping) ? data.inputMapping : [];
    const sources = sourcesByTarget.get(nodeId) ?? new Set<string>();
    const mappings = existingMappings
      .filter((mapping) => nodeIds.has(mapping.sourceNodeId) && sources.has(mapping.sourceNodeId))
      .map((mapping) => ensureWoohaa3CanvasInputMappingSlotId(mapping));
    const knownSources = new Set(mappings.map((mapping) => mapping.sourceNodeId));
    let nextMappings: CanvasNodeInputMapping[] = mappings;
    for (const sourceNodeId of sources) {
      if (knownSources.has(sourceNodeId)) continue;
      const sourceNode = nodesById.get(sourceNodeId);
      const sourceData = nodeData[sourceNodeId];
      const mapping = {
        sourceNodeId,
        role: inferWoohaa3CanvasInputRole({
          sourceNode: sourceNode ?? { id: sourceNodeId, type: "custom" },
          targetNode: nodesById.get(nodeId) ?? { id: nodeId, type: "custom" },
          sourceData,
          readNodeData: id => nodeData[id],
          targetData: data,
          existingRoles: nextMappings.map((mapping) => mapping.role),
        }),
        sortKey: String(nextMappings.length),
      };
      nextMappings = [...nextMappings, ensureWoohaa3CanvasInputMappingSlotId(mapping)];
    }
    const mode = data.parameters?.generationMode === "first_last_frame"
      ? "first_last_frame"
      : data.parameters?.generationMode === "edit_video" ? "edit_video" : "omni_reference";
    if (mode === "first_last_frame") {
      let frameIndex = 0;
      nextMappings = nextMappings.map((mapping) => {
        const sourceNode = nodesById.get(mapping.sourceNodeId);
        const sourceData = nodeData[mapping.sourceNodeId];
        const isImage = sourceNode?.type === "image" || sourceData?.resultPreview?.kind === "image";
        if (!isImage) return mapping;
        const role = frameIndex === 0 ? "first_frame" : frameIndex === 1 ? "last_frame" : "reference_image";
        frameIndex += 1;
        return { ...mapping, role };
      });
    }
    if (mode === "edit_video") {
      let editVideoAssigned = false;
      nextMappings = nextMappings.map((mapping) => {
        const sourceNode = nodesById.get(mapping.sourceNodeId);
        const sourceData = nodeData[mapping.sourceNodeId];
        const isVideo = sourceNode?.type === "video" || sourceData?.resultPreview?.kind === "video";
        if (isVideo && (mapping.role === "edit_video" || !editVideoAssigned)) {
          editVideoAssigned = true;
          return { ...mapping, role: "edit_video" };
        }
        if (mapping.role === "first_frame" || mapping.role === "last_frame") return { ...mapping, role: isVideo ? "reference_video" : "reference_image" };
        return mapping;
      });
    }
    if (options.repairRoles) nextMappings = options.repairRoles(nodesById.get(nodeId)?.type, nextMappings, nodesById, nodeData);
    if (nextMappings.length === existingMappings.length && nextMappings.every((mapping, index) => mapping === existingMappings[index])) return [nodeId, data];
    changed = true;
    return [nodeId, { ...data, inputMapping: nextMappings }];
  })) as Record<string, CanvasNodeData>;
  return changed ? next : nodeData;
}
