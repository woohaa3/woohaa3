/**
 * 片场组合运行时构建（change: 2026-10-09-add-film-set-object-motion-and-editing，
 * 任务 3.1/3.2/5.1/5.2 / design D2/D4）。
 *
 * 浏览器侧把一份 `FilmSetNodeData` 组合为单个 prepared resource（**只含静态几何**）：
 * - 每个 model item 的 `model.modelScript`；
 * - ground 几何。
 *
 * 动态 child 动作**不烘焙进 ops**，而是作为独立投影（`BevyFilmSetObjectMotion`）交给 Bevy，
 * 由 Rust 按片场统一播放头 T 求值。这样静态几何在播放/seek/摆放时不重编译（design D2）。
 *
 * 对象脚本失败被隔离为对象级诊断，其他合法对象继续显示；空顶层源码同样构建完整可见片场。
 * 组合 IR 只用于发送执行器，绝不写回 canonical nodeData。
 */
import {
  composeFilmSetScene,
  encodeFilmSetPartId,
  executeModelScriptVersioned,
  prepareModelResource,
  type FilmSetNodeData,
  type FilmSetItem,
  type PreparedModelResource,
  type SceneV2Op
} from "@woohaa3/contracts";

/** 单个模型对象的运行时身份与诊断。 */
export type FilmSetObjectRuntime = {
  itemId: string;
  kind: FilmSetItem["kind"];
  /** 对象根运行时 id（`encodeFilmSetPartId(itemId, "")`）。 */
  rootId: string;
  /** 对象在组合 IR 中的部件 id 集合（含根）。 */
  partIds: string[];
  /** 模型对象编译诊断；媒体/地面或成功时为 null。 */
  diagnostic: string | null;
  /** 对象基础局部变换（供动态根运动叠加）。 */
  base: {
    offset: { x: number; y: number; z: number };
    scale: number;
    yaw: number;
  };
};

export type FilmSetCompositionResult = {
  /** 静态几何资源。 */
  resource: PreparedModelResource;
  objects: FilmSetObjectRuntime[];
  /** 对象 itemId → 组合作用域根 id。 */
  itemRoots: Record<string, string>;
  /** 模型编译失败的对象条目（已保存在 `objects` 的 diagnostic）。 */
  failures: Array<{ itemId: string; diagnostic: string }>;
};

export type BuildFilmSetCompositionInput = {
  nodeId: string;
  animation: FilmSetNodeData;
};

/**
 * 构建片场静态组合。任一模型脚本失败时该对象仍保留占位根（可静态参与取景），并记录诊断。
 */
export function buildFilmSetComposition(input: BuildFilmSetCompositionInput): FilmSetCompositionResult {
  const { animation } = input;
  const content = animation.filmSetContent;
  const modelOps = new Map<string, SceneV2Op[]>();
  const diagnostics = new Map<string, string>();

  for (const item of content.items) {
    if (item.kind !== "model") continue;
    const execution = executeModelScriptVersioned(item.model.modelScript, item.model.modelScriptVersion);
    if (execution.ok) {
      modelOps.set(item.id, execution.scene.ops);
    } else {
      diagnostics.set(item.id, `fail:${execution.stage}:${execution.code}`);
    }
  }

  // items-only 片场：几何只来自内部 model/ground items，不存在顶层 authored 模型作用域。
  const models = content.items
    .filter((item) => item.kind === "model")
    .map((item) => ({
      itemId: item.id,
      localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      ops: modelOps.get(item.id) ?? [],
      placement: item.model.placement
    }));
  const grounds = content.items
    .filter((item) => item.kind === "ground")
    .map((ground) => ({
      itemId: ground.id,
      localTransform: { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 },
      size: ground.size,
      ...(ground.color ? { color: ground.color } : {})
    }));

  const composition = composeFilmSetScene({
    scenePlacement: animation.scenePlacement,
    models,
    grounds
  });

  const failures: Array<{ itemId: string; diagnostic: string }> = [];
  const objects: FilmSetObjectRuntime[] = content.items.map((item) => {
    const rootId = encodeFilmSetPartId(item.id, "");
    const partIds = collectPartIds(modelOps.get(item.id) ?? [], item.id, rootId);
    const diagnostic = diagnostics.get(item.id) ?? null;
    if (diagnostic) failures.push({ itemId: item.id, diagnostic });
    return {
      itemId: item.id,
      kind: item.kind,
      rootId,
      partIds,
      diagnostic,
      base: {
        offset: { ...item.localTransform.offset },
        scale: item.localTransform.scale,
        yaw: item.localTransform.yaw
      }
    };
  });

  const resource = prepareModelResource({
    sceneVersion: "woohaa-model-scene-ir-v2",
    ops: composition.ops
  });

  return { resource, objects, itemRoots: composition.itemRoots, failures };
}

function collectPartIds(ops: readonly SceneV2Op[], itemId: string, rootId: string): string[] {
  const ids = new Set<string>([rootId]);
  for (const op of ops) {
    if (op.t === "material") continue;
    ids.add(encodeFilmSetPartId(itemId, op.id));
  }
  return [...ids];
}
