import { decodeFilmSetContent } from "./legacy-film-set-content.js";
/**
 * 隔离的离线片场 reader（change: 2026-10-11-extract-film-set-extension，任务 7.1–7.10 / D7/D8/D10）。
 *
 * **只**由显式运维迁移命令（`scripts/migrate-model-native-nodes.mjs`）调用；生产读取、Room.load、codec、history restore、MCP 与浏览器导入
 * MUST NOT 引用本模块。它不是兼容读取层：不把旧身份带进运行态，只把旧磁盘格式一次性转换为
 * 新 items-only 规范结构（独立根 + 共享 items + schema 2 clips）。
 *
 * 转换规则见 notes/items-only-content.md §3：
 * - 顶层 authored 模型 → 一份稳定 id 的普通 model item（无源码且无模型动作则不造幽灵 item）；
 * - 旧节点级 motionScript 的镜头轨道 → 片段独立 `cameraMotion`，模型轨道 → 该 model item 的 binding；
 * - 旧 `filmSetContent`（schema 1/2）对象 motion/playback → 片段 binding，items 去动作后转 schema 3；
 * - 旧 `filmSetAnimations`（schema 1）`clip.motion` 同样按镜头/模型轨道拆分；
 * - 混合镜头+模型轨道、模型轨道无目标、非法旧脚本 → 明确阻塞，不截断、不字节切割。
 */
import {
  DEFAULT_FILM_SET_LOCAL_TRANSFORM,
  DEFAULT_FILM_SET_PLAYBACK,
  FILM_SET_EXTENSION_ID,
  MOTION_SCRIPT_LANGUAGE,
  MOTION_SCRIPT_VERSION,
  canonicalFilmSetFields,
  cloneInitialCamera,
  decodeAnimationTimeline,
  decodeFilmSetLocalTransform,
  decodeFilmSetMotion,
  decodeFilmSetNodeData,
  decodeFilmSetPlayback,
  decodeInitialShotCamera,
  decodeModelDefinition,
  decodeMotionDefinition,
  defaultInitialShotCamera,
  deriveFilmSetShotKind,
  executeMotionScript,
  hashMotionScript,
  isJsonObject,
  isBoundedId,
  type AnimationTimeline,
  type FilmSetAnimationBinding,
  type FilmSetAnimationClip,
  type FilmSetAnimations,
  type FilmSetContent,
  type FilmSetItem,
  type FilmSetModelItem,
  type FilmSetNodeData,
  type InitialShotCamera,
  type ModelDefinition,
  type MotionDefinition
} from "@woohaa3/contracts";

export type LegacyFilmSetRead =
  | { ok: true; value: FilmSetNodeData; /** 是否需要写回（旧类型/旧字段存在）。 */ changed: boolean }
  | { ok: false; reason: string };

/** 空（静态）片段镜头定义：完整 `MotionDefinition`，脚本为空。 */
function emptyCameraMotion(): MotionDefinition {
  return {
    motionScript: "",
    motionScriptLanguage: MOTION_SCRIPT_LANGUAGE,
    motionScriptVersion: MOTION_SCRIPT_VERSION,
    revision: 1,
    sourceHash: hashMotionScript(""),
    basedOnModelVersion: { revision: 1, contentHash: "camera" }
  };
}

/**
 * 组装 schema 3 拍摄镜头：显式派生 `kind`，并按类型收敛静态不变式（零时长、非循环、无动作、
 * 无时序媒体）。旧记录本就应满足这些约束；若旧记录带正时序/动作则派生为 dynamic，绝不静默裁掉。
 */
function toShootingShot(input: {
  id: string;
  name: string;
  timeline: AnimationTimeline;
  initialCamera: InitialShotCamera;
  cameraMotion: MotionDefinition;
  bindings: FilmSetAnimationBinding[];
}): FilmSetAnimationClip {
  const kind = deriveFilmSetShotKind(input);
  if (kind === "dynamic") return { ...input, kind };
  return {
    id: input.id,
    name: input.name,
    kind: "static",
    timeline: { duration: 0, loop: false },
    initialCamera: input.initialCamera,
    cameraMotion: emptyCameraMotion(),
    bindings: input.bindings
  };
}

/** 在已用 id 集合内选取稳定、合法且唯一的 itemId（不假设 `model` 空闲）。 */
function pickFilmSetItemId(used: ReadonlySet<string>, base: string): string {
  if (!used.has(base)) return base;
  for (let index = 2; index < 10000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`无法为片场模型选择一个唯一 itemId（基名 ${base}）`);
}

