import {
  decodeSceneAreaData, decodeWorldInstanceData, executeModelWithStoredRig, isGlbModelNodeData,
  readGlbModelAssetId, hasReadyMediaAsset, parseGlbModel, stableStringify, worldToRendererRotation,
  type ServerCanvas, type StoredAsset, type WorldPreparedAuthoritySnapshot
} from "@woohaa3/contracts";
import { Group, Scene } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { buildDownloadScene, disposeDownloadScene, exportDownloadScene } from "./model-download.js";

/** Freeze exactly the models whose stable ground anchors belong to this area. */
export function sceneAreaDownloadModels(canvas: ServerCanvas, nodeId: string, snapshot: WorldPreparedAuthoritySnapshot) {
  const area = decodeSceneAreaData(canvas.nodeData[nodeId]?.sceneArea);
  if (snapshot.revision !== canvas.revision) throw new Error("场景模型已变化，请等待同步后重新下载");
  if (!area.ok || snapshot.canvasId !== canvas.id || snapshot.areaNodeId !== nodeId
    || snapshot.area.areaId !== area.value.areaId || snapshot.area.scopeVersion !== area.value.scopeVersion
    || stableStringify(snapshot.area.bounds) !== stableStringify(area.value.bounds)) {
    throw new Error("片场已变化，请重新下载");
  }
  if (!snapshot.members.instances.length) throw new Error("片场中尚无可导出的模型");
  return snapshot.members.instances.map(member => {
    const node = canvas.document.nodes.find(candidate => {
      const instance = decodeWorldInstanceData(canvas.nodeData[candidate.id]?.sharedWorldInstance);
      return instance.ok && instance.value.instanceId === member.identity.instanceId;
    });
    const instance = decodeWorldInstanceData(node && canvas.nodeData[node.id]?.sharedWorldInstance);
    if (!node || !instance.ok || stableStringify(instance.value.transform) !== stableStringify(member.transform)) throw new Error("场景模型已变化，请等待同步后重新下载");
    return { nodeId: node.id, data: structuredClone(canvas.nodeData[node.id]!), transform: structuredClone(member.transform) };
  });
}

/** A static, meter-based GLB containing authored models and their world transforms. */
export async function downloadSceneAreaBlob(canvas: ServerCanvas, nodeId: string, snapshot: WorldPreparedAuthoritySnapshot,
  signal: AbortSignal, readMedia: (asset: StoredAsset, signal: AbortSignal, canvasId?: string) => Promise<Blob>): Promise<Blob> {
  signal.throwIfAborted();
  const models = sceneAreaDownloadModels(canvas, nodeId, snapshot);
  const assets = structuredClone(canvas.assets);
  const scene = new Scene();
  try {
    for (const model of models) {
      signal.throwIfAborted();
      const root = new Group();
      root.name = typeof model.data.title === "string" ? model.data.title : model.nodeId;
      const { position, rotation, scale } = model.transform;
      root.position.set(position.u, position.h, -position.v);
      root.quaternion.set(...worldToRendererRotation(rotation));
      root.scale.setScalar(scale);
      scene.add(root);
      if (isGlbModelNodeData(model.data)) {
        const asset = assets.find(candidate => candidate.id === readGlbModelAssetId(model.data));
        if (!asset || !hasReadyMediaAsset(asset)) throw new Error("场景模型资源尚未就绪，请稍后重试");
        const bytes = await (await readMedia(asset, signal, canvas.id)).arrayBuffer();
        signal.throwIfAborted();
        // Keep the same embedded-only asset boundary as model import before the
        // Three loader reconstructs the original materials, UVs and textures.
        const checked = parseGlbModel(new Uint8Array(bytes));
        if (!checked.ok) throw new Error(`场景模型无法导出：${checked.message}`);
        const loaded = await new GLTFLoader().parseAsync(bytes, "");
        root.add(loaded.scene);
      } else {
        const result = executeModelWithStoredRig(model.data.modelScript ?? "", model.data.modelScriptVersion, model.data.modelRig);
        if (!result.ok) throw new Error(`场景模型无法导出：${result.message}`);
        if (!result.scene.ops.some(op => "parent" in op && op.t !== "group")) throw new Error("场景模型尚无可导出的几何内容");
        const geometry = buildDownloadScene(result.scene.ops);
        root.add(...geometry.children);
      }
    }
    return await exportDownloadScene(scene, signal);
  } finally { disposeDownloadScene(scene); }
}