/** 拆分一份旧动作脚本：返回镜头定义与（可选）模型轨道 binding，或明确的阻塞原因。 */
function splitLegacyMotion(input: {
  motion: MotionDefinition;
  duration: number;
  timeline: AnimationTimeline;
  topModelItemId: string | null;
}): { ok: true; cameraMotion: MotionDefinition; binding?: FilmSetAnimationBinding } | { ok: false; reason: string } {
  if (input.motion.motionScript.trim() === "") return { ok: true, cameraMotion: emptyCameraMotion() };
  const executed = executeMotionScript(input.motion.motionScript, { duration: input.timeline.duration });
  if (!executed.ok) return { ok: false, reason: `旧动作脚本无法执行：${executed.message}` };
  const hasCamera = executed.ir.cameraMotion.length > 0;
  const hasModel = executed.ir.modelMotion.length > 0;
  if (hasCamera && hasModel) {
    if (!input.topModelItemId) return { ok: false, reason: "旧动作含模型轨道但旧节点没有可用顶层模型，模型目标缺失" };
    // 同一份旧脚本同时含镜头与模型轨道：按命名空间逐语句拆分，参数逐字保留；镜头轨道成为片段
    // 独立镜头定义，模型轨道成为该 model item 的 binding（D10，任务 7.9）。拆分改变源码，派生
    // 真实 sourceHash 并保留原基于模型版本关联，不冒充保留原 hash。
    const splitSource = splitMotionSourceByNamespace(input.motion.motionScript);
    if (!splitSource.ok) return { ok: false, reason: splitSource.reason };
    return {
      ok: true,
      cameraMotion: { ...input.motion, motionScript: splitSource.camera, sourceHash: hashMotionScript(splitSource.camera) },
      binding: {
        itemId: input.topModelItemId,
        motion: { ...input.motion, motionScript: splitSource.model, sourceHash: hashMotionScript(splitSource.model) },
        playback: {
          startTime: 0,
          duration: input.timeline.duration > 0 ? input.timeline.duration : 1,
          timeScale: 1,
          loop: input.timeline.loop
        }
      }
    };
  }
  if (hasModel) {
    if (!input.topModelItemId) return { ok: false, reason: "旧动作含模型轨道但旧节点没有可用顶层模型，模型目标缺失" };
    return {
      ok: true,
      cameraMotion: emptyCameraMotion(),
      binding: {
        itemId: input.topModelItemId,
        motion: input.motion,
        playback: {
          startTime: 0,
          duration: input.timeline.duration > 0 ? input.timeline.duration : 1,
          timeScale: 1,
          loop: input.timeline.loop
        }
      }
    };
  }
  // 纯镜头（或空轨道）：整份动作作为片段独立镜头定义，保留完整动态构图与时域。
  return { ok: true, cameraMotion: input.motion };
}

/**
 * 按代码命名空间把旧脚本拆成 camera-only 与 model-only 两份。
 *
 * 逐语句（`;` 分隔）判定首个非注释代码行：`motion.camera.*` → 镜头，`motion.model.*` → 模型；
 * 参数逐字保留。注释/空白语句不进入任何一侧；出现无法归类且非空的语句时明确阻塞（不静默丢轨道）。
 */
function splitMotionSourceByNamespace(source: string): { ok: true; camera: string; model: string } | { ok: false; reason: string } {
  const cameraParts: string[] = [];
  const modelParts: string[] = [];
  for (const rawPart of source.split(";")) {
    const namespace = motionStatementNamespace(rawPart);
    if (namespace === null) {
      if (!isCommentOrBlank(rawPart)) {
        return { ok: false, reason: `旧动作脚本含无法归类的语句：${rawPart.trim().slice(0, 60)}` };
      }
      continue;
    }
    if (namespace === "camera") cameraParts.push(rawPart.trim());
    else modelParts.push(rawPart.trim());
  }
  const join = (parts: string[]): string => parts.map(part => `${part};`).join("\n");
  if (modelParts.length === 0) return { ok: false, reason: "旧动作脚本含模型轨道但拆分后模型轨道为空" };
  if (cameraParts.length === 0) return { ok: false, reason: "旧动作脚本含镜头轨道但拆分后镜头轨道为空" };
  return { ok: true, camera: join(cameraParts), model: join(modelParts) };
}

/** 首个有效代码行的命名空间；无有效代码行返回 null。 */
function motionStatementNamespace(statement: string): "camera" | "model" | null {
  for (const line of statement.split("\n")) {
    const code = line.replace(/\/\/.*$/, "").trim();
    if (code === "") continue;
    if (code.startsWith("motion.camera.")) return "camera";
    if (code.startsWith("motion.model.")) return "model";
    return null;
  }
  return null;
}

function isCommentOrBlank(statement: string): boolean {
  return statement.split("\n").every(line => line.replace(/\/\/.*$/, "").trim() === "");
}

type LegacyClipRead = { clips: FilmSetAnimationClip[]; defaultClipId: string | null };

/**
 * 读取旧 `filmSetAnimations`（schema 1，含 `clip.motion`）并转换为 schema 2 片段。
 * 缺失或非 schema 1 返回空集合。
 */
function readLegacyFilmsetAnimations(input: {
  raw: unknown;
  content: FilmSetContent;
  topModelItemId: string | null;
  itemBindings: FilmSetAnimationBinding[];
  fallbackTimeline: AnimationTimeline;
  fallbackCamera: InitialShotCamera;
}): { ok: true; value: LegacyClipRead } | { ok: false; reason: string } {
  if (input.raw === undefined || input.raw === null) return { ok: true, value: { clips: [], defaultClipId: null } };
  if (!isJsonObject(input.raw) || input.raw.schemaVersion !== 1) {
    return { ok: false, reason: "片场片段既非 schema 1 旧格式也非 schema 2 目标格式" };
  }
  const rawClips = input.raw.clips;
  if (!Array.isArray(rawClips)) return { ok: false, reason: "filSetAnimations.clips 非法" };
  const itemIds = new Set(input.content.items.map(item => item.id));
  const clips: FilmSetAnimationClip[] = [];
  for (const raw of rawClips) {
    if (!isJsonObject(raw) || typeof raw.id !== "string" || raw.id.length === 0) return { ok: false, reason: "旧片段 id 非法" };
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "动画";
    const timeline = decodeAnimationTimeline(raw.timeline);
    if (!timeline.ok) return { ok: false, reason: timeline.reason };
    const camera = decodeInitialShotCamera(raw.initialCamera, input.fallbackCamera);
    if (!camera.ok) return { ok: false, reason: camera.reason };
    // 旧 schema 1 片段把 `raw.motion` 嵌套保存为完整 MotionDefinition（不是 flat 节点字段）。
    const motion = decodeFilmSetMotion(raw.motion, raw.id);
    if (!motion.ok) return { ok: false, reason: motion.reason };
    if (!motion.value) return { ok: false, reason: `片段 ${raw.id} 缺少旧 clip.motion` };
    const split = splitLegacyMotion({ motion: motion.value, duration: timeline.value.duration, timeline: timeline.value, topModelItemId: input.topModelItemId });
    if (!split.ok) return { ok: false, reason: `片段 ${raw.id} ${split.reason}` };
    const bindings: FilmSetAnimationBinding[] = split.binding ? [split.binding] : [];
    if (raw.bindings !== undefined) {
      if (!Array.isArray(raw.bindings)) return { ok: false, reason: `片段 ${raw.id} bindings 非法` };
      for (const binding of raw.bindings) {
        if (!isJsonObject(binding) || typeof binding.itemId !== "string" || !itemIds.has(binding.itemId)) {
          return { ok: false, reason: `片段 ${raw.id} binding 引用非法` };
        }
        const childMotion = decodeFilmSetMotion(binding.motion, binding.itemId);
        const playback = decodeFilmSetPlayback(binding.playback, binding.itemId);
        if (!childMotion.ok) return { ok: false, reason: childMotion.reason };
        if (!playback.ok) return { ok: false, reason: playback.reason };
        bindings.push({ itemId: binding.itemId, ...(childMotion.value ? { motion: childMotion.value } : {}), playback: playback.value ?? { ...DEFAULT_FILM_SET_PLAYBACK } });
      }
    }
    clips.push(toShootingShot({ id: raw.id, name, timeline: timeline.value, initialCamera: cloneInitialCamera(camera.value), cameraMotion: split.cameraMotion, bindings }));
  }
  const defaultClipId = typeof input.raw.defaultClipId === "string" ? input.raw.defaultClipId : null;
  return { ok: true, value: { clips, defaultClipId } };
}

/**
 * 读取旧 flat 片场 nodeData 并转换为 canonical items-only 结构。
 *
 * 若输入已是目标格式（schema 3 内容 + schema 2 或无片段），只做业务身份投影（`changed` 标记）。
 */
export function readLegacyFilmSetNodeData(
  nodeData: unknown,
  options: { topModelItemId?: string } = {}
): LegacyFilmSetRead {
  if (options.topModelItemId !== undefined && (!isBoundedId(options.topModelItemId) || options.topModelItemId.length === 0)) {
    return { ok: false, reason: "预分配的顶层模型 itemId 非法" };
  }
  if (!isJsonObject(nodeData)) return { ok: false, reason: "nodeData 必须是对象" };

  // 已是 items-only 目标格式（schema 3 或已升到场景单位的 schema 4）：只做业务身份投影。
  const contentProbe = decodeFilmSetContent(nodeData.filmSetContent);
  if (contentProbe.ok && (contentProbe.value.schemaVersion === 3 || contentProbe.value.schemaVersion === 4)) {
    // 目标内容下可能存在旧顶层/节点级字段（schema 3 内容但尚未清理顶层）：仍走转换以清理。
    const hasLegacyTop = ["modelScript", "modelScriptLanguage", "modelScriptVersion", "modelContentVersion", "modelPlacement", "motionScript", "motionScriptLanguage", "motionScriptVersion", "motionRevision", "motionSourceHash", "motionBasedOnModelVersion", "initialCamera", "timeline"].some(
      field => nodeData[field] !== undefined
    );
    if (!hasLegacyTop) {
      const direct = readTargetFilmSet(nodeData);
      if (!direct.ok) return direct;
      return direct;
    }
  }

  // ---- 旧格式转换（仅离线 reader）----
  const contentDecoded = decodeFilmSetContent(nodeData.filmSetContent);
  if (!contentDecoded.ok) return { ok: false, reason: contentDecoded.reason };
  const legacyContent = contentDecoded.value;

  const usedIds = new Set(legacyContent.items.map(item => item.id));

  let topModel: ModelDefinition | null = null;
  if (nodeData.modelScript !== undefined) {
    const decoded = decodeModelDefinition(nodeData);
    if (!decoded.ok) return { ok: false, reason: decoded.reason };
    topModel = decoded.value;
  }
  let nodeMotion: MotionDefinition | null = null;
  if (nodeData.motionScript !== undefined) {
    const decoded = decodeMotionDefinition(nodeData);
    if (!decoded.ok) return { ok: false, reason: decoded.reason };
    nodeMotion = decoded.value;
  }

  const timeline = decodeAnimationTimeline(nodeData.timeline);
  if (!timeline.ok) return { ok: false, reason: timeline.reason };
  const camera = decodeInitialShotCamera(nodeData.initialCamera, defaultInitialShotCamera());
  if (!camera.ok) return { ok: false, reason: camera.reason };
  const scenePlacement = decodeFilmSetLocalTransform(nodeData.scenePlacement);
  if (!scenePlacement.ok) return { ok: false, reason: scenePlacement.reason };

  // items：剥离对象级 motion/playback，转为片段 binding。
  const itemBindings: FilmSetAnimationBinding[] = [];
  const items: FilmSetItem[] = legacyContent.items.map(item => {
    const { motion, playback, ...shared } = item;
    if (motion || playback) {
      itemBindings.push({ itemId: item.id, ...(motion ? { motion } : {}), playback: playback ?? { ...DEFAULT_FILM_SET_PLAYBACK } });
    }
    return shared as FilmSetItem;
  });

  let topModelItemId: string | null = null;
  // Motion cannot create geometry. In particular, a nonempty camera-only
  // script with an empty top source must never produce a phantom model item.
  // Model tracks without a real top model are rejected by splitLegacyMotion.
  if (topModel && topModel.modelScript.trim() !== "") {
    // The unified offline tool precollects all payloads for this node and supplies one manifest ID.
    // Never silently choose another suffix for just one history version when that manifest conflicts.
    if (options.topModelItemId !== undefined && usedIds.has(options.topModelItemId)) {
      return { ok: false, reason: `预分配的顶层模型 itemId 与既有对象冲突：${options.topModelItemId}` };
    }
    topModelItemId = options.topModelItemId ?? pickFilmSetItemId(usedIds, "model");
    usedIds.add(topModelItemId);
    const modelItem: FilmSetModelItem = {
      id: topModelItemId,
      kind: "model",
      name: typeof nodeData.title === "string" && nodeData.title.trim() ? nodeData.title.trim() : "模型",
      localTransform: { ...DEFAULT_FILM_SET_LOCAL_TRANSFORM },
      model: topModel
    };
    items.push(modelItem);
  }

  // 旧 schema 1 片段（clip.motion）。
  const legacyClips = readLegacyFilmsetAnimations({
    raw: nodeData.filmSetAnimations,
    content: legacyContent,
    topModelItemId,
    itemBindings,
    fallbackTimeline: timeline.value,
    fallbackCamera: camera.value
  });
  if (!legacyClips.ok) return { ok: false, reason: legacyClips.reason };

  let animations: FilmSetAnimations;
  if (legacyClips.value.clips.length > 0) {
    // 对象级 binding 归入默认片段。
    const clips = legacyClips.value.clips.map(clip => ({ ...clip, bindings: [...clip.bindings] }));
    const defaultId = legacyClips.value.defaultClipId ?? clips[0]!.id;
    const target = clips.find(clip => clip.id === defaultId) ?? clips[0]!;
    target.bindings.push(...itemBindings);
    // 合并对象动作/时序后重新派生 kind 并收敛静态不变式（对象动作使镜头成为 dynamic）。
    animations = { schemaVersion: 3, defaultClipId: defaultId, clips: clips.map(toShootingShot) };
  } else {
    // Era A（无独立片段）：节点级动作 + 对象 binding 折叠为唯一默认片段。
    const split = splitLegacyMotion({
      motion: nodeMotion ?? emptyCameraMotion(),
      duration: timeline.value.duration,
      timeline: timeline.value,
      topModelItemId
    });
    if (!split.ok) return { ok: false, reason: split.reason };
    const bindings = [...(split.binding ? [split.binding] : []), ...itemBindings];
    animations = {
      schemaVersion: 3,
      defaultClipId: "legacy-default",
      clips: [toShootingShot({
        id: "legacy-default",
        name: "默认动画",
        timeline: timeline.value,
        initialCamera: cloneInitialCamera(camera.value),
        cameraMotion: split.cameraMotion,
        bindings
      })]
    };
  }

  const value: FilmSetNodeData = {
    kind: "composite-asset",
    title: typeof nodeData.title === "string" && nodeData.title.trim() ? nodeData.title.trim() : "片场",
    scenePlacement: scenePlacement.value,
    sceneCamera: cloneInitialCamera(camera.value),
    camera: cloneInitialCamera(camera.value),
    timeline: timeline.value,
    filmSetContent: { schemaVersion: 3, items },
    filmSetAnimations: animations
  };
  return { ok: true, value, changed: true };
}

/**
 * 目标格式（items-only）投影读取；复用生产严格解码但不做旧字段兼容。
 *
 * 同时接受 schema 3（旧世界单位坐标，等待坐标迁移）与 schema 4（场景单位）：离线 reader 本身
 * 不拥有节点尺寸，无法反解镜头单位，因此不在这里擅自升级内容版本
 * （change: 2026-10-23-isolate-film-set-camera-space，design D1/D5）。
 */
function readTargetFilmSet(nodeData: Record<string, unknown>): LegacyFilmSetRead {
  const decoded = decodeFilmSetNodeData(nodeData, { acceptedContentVersions: [3, 4] });
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  return { ok: true, value: decoded.value, changed: canonicalFieldsDiffer(nodeData, decoded.value) };
}

/**
 * 输入是否与 canonical 目标字段存在实际差异（重复运行必须为 no-op，`changed: false`）。
 *
 * 只比较 canonical 键：`extensionId`/`title`/`scenePlacement`/`sceneCamera`/`filmSetContent`/
 * `filmSetAnimations`/`origin`。额外存在但不影响规范语义的字段（如 `animationSnapshotHash`）不算变化。
 * 比较按**结构化**进行（对象键序无关），否则读者重建的等价结构会因属性顺序被判为变化。
 */
function canonicalFieldsDiffer(nodeData: Record<string, unknown>, value: FilmSetNodeData): boolean {
  const canonical: Record<string, unknown> = { extensionId: FILM_SET_EXTENSION_ID, ...canonicalFilmSetFields(value) };
  const relevant = new Set([...Object.keys(canonical), "origin"]);
  for (const key of relevant) {
    if (stableStringify(nodeData[key]) !== stableStringify(canonical[key])) return true;
  }
  return false;
}

/** 结构化稳定序列化（对象键递归排序），用于忽略属性书写顺序的等价比较。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
